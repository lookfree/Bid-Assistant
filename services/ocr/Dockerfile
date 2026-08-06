FROM python:3.12-slim
WORKDIR /app
# pip 走阿里云镜像（客户环境 Docker Hub 不通、但 pypi/阿里云可达，见部署记录）
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_TRUSTED_HOST=mirrors.aliyun.com \
    PIP_DEFAULT_TIMEOUT=600
# opencv 的运行时依赖（rapidocr 依赖 opencv-python-headless，仍需 libGL 之外的少量 so）
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
# 识别引擎单独一层：onnxruntime + 模型权重是体积大头，成功即缓存，重建不重下
RUN pip install --no-cache-dir --retries 10 rapidocr-onnxruntime
RUN pip install --no-cache-dir --retries 10 fastapi "uvicorn[standard]" pillow
COPY app.py .
EXPOSE 8000
# 单 worker：模型常驻内存，多 worker 会把内存乘上去；并发靠上游排队，不靠多进程
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
