FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System deps for uvicorn, etc.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*

# Install deps
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App
COPY backend/ /app/

# Default env (override in compose if needed)
ENV PORT=7861 \
    UPLOAD_ROOT=/data/uploads \
    CARDS_JSON_PATH=/data/cards/cards.json \
    USE_WHISPER=0

# Volumes
VOLUME ["/data/uploads", "/data/cards"]

EXPOSE 7861
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7861"]
