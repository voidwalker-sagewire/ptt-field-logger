const APP_VERSION = "0.2.3";
const SESSION_KEY = "pttFieldLogger.sessions.v0.2.3";
const COUNTER_KEY = "pttFieldLogger.counter.v0.2.3";
const DB_NAME = "ptt-field-logger-db";
const DB_VERSION = 1;
const AUDIO_STORE = "audioClips";

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
let dbPromise = null;

const connectBtn = document.getElementById("connectBtn");
const micTestBtn = document.getElementById("micTestBtn");
const manualStartBtn = document.getElementById("manualStartBtn");
const manualStopBtn = document.getElementById("manualStopBtn");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");

connectBtn.addEventListener("click", connect);
micTestBtn.addEventListener("click", setupMicrophonePreview);
manualStartBtn.addEventListener("click", () => startSession("manual"));
manualStopBtn.addEventListener("click", () => endSession("manual_stop"));
exportBtn.addEventListener("click", downloadLog);
clearBtn.addEventListener("click", clearLog);

function nowIso() {
  return new Date().toISOString();
}

function logRaw(msg) {
  const time = new Date().toLocaleTimeString();
  const rawLog = document.getElementById("rawLog");
  rawLog.textContent = `[${time}] ${msg}\n` + rawLog.textContent;
}

function setConnection(msg) {
  document.getElementById("connection").textContent = msg;
}

function setState(pressed) {
  const state = document.getElementById("state");
  if (pressed) {
    state.textContent = "RECORDING";
    state.className = "pressed";
  } else {
    state.textContent = "IDLE";
    state.className = "released";
  }
}

function setRecorderStatus(msg) {
  document.getElementById("recorderStatus").textContent = msg;
}

function loadSavedState() {
  try {
    sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
    sessionCounter = Number(localStorage.getItem(COUNTER_KEY) || "0");
  } catch (err) {
    sessions = [];
    sessionCounter = 0;
    logRaw("Could not load saved sessions: " + err.message);
  }
}

function saveState() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
  localStorage.setItem(COUNTER_KEY, String(sessionCounter));
}

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: "sessionId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function saveAudioClip(sessionId, blob) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readwrite");
    tx.objectStore(AUDIO_STORE).put({
      sessionId,
      blob,
      type: blob.type || "audio/webm",
      savedAt: nowIso()
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getAudioClip(sessionId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const request = tx.objectStore(AUDIO_STORE).get(sessionId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function deleteAudioClips() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readwrite");
    tx.objectStore(AUDIO_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
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
    startSession("ptt_press");
  } else if (byte === 0) {
    logRaw("FFE1 = 00 -> RELEASED");
    endSession("ptt_release");
  } else {
    logRaw("FFE1 = " + byte + " -> UNKNOWN");
  }
}

async function startSession(startReason = "unknown") {
  if (currentSession) {
    logRaw("Ignored duplicate start; session already active");
    return;
  }

  await setupMicrophonePreview();

  if (!micStream) {
    logRaw("Cannot record: microphone is not ready");
    setRecorderStatus("Mic unavailable. Check browser permission.");
    return;
  }

  sessionCounter += 1;
  const start = new Date();

  currentSession = {
    id: "ptt-" + sessionCounter.toString().padStart(4, "0"),
    startedAt: start.toISOString(),
    endedAt: null,
    durationMs: null,
    startReason,
    endReason: null,
    audioStored: false,
    audioType: null,
    audioBytes: 0,
    transcript: ""
  };

  try {
    recordedChunks = [];
    const mimeType = getBestMimeType();
    const recorderOptions = mimeType ? { mimeType } : undefined;
    mediaRecorder = new MediaRecorder(micStream, recorderOptions);

    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    });

    const recordingSessionId = currentSession.id;
    mediaRecorder.addEventListener("stop", () => finalizeRecording(recordingSessionId));

    mediaRecorder.start(250);
    setRecorderStatus("Recording audio locally...");
  } catch (err) {
    logRaw("Recorder failed: " + err.message);
    setRecorderStatus("Recorder failed: " + err.message);
  }

  setState(true);
  updateCurrentSession();
  startTimer(start);
  saveState();
}

function getBestMimeType() {
  const options = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4"
  ];

  for (const type of options) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }

  return "";
}

function endSession(reason) {
  if (!currentSession) {
    setState(false);
    return;
  }

  const endingSession = currentSession;
  const end = new Date();
  endingSession.endedAt = end.toISOString();
  endingSession.durationMs = end - new Date(endingSession.startedAt);
  endingSession.endReason = reason;

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  } else {
    finalizeRecording(endingSession.id);
  }

  sessions.unshift(endingSession);
  currentSession = null;

  setState(false);
  stopTimer();
  renderSessions();
  updateCurrentSession();
  saveState();
}

async function finalizeRecording(sessionId) {
  if (!sessionId) {
    setRecorderStatus("Recorder stopped, but no session ID was available.");
    logRaw("Recorder stop had no session ID");
    return;
  }

  if (recordedChunks.length === 0) {
    setRecorderStatus("No audio captured for " + sessionId + ". Try a longer test clip.");
    logRaw("No chunks captured for " + sessionId);
    return;
  }

  const type = recordedChunks[0].type || "audio/webm";
  const audioBlob = new Blob(recordedChunks, { type });
  recordedChunks = [];

  try {
    await saveAudioClip(sessionId, audioBlob);

    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      session.audioStored = true;
      session.audioType = type;
      session.audioBytes = audioBlob.size;
      saveState();
      renderSessions();
    }

    setRecorderStatus(`Audio saved locally for ${sessionId} (${formatBytes(audioBlob.size)}).`);
    logRaw(`Audio saved for ${sessionId}: ${formatBytes(audioBlob.size)} / ${type}`);
  } catch (err) {
    setRecorderStatus("Could not save audio: " + err.message);
    logRaw("Could not save audio: " + err.message);
  }
}

function startTimer(startDate) {
  stopTimer();
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - startDate.getTime();
    document.getElementById("timer").textContent = formatDuration(elapsed);
    updateCurrentSession();
  }, 100);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  document.getElementById("timer").textContent = "00:00.0";
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const tenths = Math.floor((ms % 1000) / 100);
  return `${minutes}:${seconds}.${tenths}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function updateCurrentSession() {
  const el = document.getElementById("currentSession");

  if (!currentSession) {
    el.textContent = "No active session";
    return;
  }

  const elapsed = Date.now() - new Date(currentSession.startedAt).getTime();
  el.innerHTML = `
    <strong>${currentSession.id}</strong><br>
    Started: ${new Date(currentSession.startedAt).toLocaleTimeString()}<br>
    Duration: ${formatDuration(elapsed)}<br>
    Source: ${currentSession.startReason}
  `;
}

function renderSessions() {
  const log = document.getElementById("sessionLog");

  if (sessions.length === 0) {
    log.textContent = "No sessions yet.";
    return;
  }

  log.innerHTML = sessions.map(s => `
    <div class="session">
      <strong>${s.id}</strong><br>
      Start: ${new Date(s.startedAt).toLocaleString()}<br>
      End: ${new Date(s.endedAt).toLocaleString()}<br>
      Duration: ${formatDuration(s.durationMs)}<br>
      Start Source: ${s.startReason || "unknown"}<br>
      End Reason: ${s.endReason}<br>
      Audio: ${s.audioStored ? `saved locally (${formatBytes(s.audioBytes)})` : "not saved"}<br>
      Transcript: ${s.transcript || "not added yet"}<br>
      ${s.audioStored ? `<button class="smallBtn" onclick="playAudio('${s.id}')">Play</button><button class="smallBtn" onclick="downloadAudio('${s.id}')">Download Audio</button>` : ""}
    </div>
  `).join("");
}

async function playAudio(sessionId) {
  try {
    const record = await getAudioClip(sessionId);
    if (!record) {
      logRaw("No audio found for " + sessionId);
      return;
    }

    const url = URL.createObjectURL(record.blob);
    const player = document.getElementById("audioPlayer");
    player.src = url;
    player.play();
    logRaw("Playing " + sessionId);
  } catch (err) {
    logRaw("Play failed: " + err.message);
  }
}

async function downloadAudio(sessionId) {
  try {
    const record = await getAudioClip(sessionId);
    if (!record) {
      logRaw("No audio found for " + sessionId);
      return;
    }

    const ext = record.type.includes("mp4") ? "m4a" : "webm";
    const url = URL.createObjectURL(record.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionId}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    logRaw("Download audio failed: " + err.message);
  }
}

function downloadLog() {
  const payload = {
    app: "PTT Field Logger",
    version: APP_VERSION,
    exportedAt: nowIso(),
    note: "Audio clips are stored locally in this browser. JSON export includes metadata only.",
    sessions
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "ptt-field-log-" + new Date().toISOString().replaceAll(":", "-") + ".json";
  a.click();

  URL.revokeObjectURL(url);
}

async function clearLog() {
  if (currentSession) endSession("clear_log");
  sessions = [];
  saveState();
  await deleteAudioClips();
  renderSessions();
  logRaw("Session log and local audio cleared");
}

async function setupMicrophonePreview() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia is not available in this browser");
    }

    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    }

    if (!audioContext) {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
    }

    if (audioContext.state === "suspended") await audioContext.resume();

    drawVuMeter();
    setRecorderStatus("Microphone ready.");
    logRaw("Microphone preview ready");
  } catch (err) {
    setRecorderStatus("Mic preview unavailable: " + err.message);
    logRaw("Mic preview unavailable: " + err.message);
  }
}

function drawVuMeter() {
  if (!analyser) return;

  const canvas = document.getElementById("vu");
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);

  if (vuAnimation) cancelAnimationFrame(vuAnimation);

  function draw() {
    vuAnimation = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(data);

    let sumSquares = 0;
    for (const v of data) {
      const centered = v - 128;
      sumSquares += centered * centered;
    }

    const rms = Math.sqrt(sumSquares / data.length);
    const level = Math.min(1, rms / 42);
    const width = canvas.width * level;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(0, 0, width, canvas.height);
    ctx.strokeStyle = "#f5f5f5";
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
  }

  draw();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("./service-worker.js");
    logRaw("Service worker registered");
  } catch (err) {
    logRaw("Service worker failed: " + err.message);
  }
}

loadSavedState();
renderSessions();
setState(false);
registerServiceWorker();
