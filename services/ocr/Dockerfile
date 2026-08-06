FROM python:3.12-slim
WORKDIR /app
# pip 走阿里云镜像（客户环境 Docker Hub 不通、但 pypi/阿里云可达，见部署记录）
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_TRUSTED_HOST=mirrors.aliyun.com \
    PIP_DEFAULT_TIMEOUT=600
# 识别引擎单独一层：onnxruntime + 模型权重是体积大头，成功即缓存，重建不重下。
# rapidocr 默认拖的是**完整版 opencv-python**，它要 libGL/libxcb 等一串 X11 库，
# slim 基镜像里没有 —— 容器会在 import cv2 时直接启动失败（231 实测）。
# 换成 headless 版：同一套 cv2 API，不依赖任何图形库，也不用往镜像里塞 X11。
RUN pip install --no-cache-dir --retries 10 rapidocr-onnxruntime \
 && pip uninstall -y opencv-python \
 && pip install --no-cache-dir --retries 10 opencv-python-headless
RUN pip install --no-cache-dir --retries 10 fastapi "uvicorn[standard]" pillow
COPY app.py .
EXPOSE 8000
# 单 worker：模型常驻内存，多 worker 会把内存乘上去；并发靠上游排队，不靠多进程
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
