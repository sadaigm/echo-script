FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends libgomp1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY whisper-bin-ubuntu-x64/ ./whisper-bin-ubuntu-x64/
COPY models/ ./models/

ENV LD_LIBRARY_PATH=/app/whisper-bin-ubuntu-x64

EXPOSE 8001

CMD ["./whisper-bin-ubuntu-x64/whisper-server", \
     "-m", "./models/ggml-base.en.bin", \
     "--port", "8001", \
     "--host", "0.0.0.0"]
