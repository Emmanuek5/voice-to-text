// content-script.ts
// Mic button content script with improved VAD and top-entry, high-visibility toasts.

const LOG_PREFIX = "[Voice-to-Text]";
const log = {
  info: (...args: any[]) => console.log(LOG_PREFIX, ...args),
  warn: (...args: any[]) => console.warn(LOG_PREFIX, ...args),
  error: (...args: any[]) => console.error(LOG_PREFIX, ...args),
  debug: (...args: any[]) => console.debug(LOG_PREFIX, ...args),
};

// HTTP ASR server config
const DEFAULT_SERVER_BASE = "127.0.0.1:8020";
const DEFAULT_SERVER_PROTOCOL: "http" | "https" = "http";
const RECORD_SAMPLE_RATE = 16000;

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    log.info("Content script initialized on:", window.location.href);

    // State
    let micBtn: HTMLButtonElement | null = null;
    let micLevelEl: HTMLDivElement | null = null;
    let currentEl: HTMLElement | null = null;

    let isRecording = false;
    let audioCtx: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let procNode: ScriptProcessorNode | null = null;
    let micStream: MediaStream | null = null;
    let recordedChunks: Int16Array[] = [];
    let recordingStartTime = 0;
    let maxRecordingTimer: number | null = null;

    // VAD state
    let noiseFloor = 0.002; // adaptive baseline
    let vadHistory: number[] = [];
    let voiceDetectedFrames = 0;
    let silenceFrames = 0;
    let hasDetectedVoice = false;

    // Toast
    let toastEl: HTMLDivElement | null = null;
    let toastTimer: number | null = null;

    // Style constants
    const STYLE_ID = "vt-mic-style";
    const BTN_SIZE = 40;
    const BTN_OFFSET_X = 8;
    const BTN_OFFSET_Y = 8;

    injectStyles();

    // ------------------------
    // Utilities
    // ------------------------
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
        el.classList.contains("ProseMirror") ||
        el.id === "prompt-textarea";

      if (!editable) return false;
      if (tag === "INPUT" && (el as HTMLInputElement).type === "password")
        return false;

      const cs = window.getComputedStyle(el);
      if (
        cs.visibility === "hidden" ||
        cs.display === "none" ||
        (el as HTMLInputElement | HTMLTextAreaElement).readOnly ||
        (el as HTMLInputElement | HTMLTextAreaElement).disabled
      )
        return false;

      return true;
    }

    function ensureMicBtn() {
      if (micBtn) return;
      micBtn = document.createElement("button");
      micBtn.type = "button";
      micBtn.className = "vt-mic";
      micBtn.title = "Click to start recording";
      micBtn.setAttribute("aria-label", "Start voice input");
      micBtn.style.display = "none";
      micBtn.tabIndex = -1;
      micBtn.innerHTML = "🎤";

      // mic level indicator
      micLevelEl = document.createElement("div");
      micLevelEl.className = "vt-mic-level";
      micBtn.appendChild(micLevelEl);

      document.body.appendChild(micBtn);

      micBtn.addEventListener("mousedown", (e) => e.preventDefault());
      micBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!currentEl) return;
        if (currentEl instanceof HTMLElement) currentEl.focus();
        if (isRecording) stopRecording();
        else startRecording();
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
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform .12s ease, background .15s ease, border .15s ease, opacity .15s ease;
          user-select: none;
          overflow: hidden;
        }
        .vt-mic-level {
          position: absolute;
          bottom: 4px;
          left: 4px;
          right: 4px;
          height: 4px;
          border-radius: 2px;
          background: rgba(99,102,241,0.3);
          transform-origin: left center;
          transform: scaleX(0);
          transition: transform 0.05s linear;
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
        @keyframes vt-spin { to { transform: rotate(360deg); } }
        .vt-toast {
          position: fixed;
          left: 50%;
          top: 14px;
          transform: translate(-50%, -12px);
          background: rgba(15, 23, 42, 0.98);
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
        .vt-toast.show { opacity: 1; transform: translate(-50%, 0); }
        .vt-toast.success { border-color: rgba(34,197,94,0.6); background: rgba(6,95,70,0.96); color: #e7fff5; }
        .vt-toast.error { border-color: rgba(239,68,68,0.6); background: rgba(127,29,29,0.96); color: #ffe7e7; }
        .vt-toast.info { border-color: rgba(99,102,241,0.6); background: rgba(30,27,75,0.96); color: #eef2ff; }
      `;
      document.head.appendChild(style);
    }

    type ToastKind = "success" | "error" | "info";
    function showToast(msg: string, kind: ToastKind = "info", timeout = 2600) {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "vt-toast";
        toastEl.innerHTML = `<span class="vt-toast-icon">🔔</span><span class="vt-toast-text"></span>`;
        document.body.appendChild(toastEl);
      }
      const icon = toastEl.querySelector(".vt-toast-icon") as HTMLSpanElement;
      const text = toastEl.querySelector(".vt-toast-text") as HTMLSpanElement;
      toastEl.classList.remove("success", "error", "info");
      toastEl.classList.add(kind);
      icon.textContent =
        kind === "success" ? "✅" : kind === "error" ? "⚠️" : "🔔";
      text.textContent = msg;
      toastEl.classList.add("show");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = window.setTimeout(
        () => toastEl?.classList.remove("show"),
        timeout
      );
    }

    function positionMic(el: HTMLElement) {
      if (!micBtn) return;
      const rect = el.getBoundingClientRect();
      let left = window.scrollX + rect.right + BTN_OFFSET_X - BTN_SIZE / 2 - 2;
      let top = window.scrollY + rect.top - BTN_OFFSET_Y;
      const vw = window.innerWidth,
        vh = window.innerHeight;
      if (left + BTN_SIZE > window.scrollX + vw - 4)
        left = window.scrollX + rect.right - BTN_SIZE - 6;
      if (left < window.scrollX + 4) left = window.scrollX + rect.left + 4;
      if (top < window.scrollY + 4) top = window.scrollY + rect.top + 4;
      if (top + BTN_SIZE > window.scrollY + vh - 4)
        top = window.scrollY + rect.bottom - BTN_SIZE - 6;
      micBtn.style.left = `${left}px`;
      micBtn.style.top = `${top}px`;
      micBtn.style.display = "flex";
      micBtn.style.opacity = "1";
    }

    function hideMic() {
      if (!micBtn || isRecording) return;
      micBtn.style.display = "none";
      micBtn.style.opacity = "0";
    }

    // ------------------------
    // Recording
    // ------------------------
    async function startRecording() {
      if (!navigator.mediaDevices || !currentEl || isRecording) return;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new (window.AudioContext ||
          (window as any).webkitAudioContext)();
        sourceNode = audioCtx.createMediaStreamSource(micStream);
        procNode = audioCtx.createScriptProcessor(4096, 1, 1);

        recordedChunks = [];
        recordingStartTime = Date.now();
        vadHistory = [];
        noiseFloor = 0.002;
        voiceDetectedFrames = 0;
        silenceFrames = 0;
        hasDetectedVoice = false;

        procNode.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          const downsampled = downsampleFloat32(
            input,
            audioCtx!.sampleRate,
            RECORD_SAMPLE_RATE
          );
          if (!downsampled) return;
          const pcm = floatTo16BitPCM(downsampled);
          recordedChunks.push(pcm);

          // --- Improved VAD ---
          const rms =
            Math.sqrt(
              downsampled.reduce((s, v) => s + v * v, 0) / downsampled.length
            ) || 0;
          let zcr = 0;
          for (let i = 1; i < downsampled.length; i++) {
            if (downsampled[i] * downsampled[i - 1] < 0) zcr++;
          }
          zcr /= downsampled.length;

          noiseFloor = noiseFloor * 0.95 + rms * 0.05;
          const dynamicVoiceThreshold = noiseFloor * 3.5;

          vadHistory.push(rms);
          if (vadHistory.length > 30) vadHistory.shift();
          const avgEnergy =
            vadHistory.reduce((a, b) => a + b, 0) / vadHistory.length;

          if (micLevelEl) {
            const level = Math.min(1, rms * 20);
            micLevelEl.style.transform = `scaleX(${level})`;
          }

          if (rms > dynamicVoiceThreshold && zcr > 0.02) {
            voiceDetectedFrames++;
            silenceFrames = 0;
            if (!hasDetectedVoice && voiceDetectedFrames > 5) {
              hasDetectedVoice = true;
              showToast("Listening…", "info", 1200);
            }
          } else {
            if (hasDetectedVoice) silenceFrames++;
            voiceDetectedFrames = Math.max(0, voiceDetectedFrames - 1);
          }

          if (hasDetectedVoice && silenceFrames > 45) {
            log.info("Stopping due to silence");
            stopRecording();
          }
        };

        sourceNode.connect(procNode);
        procNode.connect(audioCtx.destination);

        isRecording = true;
        setBtnRecording();
        showToast("Recording… Start speaking or click to stop.", "info", 2500);

        maxRecordingTimer = window.setTimeout(() => {
          if (isRecording) stopRecording();
        }, 30000);

        if (currentEl instanceof HTMLElement) currentEl.focus();
        requestAnimationFrame(() => {
          if (currentEl) positionMic(currentEl as HTMLElement);
        });
      } catch (err: any) {
        log.error("Failed to start recording:", err);
        showToast("Microphone error.", "error");
        cleanupRecording();
        resetBtn();
      }
    }

    async function stopRecording() {
      if (!isRecording) return;
      isRecording = false;
      setBtnProcessing();
      showToast("Transcribing…", "info", 3200);
      cleanupRecording();

      try {
        const totalLength = recordedChunks.reduce((s, c) => s + c.length, 0);
        const combinedAudio = new Int16Array(totalLength);
        let offset = 0;
        for (const chunk of recordedChunks) {
          combinedAudio.set(chunk, offset);
          offset += chunk.length;
        }
        if (combinedAudio.length === 0) {
          showToast("No audio recorded.", "info", 1600);
          resetBtn();
          return;
        }
        const audioBlob = new Blob([combinedAudio.buffer], {
          type: "application/octet-stream",
        });
        const formData = new FormData();
        formData.append("audio", audioBlob, "audio.raw");
        formData.append("lang", "en");

        const serverUrl = await getServerUrl();
        const response = await fetch(`${serverUrl}/transcribe`, {
          method: "POST",
          body: formData,
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const result = await response.json();
        if (result.error) throw new Error(result.error);

        const text = result.text?.trim() || "";
        if (currentEl && text) {
          insertTextAtCursor(currentEl, text);
          showToast("Transcribed ✓", "success", 1500);
        } else {
          showToast("No speech detected.", "info", 1600);
        }
      } catch (error: any) {
        log.error("Transcription failed:", error);
        showToast(`Error: ${error.message}`, "error", 3200);
      } finally {
        resetBtn();
        recordedChunks = [];
      }
    }

    function setBtnRecording() {
      if (!micBtn) return;
      micBtn.classList.add("is-recording");
      micBtn.classList.remove("is-processing");
      micBtn.innerHTML = "⏹️";
      micBtn.appendChild(micLevelEl!);
      micBtn.title = "Click to stop recording";
    }

    function setBtnProcessing() {
      if (!micBtn) return;
      micBtn.classList.remove("is-recording");
      micBtn.classList.add("is-processing");
      micBtn.innerHTML = `<span class="vt-spinner"></span>`;
      micBtn.title = "Transcribing...";
    }

    function resetBtn() {
      if (!micBtn) return;
      micBtn.classList.remove("is-recording", "is-processing");
      micBtn.innerHTML = "🎤";
      micBtn.appendChild(micLevelEl!);
      micBtn.title = "Click to start recording";
    }

    function cleanupRecording() {
      try {
        procNode?.disconnect();
      } catch {}
      try {
        sourceNode?.disconnect();
      } catch {}
      try {
        audioCtx?.close();
      } catch {}
      procNode = null;
      sourceNode = null;
      audioCtx = null;
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }
      if (maxRecordingTimer) {
        clearTimeout(maxRecordingTimer);
        maxRecordingTimer = null;
      }
    }

    function downsampleFloat32(
      buffer: Float32Array,
      inRate: number,
      outRate: number
    ): Int16Array | null {
      if (outRate === inRate) return floatTo16BitPCM(buffer);
      if (outRate > inRate) return floatTo16BitPCM(buffer);
      const ratio = inRate / outRate;
      const newLen = Math.floor(buffer.length / ratio);
      const result = new Int16Array(newLen);
      let offsetResult = 0,
        offsetBuffer = 0;
      while (offsetResult < newLen) {
        const nextOffsetBuffer = Math.floor((offsetResult + 1) * ratio);
        let acc = 0,
          count = 0;
        for (
          let i = offsetBuffer;
          i < nextOffsetBuffer && i < buffer.length;
          i++
        ) {
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

    function insertTextAtCursor(el: HTMLElement, text: string) {
      if (
        el.isContentEditable ||
        el.getAttribute("contenteditable") === "true"
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
      const newValue =
        input.value.slice(0, start) + text + input.value.slice(end);
      input.value = newValue;
      const caret = start + text.length;
      input.selectionStart = input.selectionEnd = caret;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    async function getServerConfig(): Promise<{
      protocol: "http" | "https";
      base: string;
    }> {
      return new Promise((resolve) => {
        const chromeObj: any = (window as any).chrome;
        if (chromeObj?.storage?.local) {
          chromeObj.storage.local.get(
            ["server_protocol", "server_base"],
            (result: any) => {
              let protocol = result.server_protocol || DEFAULT_SERVER_PROTOCOL;
              if (protocol === "ws") protocol = "http";
              if (protocol === "wss") protocol = "https";
              const base = result.server_base || DEFAULT_SERVER_BASE;
              resolve({ protocol, base });
            }
          );
        } else {
          resolve({
            protocol: DEFAULT_SERVER_PROTOCOL,
            base: DEFAULT_SERVER_BASE,
          });
        }
      });
    }

    async function getServerUrl(): Promise<string> {
      const cfg = await getServerConfig();
      return `${cfg.protocol}://${cfg.base}`;
    }

    // ------------------------
    // Focus + DOM handling
    // ------------------------
    function handlePotentialEditable(target: EventTarget | null) {
      const el = target as HTMLElement | null;
      if (!el) return;
      if (currentEl && document.contains(currentEl) && isEditable(currentEl)) {
        ensureMicBtn();
        positionMic(currentEl);
        return;
      }
      let candidate: HTMLElement | null = null;
      if (isEditable(el)) candidate = el;
      else
        candidate = el.closest(
          "input, textarea, [contenteditable='true'], .ProseMirror, #prompt-textarea"
        );
      if (candidate && isEditable(candidate)) {
        currentEl = candidate;
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
    document.addEventListener("click", (e) =>
      setTimeout(() => handlePotentialEditable(e.target), 0)
    );

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

    document.addEventListener("focusout", (e) => {
      const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (related && micBtn && related === micBtn) return;
      setTimeout(() => {
        if (currentEl && document.contains(currentEl) && isEditable(currentEl))
          return;
        hideMic();
      }, 100);
    });

    const mo = new MutationObserver(() => {
      if (currentEl && !document.contains(currentEl)) {
        currentEl = null;
        hideMic();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  },
});
