import express from "express";
import multer from "multer";
import { authorized, createMax8TurnHandler } from "./max8-turn.mjs";

// Isolated from the field logger: no disk upload, location, or Sheets calls.
export function createMax8Router(options) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1048576, files: 1, fields: 1, fieldSize: 8192, parts: 3 }
  }).single("audio");
  const turn = createMax8TurnHandler(options);
  router.post("/api/max8/turn", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!options.token) return res.status(503).json({ error: "MAX8_NOT_CONFIGURED" });
    if (!authorized(req.get("authorization"), options.token)) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    upload(req, res, error => {
      if (error) return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({ error: "INVALID_AUDIO_UPLOAD" });
      next();
    });
  }, turn);
  return router;
}
