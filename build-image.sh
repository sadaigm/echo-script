#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-latest}"
IMAGE="echo-script:${VERSION}"

WHISPER_VERSION="${WHISPER_VERSION:-v1.9.1}"
MODEL="${WHISPER_MODEL:-base.en}"

WHISPER_DIR="$SCRIPT_DIR/whisper-cpp-server"
BIN_DIR="$WHISPER_DIR/whisper-bin-ubuntu-x64"
TARBALL="whisper-bin-ubuntu-x64.tar.gz"
URL="https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/${TARBALL}"

# --- 1. Download whisper binaries from GitHub release ---
if [ ! -d "$BIN_DIR" ] || [ -z "$(ls -A "$BIN_DIR" 2>/dev/null)" ]; then
    echo "==> Downloading whisper binaries: $WHISPER_VERSION"
    echo "    $URL"
    curl -L --fail --retry 3 -o "$WHISPER_DIR/$TARBALL" "$URL"
    tar -xzf "$WHISPER_DIR/$TARBALL" -C "$WHISPER_DIR"
    rm -f "$WHISPER_DIR/$TARBALL"
    echo "    Extracted to $BIN_DIR"
else
    echo "==> Whisper binaries already present, skipping download."
fi

# --- 2. Download model if not present ---
MODEL_FILE="$WHISPER_DIR/models/ggml-${MODEL}.bin"
if [ ! -f "$MODEL_FILE" ]; then
    echo "==> Downloading model: $MODEL"
    bash "$WHISPER_DIR/models/download-ggml-model.sh" \
        "$MODEL" "$WHISPER_DIR/models"
else
    echo "==> Model ggml-${MODEL}.bin already exists, skipping download."
fi

# --- 3. Build and tag the image ---
echo "==> Building Docker image: $IMAGE"
docker build -t "$IMAGE" "$SCRIPT_DIR"

echo ""
echo "==> Done! Image: $IMAGE"
echo "    Deploy:  docker compose up -d"
