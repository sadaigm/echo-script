FROM python:3.12-slim

# ffmpeg: audio conversion inside server-socket.py
# libgomp1: OpenMP runtime needed by whisper binaries
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libgomp1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Whisper prebuilt binaries + models
COPY whisper-cpp-server/whisper-bin-ubuntu-x64/ ./whisper-bin-ubuntu-x64/
COPY whisper-cpp-server/models/ ./models/

# Python server
COPY server/server-socket.py .

# Entrypoint that launches both processes
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV LD_LIBRARY_PATH=/app/whisper-bin-ubuntu-x64

EXPOSE 8000 8001

CMD ["./entrypoint.sh"]
