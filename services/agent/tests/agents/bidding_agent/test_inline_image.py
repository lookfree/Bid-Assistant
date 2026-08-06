"""正文里内联的图片不能把喂给模型的正文顶掉。

2026-08-06 用户反馈：「标书审查中识别不了图片，标书中已经放了该文件」。
实测 230：用户在正文里插入的图片是 `<img src="data:image/jpeg;base64,……">`，单张就有 20 万字符；
而审查每章只喂前 4000 字符（_CHAPTER_CAP）——
  章节 b2  全长 206416 字符，图片从第 1825 字符开始
  章节 t3  全长  55271 字符，图片从第  407 字符开始
图片之后的正文**一个字都进不了审查**，于是审查报「缺少企业法人身份证复印件」，
而那份材料恰恰就是用户以图片形式放进去的。

所以喂模型之前必须把 <img> 换成短占位符：既不吃截断预算，也让模型知道这里有一张图。
存库与导出仍保留真图，本函数只用于「构造模型输入」这一步。
"""
from agent.agents.bidding_agent.nodes.common import strip_inline_images

BIG = "A" * 200_000


class TestBudget:
    def test_data_url_does_not_eat_the_budget(self):
        html = f'<p>前文</p><img src="data:image/jpeg;base64,{BIG}" alt="插图"><p>后文</p>'
        out = strip_inline_images(html)
        assert len(out) < 200
        assert "前文" in out and "后文" in out      # 图后的正文必须活下来
        assert BIG[:50] not in out

    def test_multiple_images(self):
        html = f'<img src="data:image/png;base64,{BIG}"><p>中间</p><img src="data:image/png;base64,{BIG}">'
        out = strip_inline_images(html)
        assert len(out) < 200 and "中间" in out


class TestPlaceholder:
    def test_placeholder_tells_the_model_an_image_is_there(self):
        out = strip_inline_images('<img src="data:image/png;base64,AAA" alt="营业执照扫描件">')
        assert "图片" in out
        assert "营业执照扫描件" in out              # alt 有内容就带上，审查据此判断材料在不在

    def test_placeholder_without_alt_still_marks_presence(self):
        out = strip_inline_images('<img src="data:image/png;base64,AAA">')
        assert "图片" in out

    def test_generic_alt_is_not_worth_repeating(self):
        """默认 alt 就是「插图」，重复一遍没有信息量，占位符自己已经说了是图片。"""
        out = strip_inline_images('<img src="data:image/png;base64,AAA" alt="插图">')
        assert out.count("图") <= 3


class TestUntouched:
    def test_remote_images_are_also_replaced(self):
        """远程图同样对模型不可读，一并换掉。"""
        assert "base64" not in strip_inline_images('<img src="https://x/y.png" alt="图">')

    def test_other_markup_survives(self):
        html = "<h3>标题</h3><p>正文</p><table><tr><td>甲</td></tr></table>"
        assert strip_inline_images(html) == html

    def test_empty_and_none_safe(self):
        assert strip_inline_images("") == ""
        assert strip_inline_images(None) == ""
