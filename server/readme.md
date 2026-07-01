You've put together a great foundation here. The logic flow from `background.js` -> `offscreen.js` -> `FastAPI` -> `ffmpeg` is structurally sound. However, if you run this code exactly as-is, you will run into a couple of critical bugs (specifically regarding blocking I/O and incorrect WebSocket endpoints).

Here are the fixes you need to apply to make this PoC work.

---

## 1. The FastAPI Blocking Bug Fix

In your current `server.py`, `ffmpeg_process.stdout.read(32000)` is a **blocking synchronous call** running inside an `async def` loop. Because FastAPI relies on a single-threaded event loop for async functions, this will freeze your WebSocket connection, preventing it from receiving new chunks seamlessly.

Furthermore, `subprocess.Popen` should be swapped for `asyncio.create_subprocess_exec` so you can use `await`.

Here is the corrected `server.py`:

```python
# server.py
import os
import asyncio
import httpx
import ollama
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI(title="WhisperFlow-Streaming-Gateway")

WHISPER_SERVER_URL = "http://127.0.0.1:8001/inference"
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
ollama_client = ollama.Client(host=OLLAMA_HOST)

# FIX: Ensure this matches the endpoint path used in your extension!
@app.websocket("/api/stream-flow")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🚀 Chrome Extension connected over WebSocket.")

    ffmpeg_cmd = [
        "ffmpeg", "-f", "webm", "-i", "pipe:0",
        "-f", "s16le", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1", "-loglevel", "quiet", "pipe:1"
    ]
    
    # FIX: Use asyncio subprocess to avoid blocking the event loop
    ffmpeg_process = await asyncio.create_subprocess_exec(
        *ffmpeg_cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL
    )

    audio_buffer = bytearray()
    
    async def process_whisper_and_ollama(audio_payload: bytes):
        try:
            print(f"Forwarding {len(audio_payload)} bytes to whisper...")
            async with httpx.AsyncClient() as client:
                files = {'file': ('stream.wav', audio_payload, 'audio/wav')}
                response = await client.post(WHISPER_SERVER_URL, files=files, timeout=15.0)
                
                if response.status_code != 200:
                    print(f"⚠️ Whisper error: {response.text}")
                    return

                raw_text = response.json().get("text", "").strip()

            if not raw_text:
                return

            print(f"Captured Text: {raw_text}")
            await websocket.send_json({"type": "transcript", "text": raw_text})

            # FIX: ollama-python client is synchronous. Run it in an executor so it doesn't block!
            loop = asyncio.get_event_loop()
            llm_payload = await loop.run_in_executor(
                None, 
                lambda: ollama_client.generate(
                    model="qwen3:4b", 
                    prompt=f"Clean up this text if needed, then reply intelligently: {raw_text}"
                )
            )
            
            ai_response = llm_payload.get("response", "")
            await websocket.send_json({"type": "ai_response", "text": ai_response})

        except Exception as err:
            print(f"Error inside processing flow: {err}")

    try:
        while True:
            webm_chunk = await websocket.receive_bytes()
            
            # Write to ffmpeg asynchronously
            ffmpeg_process.stdin.write(webm_chunk)
            await ffmpeg_process.stdin.drain()
            
            # FIX: Non-blocking read from stdout
            # 1 second of 16kHz 16-bit mono PCM = 32000 bytes
            pcm_data = await ffmpeg_process.stdout.read(32000)
            if pcm_data:
                audio_buffer.extend(pcm_data)

            # Every ~5 seconds trigger inference
            if len(audio_buffer) >= 160000:
                payload_to_process = bytes(audio_buffer)
                audio_buffer.clear()
                asyncio.create_task(process_whisper_and_ollama(payload_to_process))

    except WebSocketDisconnect:
        print("🛑 Chrome Extension disconnected.")
    except Exception as e:
        print(f"Server Error: {e}")
    finally:
        if ffmpeg_process:
            try:
                ffmpeg_process.stdin.close()
                ffmpeg_process.terminate()
            except Exception:
                pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

```

---

## 2. Extension Alignment Fixes

### Endpoint Mismatch

In `server.py` you defined the route as `@app.websocket("/api/stream-flow")`, but in `offscreen.js` you wrote:

```javascript
ws = new WebSocket("ws://YOUR_API_IP_OR_TUNNEL:8000/api/stream-transcribe");

```

> **Action:** Change `stream-transcribe` to `stream-flow` in your `offscreen.js` file so it connects properly.

### Creating the Missing `offscreen.html`

For `chrome.offscreen.createDocument` to work, the HTML file **must actually exist** in your extension directory.

Create `offscreen.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="offscreen.js"></script>
</head>
<body>
</body>
</html>

```

### Missing Popup or Action UI

Your `manifest.json` declares an `"action": { "default_popup": "popup.html" }`. However, in `background.js` you are listening to `chrome.action.onClicked.addListener`.

**Note:** If a `default_popup` is defined, the `onClicked` event listener in your background script will *never* fire when you click the extension icon—it will just open the empty popup instead.

If you want the pipeline to trigger immediately when clicking the extension badge, **remove** the `"action"` block or delete `"default_popup"` from your `manifest.json`.

---

### Ready to Run

1. Spin up your Whisper daemon on port `8001`.
2. Start Ollama (`ollama run qwen3:4b`).
3. Run `python server.py`.
4. Load your extension directory into Chrome (`chrome://extensions` -> Developer Mode -> Load unpacked).
5. Click your extension icon on any tab playing audio!