FROM python:3.12-slim
WORKDIR /app
# pip 走阿里云镜像；HF 走 hf-mirror（BGE-M3 权重下载）；模型缓存到 /models（挂卷持久化）
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_TRUSTED_HOST=mirrors.aliyun.com \
    PIP_DEFAULT_TIMEOUT=600 \
    HF_ENDPOINT=https://hf-mirror.com \
    HF_HOME=/models \
    TRANSFORMERS_OFFLINE=0
# torch 单独一层（体积最大，超时重试隔离，成功即缓存）
RUN pip install --no-cache-dir --retries 10 torch
RUN pip install --no-cache-dir --retries 10 fastapi "uvicorn[standard]" sentence-transformers
COPY app.py .
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
