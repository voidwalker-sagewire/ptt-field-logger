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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = __dirname;
const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const original = file.originalname || "audio.webm";
    const safe = original.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safe);
  }
});

const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "PTT Field Logger",
    service: "headset-bridge",
    summary_enabled: true,
    api_routes: ["/api/transcribe", "/transcribe"]
  });
});

app.get("/api/transcribe", (req, res) => {
  res.status(405).json({
    ok: false,
    error: "Use POST with an audio file"
  });
});

app.get("/transcribe", (req, res) => {
  res.status(405).json({
    ok: false,
    error: "Use POST with an audio file"
  });
});

async function handleTranscribe(req, res) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_API_KEY is not set"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No audio file uploaded"
      });
    }

    console.log("========== AUDIO UPLOAD ==========");
    console.log("File name:", req.file.originalname);
    console.log("Mime type:", req.file.mimetype);
    console.log("Size bytes:", req.file.size);
    console.log("==================================");

    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-mini-transcribe"
    });

    const transcriptText = result.text || "";
    let summary = "";

    if (transcriptText.trim()) {
      const summaryResult = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Summarize headset field notes clearly and briefly. If there are action items, list them. If it is only a test recording, say it was a test."
          },
          {
            role: "user",
            content: transcriptText
          }
        ]
      });

      summary = summaryResult.choices?.[0]?.message?.content || "";
    }

    fs.unlink(req.file.path, () => {});

    console.log("TRANSCRIPT:", transcriptText);
    console.log("SUMMARY:", summary);

    return res.json({
      ok: true,
      text: transcriptText,
      summary
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
}

app.post("/api/transcribe", upload.single("audio"), handleTranscribe);
app.post("/transcribe", upload.single("audio"), handleTranscribe);

app.post("/api/log-session", async (req, res) => {
  try {
    if (!process.env.GOOGLE_SHEET_WEBHOOK_URL) {
      return res.status(500).json({
        ok: false,
        error: "GOOGLE_SHEET_WEBHOOK_URL is not set"
      });
    }

    const sheetResponse = await fetch(process.env.GOOGLE_SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    const text = await sheetResponse.text();

    return res.json({
      ok: true,
      sheetResponse: text
    });
  } catch (err) {
    console.error("LOG SESSION ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PTT Field Logger running on port ${PORT}`);
});
