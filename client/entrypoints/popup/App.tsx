import { useEffect, useState } from "react";
import "./App.css";

const LOG_PREFIX = "[Voice-to-Text Popup]";
const log = {
  info: (...args: any[]) => console.log(LOG_PREFIX, ...args),
  warn: (...args: any[]) => console.warn(LOG_PREFIX, ...args),
  error: (...args: any[]) => console.error(LOG_PREFIX, ...args),
  debug: (...args: any[]) => console.debug(LOG_PREFIX, ...args),
};

type WsProtocol = "ws" | "wss";

function App() {
  log.info("Popup component initialized");
  const [serverStatus, setServerStatus] = useState<"checking" | "online" | "offline">("checking");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverProtocol, setServerProtocol] = useState<WsProtocol>("ws");
  const [serverBase, setServerBase] = useState<string>("127.0.0.1:8020");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    // Load saved config on mount
    const chromeObj: any = (window as any).chrome;
    if (chromeObj?.storage?.local) {
      chromeObj.storage.local.get(["server_protocol", "server_base"], (res: { server_protocol?: WsProtocol; server_base?: string }) => {
        if (res.server_protocol) setServerProtocol(res.server_protocol);
        if (res.server_base) setServerBase(res.server_base);
        // After loading, check status
        setTimeout(checkServerStatus, 0);
      });
    } else {
      // Fallback: still try status with defaults
      setTimeout(checkServerStatus, 0);
    }
    const interval = setInterval(checkServerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const wsUrl = () => `${serverProtocol}://${serverBase}/asr`;

  const checkServerStatus = async () => {
    // Try opening a short-lived WebSocket to the configured endpoint
    const url = wsUrl();
    try {
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        let sock: WebSocket | null = null;
        try {
          sock = new WebSocket(url);
        } catch (e) {
          resolve(false);
          return;
        }
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { sock?.close(); } catch {}
          resolve(false);
        }, 2500);
        if (!sock) return resolve(false);
        sock.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { sock?.close(); } catch {}
          resolve(true);
        };
        sock.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        };
        sock.onclose = () => {
          // If it closes before onopen, treat as failure (handled by timeout/onerror)
        };
      });
      if (ok) {
        setServerStatus("online");
        setError(null);
      } else {
        setServerStatus("offline");
      }
    } catch {
      setServerStatus("offline");
    }
  };

 
  const testConnection = async () => {
    setIsLoading(true);
    setError(null);
    await checkServerStatus();
    setIsLoading(false);
    if (serverStatus === "offline") {
      setError("Server not reachable. Check your server settings and connectivity.");
    }
  };

  const saveSettings = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const chromeObj: any = (window as any).chrome;
      if (chromeObj?.storage?.local) {
        await new Promise<void>((resolve) => {
          chromeObj.storage.local.set(
            {
              server_protocol: serverProtocol,
              server_base: serverBase,
            },
            () => resolve()
          );
        });
      }
      await checkServerStatus();
    } catch (e) {
      setError("Failed to save settings.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-icon" aria-hidden>
            🎤
          </div>
          <div className="brand-text">
            <h1 className="title">Voice to Text</h1>
            <p className="subtitle">Local streaming transcription with auto-stop on silence</p>
          </div>
        </div>
      </header>

      <main className="main">
        <section className="card">
          <div className="section-header">
            <h2>Server Status</h2>
            <span
              className={`status-pill ${
                serverStatus === "online" ? "status-success" : 
                serverStatus === "offline" ? "status-error" : "status-neutral"
              }`}
              role="status"
              aria-live="polite"
            >
              {serverStatus === "online" ? "Online" : 
               serverStatus === "offline" ? "Offline" : "Checking..."}
            </span>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Endpoint: <code>{wsUrl()}</code>
          </p>
          
          {serverStatus === "offline" && (
            <div className="server-help">
              <p className="help-text">Start the local server to enable transcription:</p>
              <code className="code-block">cd server && .venv\Scripts\python.exe app.py</code>
              <button className="btn ghost small" onClick={testConnection} disabled={isLoading}>
                {isLoading ? <span className="spinner" /> : "Test Connection"}
              </button>
            </div>
          )}
          
          {serverStatus === "online" && (
            <div className="tips">
              <div className="tip">
                <span className="tip-icon" aria-hidden>✨</span>
                Click the mic button next to any input field
              </div>
              <div className="tip">
                <span className="tip-icon" aria-hidden>🔇</span>
                Auto-stops after 3 seconds of silence
              </div>
              <div className="tip">
                <span className="tip-icon" aria-hidden>⚡</span>
                See live partials as you speak
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <div className="section-header">
            <h2>Server Settings</h2>
          </div>
          <div className="form">
            <div className="form-row">
              <label htmlFor="protocol">Protocol</label>
              <select
                id="protocol"
                value={serverProtocol}
                onChange={(e) => setServerProtocol(e.target.value as WsProtocol)}
              >
                <option value="ws">ws (insecure)</option>
                <option value="wss">wss (TLS)</option>
              </select>
            </div>
            <div className="form-row">
              <label htmlFor="base">Base (host:port)</label>
              <input
                id="base"
                type="text"
                placeholder="your-domain.com:8020"
                value={serverBase}
                onChange={(e) => setServerBase(e.target.value)}
              />
            </div>
            <div className="form-row" style={{ marginTop: 8 }}>
              <button className="btn" onClick={saveSettings} disabled={isSaving}>
                {isSaving ? <span className="spinner" /> : "Save Settings"}
              </button>
              <button className="btn ghost" onClick={testConnection} disabled={isLoading} style={{ marginLeft: 8 }}>
                {isLoading ? <span className="spinner" /> : "Test Connection"}
              </button>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              Use wss for HTTPS domains or behind a reverse proxy with TLS.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="section-header">
            <h2>Features</h2>
          </div>
          
          <div className="feature-grid">
            <div className="feature">
              <div className="feature-icon">🎯</div>
              <div className="feature-text">
                <strong>Smart Detection</strong>
                <span>Works with inputs, textareas, and contenteditable</span>
              </div>
            </div>
            <div className="feature">
              <div className="feature-icon">⚡</div>
              <div className="feature-text">
                <strong>Live Streaming</strong>
                <span>See transcription as you speak</span>
              </div>
            </div>
            <div className="feature">
              <div className="feature-icon">🔇</div>
              <div className="feature-text">
                <strong>Auto-Stop</strong>
                <span>Stops after 3 seconds of silence</span>
              </div>
            </div>
            <div className="feature">
              <div className="feature-icon">🔒</div>
              <div className="feature-text">
                <strong>Local Processing</strong>
                <span>No API keys, runs on your machine</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer-content">
          <p className="footnote">Local Whisper • No API required</p>
          {error && (
            <p className="error-footer" role="alert">
              {error}
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;