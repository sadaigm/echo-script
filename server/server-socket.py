#!/usr/bin/env python3
import io
import os
import json
import sqlite3
import wave
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse, parse_qs

import asyncio
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

WHISPER_SERVER_URL = os.getenv("WHISPER_SERVER_URL", "http://127.0.0.1:8001/inference")
DB_PATH = os.getenv("ECHOSCRIPT_DB", "transcripts.db")


# --- persistence ---------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT,
                title TEXT,
                text TEXT,
                ai TEXT,
                created_at TEXT,
                updated_at TEXT,
                video_id TEXT
            )
            """
        )
        # Migrate older DBs that predate these columns
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(transcripts)").fetchall()}
        if "updated_at" not in cols:
            conn.execute("ALTER TABLE transcripts ADD COLUMN updated_at TEXT")
        if "video_id" not in cols:
            conn.execute("ALTER TABLE transcripts ADD COLUMN video_id TEXT")
        conn.commit()


def db_create_record(url: str, title: str, video_id: str) -> int:
    """Start a new transcript record (one per video visit)."""
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO transcripts (url, title, video_id, text, ai, created_at, updated_at) "
            "VALUES (?, ?, ?, '', '', ?, ?)",
            (url, title, video_id, now, now),
        )
        conn.commit()
        return cur.lastrowid


def db_append_text(record_id: int, text: str) -> None:
    """Append a transcript chunk to an existing record."""
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        conn.execute(
            "UPDATE transcripts SET text = text || ' ' || ?, updated_at = ? WHERE id = ?",
            (text, now, record_id),
        )
        conn.commit()


def db_update_title(record_id: int, title: str) -> None:
    """Update the title of an existing record (title arrives late from the SW)."""
    with get_db() as conn:
        conn.execute(
            "UPDATE transcripts SET title = ? WHERE id = ?",
            (title, record_id),
        )
        conn.commit()


def extract_video_id(url: str) -> str:
    """YouTube ?v= id when present, else the raw URL as a fallback id."""
    if not url:
        return ""
    try:
        q = parse_qs(urlparse(url).query)
        return q.get("v", [url])[0]
    except Exception:
        return url


# --- audio helpers -------------------------------------------------------

def pcm16_to_wav(pcm: bytes, framerate: int = 16000, channels: int = 1) -> bytes:
    """Wrap raw 16-bit little-endian PCM in a proper WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(framerate)
        w.writeframes(pcm)
    return buf.getvalue()


# --- app -----------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="EchoScript Server", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/transcripts")
def list_transcripts(url: Optional[str] = Query(default=None)):
    """All transcript records (one per video visit), most recently active first."""
    with get_db() as conn:
        if url:
            rows = conn.execute(
                "SELECT * FROM transcripts WHERE url = ? ORDER BY id DESC", (url,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM transcripts "
                "ORDER BY COALESCE(updated_at, created_at) DESC, id DESC"
            ).fetchall()
    return [dict(r) for r in rows]


@app.get("/transcripts/{item_id}")
def get_transcript(item_id: int):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM transcripts WHERE id = ?", (item_id,)
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return dict(row)


@app.delete("/transcripts")
def clear_transcripts(url: Optional[str] = Query(default=None)):
    with get_db() as conn:
        if url:
            conn.execute("DELETE FROM transcripts WHERE url = ?", (url,))
        else:
            conn.execute("DELETE FROM transcripts")
        conn.commit()
    return {"status": "cleared"}


@app.delete("/transcripts/{item_id}")
def delete_transcript(item_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM transcripts WHERE id = ?", (item_id,))
        conn.commit()
    return {"status": "deleted"}


@app.websocket("/api/stream-flow")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    # Initial source (from query params); updated by 'source' control frames mid-session.
    source_url = websocket.query_params.get("url", "")
    source_title = websocket.query_params.get("title", "")
    source_video_id = websocket.query_params.get("videoId", "") or extract_video_id(source_url)
    print(f"🚀 Chrome Extension connected. video_id={source_video_id!r} url={source_url!r}")

    # Per-connection record state. A new record is created whenever source_video_id changes.
    state = {"record_id": None, "current_video_id": None}

    ffmpeg_cmd = [
        "ffmpeg", "-f", "webm", "-i", "pipe:0",
        "-f", "s16le", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1", "-loglevel", "quiet", "pipe:1"
    ]

    ffmpeg_process = await asyncio.create_subprocess_exec(
        *ffmpeg_cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL
    )

    audio_buffer = bytearray()

    async def process_whisper(audio_payload: bytes, record_id: int):
        try:
            print(f"Forwarding {len(audio_payload)} bytes to whisper...")
            wav_payload = pcm16_to_wav(audio_payload)
            async with httpx.AsyncClient() as client:
                files = {'file': ('stream.wav', wav_payload, 'audio/wav')}
                response = await client.post(WHISPER_SERVER_URL, files=files, timeout=15.0)

                if response.status_code != 200:
                    print(f"⚠️ Whisper error: {response.text}")
                    return

                raw_text = response.json().get("text", "").strip()

            if not raw_text:
                return

            print(f"Captured Text: {raw_text}")
            await websocket.send_json({"type": "transcript", "text": raw_text})

            try:
                db_append_text(record_id, raw_text)
                print(f"   (appended to record id={record_id})")
            except Exception as db_err:
                print(f"DB append error: {db_err}")

        except Exception as err:
            print(f"Error inside processing flow: {err}")

    try:
        while True:
            # Low-level receive() so we can accept BOTH text control frames and binary audio.
            msg = await websocket.receive()

            # Starlette may deliver disconnect as a dict instead of raising.
            if msg.get("type") == "websocket.disconnect":
                break

            text_data = msg.get("text")
            bin_data = msg.get("bytes")

            # --- control frame (text): the source video changed mid-session ---
            if text_data is not None:
                try:
                    ctrl = json.loads(text_data)
                    if ctrl.get("type") == "source":
                        new_video_id = ctrl.get("videoId") or extract_video_id(ctrl.get("url", "")) or source_url
                        if ctrl.get("url"):
                            source_url = ctrl["url"]
                        if ctrl.get("title"):
                            source_title = ctrl["title"]
                        source_video_id = new_video_id
                        print(f"📹 source changed -> video_id={source_video_id!r} title={source_title!r}")
                        # Late title fixup: if the record was already created
                        # with a stale title, patch it now.
                        if ctrl.get("title") and state["record_id"] and source_video_id == state["current_video_id"]:
                            try:
                                db_update_title(state["record_id"], ctrl["title"])
                            except Exception:
                                pass
                except Exception as e:
                    print(f"bad control frame: {e}")
                continue

            if bin_data is None:
                continue

            # --- audio frame (binary) ---
            ffmpeg_process.stdin.write(bin_data)
            await ffmpeg_process.stdin.drain()

            pcm_data = await ffmpeg_process.stdout.read(32000)
            if pcm_data:
                audio_buffer.extend(pcm_data)

            if len(audio_buffer) >= 160000:
                payload_to_process = bytes(audio_buffer)
                audio_buffer.clear()

                # Decide record synchronously at cut time (no race with async whisper tasks).
                if source_video_id != state["current_video_id"]:
                    state["record_id"] = db_create_record(source_url, source_title, source_video_id)
                    state["current_video_id"] = source_video_id
                    print(f"   ➕ new record id={state['record_id']} (video_id={source_video_id!r})")

                asyncio.create_task(process_whisper(payload_to_process, state["record_id"]))

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
