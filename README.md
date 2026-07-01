# EchoScript

Real-time speech-to-text for browser tabs. Captures audio from any tab (YouTube, meetings, etc.) via a Chrome extension, transcribes it with a local whisper.cpp server, and stores transcripts in SQLite.

## Architecture

```
Chrome Extension                Python Server (FastAPI)           Whisper Server
┌─────────────┐   WebSocket   ┌──────────────────────┐   HTTP   ┌────────────────┐
│ tabCapture  │ ──────────── │  :8000               │ ──────── │  :8001         │
│ offscreen   │  binary audio │  ffmpeg → PCM → WAV  │  WAV     │  ggml-base.en  │
│ popup       │ ──────────── │  SQLite transcripts  │ ──────── │  whisper-cpp   │
└─────────────┘               └──────────────────────┘  text    └────────────────┘
```

Both servers run inside a **single Docker container**.

## Prerequisites

- Docker + Docker Compose
- Chrome / Chromium browser

## Project Structure

```
echo-script/
├── build-image.sh                # Downloads binaries + model, builds Docker image
├── docker-compose.yml            # Deploys the pre-built image
├── Dockerfile                    # Single image: python-slim + ffmpeg + whisper
├── entrypoint.sh                 # Starts whisper-server, then uvicorn
├── echo-script-chrome-ext/       # Chrome extension (load unpacked)
│   ├── manifest.json
│   ├── background.js
│   ├── offscreen.js / offscreen.html
│   ├── popup.js / popup.html
│   ├── manage.js / manage.html
├── server/
│   ├── server-socket.py          # FastAPI WebSocket + REST server
│   └── requirements.txt
└── whisper-cpp-server/
    ├── models/
    │   ├── download-ggml-model.sh
    │   └── ggml-base.en.bin
    └── whisper-bin-ubuntu-x64/   # Prebuilt binaries (auto-downloaded)
```

## Step 1 — Build the Docker Image

```bash
cd echo-script
chmod +x build-image.sh
./build-image.sh
```

This script will:
1. Download whisper.cpp prebuilt binaries (`v1.9.1`) from GitHub releases
2. Download the `base.en` model if not already present
3. Build and tag the image as `echo-script:latest`

Options:
```bash
# Pin a version tag
./build-image.sh 1.0.0        # → echo-script:1.0.0

# Use a different whisper version
WHISPER_VERSION=v1.9.1 ./build-image.sh

# Use a different model (must be a valid whisper model name)
WHISPER_MODEL=small.en ./build-image.sh
```

## Step 2 — Deploy with Docker Compose

```bash
docker compose up -d
```

This starts the container with:
- **Port 8000** → Python server (WebSocket + REST API)
- **Port 18001** → Whisper server (direct access for debugging)
- SQLite database persisted in a Docker volume (`/data/transcripts.db`)

Check logs:
```bash
docker compose logs -f
```

Verify it's running:
```bash
curl http://localhost:8000/transcripts      # Python API
curl http://localhost:18001/health           # Whisper direct
```

## Step 3 — Load the Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `echo-script/echo-script-chrome-ext/` directory
5. The EchoScript icon should appear in your toolbar

## Step 4 — Use It

1. Open a tab with audio (YouTube video, meeting, podcast, etc.)
2. Click the EchoScript extension icon
3. The extension captures tab audio and streams it to the server
4. Transcripts appear in real-time in the popup
5. Transcripts are saved per-video in SQLite

To stop capturing, click the icon again.

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/transcripts` | List all transcripts (newest first) |
| `GET` | `/transcripts?url=<url>` | Filter transcripts by URL |
| `GET` | `/transcripts/{id}` | Get a single transcript |
| `DELETE` | `/transcripts` | Clear all (or filter by `?url=`) |
| `DELETE` | `/transcripts/{id}` | Delete one transcript |

WebSocket endpoint: `ws://localhost:8000/api/stream-flow`

## Configuration

All configuration is via environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_MODEL` | `base.en` | Model file to load (without `ggml-` prefix and `.bin` suffix) |
| `ECHOSCRIPT_DB` | `/data/transcripts.db` | SQLite database path |
| `WHISPER_SERVER_URL` | `http://127.0.0.1:8001/inference` | Whisper inference endpoint (set automatically inside container) |

## Available Models

Change `WHISPER_MODEL` in `docker-compose.yml`, then rebuild:

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| `tiny.en` | ~75 MB | Fastest | Basic |
| `base.en` | ~142 MB | Fast | Good (default) |
| `small.en` | ~466 MB | Medium | Better |
| `medium.en` | ~1.5 GB | Slow | Best English |

Rebuild after changing the model:
```bash
WHISPER_MODEL=small.en ./build-image.sh
docker compose up -d
```

## Troubleshooting

**Container won't start**
```bash
docker compose logs echo-script
```

**Whisper server not responding**
```bash
curl http://localhost:18001/health
docker compose exec echo-script ls /app/models/
```

**Chrome extension can't connect**
- Verify the server is running: `curl http://localhost:8000/transcripts`
- Check `host_permissions` in `manifest.json` matches your server address
- The extension defaults to `ws://localhost:8000/api/stream-flow`

**No transcription output**
- Make sure the tab is actually playing audio
- Check server logs for ffmpeg or whisper errors
- Try a larger model for better accuracy

**Rebuild from scratch**
```bash
docker compose down
rm -rf whisper-cpp-server/whisper-bin-ubuntu-x64
./build-image.sh
docker compose up -d
```

## Stop / Clean Up

```bash
docker compose down              # stop containers
docker compose down -v           # stop + delete transcript database
```
