# Voice-to-Text (Browser Extension + Local ASR Server)

Voice input anywhere on the web. This project pairs a browser extension (WXT + React) with a local FastAPI server running a Whisper ASR model (via faster-whisper). Click the floating mic next to inputs/editors to dictate text; see live partials and a final transcript.

## Project Structure

```
voice-to-text/
├─ client/   # WXT + React extension (content script, popup, background)
└─ server/   # FastAPI + faster-whisper WebSocket server
```

## Quickstart

### 1) Start the ASR Server

```bash
cd server
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
# source .venv/bin/activate
pip install -r requirements.txt
python app.py  # starts on 127.0.0.1:8020 by default
```

Environment options:

- PORT (default 8020)
- WHISPER_MODEL (e.g. tiny, base, small, medium, large-v3; default base)
- LANG (default en)
- SILENCE_SECONDS (default 3.0)
- SILENCE_RMS (default 200.0)

Health check: GET http://127.0.0.1:8020/health

### 2) Load/Run the Extension

```bash
cd client
npm install
npm run dev  # or: npm run build
```

Load the extension per the WXT instructions shown in the terminal, or load `.output/chrome-mv3` as an unpacked extension after `npm run build`.

### 3) Use It

- Open the popup and confirm the server status is Online
- Configure host/port and protocol (ws/wss) if needed
- Focus an input/textarea/editor, click the mic, and start speaking
- Auto-stops after a few seconds of silence

## Notes & Tips

- For best performance, use a GPU with WHISPER_MODEL=small or medium
- CPU-only machines run best with tiny/base
- If hosting the server remotely, prefer wss behind HTTPS and add your domain to the extension host permissions

## Troubleshooting

- Extension says Offline
  - Ensure server is running on 127.0.0.1:8020 (or configured host:port)
  - Firewall/port issues can block WebSocket connections
- unsupported_sample_rate errors
  - Client streams 16 kHz Int16 PCM. Keep sampleRate=16000 in the start message (already handled by the client).

## License

MIT

## Links

- Client README: client/README.md
- Server README: server/README.md
