# syntax=docker/dockerfile:1
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0 \
    PORT=8020 \
    WHISPER_MODEL=small \
    LANG=en \
    SILENCE_SECONDS=3.0 \
    SILENCE_RMS=200.0

WORKDIR /app

# System deps (git for wheels source, build-essential for some wheels if needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
  && rm -rf /var/lib/apt/lists/*

# Install Python deps first to leverage Docker layer caching
COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

# Copy app
COPY app.py ./

EXPOSE 8020

CMD ["python", "app.py"]


