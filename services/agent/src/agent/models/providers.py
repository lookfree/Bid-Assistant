PROVIDERS: dict[str, dict] = {
    "deepseek": {"base_url": "https://api.deepseek.com/v1", "default_model": "deepseek-chat"},
    "qwen":     {"base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "default_model": "qwen-plus"},
    "glm":      {"base_url": "https://open.bigmodel.cn/api/paas/v4", "default_model": "glm-4-flash"},
}

# provider -> Settings 上的 Key 字段名
KEY_FIELD: dict[str, str] = {
    "deepseek": "deepseek_api_key",
    "qwen": "dashscope_api_key",
    "glm": "zhipu_api_key",
}

# provider -> "关闭思考模式"的 extra_body（OpenAI 兼容接口各家参数不同）。思考默认关：
# 混合思考模型（DeepSeek v4 / Qwen3 / GLM-4.6）流式下默认开思考，与强制 tool_choice 不兼容且更慢更贵。
# deepseek 实测确认；qwen(enable_thinking)/glm(thinking.type) 按各家文档，后台"测试连通"会实际探到。
# 表里没有的 provider（自建/未知）不下发关闭参（不知其格式，交给该模型自身默认 + 后台自测）。
THINKING_DISABLE: dict[str, dict] = {
    "deepseek": {"thinking": {"type": "disabled"}},
    "glm": {"thinking": {"type": "disabled"}},
    "qwen": {"enable_thinking": False},
}
