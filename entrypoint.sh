#!/bin/bash
set -e

MODEL="${WHISPER_MODEL:-base.en}"

echo "Starting whisper-server (model: $MODEL) ..."
./whisper-bin-ubuntu-x64/whisper-server \
    -m "./models/ggml-${MODEL}.bin" \
    --port 8001 \
    --host 0.0.0.0 &

# Brief pause so whisper is ready before the Python server starts sending requests
sleep 2

echo "Starting echo-server (uvicorn) ..."
exec uvicorn server-socket:app --host 0.0.0.0 --port 8000
