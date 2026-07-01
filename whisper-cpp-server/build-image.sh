#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL="${1:-base.en}"

# Download model if not already present
if [ ! -f "$SCRIPT_DIR/models/ggml-$MODEL.bin" ]; then
    echo "==> Downloading model: $MODEL"
    bash "$SCRIPT_DIR/models/download-ggml-model.sh" "$MODEL" "$SCRIPT_DIR/models"
else
    echo "==> Model ggml-$MODEL.bin already exists, skipping download."
fi

# Build the Docker image
echo "==> Building Docker image: whisper-cpp-server"
docker build -t whisper-cpp-server "$SCRIPT_DIR"

echo ""
echo "==> Build complete!"
echo "    Run:  docker run -d -p 18001:8001 --name whisper-server whisper-cpp-server"
echo "    Test: curl http://localhost:18001/health"
