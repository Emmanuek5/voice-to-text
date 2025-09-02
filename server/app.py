import os
import asyncio
import json
import time
import logging
from typing import Optional, List

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, File, UploadFile, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


APP_PORT = int(os.getenv("PORT", "8020"))
APP_HOST = os.getenv("HOST", "0.0.0.0")
# tiny, base, small, medium, large-v3, etc.
MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")
LANG_DEFAULT = os.getenv("LANG", "en")
SAMPLE_RATE = 16000  # expected input sample rate (Hz)
# throttle partial decoding (higher for remote)
PARTIAL_INTERVAL_SEC = float(os.getenv("PARTIAL_INTERVAL_SEC", "1.5"))
# decode on the last N seconds for partials
PARTIAL_WINDOW_SEC = float(os.getenv("PARTIAL_WINDOW_SEC", "6.0"))
# stop after this much silence
SILENCE_SECONDS = float(os.getenv("SILENCE_SECONDS", "3.0"))
# RMS threshold for silence in Int16 units
SILENCE_RMS = float(os.getenv("SILENCE_RMS", "200.0"))

app = FastAPI(title="Voice-to-Text Streaming ASR")

# Optional CORS for HTTP endpoints (not needed for WS, but harmless)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_model: Optional[WhisperModel] = None
_model_lock = asyncio.Lock()


@app.on_event("startup")
async def startup_event():
    """Preload the model on startup to reduce first-request latency"""
    logger.info(f"Preloading Whisper model: {MODEL_SIZE}")
    start_time = time.time()
    await get_model()
    load_time = time.time() - start_time
    logger.info(f"Model loaded in {load_time:.2f}s")


async def get_model() -> WhisperModel:
    global _model
    if _model is None:
        async with _model_lock:
            if _model is None:
                # device="auto" will use CUDA if available, else CPU
                _model = WhisperModel(MODEL_SIZE, device="auto")
    return _model


@app.get("/health")
async def health():
    return JSONResponse({"status": "ok", "model": MODEL_SIZE})


@app.post("/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    lang: str = Form(default=LANG_DEFAULT)
):
    """HTTP endpoint for non-streaming transcription"""
    try:
        start_time = time.time()

        # Read audio data
        audio_data = await audio.read()
        logger.info(
            f"Received audio file: {len(audio_data)} bytes, content-type: {audio.content_type}")

        # Convert to numpy array (expecting Int16LE PCM)
        audio_np = np.frombuffer(audio_data, dtype=np.int16)

        # Convert to float32 for Whisper
        audio_f32 = (audio_np.astype(np.float32) / 32768.0).copy()

        # Transcribe
        model = await get_model()
        segments, info = model.transcribe(
            audio_f32,
            language=lang if lang != "auto" else None,
            vad_filter=True,
            without_timestamps=True
        )

        text = "".join(seg.text for seg in segments).strip()
        processing_time = time.time() - start_time

        logger.info(
            f"HTTP transcribe: {processing_time:.3f}s, lang: {lang}, text: '{text[:100]}'")

        return JSONResponse({
            "text": text,
            "language": info.language if hasattr(info, 'language') else lang,
            "processing_time": round(processing_time, 3)
        })

    except Exception as e:
        logger.error(f"HTTP transcription failed: {e}")
        return JSONResponse(
            {"error": str(e)},
            status_code=500
        )


@app.websocket("/asr")
async def ws_asr(ws: WebSocket):
    await ws.accept()
    logger.info("WebSocket connection established")

    # Session state
    lang = LANG_DEFAULT
    buffer = np.zeros((0,), dtype=np.int16)
    running = True
    last_partial_ts = 0.0
    started = False
    silent_samples = 0  # count consecutive silent samples
    session_start = time.time()

    async def decode_partial():
        nonlocal last_partial_ts
        now = asyncio.get_event_loop().time()
        if now - last_partial_ts < PARTIAL_INTERVAL_SEC:
            return
        last_partial_ts = now

        # Use only the last PARTIAL_WINDOW_SEC seconds for partial decoding
        samples_window = int(PARTIAL_WINDOW_SEC * SAMPLE_RATE)
        if buffer.size <= 0:
            return
        chunk = buffer[-samples_window:]
        if chunk.size < int(0.5 * SAMPLE_RATE):  # require at least 0.5 sec
            return
        audio_f32 = (chunk.astype(np.float32) / 32768.0).copy()
        try:
            decode_start = time.time()
            model = await get_model()
            # Use no_speech_threshold to reduce hallucinations; disable vad_filter for speed
            segments, info = model.transcribe(
                audio_f32, language=lang, vad_filter=False, without_timestamps=True)
            text = "".join(seg.text for seg in segments).strip()
            decode_time = time.time() - decode_start
            if text:
                logger.debug(
                    f"Partial decode: {decode_time:.3f}s, text: '{text[:50]}...'")
                await ws.send_text(json.dumps({"type": "partial", "text": text}))
        except Exception as e:
            logger.error(f"Partial decode failed: {e}")
            await ws.send_text(json.dumps({"type": "error", "message": f"partial_decode_failed: {e}"}))

    async def decode_final():
        if buffer.size == 0:
            await ws.send_text(json.dumps({"type": "final", "text": ""}))
            return
        audio_f32 = (buffer.astype(np.float32) / 32768.0).copy()
        try:
            decode_start = time.time()
            model = await get_model()
            segments, info = model.transcribe(
                audio_f32, language=lang, vad_filter=True, without_timestamps=True)
            text = "".join(seg.text for seg in segments).strip()
            decode_time = time.time() - decode_start
            session_time = time.time() - session_start
            logger.info(
                f"Final decode: {decode_time:.3f}s, session: {session_time:.1f}s, text: '{text[:100]}'")
            await ws.send_text(json.dumps({"type": "final", "text": text}))
        except Exception as e:
            logger.error(f"Final decode failed: {e}")
            await ws.send_text(json.dumps({"type": "error", "message": f"final_decode_failed: {e}"}))

    await ws.send_text(json.dumps({"type": "ready"}))

    try:
        while running:
            msg = await ws.receive()
            mtype = msg.get("type")
            if mtype == "websocket.disconnect":
                break

            if "text" in msg and msg["text"] is not None:
                try:
                    data = json.loads(msg["text"])
                except Exception:
                    await ws.send_text(json.dumps({"type": "error", "message": "invalid_json"}))
                    continue

                dtype = data.get("type")
                if dtype == "start":
                    if started:
                        await ws.send_text(json.dumps({"type": "error", "message": "already_started"}))
                        continue
                    sr = int(data.get("sampleRate", SAMPLE_RATE))
                    if sr != SAMPLE_RATE:
                        await ws.send_text(json.dumps({"type": "error", "message": f"unsupported_sample_rate:{sr}"}))
                        await ws.close()
                        break
                    lang = data.get("lang", LANG_DEFAULT)
                    started = True
                    await ws.send_text(json.dumps({"type": "started", "sampleRate": SAMPLE_RATE, "lang": lang}))
                elif dtype == "stop":
                    await decode_final()
                    running = False
                    break
                elif dtype == "cancel":
                    running = False
                    break
                else:
                    await ws.send_text(json.dumps({"type": "error", "message": "unknown_control_message"}))

            elif "bytes" in msg and msg["bytes"] is not None:
                if not started:
                    await ws.send_text(json.dumps({"type": "error", "message": "not_started"}))
                    continue
                # Expect Int16LE PCM
                chunk = np.frombuffer(msg["bytes"], dtype=np.int16)
                if chunk.size == 0:
                    continue
                buffer = np.concatenate([buffer, chunk])
                # Silence detection based on RMS over incoming chunk
                # Convert to float32 to avoid overflow when squaring
                rms = float(np.sqrt(np.mean((chunk.astype(np.float32)) ** 2)))
                if rms < SILENCE_RMS:
                    silent_samples += chunk.size
                else:
                    silent_samples = 0

                if silent_samples >= int(SILENCE_SECONDS * SAMPLE_RATE):
                    # Auto-stop due to extended silence
                    await decode_final()
                    running = False
                    break
                # Schedule partial decode (throttled)
                await decode_partial()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_text(json.dumps({"type": "error", "message": f"server_exception: {e}"}))
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


# Entrypoint for `python app.py` (dev convenience)
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=APP_HOST, port=APP_PORT, reload=False)
