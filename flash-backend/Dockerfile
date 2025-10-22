FROM python:3.10-slim

# Optional (ffmpeg helps if you ever enable Whisper)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Your FastAPI app
COPY app.py .

# Expose and config
ENV PORT=7861
# Bind-mount on host will provide cards.json here (see docker-compose.yml)
ENV CARDS_JSON_PATH=/data/cards/cards.json

EXPOSE 7861
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7861"]
