// content-script.ts
// Mic button content script with top-entry, high-visibility toasts.
// Errors and success messages both use the toast with distinct styles.

const LOG_PREFIX = "[Voice-to-Text]";
const log = {
  info: (...args: any[]) => console.log(LOG_PREFIX, ...args),
  warn: (...args: any[]) => console.warn(LOG_PREFIX, ...args),
  error: (...args: any[]) => console.error(LOG_PREFIX, ...args),
  debug: (...args: any[]) => console.debug(LOG_PREFIX, ...args),
};

// Streaming ASR server config (user-configurable via popup; falls back to localhost)
const DEFAULT_SERVER_BASE = "127.0.0.1:8020";
const DEFAULT_SERVER_PROTOCOL: "ws" | "wss" = "ws";
const STREAM_SAMPLE_RATE = 16000;

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    log.info("Content script initialized on:", window.location.href);
    // State
    let micBtn: HTMLButtonElement | null = null;
    let currentEl:
      | HTMLInputElement
      | HTMLTextAreaElement
      | (HTMLElement & { isContentEditable?: boolean })
      | null = null;

    let isRecording = false;
    // Streaming capture + WS
    let ws: WebSocket | null = null;
    let audioCtx: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let procNode: ScriptProcessorNode | null = null;
    let micStream: MediaStream | null = null;

    // Live insertion tracking
    let liveStartIdx: number | null = null;
    let livePrevLen = 0;
    let liveNode: Node | null = null;

    // Partials handling
    let lastPartial: string = "";
    let lastPartialTs = 0;
    const PARTIAL_DEBOUNCE_MS = 250;
    const PARTIAL_MIN_CHARS = 3;

    // Toast
    let toastEl: HTMLDivElement | null = null;
    let toastTimer: number | null = null;

    // Style constants
    const STYLE_ID = "vt-mic-style";
    const BTN_SIZE = 40; // px
    const BTN_OFFSET_X = 8;
    const BTN_OFFSET_Y = 8;

    injectStyles();

    // Utilities
    function isEditable(el: Element | null): boolean {
      if (!el || !(el instanceof HTMLElement)) return false;

      const tag = el.tagName;
      const editable =
        el.isContentEditable ||
        el.getAttribute("contenteditable") === "true" ||
        tag === "TEXTAREA" ||
        (tag === "INPUT" &&
          ["text", "search", "url", "email", "tel", "number"].includes(
            (el as HTMLInputElement).type
          )) ||
        // Special case for ChatGPT and similar ProseMirror editors
        (el.classList.contains("ProseMirror") || el.id === "prompt-textarea");

      if (!editable) return false;

      // Exclude disabled, readonly, hidden, password
      if (tag === "INPUT" && (el as HTMLInputElement).type === "password") {
        return false;
      }
      const cs = window.getComputedStyle(el);
      if (
        cs.visibility === "hidden" ||
        cs.display === "none" ||
        (el as HTMLInputElement | HTMLTextAreaElement).readOnly ||
        (el as HTMLInputElement | HTMLTextAreaElement).disabled
      ) {
        return false;
      }

      return true;
    }

    function ensureMicBtn() {
      if (micBtn) {
        log.debug("ensureMicBtn: button already exists");
        return;
      }
      log.info("Creating microphone button");
      micBtn = document.createElement("button");
      micBtn.type = "button";
      micBtn.className = "vt-mic";
      micBtn.title = "Click to start recording";
      micBtn.setAttribute("aria-label", "Start voice input");
      micBtn.style.display = "none";
      micBtn.tabIndex = -1; // do not take focus
      micBtn.innerHTML = "🎤";
      document.body.appendChild(micBtn);

      // Prevent the mic button from stealing focus from the input
      micBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });

      micBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        log.info("Microphone button clicked", { isRecording, currentEl: currentEl?.tagName });
        
        if (!currentEl) {
          log.warn("No current element when mic button clicked");
          return;
        }

        if (currentEl instanceof HTMLElement) currentEl.focus();

        if (isRecording) {
          log.info("Stopping recording");
          stopRecording();
        } else {
          log.info("Starting recording");
          startRecording();
        }

        requestAnimationFrame(() => {
          if (currentEl) positionMic(currentEl as HTMLElement);
        });
      });
    }

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        .vt-mic {
          position: absolute;
          z-index: 2147483647;
          width: ${BTN_SIZE}px;
          height: ${BTN_SIZE}px;
          border-radius: 50%;
          border: 1px solid rgba(99, 102, 241, 0.5);
          background: #ffffff;
          color: #111827;
          box-shadow: 0 6px 16px rgba(0,0,0,0.18);
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform .12s ease, background .15s ease, border .15s ease, opacity .15s ease;
          user-select: none;
        }
        .vt-mic:hover {
          transform: translateY(-1px);
          background: #f8fafc;
        }
        .vt-mic:active {
          transform: translateY(0);
        }
        .vt-mic.is-recording {
          background: #ef4444;
          border-color: #ef4444;
          color: #fff;
          animation: vt-pulse 1.1s infinite;
        }
        .vt-mic.is-processing {
          background: #f59e0b;
          border-color: #f59e0b;
          color: #fff;
          animation: none;
        }
        @keyframes vt-pulse {
          0% { transform: scale(1); }
          50% { transform: scale(1.08); }
          100% { transform: scale(1); }
        }
        .vt-spinner {
          width: 16px;
          height: 16px;
          border: 2px solid rgba(255,255,255,0.5);
          border-top-color: #fff;
          border-radius: 50%;
          animation: vt-spin .8s linear infinite;
        }
        @keyframes vt-spin {
          to { transform: rotate(360deg); }
        }

        /* Top toast: highly visible, slides from the top, colored variants */
        .vt-toast {
          position: fixed;
          left: 50%;
          top: 14px;
          transform: translate(-50%, -12px);
          background: rgba(15, 23, 42, 0.98); /* slate-900-ish */
          color: #e5e7eb;
          border: 1px solid rgba(99, 102, 241, 0.5);
          padding: 10px 14px;
          border-radius: 12px;
          font-size: 13px;
          box-shadow: 0 16px 30px rgba(0,0,0,0.35);
          opacity: 0;
          pointer-events: none;
          transition: opacity .22s ease, transform .22s ease;
          z-index: 2147483647;
          max-width: min(88vw, 560px);
          text-align: left;
          display: grid;
          grid-auto-flow: column;
          align-items: center;
          gap: 10px;
          backdrop-filter: saturate(1.2) blur(4px);
        }
        .vt-toast.show {
          opacity: 1;
          transform: translate(-50%, 0);
        }
        .vt-toast .vt-toast-icon {
          font-size: 16px;
        }
        .vt-toast .vt-toast-text {
          line-height: 1.3;
          word-break: break-word;
        }
        .vt-toast.success {
          border-color: rgba(34,197,94,0.6);
          background: rgba(6,95,70,0.96);
          color: #e7fff5;
        }
        .vt-toast.error {
          border-color: rgba(239,68,68,0.6);
          background: rgba(127,29,29,0.96);
          color: #ffe7e7;
        }
        .vt-toast.info {
          border-color: rgba(99,102,241,0.6);
          background: rgba(30,27,75,0.96);
          color: #eef2ff;
        }
      `;
      document.head.appendChild(style);
    }

    type ToastKind = "success" | "error" | "info";

    function showToast(
      msg: string,
      kind: ToastKind = "info",
      timeout = 2600
    ) {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "vt-toast";
        // Structure: icon + text
        toastEl.innerHTML = `
          <span class="vt-toast-icon" aria-hidden="true">🔔</span>
          <span class="vt-toast-text"></span>
        `;
        document.body.appendChild(toastEl);
      }
      const icon = toastEl.querySelector(
        ".vt-toast-icon"
      ) as HTMLSpanElement | null;
      const text = toastEl.querySelector(
        ".vt-toast-text"
      ) as HTMLSpanElement | null;

      // Set variant
      toastEl.classList.remove("success", "error", "info");
      toastEl.classList.add(kind);

      // Icon per kind
      if (icon) {
        icon.textContent = kind === "success" ? "✅" : kind === "error" ? "⚠️" : "🔔";
      }
      if (text) text.textContent = msg;

      toastEl.classList.add("show");
      if (toastTimer) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        toastEl?.classList.remove("show");
      }, timeout);
    }

    function positionMic(el: HTMLElement) {
      if (!micBtn) return;
      const rect = el.getBoundingClientRect();

      // Base position: near top-right of target
      let left =
        window.scrollX + rect.right + BTN_OFFSET_X - BTN_SIZE / 2 - 2;
      let top = window.scrollY + rect.top - BTN_OFFSET_Y;

      // Keep on-screen
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (left + BTN_SIZE > window.scrollX + vw - 4) {
        left = window.scrollX + rect.right - BTN_SIZE - 6;
      }
      if (left < window.scrollX + 4) {
        left = window.scrollX + rect.left + 4;
      }
      if (top < window.scrollY + 4) {
        top = window.scrollY + rect.top + 4;
      }
      if (top + BTN_SIZE > window.scrollY + vh - 4) {
        top = window.scrollY + rect.bottom - BTN_SIZE - 6;
      }

      micBtn.style.left = `${left}px`;
      micBtn.style.top = `${top}px`;
      micBtn.style.display = "flex";
      micBtn.style.opacity = "1";
    }

    function hideMic() {
      if (!micBtn) return;
      if (isRecording) return; // keep visible while recording
      micBtn.style.display = "none";
      micBtn.style.opacity = "0";
    }

    // Recording
    async function startRecording() {
      log.info("Attempting to start recording (streaming)");

      if (!navigator.mediaDevices) {
        log.error("Recording not supported in this browser");
        showToast("Recording not supported in this browser.", "error");
        return;
      }
      if (!currentEl || isRecording) {
        log.warn("Cannot start recording", { currentEl: !!currentEl, isRecording });
        return;
      }

      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        sourceNode = audioCtx.createMediaStreamSource(micStream);
        // Use ScriptProcessor for broad compatibility; buffer size 4096
        procNode = audioCtx.createScriptProcessor(4096, 1, 1);

        const wsOpen = await openWebSocket();
        if (!wsOpen) {
          throw new Error("WebSocket connection failed");
        }

        procNode.onaudioprocess = (e) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const down = downsampleFloat32(input, audioCtx!.sampleRate, STREAM_SAMPLE_RATE);
          if (!down || down.length === 0) return;
          const pcm = floatTo16BitPCM(down);
          ws.send(pcm.buffer);
        };

        sourceNode.connect(procNode);
        procNode.connect(audioCtx.destination);

        isRecording = true;
        setBtnRecording();
        showToast("Recording… Click the button to stop.", "info", 1800);

        if (currentEl instanceof HTMLElement) currentEl.focus();
        requestAnimationFrame(() => {
          if (currentEl) positionMic(currentEl as HTMLElement);
        });
      } catch (err: any) {
        log.error("Failed to start recording:", err);
        if (err && err.name === "NotAllowedError") {
          showToast("Microphone permission denied.", "error");
        } else if (err && err.name === "NotFoundError") {
          showToast("No microphone found.", "error");
        } else {
          showToast("Failed to start recording.", "error");
        }
        await cleanupStreaming(true);
        resetBtn();
      }
    }

    function stopRecording() {
      if (!isRecording) return;
      isRecording = false;
      setBtnProcessing();
      showToast("Transcribing…", "info", 3200);
      // Signal stop to server; final will arrive then we cleanup
      try {
        ws?.send(JSON.stringify({ type: "stop" }));
      } catch {}
      // Audio graph can be stopped immediately to avoid extra capture
      cleanupAudioGraph();
    }

    function setBtnRecording() {
      if (!micBtn) return;
      micBtn.classList.add("is-recording");
      micBtn.classList.remove("is-processing");
      micBtn.innerHTML = "⏹️";
      micBtn.title = "Click to stop recording";
      micBtn.setAttribute("aria-label", "Stop recording");
    }

    function setBtnProcessing() {
      if (!micBtn) return;
      micBtn.classList.remove("is-recording");
      micBtn.classList.add("is-processing");
      micBtn.innerHTML = `<span class="vt-spinner" aria-hidden="true"></span>`;
      micBtn.title = "Transcribing...";
      micBtn.setAttribute("aria-label", "Transcribing");
    }

    function resetBtn() {
      if (!micBtn) return;
      micBtn.classList.remove("is-recording", "is-processing");
      micBtn.innerHTML = "🎤";
      micBtn.title = "Click to start recording";
      micBtn.setAttribute("aria-label", "Start voice input");
    }

    // WebSocket streaming helpers
    async function openWebSocket(): Promise<boolean> {
      const wsUrl = await getWsUrl();
      return new Promise((resolve) => {
        try {
          ws = new WebSocket(wsUrl);
          ws.binaryType = "arraybuffer";
          ws.onopen = () => {
            log.info("WS connected to", wsUrl);
            ws?.send(JSON.stringify({ type: "start", sampleRate: STREAM_SAMPLE_RATE, lang: "en" }));
            resolve(true);
          };
          ws.onmessage = (ev) => {
            if (typeof ev.data === "string") {
              try {
                const msg = JSON.parse(ev.data);
                handleWsMessage(msg);
              } catch (e) {
                log.warn("Non-JSON WS text message", ev.data);
              }
            }
          };
          ws.onerror = (e) => {
            log.error("WS error", e);
          };
          ws.onclose = () => {
            log.info("WS closed");
            if (isRecording) {
              showToast("Stopped.", "info", 1200);
              cleanupStreaming(true);
              resetBtn();
            }
          };
        } catch (e) {
          log.error("Failed to create WebSocket", e);
          resolve(false);
        }
      });
    }

    function handleWsMessage(msg: any) {
      const t = msg?.type;
      if (t === "ready") {
        log.info("Server ready");
      } else if (t === "started") {
        log.info("Streaming started", msg);
      } else if (t === "partial") {
        const text = (msg.text || "").trim();
        log.debug("Received partial", { text, currentEl: currentEl?.tagName });
        
        // Ignore empty partials and unchanged text
        const now = Date.now();
        if (!text) return;
        // Ignore very short partials to reduce flicker
        if (text.length < PARTIAL_MIN_CHARS) return;
        if (text === lastPartial) return;
        if (now - lastPartialTs < PARTIAL_DEBOUNCE_MS) return;
        // Ignore backtracking updates (when new partial is just a prefix of the previous)
        if (lastPartial && lastPartial.startsWith(text) && text.length < lastPartial.length) return;
        lastPartial = text;
        lastPartialTs = now;
        if (currentEl) {
          log.debug("Updating live text with partial", { text });
          updateLiveText(currentEl, text);
        }
      } else if (t === "final") {
        const text = (msg.text || "").trim();
        if (currentEl) finalizeLiveText(currentEl, text);
        if (text) {
          showToast("Transcribed ✓", "success", 1500);
        } else {
          showToast("No speech detected.", "info", 1600);
        }
        cleanupStreaming(false);
        resetBtn();
        lastPartial = "";
        lastPartialTs = 0;
      } else if (t === "error") {
        log.error("Server error:", msg.message);
        showToast(`Error: ${msg.message}`, "error", 3200);
        clearLiveText();
        cleanupStreaming(true);
        resetBtn();
      }
    }

    function cleanupAudioGraph() {
      try { procNode?.disconnect(); } catch {}
      try { sourceNode?.disconnect(); } catch {}
      try { audioCtx?.close(); } catch {}
      procNode = null; sourceNode = null; audioCtx = null;
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }
    }

    async function cleanupStreaming(error: boolean) {
      cleanupAudioGraph();
      try { ws?.close(); } catch {}
      ws = null;
      isRecording = false;
      if (error) clearLiveText();
      lastPartial = "";
      lastPartialTs = 0;
    }

    function downsampleFloat32(buffer: Float32Array, inRate: number, outRate: number): Int16Array | null {
      if (outRate === inRate) return floatTo16BitPCM(buffer);
      if (outRate > inRate) {
        // Do not upsample
        return floatTo16BitPCM(buffer);
      }
      const ratio = inRate / outRate;
      const newLen = Math.floor(buffer.length / ratio);
      const result = new Int16Array(newLen);
      let offsetResult = 0;
      let offsetBuffer = 0;
      while (offsetResult < newLen) {
        const nextOffsetBuffer = Math.floor((offsetResult + 1) * ratio);
        // Simple average to downsample
        let acc = 0;
        let count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
          acc += buffer[i];
          count++;
        }
        const sample = acc / (count || 1);
        result[offsetResult] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
      }
      return result;
    }

    function floatTo16BitPCM(input: Float32Array | Int16Array): Int16Array {
      if (input instanceof Int16Array) return input;
      const output = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return output;
    }

    // Live insertion for input/textarea/contenteditable
    function updateLiveText(
      el:
        | HTMLInputElement
        | HTMLTextAreaElement
        | (HTMLElement & { isContentEditable?: boolean }),
      text: string
    ) {
      log.debug("updateLiveText called", { 
        text, 
        tagName: el.tagName, 
        isContentEditable: (el as HTMLElement).isContentEditable,
        contenteditable: (el as HTMLElement).getAttribute("contenteditable"),
        hasLiveNode: !!liveNode 
      });

      if ((el as HTMLElement).isContentEditable || (el as HTMLElement).getAttribute("contenteditable") === "true" || 
          el.classList.contains("ProseMirror") || el.id === "prompt-textarea") {
        const doc = el.ownerDocument || document;
        
        if (!liveNode) {
          // For ProseMirror/ChatGPT, find or create a paragraph to insert into
          let targetContainer = el;
          if (el.classList.contains("ProseMirror") || el.id === "prompt-textarea") {
            // Look for existing <p> or create one
            let p = el.querySelector("p");
            if (!p) {
              p = doc.createElement("p");
              el.appendChild(p);
            }
            targetContainer = p;
          }
          
          // Create live text span
          const span = doc.createElement("span");
          span.setAttribute("data-vt-live", "true");
          span.style.opacity = "0.8";
          span.style.background = "rgba(99, 102, 241, 0.15)";
          span.style.borderRadius = "3px";
          span.style.padding = "1px 3px";
          span.style.margin = "0 1px";
          liveNode = span;
          
          // Ensure element is focused
          el.focus();
          
          // Get selection and insert
          const sel = doc.getSelection();
          log.debug("Selection info", { 
            rangeCount: sel?.rangeCount, 
            focusNode: sel?.focusNode?.nodeName,
            anchorNode: sel?.anchorNode?.nodeName,
            targetContainer: targetContainer.tagName
          });
          
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            // Ensure we're inserting in the right container
            if (!targetContainer.contains(range.commonAncestorContainer)) {
              // Move range to end of target container
              range.selectNodeContents(targetContainer);
              range.collapse(false);
            }
            range.insertNode(span);
            
            // Position cursor after the span
            const newRange = doc.createRange();
            newRange.setStartAfter(span);
            newRange.setEndAfter(span);
            sel.removeAllRanges();
            sel.addRange(newRange);
          } else {
            // Fallback: append to target container
            log.debug("No selection, appending to target container");
            targetContainer.appendChild(span);
          }
        }
        
        // Update the live text
        (liveNode as HTMLElement).textContent = text;
        
        // Trigger comprehensive events for modern web apps
        const events = [
          new Event("input", { bubbles: true, cancelable: true }),
          new Event("change", { bubbles: true, cancelable: true }),
          new KeyboardEvent("keyup", { bubbles: true, cancelable: true }),
          new Event("textInput", { bubbles: true, cancelable: true }),
        ];
        
        events.forEach(event => {
          try {
            el.dispatchEvent(event);
          } catch (e) {
            log.debug("Event dispatch failed", event.type, e);
          }
        });
        
        log.debug("Live text updated in contenteditable", { text, nodeExists: !!liveNode });
        return;
      }

      const input = el as HTMLInputElement | HTMLTextAreaElement;
      if (liveStartIdx == null) {
        liveStartIdx = input.selectionStart ?? input.value.length;
        livePrevLen = 0;
      }
      const before = input.value.slice(0, liveStartIdx);
      const after = input.value.slice(liveStartIdx + livePrevLen);
      input.value = before + text + after;
      livePrevLen = text.length;
      const caret = liveStartIdx + livePrevLen;
      input.selectionStart = input.selectionEnd = caret;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function finalizeLiveText(
      el:
        | HTMLInputElement
        | HTMLTextAreaElement
        | (HTMLElement & { isContentEditable?: boolean }),
      text: string
    ) {
      log.debug("finalizeLiveText called", { text, hasLiveNode: !!liveNode });
      
      if ((el as HTMLElement).isContentEditable || (el as HTMLElement).getAttribute("contenteditable") === "true") {
        if (!liveNode) {
          insertTextAtCursor(el, text);
        } else {
          // Replace the live span with final text
          const textNode = document.createTextNode(text);
          (liveNode as HTMLElement).replaceWith(textNode);
          
          // Position cursor after the inserted text
          const sel = document.getSelection();
          if (sel) {
            const range = document.createRange();
            range.setStartAfter(textNode);
            range.setEndAfter(textNode);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          
          liveNode = null;
        }
        
        // Trigger events for final text
        const events = [
          new Event("input", { bubbles: true, cancelable: true }),
          new Event("change", { bubbles: true, cancelable: true }),
          new KeyboardEvent("keyup", { bubbles: true, cancelable: true }),
        ];
        
        events.forEach(event => {
          try {
            el.dispatchEvent(event);
          } catch (e) {
            log.debug("Event dispatch failed in finalize", event.type, e);
          }
        });
        
        return resetLiveState();
      }
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      if (liveStartIdx == null) {
        insertTextAtCursor(el, text);
      } else {
        const before = input.value.slice(0, liveStartIdx);
        const after = input.value.slice(liveStartIdx + livePrevLen);
        input.value = before + text + after;
        const caret = (liveStartIdx + text.length);
        input.selectionStart = input.selectionEnd = caret;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      resetLiveState();
    }

    function clearLiveText() {
      if (currentEl) {
        if ((currentEl as HTMLElement).isContentEditable || (currentEl as HTMLElement).getAttribute("contenteditable") === "true") {
          if (liveNode && liveNode.parentNode) {
            liveNode.parentNode.removeChild(liveNode);
          }
        } else if (liveStartIdx != null) {
          const input = currentEl as HTMLInputElement | HTMLTextAreaElement;
          const before = input.value.slice(0, liveStartIdx);
          const after = input.value.slice(liveStartIdx + livePrevLen);
          input.value = before + after;
          input.selectionStart = input.selectionEnd = before.length;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      resetLiveState();
    }

    function resetLiveState() {
      liveStartIdx = null;
      livePrevLen = 0;
      liveNode = null;
    }

    // Input insertion for input/textarea/contenteditable
    function insertTextAtCursor(
      el:
        | HTMLInputElement
        | HTMLTextAreaElement
        | (HTMLElement & { isContentEditable?: boolean }),
      text: string
    ) {
      if (
        (el as HTMLElement).isContentEditable ||
        (el as HTMLElement).getAttribute("contenteditable") === "true"
      ) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.setEndAfter(node);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          el.appendChild(document.createTextNode(text));
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const value = input.value;
      const newValue = value.slice(0, start) + text + value.slice(end);
      input.value = newValue;
      const caret = start + text.length;
      input.selectionStart = input.selectionEnd = caret;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Storage
    async function getApiKey(): Promise<string | null> {
      return new Promise((resolve) => {
        // @ts-ignore
        const chromeObj: any = (window as any).chrome;
        if (chromeObj?.storage?.local) {
          chromeObj.storage.local.get(
            ["assemblyai_api_key"],
            (result: { assemblyai_api_key?: string }) => {
              resolve(result.assemblyai_api_key || null);
            }
          );
        } else {
          resolve(null);
        }
      });
    }

    async function getServerConfig(): Promise<{ protocol: "ws" | "wss"; base: string }> {
      return new Promise((resolve) => {
        // @ts-ignore
        const chromeObj: any = (window as any).chrome;
        if (chromeObj?.storage?.local) {
          chromeObj.storage.local.get(
            ["server_protocol", "server_base"],
            (result: { server_protocol?: "ws" | "wss"; server_base?: string }) => {
              const protocol = (result.server_protocol || DEFAULT_SERVER_PROTOCOL) as "ws" | "wss";
              const base = (result.server_base || DEFAULT_SERVER_BASE) as string;
              resolve({ protocol, base });
            }
          );
        } else {
          resolve({ protocol: DEFAULT_SERVER_PROTOCOL, base: DEFAULT_SERVER_BASE });
        }
      });
    }

    async function getWsUrl(): Promise<string> {
      const cfg = await getServerConfig();
      // Always use /asr path for streaming endpoint
      return `${cfg.protocol}://${cfg.base}/asr`;
    }

    // Focus and click detection
    function handlePotentialEditable(target: EventTarget | null) {
      const el = target as HTMLElement | null;
      if (!el) return;

      // If we already have a valid currentEl, prefer keeping it
      if (
        currentEl &&
        document.contains(currentEl) &&
        isEditable(currentEl as HTMLElement)
      ) {
        ensureMicBtn();
        positionMic(currentEl as HTMLElement);
        return;
      }

      let candidate: HTMLElement | null = null;

      if (isEditable(el)) {
        candidate = el;
      } else {
        // Improved selector for ChatGPT and other editors
        candidate = el.closest("input, textarea, [contenteditable='true'], .ProseMirror, #prompt-textarea");
        if (!isEditable(candidate)) candidate = null;
      }

      if (candidate) {
        log.debug("Found editable candidate", { 
          tagName: candidate.tagName, 
          id: candidate.id, 
          classes: candidate.className 
        });
        currentEl = candidate as any;
        ensureMicBtn();
        positionMic(candidate);
      } else {
        currentEl = null;
        hideMic();
      }
    }

    document.addEventListener(
      "focusin",
      (e) => handlePotentialEditable(e.target),
      true
    );

    document.addEventListener("click", (e) => {
      setTimeout(() => handlePotentialEditable(e.target), 0);
    });

    // Repositioning on scroll/resize with rAF debounce
    let repositionRaf = 0;
    function scheduleReposition() {
      if (!currentEl || !micBtn || micBtn.style.display === "none") return;
      if (repositionRaf) cancelAnimationFrame(repositionRaf);
      repositionRaf = requestAnimationFrame(() =>
        positionMic(currentEl as HTMLElement)
      );
    }

    window.addEventListener("scroll", scheduleReposition, true);
    window.addEventListener("resize", scheduleReposition);

    // Hide mic when focus truly leaves editable context
    document.addEventListener("focusout", (e) => {
      const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (related && micBtn && related === micBtn) return;

      setTimeout(() => {
        if (
          currentEl &&
          document.contains(currentEl) &&
          isEditable(currentEl as HTMLElement)
        ) {
          return;
        }
        hideMic();
      }, 100);
    });

    // Mutation observer to hide mic if element removed from DOM
    const mo = new MutationObserver(() => {
      if (currentEl && !document.contains(currentEl)) {
        currentEl = null;
        hideMic();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  },
});