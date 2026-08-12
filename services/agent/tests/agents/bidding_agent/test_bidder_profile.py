"""营业执照 OCR → 投标人信息：填错单位名称比留空更糟，所以宁可不给也不能给错。"""

from agent.agents.bidding_agent.nodes.bidder_profile import from_credentials, profile_block

# 真实营业执照 OCR 的样子：字段名里被塞了空格，值与标签之间也不规整
LICENSE_OCR = """营业执照
统一社会信用代码 91310115MA1K35XY7B
名　称 上海安几科技有限公司
类　型 有限责任公司(自然人投资或控股)
法定代表人 冯世瑾
注册资本 壹仟万元整
成立日期 2018年03月15日
住　所 上海市浦东新区张江路XX号3幢201室"""


def _creds(text: str, title: str = "企业法人营业执照") -> list:
    return [{"title": title, "images": [{"fileId": "f1", "key": "k1", "ocrText": text}]}]


class TestFromCredentials:
    def test_pulls_the_fields_a_form_actually_needs(self):
        got = from_credentials(_creds(LICENSE_OCR))
        assert got["name"] == "上海安几科技有限公司"
        assert got["credit_code"] == "91310115MA1K35XY7B"
        assert got["legal_person"] == "冯世瑾"
        assert got["address"].startswith("上海市浦东新区")

    def test_no_credit_code_means_no_values_at_all(self):
        """认不出是营业执照就一个字都不给：把识别噪音填进投标函比留空危险得多。"""
        assert from_credentials(_creds("营业执照\n名　称 某某公司\n（这页糊了，识别不全）")) == {}

    def test_other_certificates_are_not_mistaken_for_a_license(self):
        """资料库里还有开户许可证、体系认证证书等，它们不带统一社会信用代码格式的值。"""
        assert from_credentials(_creds("ISO9001 质量管理体系认证证书\n证书编号 00121Q12345ROS",
                                       title="ISO9001证书")) == {}

    def test_missing_field_is_simply_absent(self):
        """抠不到的字段不写，让模板的空位留着——绝不从上下文猜一个出来。"""
        got = from_credentials(_creds("营业执照\n统一社会信用代码 91310115MA1K35XY7B\n名　称 上海安几科技有限公司"))
        assert "legal_person" not in got
        assert got["name"] == "上海安几科技有限公司"

    def test_empty_or_broken_input_never_raises(self):
        assert from_credentials([]) == {}
        assert from_credentials([{"title": "x"}]) == {}
        assert from_credentials([None, {"images": [None]}]) == {}


class TestProfileBlock:
    def test_block_tells_the_model_to_fill_but_not_rewrite(self):
        block = profile_block(from_credentials(_creds(LICENSE_OCR)))
        assert "上海安几科技有限公司" in block
        assert "不得改写模板的固定文字" in block, "填空指令必须同时重申不许改原文"

    def test_no_profile_means_no_block(self):
        """没有营业执照的用户，简报要逐字节不变——不能凭空多出一个空段落。"""
        assert profile_block({}) == ""
