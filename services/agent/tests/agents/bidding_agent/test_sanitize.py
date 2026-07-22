from agent.agents.bidding_agent.render.sanitize import strip_document_shell, strip_chat_wrapper

FULL_DOC = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>第一章 技术偏差表</title>
  <style>
    body { max-width: 1200px; margin: 0 auto; padding: 30px 20px; }
  </style>
</head>
<body>
<h3>1.1 技术偏差表</h3><table><tr><td>条款</td></tr></table>
</body>
</html>"""

HEADLESS = """\n\n\n  <meta charset="UTF-8">\n  <title>第一章 商务偏差表</title>\n  <style>\n    body { padding: 30px 20px; }\n  </style>\n<h3>正文</h3>"""


def test_full_document_stripped_to_fragment():
    out = strip_document_shell(FULL_DOC)
    assert "<style" not in out and "<head" not in out and "DOCTYPE" not in out
    assert "<body" not in out and "<html" not in out and "<title" not in out
    assert "<h3>1.1 技术偏差表</h3>" in out and "<table>" in out


def test_headless_variant_stripped():
    out = strip_document_shell(HEADLESS)
    assert "<style" not in out and "<meta" not in out and "<title" not in out
    assert out.startswith("<h3>正文</h3>")


def test_plain_fragment_idempotent():
    frag = "<h3>小节</h3><p>内容</p><table><tr><td>x</td></tr></table>"
    assert strip_document_shell(frag) == frag
    assert strip_document_shell("") == ""


# 2026-07-22 生产实测样本：改写输出带开场白 + ```html 围栏，整段被存进正文
CHATTY_FENCED = """好的，这是根据您的指令，对原章"第五章 应急响应能力"进行的改写。修改之处已用 HTML 注释 `` 标注在相应位置，方便您对照查阅。```html
<p>第五章 应急响应能力</p><h3>5.1 应急响应方案</h3><table><tr><td>P1</td></tr></table>
```"""


def test_chat_wrapper_fenced_preamble_stripped():
    out = strip_chat_wrapper(CHATTY_FENCED)
    assert out.startswith("<p>第五章 应急响应能力</p>")
    assert "```" not in out and "好的" not in out and "根据您的指令" not in out


def test_chat_wrapper_prose_prefix_and_tail_stripped():
    out = strip_chat_wrapper("已按要求改写如下：\n<h3>5.1 方案</h3><p>正文</p>\n以上是全部修改，请查收。")
    assert out == "<h3>5.1 方案</h3><p>正文</p>"


def test_chat_wrapper_plain_html_idempotent():
    frag = "<h3>小节</h3><p>内容</p>"
    assert strip_chat_wrapper(frag) == frag
    assert strip_chat_wrapper("") == ""


def test_chat_wrapper_joins_all_html_fences():
    # 模型把整章拆成多段围栏：所有含标签的围栏段都要保留（原实现只取最长段，丢半章）
    text = "```html\n<h3>上半</h3>\n```\n接下来是下半：\n```html\n<table><tr><td>下半</td></tr></table>\n```"
    out = strip_chat_wrapper(text)
    assert "<h3>上半</h3>" in out and "<td>下半</td>" in out
    assert "接下来" not in out


def test_chat_wrapper_tail_only_chat_stripped():
    # 正文以标签开头、仅结尾带闲聊（原实现前缀分支不触发导致尾巴入库）
    out = strip_chat_wrapper("<h3>5.1 方案</h3><p>正文</p>\n以上是全部修改，请查收。")
    assert out == "<h3>5.1 方案</h3><p>正文</p>"


def test_chat_wrapper_keeps_legit_bare_text():
    # 宁留勿删：裸文本标题开头/落款结尾/行内标签开头都是合法正文，不得误删
    keep_head = "第五章 应急响应方案\n<p>正文</p>"
    assert strip_chat_wrapper(keep_head) == keep_head
    keep_tail = "<p>正文</p>\nXX科技有限公司\n2026年7月22日"
    assert strip_chat_wrapper(keep_tail) == keep_tail
    inline = "<strong>重点提示：</strong><p>正文</p>"
    assert strip_chat_wrapper(inline) == inline


def test_chat_wrapper_aside_fence_with_unfenced_chapter():
    # 模型只把旁白围了起来、正文没围（原实现取围栏 → 整章被旁白替换）
    text = "修改点如下：```\n- 响应时间改为15分钟\n```\n<h3>5.1 应急响应</h3><p>正文</p>"
    out = strip_chat_wrapper(text)
    assert out == "<h3>5.1 应急响应</h3><p>正文</p>"
