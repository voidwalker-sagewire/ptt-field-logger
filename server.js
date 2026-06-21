import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { google } from "googleapis";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8787;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const safe = (file.originalname || "audio.webm").replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  }
});

const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ---------------- HEALTH ---------------- */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "PTT Field Logger",
    service: "headset-bridge"
  });
});

/* ---------------- TRANSCRIBE ---------------- */

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No audio file uploaded" });
    }

    /* ---------------- OPENAI TRANSCRIBE ---------------- */

    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-mini-transcribe"
    });

    const transcriptText = result.text || "";

    /* ---------------- SUMMARY ---------------- */

    let summary = "";

    if (transcriptText.trim()) {
      const summaryResult = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Summarize field notes briefly. List action items if present. If test recording, say so."
          },
          {
            role: "user",
            content: transcriptText
          }
        ]
      });

      summary = summaryResult.choices?.[0]?.message?.content || "";
    }

    /* ---------------- GOOGLE DRIVE UPLOAD ---------------- */

    let audioUrl = "";

    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
        scopes: ["https://www.googleapis.com/auth/drive"]
      });

      const drive = google.drive({ version: "v3", auth });

      const upload = await drive.files.create({
        requestBody: {
          name: req.file.originalname,
          parents: [process.env.DRIVE_FOLDER_ID]
        },
        media: {
          body: fs.createReadStream(req.file.path)
        }
      });

      await drive.permissions.create({
        fileId: upload.data.id,
        requestBody: {
          role: "reader",
          type: "anyone"
        }
      });

      audioUrl = `https://drive.google.com/file/d/${upload.data.id}/view`;

    } catch (err) {
      console.error("DRIVE ERROR:", err.message);
    }

    /* ---------------- CLEANUP ---------------- */

    fs.unlink(req.file.path, () => {});

    /* ---------------- RESPONSE ---------------- */

    return res.json({
      ok: true,
      text: transcriptText,
      summary,
      audioUrl
    });

  } catch (err) {
    console.error("TRANSCRIBE ERROR:", err);

    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }

    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ---------------- LOG TO SHEET (NO AUDIO HERE) ---------------- */

app.post("/api/log-session", async (req, res) => {
  try {
    if (!process.env.GOOGLE_SHEET_WEBHOOK_URL) {
      return res.status(500).json({ ok: false, error: "Missing webhook URL" });
    }

    const response = await fetch(process.env.GOOGLE_SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });

    const text = await response.text();

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: false, error: text };
    }

    return res.json({
      ok: true,
      sheet: payload
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ---------------- START ---------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PTT Field Logger running on port ${PORT}`);
});
