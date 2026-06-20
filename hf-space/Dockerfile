FROM python:3.11-slim

# birdnetlib/soundfile brauchen libsndfile; ffmpeg für robustes Audio-Decoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

# Modell-Cache in ein beschreibbares Verzeichnis (HF-Container)
ENV NUMBA_CACHE_DIR=/tmp HOME=/tmp PORT=7860
EXPOSE 7860
CMD ["python", "server.py"]
