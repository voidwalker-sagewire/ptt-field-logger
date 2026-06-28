import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8787;

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "https://api.sagewire.dev";
const WEATHER_BASE_URL = process.env.WEATHER_BASE_URL || "https://weather.herdmate.ag";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://headset.herdmate.ag";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "audio");

for (const dir of [uploadsDir, audioDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const safe = (file.originalname || "audio.webm").replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  }
});

const upload = multer({ storage });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));
app.use("/audio", express.static(audioDir));

function publicAudioUrl(fileName) {
  return `${PUBLIC_BASE_URL}/audio/${encodeURIComponent(fileName)}`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(payload.error || `${url} HTTP ${response.status}`);
  }

  return payload;
}

async function callGatewayLoc(gps = {}, device = {}) {
  if (!gps.latitude || !gps.longitude) {
    return { status: "skipped", reason: "missing latitude/longitude", gps };
  }

  return postJson(`${GATEWAY_BASE_URL}/loc/stamp`, {
    latitude: gps.latitude,
    longitude: gps.longitude,
    accuracy_m: gps.accuracy_m,
    altitude_m: gps.altitude_m,
    heading: gps.heading,
    speed_mps: gps.speed_mps,
    device_id: device.device_id || device.name || "unknown-device"
  });
}

async function callWeather(gps = {}) {
  if (!gps.latitude || !gps.longitude) {
    return { status: "skipped", reason: "missing latitude/longitude" };
  }

  const url = `${WEATHER_BASE_URL}/weather?lat=${encodeURIComponent(gps.latitude)}&lng=${encodeURIComponent(gps.longitude)}`;
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Weather HTTP ${response.status}`);
  }

  return payload;
}

async function callGatewayStt(audioPath, originalName, mimeType) {
  const form = new FormData();
  const buffer = fs.readFileSync(audioPath);
  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });

  form.append("audio", blob, originalName || "audio.webm");

  const response = await fetch(`${GATEWAY_BASE_URL}/stt/transcribe`, {
    method: "POST",
    body: form
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `STT HTTP ${response.status}`);
  }

  return payload;
}

async function callGatewayTts(text) {
  const response = await fetch(`${GATEWAY_BASE_URL}/tts/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(errorText || `TTS HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function askFieldAssistant(transcript, context) {
  if (!transcript || !transcript.trim()) {
    return "No speech detected.";
  }

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a calm, practical field assistant for a push-to-talk headset. Reply briefly and naturally. Acknowledge the field note. If there are obvious action items, mention them. Keep the response short enough to hear through a headset."
      },
      {
        role: "user",
        content: JSON.stringify({ transcript, context })
      }
    ]
  });

  return completion.choices?.[0]?.message?.content || "Copy that.";
}

async function logToSheet(record) {
  if (!process.env.GOOGLE_SHEET_WEBHOOK_URL) {
    return { ok: false, skipped: true, reason: "Missing GOOGLE_SHEET_WEBHOOK_URL" };
  }

  const response = await fetch(process.env.GOOGLE_SHEET_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record)
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(payload.error || `Sheet HTTP ${response.status}`);
  }

  return payload;
}


function makeFlatSheetRecord({
  sessionId,
  metadata,
  transcript,
  answer,
  inputAudioUrl,
  replyAudioUrl,
  gps,
  location,
  weather,
  stt,
  savedAudioPath,
  savedAudioName,
  audioMimeType
}) {
  const session = metadata.session || {};
  const device = metadata.device || {};

  let audioBase64 = "";
  try {
    if (savedAudioPath && fs.existsSync(savedAudioPath)) {
      audioBase64 = fs.readFileSync(savedAudioPath).toString("base64");
    }
  } catch (err) {
    console.error("AUDIO BASE64 ERROR:", err.message);
  }

  return {
    id: sessionId,
    startedAt: session.startedAt || "",
    endedAt: session.endedAt || "",
    durationMs: session.durationMs || "",
    endReason: session.endReason || "",

    latitude: gps.latitude || "",
    longitude: gps.longitude || "",
    gpsAccuracy: gps.accuracy_m || "",
    gpsTimestamp: gps.gps_timestamp || "",
    gpsError: gps.gps_error || "",

    weatherTemp: weather.temp || weather.temperature || "",
    weatherCondition: weather.condition || weather.description || "",
    weatherWind: weather.wind || "",
    weatherHumidity: weather.humidity || "",

    transcript,
    summary: answer || "",
    reply: answer || "",

    audioName: savedAudioName || "",
    audioUrl: inputAudioUrl || "",
    replyAudioUrl: replyAudioUrl || "",
    transcriptStatus: transcript ? "complete" : "empty",
    source: "PTT Field Logger v1.0",

    locationJson: JSON.stringify(location || {}),
    weatherJson: JSON.stringify(weather || {}),
    sttJson: JSON.stringify(stt || {}),
    deviceJson: JSON.stringify(device || {}),

    audioBase64,
    audioMimeType: audioMimeType || "audio/webm"
  };
}

async function handleFieldSession(req, res, legacyMode = false) {
  let uploadedPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No audio file uploaded" });
    }

    let metadata = {};
    try {
      metadata = JSON.parse(req.body.metadata || "{}");
    } catch {
      metadata = {};
    }

    if (legacyMode && !metadata.session) {
      metadata.session = {
        id: path.parse(req.file.originalname || `ptt-${Date.now()}`).name
      };
      metadata.device = { source: "legacy-client" };
      metadata.gps = {};
    }

    const sessionId = metadata.session?.id || `ptt-${Date.now()}`;
    const safeBase = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");

    const originalExt = path.extname(req.file.originalname || "") || ".webm";
    const savedAudioName = `${safeBase}${originalExt}`;
    const savedAudioPath = path.join(audioDir, savedAudioName);

    fs.copyFileSync(uploadedPath, savedAudioPath);
    const inputAudioUrl = publicAudioUrl(savedAudioName);

    const gps = metadata.gps || {};
    const device = metadata.device || {};

    const [locationResult, weatherResult, sttResult] = await Promise.allSettled([
      callGatewayLoc(gps, device),
      callWeather(gps),
      callGatewayStt(uploadedPath, req.file.originalname, req.file.mimetype)
    ]);

    const location = locationResult.status === "fulfilled"
      ? locationResult.value
      : { status: "failed", error: locationResult.reason.message };

    const weather = weatherResult.status === "fulfilled"
      ? weatherResult.value
      : { status: "failed", error: weatherResult.reason.message };

    if (sttResult.status === "rejected") {
      throw new Error(`STT failed: ${sttResult.reason.message}`);
    }

    const transcript = (sttResult.value.text || "").trim();
    const stt = sttResult.value;

    const context = {
      session: metadata.session || {},
      device,
      gps,
      location,
      weather
    };

    const answer = await askFieldAssistant(transcript, context);

    let replyAudioUrl = "";
    try {
      const replyBuffer = await callGatewayTts(answer);
      const replyFileName = `embervox-${Date.now()}.wav`;
      fs.writeFileSync(path.join(audioDir, replyFileName), replyBuffer);
      replyAudioUrl = publicAudioUrl(replyFileName);
    } catch (err) {
      console.error("EMBERVOX TTS ERROR:", err.message);
    }

    const record = {
      ok: true,
      source: "PTT Field Logger",
      version: "1.0.0",
      sessionId,
      createdAt: new Date().toISOString(),
      inputAudioUrl,
      transcript,
      stt,
      answer,
      replyAudioUrl,
      gps,
      location,
      weather,
      device,
      session: metadata.session || {}
    };

    const sheetRecord = makeFlatSheetRecord({
      sessionId,
      metadata,
      transcript,
      answer,
      inputAudioUrl,
      replyAudioUrl,
      gps,
      location,
      weather,
      stt,
      savedAudioPath,
      savedAudioName,
      audioMimeType: req.file.mimetype
    });

    let sheet = null;
    try {
      sheet = await logToSheet(sheetRecord);
      if (sheet?.audioUrl) {
        record.driveAudioUrl = sheet.audioUrl;
      }
    } catch (err) {
      sheet = { ok: false, error: err.message };
      console.error("GOOGLE SHEET LOG ERROR:", err.message);
    }

    return res.json({ ...record, sheet });

  } catch (err) {
    console.error("FIELD SESSION ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });

  } finally {
    if (uploadedPath) fs.unlink(uploadedPath, () => {});
  }
}

/* ---------------- HEALTH ---------------- */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "PTT Field Logger",
    service: "ptt-field-logger",
    version: "1.0.0",
    gateway: GATEWAY_BASE_URL
  });
});

/* ---------------- FIELD SESSION ORCHESTRATION ---------------- */

app.post("/api/field-session", upload.single("audio"), async (req, res) => {
  return handleFieldSession(req, res, false);
});

/* Backward-compatible endpoint for old test clients. */
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  return handleFieldSession(req, res, true);
});

/* ---------------- START ---------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PTT Field Logger v1.0 running on port ${PORT}`);
  console.log(`Gateway: ${GATEWAY_BASE_URL}`);
});
