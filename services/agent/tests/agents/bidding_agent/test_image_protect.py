"""AI 改写单章时，正文里插入的图片必须活下来。

rewrite_chapter 把原章 HTML 整个喂给模型，再用模型输出**整章替换**。而插入的图片是内联
base64（实测单张 20 万字符），模型既读不懂也不可能原样吐回——一次改写，用户放进去的
营业执照就没了。这不是"识别不到"，是**数据丢失**。

所以喂之前把 <img> 换成短标记、拿回输出后再把原标签换回去。模型漏掉标记的，图片补到章末——
放错位置可以让用户再挪，凭空消失不行。
"""
import re

from agent.agents.bidding_agent.nodes.common import protect_images, restore_images

IMG1 = '<img src="data:image/jpeg;base64,' + "A" * 5000 + '" alt="营业执照.png">'
IMG2 = '<img src="data:image/png;base64,' + "B" * 3000 + '" alt="身份证.png">'


class TestProtect:
    def test_base64_replaced_by_short_marker(self):
        out, keep = protect_images(f"<p>前文</p>{IMG1}<p>后文</p>")
        assert len(out) < 200
        assert "前文" in out and "后文" in out
        assert len(keep) == 1

    def test_marker_carries_alt_so_the_model_knows_what_it_is(self):
        out, _ = protect_images(IMG1)
        assert "营业执照.png" in out

    def test_multiple_images_get_distinct_markers(self):
        out, keep = protect_images(IMG1 + IMG2)
        assert len(keep) == 2
        assert out.count("［图片") == 2

    def test_html_without_images_is_untouched(self):
        html = "<h3>标题</h3><p>正文</p>"
        out, keep = protect_images(html)
        assert out == html and keep == {}


class TestRestore:
    def test_round_trip_is_lossless(self):
        html = f"<p>前文</p>{IMG1}<p>后文</p>"
        out, keep = protect_images(html)
        assert restore_images(out, keep) == html

    def test_model_may_reword_around_the_marker(self):
        _out, keep = protect_images(IMG1)
        rewritten = "<p>改写后的段落</p>［图片1：营业执照.png］<p>结尾</p>"
        got = restore_images(rewritten, keep)
        assert IMG1 in got
        assert "改写后的段落" in got

    def test_dropped_marker_means_the_image_is_appended_not_lost(self):
        """模型没把标记写回来——图片补到章末。位置不完美，但绝不能凭空消失。"""
        _out, keep = protect_images(IMG1 + IMG2)
        got = restore_images("<p>模型只写了文字</p>", keep)
        assert IMG1 in got and IMG2 in got

    def test_partially_dropped(self):
        _out, keep = protect_images(IMG1 + IMG2)
        got = restore_images("<p>甲</p>［图片1：营业执照.png］<p>乙</p>", keep)
        assert got.index(IMG1) < got.index(IMG2)   # 保留的在原位，丢掉的补在后面

    def test_empty_mapping_is_a_noop(self):
        assert restore_images("<p>x</p>", {}) == "<p>x</p>"
