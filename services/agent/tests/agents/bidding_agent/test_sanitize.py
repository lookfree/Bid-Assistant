from agent.agents.bidding_agent.render.sanitize import strip_document_shell

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
