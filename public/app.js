const APP_VERSION = "0.3.0";
const BRIDGE_TRANSCRIBE_URL = "https://headset.herdmate.ag/transcribe";
const SESSION_KEY = "pttFieldLogger.sessions.v0.3.0";
const COUNTER_KEY = "pttFieldLogger.counter.v0.3.0";

let characteristic;
let connectedDevice = null;

let currentSession = null;
let sessions = [];
let sessionCounter = 0;
let timerInterval = null;

let audioContext = null;
let analyser = null;
let micStream = null;
let vuAnimation = null;

let mediaRecorder = null;
let recordedChunks = [];

const connectBtn = document.getElementById("connectBtn");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const manualStartBtn = document.getElementById("manualStartBtn");
const manualStopBtn = document.getElementById("manualStopBtn");
const micTestBtn = document.getElementById("micTestBtn");

if (connectBtn) connectBtn.addEventListener("click", connect);
if (exportBtn) exportBtn.addEventListener("click", downloadLog);
if (clearBtn) clearBtn.addEventListener("click", clearLog);
if (manualStartBtn) manualStartBtn.addEventListener("click", startSession);
if (manualStopBtn) manualStopBtn.addEventListener("click", () => endSession("manual_stop"));
if (micTestBtn) micTestBtn.addEventListener("click", setupMicrophonePreview);

function nowIso() {
  return new Date().toISOString();
}

function $(id) {
  return document.getElementById(id);
}

function logRaw(msg) {
  const rawLog = $("rawLog");
  if (!rawLog) return;
  const time = new Date().toLocaleTimeString();
  rawLog.textContent = `[${time}] ${msg}\n` + rawLog.textContent;
}

function saveState() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
  localStorage.setItem(COUNTER_KEY, String(sessionCounter));
}

function loadState() {
  try {
    sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
    sessionCounter = Number(localStorage.getItem(COUNTER_KEY) || "0");
  } catch {
    sessions = [];
    sessionCounter = 0;
  }
}

function setConnection(msg) {
  const el = $("connection");
  if (el) el.textContent = msg;
}

function setState(pressed) {
  const state = $("state");
  if (!state) return;

  if (pressed) {
    state.textContent = "PTT PRESSED";
    state.className = "pressed";
  } else {
    state.textContent = "PTT RELEASED";
    state.className = "released";
  }
}

async function connect() {
  try {
    logRaw("Requesting Bluetooth device...");

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "3M" }],
      optionalServices: [0xffe0]
    });

    connectedDevice = device;
    connectedDevice.addEventListener("gattserverdisconnected", onDisconnected);

    logRaw("Selected: " + device.name);
    setConnection("Connecting to " + device.name + "...");

    const server = await device.gatt.connect();
    logRaw("Connected to GATT server");

    const service = await server.getPrimaryService(0xffe0);
    logRaw("Found service FFE0");

    characteristic = await service.getCharacteristic(0xffe1);
    logRaw("Found characteristic FFE1");

    characteristic.addEventListener("characteristicvaluechanged", handleValueChanged);

    await characteristic.startNotifications();
    logRaw("Notifications started. Press PTT.");
    setConnection("Connected: " + device.name);

    await setupMicrophonePreview();
  } catch (err) {
    logRaw("ERROR: " + err);
    setConnection("Error: " + err.message);
  }
}

function onDisconnected() {
  setConnection("Disconnected");
  logRaw("Headset disconnected");
  if (currentSession) endSession("disconnect");
}

function handleValueChanged(event) {
  const value = event.target.value;
  const byte = value.getUint8(0);

  if (byte === 1) {
    logRaw("FFE1 = 01 -> PRESSED");
    startSession();
  } else if (byte === 0) {
    logRaw("FFE1 = 00 -> RELEASED");
    endSession("ptt_release");
  } else {
    logRaw("FFE1 = " + byte + " -> UNKNOWN");
  }
}

async function startSession() {
  if (currentSession) {
    logRaw("Ignored duplicate press; session already active");
    return;
  }

  await setupMicrophonePreview();

  sessionCounter += 1;
  const start = new Date();

  currentSession = {
    id: "ptt-" + sessionCounter.toString().padStart(4, "0"),
    startedAt: start.toISOString(),
    endedAt: null,
    durationMs: null,
    endReason: null,
    audioName: null,
    audioUrl: null,
    transcript: "",
    transcriptStatus: "not_requested",
    transcriptError: ""
  };

  setState(true);
  updateCurrentSession();
  startTimer(start);
  startRecording();
  saveState();
}

function endSession(reason) {
  if (!currentSession) {
    setState(false);
    return;
  }

  const endedSession = currentSession;
  const end = new Date();

  endedSession.endedAt = end.toISOString();
  endedSession.durationMs = end - new Date(endedSession.startedAt);
  endedSession.endReason = reason;

  sessions.unshift(endedSession);
  currentSession = null;

  setState(false);
  stopTimer();
  renderSessions();
  updateCurrentSession();
  saveState();

  stopRecordingForSession(endedSession.id);
}

function startRecording() {
  if (!micStream) {
    logRaw("No microphone stream available");
    return;
  }

  recordedChunks = [];

  let options = {};
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    options = { mimeType: "audio/webm;codecs=opus" };
  } else if (MediaRecorder.isTypeSupported("audio/webm")) {
    options = { mimeType: "audio/webm" };
  }

  mediaRecorder = new MediaRecorder(micStream, options);

  mediaRecorder.ondataavailable = event => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.start();
  logRaw("Audio recording started");
}

function stopRecordingForSession(sessionId) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    logRaw("Recorder was not active");
    return;
  }

  mediaRecorder.onstop = async () => {
    const type = mediaRecorder.mimeType || "audio/webm";
    const audioBlob = new Blob(recordedChunks, { type });
    const audioUrl = URL.createObjectURL(audioBlob);
    const audioName = `${sessionId}.webm`;

    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      session.audioName = audioName;
      session.audioUrl = audioUrl;
      session.transcriptStatus = "queued";
      saveState();
      renderSessions();
    }

    logRaw(`Audio saved locally: ${audioName}`);

    await transcribeAudio(sessionId, audioBlob, type);
  };

  mediaRecorder.stop();
  logRaw("Audio recording stopped");
}

async function transcribeAudio(sessionId, audioBlob, audioType) {
  const session = sessions.find(s => s.id === sessionId);

  if (session) {
    session.transcriptStatus = "uploading";
    session.transcriptError = "";
    saveState();
    renderSessions();
  }

  try {
    const ext = audioType && audioType.includes("mp4") ? "m4a" : "webm";

    const formData = new FormData();
    formData.append("audio", audioBlob, `${sessionId}.${ext}`);

    logRaw("Uploading audio for transcription...");

    const response = await fetch(BRIDGE_TRANSCRIBE_URL, {
      method: "POST",
      body: formData
    });

    const payload = await response.json();

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const text = (payload.text || "").trim();

    if (session) {
      session.transcript = text;
      session.transcriptStatus = text ? "complete" : "empty";
      session.transcriptError = "";
      saveState();
      renderSessions();
    }

    logRaw("Transcript complete");
  } catch (err) {
    if (session) {
      session.transcriptStatus = "failed";
      session.transcriptError = err.message;
      saveState();
      renderSessions();
    }

    logRaw("TRANSCRIPTION ERROR: " + err.message);
  }
}

function startTimer(startDate) {
  stopTimer();

  timerInterval = setInterval(() => {
    const elapsed = Date.now() - startDate.getTime();
    const timer = $("timer");
    if (timer) timer.textContent = formatDuration(elapsed);
    updateCurrentSession();
  }, 100);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;

  const timer = $("timer");
  if (timer) timer.textContent = "00:00.0";
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const tenths = Math.floor((ms % 1000) / 100);
  return `${minutes}:${seconds}.${tenths}`;
}

function updateCurrentSession() {
  const el = $("currentSession");
  if (!el) return;

  if (!currentSession) {
    el.textContent = "No active session";
    return;
  }

  const elapsed = Date.now() - new Date(currentSession.startedAt).getTime();

  el.innerHTML = `
    <strong>${currentSession.id}</strong><br>
    Started: ${new Date(currentSession.startedAt).toLocaleTimeString()}<br>
    Duration: ${formatDuration(elapsed)}
  `;
}

function renderSessions() {
  const log = $("sessionLog");
  if (!log) return;

  if (sessions.length === 0) {
    log.textContent = "No sessions yet.";
    return;
  }

  log.innerHTML = sessions.map(s => {
    const transcriptBlock = s.transcript
      ? `<div><strong>Transcript:</strong><br>${escapeHtml(s.transcript)}</div>`
      : `<div><strong>Transcript:</strong> ${s.transcriptStatus || "not_requested"}</div>`;

    const errorBlock = s.transcriptError
      ? `<div><strong>Transcript Error:</strong> ${escapeHtml(s.transcriptError)}</div>`
      : "";

    const audioBlock = s.audioUrl
      ? `
        <div>
          <audio controls src="${s.audioUrl}"></audio><br>
          <a href="${s.audioUrl}" download="${s.audioName || s.id + ".webm"}">Download Audio</a>
        </div>
      `
      : `<div>Audio: not saved</div>`;

    return `
      <div class="session">
        <strong>${s.id}</strong><br>
        Start: ${new Date(s.startedAt).toLocaleString()}<br>
        End: ${s.endedAt ? new Date(s.endedAt).toLocaleString() : "—"}<br>
        Duration: ${s.durationMs ? formatDuration(s.durationMs) : "—"}<br>
        Reason: ${s.endReason || "—"}<br>
        ${audioBlock}
        ${transcriptBlock}
        ${errorBlock}
      </div>
    `;
  }).join("");
}

function downloadLog() {
  const payload = {
    app: "PTT Field Logger",
    version: APP_VERSION,
    exportedAt: nowIso(),
    sessions: sessions.map(s => ({
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      endReason: s.endReason,
      audioName: s.audioName,
      transcript: s.transcript,
      transcriptStatus: s.transcriptStatus,
      transcriptError: s.transcriptError
    }))
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = "ptt-field-log-" + new Date().toISOString().replaceAll(":", "-") + ".json";
  a.click();

  URL.revokeObjectURL(url);
}

function clearLog() {
  sessions = [];
  saveState();
  renderSessions();
  logRaw("Session log cleared");
}

async function setupMicrophonePreview() {
  try {
    if (micStream && analyser) {
      if (audioContext && audioContext.state === "suspended") {
        await audioContext.resume();
      }
      return;
    }

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(micStream);

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    source.connect(analyser);

    drawVuMeter();
    logRaw("Microphone preview ready");
  } catch (err) {
    logRaw("Mic preview unavailable: " + err.message);
  }
}

function drawVuMeter() {
  const canvas = $("vu");
  if (!canvas || !analyser) return;

  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    vuAnimation = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(data);

    let sum = 0;
    for (const v of data) sum += v;

    const avg = sum / data.length;
    const width = Math.min(canvas.width, (avg / 255) * canvas.width * 3);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillRect(0, 0, width, canvas.height);
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
  }

  draw();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadState();
renderSessions();
