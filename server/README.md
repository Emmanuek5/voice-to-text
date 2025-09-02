# Voice-to-Text Server (FastAPI + faster-whisper)

FastAPI WebSocket server that streams microphone audio from the browser extension to a local Whisper ASR model and returns partial and final transcriptions.

## Features

- WebSocket endpoint `/asr` for real-time streaming transcription
- Partial results while speaking; final result on stop or extended silence
- Auto device selection (`CUDA` if available, else CPU)
- Health check at `/health`

## Requirements

- Python 3.10+
- Windows/Linux/macOS
- Optional: NVIDIA GPU + CUDA/cuBLAS for faster transcription

## Installation

```bash
cd server
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
# source .venv/bin/activate

pip install -r requirements.txt
```

## Running

```bash
# Default host:port 0.0.0.0:8020 (accessible on LAN)
python app.py

# Or customize via env
set HOST=0.0.0.0 & set PORT=8020 & set WHISPER_MODEL=base & set LANG=en & set SILENCE_SECONDS=3.0 & set SILENCE_RMS=200.0 && python app.py  # Windows
# HOST=0.0.0.0 PORT=8020 WHISPER_MODEL=base SILENCE_SECONDS=3.0 SILENCE_RMS=200.0 python app.py                      # macOS/Linux
```

The server starts on `http://127.0.0.1:<PORT>` and exposes:

- `GET /health` – returns `{ status: "ok", model: "<name>" }`
- `WS /asr` – streaming endpoint (see protocol below)

## Configuration (env vars)

- `PORT` (default: `8020`): HTTP/WS port
- `WHISPER_MODEL` (default: `base`): `tiny`, `base`, `small`, `medium`, `large-v3`, etc.
- `LANG` (default: `en`): ISO language code used for transcription
- `SILENCE_SECONDS` (default: `3.0`): Auto-stop after this many seconds of silence
- `SILENCE_RMS` (default: `200.0`): RMS threshold for silence in Int16 units

## WebSocket Protocol

Connect to `ws://<host>:<port>/asr`.

Messages from client:

- Text JSON control messages
  - `{"type":"start","sampleRate":16000,"lang":"en"}`
    - `sampleRate` must be `16000`
    - `lang` optional; defaults to `LANG`
  - `{"type":"stop"}` – request final decode and close
  - `{"type":"cancel"}` – cancel session
- Binary audio messages
  - Int16LE PCM chunks, downsampled to 16 kHz mono

Messages from server:

- `{"type":"ready"}` – initial handshake
- `{"type":"started","sampleRate":16000,"lang":"en"}` – after `start`
- `{"type":"partial","text":"..."}` – partial transcription (throttled)
- `{"type":"final","text":"..."}` – final transcription
- `{"type":"error","message":"..."}` – error description

## Performance Tips

- Prefer `WHISPER_MODEL=small` or `medium` on GPU for better accuracy/latency
- CPU-only machines run best with `tiny`/`base`
- Lower `SILENCE_RMS` if speech is soft; increase if noisy environment

## Troubleshooting

- Cannot connect from extension
  - Ensure the server is running on `127.0.0.1:8020` (or your configured host:port)
  - Check firewall rules for the chosen port
  - Verify extension host permissions include your host/port
- `unsupported_sample_rate` errors
  - The content script streams at 16 kHz. Keep `sampleRate=16000`.
- Slow or stuttering transcription
  - Verify GPU is detected; set `device="auto"` is used internally. Install CUDA/cuBLAS if available.

## License

MIT (project-level license applies)

## Docker

Build the image (defaults `WHISPER_MODEL=small`):

```bash
cd server
docker build -t voice-to-text-server .
```

Run the container:

```bash
docker run --rm -p 8020:8020 \
  -e PORT=8020 \
  -e WHISPER_MODEL=small \
  -e LANG=en \
  -e SILENCE_SECONDS=3.0 \
  -e SILENCE_RMS=200.0 \
  --name vtt-asr voice-to-text-server
```

Notes:

- CPU-only works out of the box. For GPU acceleration, use a CUDA-enabled base and `--gpus all` (requires NVIDIA Container Toolkit) and ensure `faster-whisper` wheels match your CUDA setup.
- Expose `8020` (or your chosen `PORT`) to the host so the extension can connect.
