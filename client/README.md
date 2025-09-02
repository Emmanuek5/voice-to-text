# Voice-to-Text Extension (Client)

React + WXT (Chrome MV3) browser extension that adds a floating mic next to editable fields and streams microphone audio to a local WebSocket ASR server for live transcription.

## Prerequisites

- Node 18+ and npm
- The ASR server running locally or remotely (see `../server/README.md`)

## Install

```bash
cd client
npm install
```

If `npm install` fails due to unknown local packages, remove any stray local `file:` deps in `package.json` (e.g. `"Voice-to-Text": "file:"`, `"wxt-react-starter": "file:"`).

## Development

Start WXT dev server:

```bash
npm run dev
```

Follow WXT instructions in the terminal to load the extension in your browser. Typically, open the printed URL or load the generated directory in your browser’s extensions page.

## Build

Create a production build into `.output/`:

```bash
npm run build
```

Then load `.output/chrome-mv3` (or the appropriate target) via Extensions → Developer mode → Load unpacked.

## Permissions & Hosts

The manifest requests:

- `storage` – to save server settings
- `activeTab` – safe default for content-scripts
  Host permissions include `http://127.0.0.1/*` and `http://localhost/*` for local development. Add your domain if hosting the server remotely.

## Server Configuration (Popup)

From the popup:

- Protocol: `ws` (local/insecure) or `wss` (TLS)
- Base (host:port): e.g. `127.0.0.1:8020` or `asr.example.com`

Saved in Chrome storage as:

- `server_protocol` (default: `ws`)
- `server_base` (default: `127.0.0.1:8020`)

The content script connects to `${protocol}://${base}/asr`.

If hosting remotely, prefer `wss` behind HTTPS or a reverse proxy that terminates TLS and forwards `/asr` to the ASR server.

## Usage

1. Ensure the server is Online (popup shows status). Use Test Connection if needed.
2. Focus an input/textarea/editor on any page. A mic button appears nearby.
3. Click the mic to start streaming. Live partials insert as you speak.
4. Click again to stop; the final transcript replaces the partial.

Supported editors: inputs, textareas, generic `contenteditable`, ChatGPT/ProseMirror-like editors.

## Troubleshooting

- Server Offline in popup
  - Start the server: `cd ../server && python app.py` (or see server README)
  - Check firewall/port and host permissions in `wxt.config.ts`
- No mic permission
  - The browser will prompt. If blocked, allow mic access for the site.
- Text doesn’t appear in complex editors
  - The content script includes fallbacks; if an editor is unsupported, open an issue describing the site/editor.
