#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-latest}"
IMAGE="echo-script:${VERSION}"
MODEL="${WHISPER_MODEL:-base.en}"

# Download model if not already present
MODEL_FILE="$SCRIPT_DIR/whisper-cpp-server/models/ggml-${MODEL}.bin"
if [ ! -f "$MODEL_FILE" ]; then
    echo "==> Downloading model: $MODEL"
    bash "$SCRIPT_DIR/whisper-cpp-server/models/download-ggml-model.sh" \
        "$MODEL" "$SCRIPT_DIR/whisper-cpp-server/models"
else
    echo "==> Model ggml-${MODEL}.bin already exists, skipping download."
fi

# Build and tag the image
echo "==> Building Docker image: $IMAGE"
docker build -t "$IMAGE" "$SCRIPT_DIR"

echo ""
echo "==> Done! Image: $IMAGE"
echo "    Deploy:  docker compose up -d"
