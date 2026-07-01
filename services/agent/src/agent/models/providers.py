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
