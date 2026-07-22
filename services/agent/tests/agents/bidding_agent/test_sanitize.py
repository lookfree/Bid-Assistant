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


def test_chat_wrapper_picks_longest_fence():
    text = "说明：```\n<p>短</p>\n```正文在这：```html\n<h3>长的一段</h3><p>内容内容内容</p>\n```"
    assert strip_chat_wrapper(text) == "<h3>长的一段</h3><p>内容内容内容</p>"
