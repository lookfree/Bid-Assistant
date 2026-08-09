"""扫描页 OCR（扫描件治理第二步）：只对扫描页发 OCR、识别文本按页拼回、失败/超时/超帽降级。

第一步（71f519d）只把提不出文字的页数出来、判「无法核验」；这一步让审查模型**真的看见**
那些页（身份证、盖章报价表、授权书）。OCR 是独立 HTTP 容器，这里用 MockTransport 打桩，
仍然真走 httpx 的请求/响应/异常路径。
"""
import json
import time

import httpx
import pytest

from agent.parsing import ocr as ocr_mod
from agent.parsing.parsers import parse_bytes

_KEY = "uploads/u/x/投标文件.pdf"
# 够长、够特征：pypdf 提取后仍能在正文里认出来，且远超「可见文字」阈值。
_TEXT_PAGE = "Bid body text that is clearly longer than the visible threshold"
# 桩的识别结果必须**够读**（≥ _MIN_VISIBLE_CHARS），否则那一页照旧算看不见——
# 真实扫描页认出来的是整页文字，一两个字的才是异常（见 test_barely_recognized_pages…）。
_OK = "识别成功·法定代表人身份证明及授权委托书盖章页"


def _recognized(n: int) -> str:
    return f"识别文字{n}·法定代表人身份证明及授权委托书盖章页"


def _pdf(*pages: str) -> bytes:
    """按页造 PDF：空串 = 无文字页（对文本提取而言与扫描图片页同义，第一步测试同款手法）。"""
    from fpdf import FPDF

    pdf = FPDF()
    pdf.set_font("helvetica", size=12)
    for text in pages:
        pdf.add_page()
        if text:
            pdf.cell(0, 10, text)
    return bytes(pdf.output())


class _OcrStub:
    """OCR 容器的 HTTP 桩：记录每次请求体，按到达序给答复（reply 可换成失败/超时）。"""

    def __init__(self):
        self.requests: list[dict] = []
        self.reads: list[str] = []
        self.reply = lambda n, body: httpx.Response(200, json={"text": _recognized(n)})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/ocr"
        body = json.loads(request.content)
        self.requests.append(body)
        return self.reply(len(self.requests), body)


@pytest.fixture
def ocr_env(monkeypatch):
    """配上 OCR 地址 + 把传输层换成桩，返回 (桩, 跑一遍解析并 OCR 的协程)。
    桩另记 `reads`：取字节的次数，供「该跳过时连字节都不该取」这类断言。"""
    stub = _OcrStub()
    real_client = httpx.AsyncClient
    monkeypatch.setattr(ocr_mod.settings, "ocr_base_url", "http://ocr.test:8100/")
    monkeypatch.setattr(ocr_mod.httpx, "AsyncClient",
                        lambda **kw: real_client(transport=httpx.MockTransport(stub), **kw))

    async def run(pdf: bytes, **kw):
        def _read(key):
            stub.reads.append(key)
            return pdf

        monkeypatch.setattr(ocr_mod, "read_bytes", _read)
        doc = parse_bytes(pdf, "投标文件.pdf")
        return doc, await ocr_mod.ocr_scanned_pages(doc, _KEY, **kw)

    return stub, run


async def test_ocr_hits_only_scanned_pages_and_splices_text_back(ocr_env):
    """两页扫描 + 一页文本：只对扫描页发 OCR（文本页绝不重复识别），识别文本按页插回原位置
    并带页码标记；全部识别成功后「看不见的页」归零——审查的扫描页注记随之消失。"""
    stub, run = ocr_env
    before, after = await run(_pdf(_TEXT_PAGE, "", ""))
    assert before.image_pages == 2                       # 第一步的判定：两页看不见
    assert len(stub.requests) == 2                       # 文本页一次都没送 OCR
    assert all(r["max_chars"] == 5000 for r in stub.requests)
    assert after.image_pages == 0
    assert "[第2页·扫描件识别]" in after.text and "[第3页·扫描件识别]" in after.text
    assert "识别文字1" in after.text and "识别文字2" in after.text
    assert "threshold" in after.text                     # 文本页原样保留在原位
    # 识别文本必须重新参与条款切分，否则按 clauses 聚章时一个字都进不了审查材料
    assert any("识别文字1" in c["text"] for c in after.clauses)


async def test_failed_pages_stay_counted_as_unverifiable(ocr_env):
    """OCR 部分失败：成功的页拼回正文，失败的页仍计入「还看不见的页数」——
    审查对那几页照旧说「无法核验」，而不是当成已经看过。"""
    stub, run = ocr_env
    stub.reply = lambda n, body: (httpx.Response(200, json={"text": _OK})
                                  if n == 1 else httpx.Response(500, text="boom"))
    _, after = await run(_pdf(_TEXT_PAGE, "", ""))
    assert len(stub.requests) == 2
    assert "识别成功" in after.text
    assert after.image_pages == 1


async def test_unconfigured_ocr_changes_nothing(monkeypatch):
    """OCR_BASE_URL 未配置 = 这套环境没部署 OCR：零 HTTP、零取字节，输出与第一步完全一致。

    绊线走**调用记录**而不是在桩里抛异常：ocr_scanned_pages 最外层有一道 `except Exception`
    兜底，桩抛的 AssertionError 会被它吞掉再 `return doc`，断言结果和「压根没调用」一模一样——
    那样的测试挡不住任何人把配置判据挪走（终审拿反向变异实证过：判据删掉后本文件仍全绿）。
    """
    pdf = _pdf(_TEXT_PAGE, "", "")
    calls: list[str] = []
    real_client = httpx.AsyncClient
    monkeypatch.setattr(ocr_mod.settings, "ocr_base_url", None)
    monkeypatch.setattr(ocr_mod, "read_bytes",
                        lambda key: (calls.append("read_bytes"), pdf)[1])
    monkeypatch.setattr(ocr_mod.httpx, "AsyncClient",
                        lambda **kw: (calls.append("http"), real_client(**kw))[1])
    doc = parse_bytes(pdf, "投标文件.pdf")
    after = await ocr_mod.ocr_scanned_pages(doc, _KEY)
    assert calls == []                      # 判据被挪走 → 这里必红（不再被兜底吞掉）
    assert after is doc and after.image_pages == 2


async def test_page_timeout_is_skipped_without_blocking_the_rest(ocr_env):
    """单页超时只丢那一页，其余页照常识别返回（超时是常量，测试不等真的 20 秒）。"""
    stub, run = ocr_env

    def _reply(n, body):
        if n == 1:
            raise httpx.ReadTimeout("识别超时")
        return httpx.Response(200, json={"text": _OK})

    stub.reply = _reply
    _, after = await run(_pdf(_TEXT_PAGE, "", ""))
    assert "识别成功" in after.text and after.image_pages == 1
    assert ocr_mod._PAGE_TIMEOUT_S == 20


async def test_page_cap_limits_how_many_pages_get_ocr(ocr_env, monkeypatch):
    """单文件页数帽：超上限的扫描页不再识别（防上千页的扫描册把审查步吊死），
    没识别的页仍算「看不见」。"""
    stub, run = ocr_env
    monkeypatch.setattr(ocr_mod, "_MAX_PAGES", 2)
    _, after = await run(_pdf(_TEXT_PAGE, "", "", "", ""))
    assert len(stub.requests) == 2
    assert after.image_pages == 2          # 4 页扫描 − 2 页识别成功


async def test_total_time_budget_stops_further_pages(ocr_env, monkeypatch):
    """单文件总时长帽到点即停手，剩下的页照第一步口径继续算「无法核验」。"""
    stub, run = ocr_env
    monkeypatch.setattr(ocr_mod, "_TOTAL_BUDGET_S", 0)
    _, after = await run(_pdf(_TEXT_PAGE, "", ""))
    assert stub.requests == [] and after.image_pages == 2


async def test_unrenderable_pdf_never_raises_into_the_review_node(ocr_env, monkeypatch):
    """字节取到了却打不开（加密/损坏）：吞掉、退回「无法核验」口径，审查步绝不因 OCR 失败。"""
    stub, run = ocr_env
    doc = parse_bytes(_pdf(_TEXT_PAGE, ""), "投标文件.pdf")
    monkeypatch.setattr(ocr_mod, "read_bytes", lambda key: b"not a pdf at all")
    after = await ocr_mod.ocr_scanned_pages(doc, _KEY)
    assert after.image_pages == 1 and stub.requests == []


@pytest.mark.parametrize("boom", ["read_bytes", "_ocr_pages", "splice_ocr_pages"])
async def test_any_unexpected_failure_falls_back_instead_of_raising(ocr_env, monkeypatch, boom):
    """识别是加分项不是前置条件：取字节、渲染、识别、**拼回**这一整段出任何意外都只是退回第一步
    口径，绝不抛穿审查节点（抛出去就是一次全额退款的失败 run，而扫描件本来只是看不见而已）。
    拼回那一跳尤其容易漏：它在 try 之外时，畸形识别文本让条款重切炸掉就会一路穿到 run 失败。"""
    _stub, _run = ocr_env
    doc = parse_bytes(_pdf(_TEXT_PAGE, ""), "投标文件.pdf")

    def _explode(*a, **kw):
        raise RuntimeError("意料之外的炸法")

    monkeypatch.setattr(ocr_mod, "read_bytes", lambda key: b"%PDF-fake")
    monkeypatch.setattr(ocr_mod, boom, _explode)
    after = await ocr_mod.ocr_scanned_pages(doc, _KEY)
    assert after is doc and after.image_pages == 1


async def test_exhausted_budget_skips_the_file_without_even_fetching_it(ocr_env):
    """时长帽是**一次审查**的：前一份文件把预算用光后，后一份连字节都不再取
    （几百 MB 的下载 + 最多 300 页渲染，白干一遍代价太大），页数照第一步口径原样保留。"""
    stub, run = ocr_env
    _, after = await run(_pdf(_TEXT_PAGE, "", ""), deadline=time.monotonic() - 1)
    assert stub.requests == [] and stub.reads == []
    assert after.image_pages == 2


async def test_remaining_budget_is_inherited_not_restarted(ocr_env):
    """两文件场景：第二份继承的是**剩余**预算，不是重新开一份 20 分钟。
    传进去的 deadline 还剩很久 → 照常识别；上一条用例给的是已过期的同一条链路。"""
    stub, run = ocr_env
    _, after = await run(_pdf(_TEXT_PAGE, "", ""),
                         deadline=time.monotonic() + ocr_mod._TOTAL_BUDGET_S)
    assert len(stub.requests) == 2 and after.image_pages == 0


async def test_barely_recognized_pages_still_count_as_unverifiable(ocr_env):
    """只认出一两个字的页（糊掉的章、被当成字符的花纹）用户实际上还是什么都看不见：
    文本照样拼回去，但**不从「看不见的页」里扣**——门槛与页面本身的扫描判定同源。"""
    stub, run = ocr_env
    stub.reply = lambda n, body: httpx.Response(200, json={"text": "章"})
    _, after = await run(_pdf(_TEXT_PAGE, "", ""))
    assert after.image_pages == 2                 # 两页都还算看不见
    assert "[第2页·扫描件识别]" in after.text      # 认出来的那点字仍原样拼回，不丢


async def test_stopping_early_still_emits_a_final_progress_frame(ocr_env, monkeypatch):
    """提前收手也要把最后一帧进度发出去，否则横幅永远停在上一个 10 的倍数上。"""
    stub, run = ocr_env
    frames: list[tuple[int, int]] = []

    async def _on_progress(done, total):
        frames.append((done, total))

    monkeypatch.setattr(ocr_mod, "_TOTAL_BUDGET_S", 0)
    await run(_pdf(_TEXT_PAGE, "", ""), on_progress=_on_progress)
    assert stub.requests == [] and frames == [(0, 2)]


async def test_resilience_budgets_are_conservative():
    """韧性预算是常量、不许悄悄放大：OCR 是 CPU 推理容器，并发打爆它会连累同机的数据层。"""
    assert ocr_mod._CONCURRENCY == 2
    assert ocr_mod._MAX_PAGES == 300
    assert ocr_mod._TOTAL_BUDGET_S == 20 * 60
