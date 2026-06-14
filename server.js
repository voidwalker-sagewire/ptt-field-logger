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

const publicDir = path.join(__dirname, "public");
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
    service: "headset-bridge"
  });
});

app.post("/transcribe", upload.single("audio"), async (req, res) => {
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

    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-mini-transcribe"
    });

    fs.unlink(req.file.path, () => {});

    res.json({
      ok: true,
      text: result.text || ""
    });
  } catch (err) {
    console.error("TRANSCRIBE ERROR:", err);
    res.status(500).json({
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
