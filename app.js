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

const connectBtn = document.getElementById("connectBtn");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");

connectBtn.addEventListener("click", connect);
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

function startSession() {
  if (currentSession) {
    logRaw("Ignored duplicate press; session already active");
    return;
  }

  sessionCounter += 1;
  const start = new Date();

  currentSession = {
    id: "ptt-" + sessionCounter.toString().padStart(4, "0"),
    startedAt: start.toISOString(),
    endedAt: null,
    durationMs: null,
    endReason: null
  };

  setState(true);
  updateCurrentSession();
  startTimer(start);
}

function endSession(reason) {
  if (!currentSession) {
    setState(false);
    return;
  }

  const end = new Date();
  currentSession.endedAt = end.toISOString();
  currentSession.durationMs = end - new Date(currentSession.startedAt);
  currentSession.endReason = reason;

  sessions.unshift(currentSession);
  currentSession = null;

  setState(false);
  stopTimer();
  renderSessions();
  updateCurrentSession();
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
    Duration: ${formatDuration(elapsed)}
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
      Reason: ${s.endReason}
    </div>
  `).join("");
}

function downloadLog() {
  const payload = {
    app: "PTT Field Logger",
    version: "0.2.1",
    exportedAt: nowIso(),
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

function clearLog() {
  sessions = [];
  renderSessions();
  logRaw("Session log cleared");
}

async function setupMicrophonePreview() {
  try {
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
  const canvas = document.getElementById("vu");
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    vuAnimation = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(data);

    let sum = 0;
    for (const v of data) sum += v;
    const avg = sum / data.length;
    const width = Math.min(canvas.width, (avg / 255) * canvas.width * 2.2);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillRect(0, 0, width, canvas.height);
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
  }

  draw();
}

renderSessions();
