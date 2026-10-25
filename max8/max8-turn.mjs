import { timingSafeEqual } from "node:crypto";

// No recording storage: process a bounded WAV in memory and return Piper audio.
// Nothing is sent to STT or the AI model until device authentication succeeds.
function validateWav(buffer, rates, maxBytes, maxSeconds) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > maxBytes) return false;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WAVE") return false;
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) return false;
  let pos = 12, fmt = null, dataBytes = 0;
  while (pos + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(pos + 4);
    const name = buffer.toString("ascii", pos, pos + 4);
    if (size > buffer.length - pos - 8) return false;
    if (name === "fmt " && size >= 16) {
      if (fmt) return false;
      fmt = {
        codec: buffer.readUInt16LE(pos + 8),
        channels: buffer.readUInt16LE(pos + 10),
        rate: buffer.readUInt32LE(pos + 12),
        byteRate: buffer.readUInt32LE(pos + 16),
        align: buffer.readUInt16LE(pos + 20),
        bits: buffer.readUInt16LE(pos + 22)
      };
    }
    if (name === "data") {
      if (dataBytes || !size) return false;
      dataBytes = size;
    }
    pos += 8 + size + (size % 2);
  }
  if (pos !== buffer.length || !fmt || !dataBytes || fmt.codec !== 1 || fmt.bits !== 16 ||
      ![1, 2].includes(fmt.channels) ||
      !rates(fmt.rate)) return false;
  if (fmt.align !== fmt.channels * 2 ||
      fmt.byteRate !== fmt.rate * fmt.align ||
      dataBytes % fmt.align !== 0) return false;
  return dataBytes / fmt.byteRate <= maxSeconds;
}
export function validPcmWav(buffer) {
  return validateWav(buffer, rate => [16000, 24000].includes(rate), 1048576, 10);
}
export function validReplyWav(buffer) {
  // Piper voices may produce 22050 Hz; match the native player's PCM limits.
  return validateWav(buffer, rate => rate >= 8000 && rate <= 48000, 2097151, 45);
}

export function authorized(header, configuredToken) {
  if (!configuredToken || !header?.startsWith("Bearer ")) return false;
  const expected = Buffer.from(configuredToken, "utf8");
  const actual = Buffer.from(header.slice(7), "utf8");
  return actual.length === expected.length &&
    timingSafeEqual(actual, expected);
}

export function safeHistory(raw) {
  let entries;
  try { entries = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { return []; }
  if (!Array.isArray(entries)) return [];
  return entries.slice(-6)
    .filter(e => e && (e.role === "user" || e.role === "assistant") && typeof e.content === "string")
    .map(e => ({ role: e.role, content: e.content.trim().slice(0, 320) }))
    .filter(e => e.content);
}

export function createMax8TurnHandler({ token, transcribe, answer, speak, timeoutMs = 75000 }) {
  return async function max8Turn(req, res) {
    if (!token) return res.status(503).json({ error: "MAX8_NOT_CONFIGURED" });
    if (!authorized(req.get("authorization"), token)) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    if (!req.file?.buffer || !validPcmWav(req.file.buffer)) {
      return res.status(400).json({ error: "INVALID_PCM_WAV" });
    }
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("TURN_TIMEOUT"));
      }, timeoutMs);
    });
    const pipeline = async () => {
      const recognized = await transcribe(req.file.buffer, controller.signal);
      controller.signal.throwIfAborted();
      const transcript = String(recognized?.text || "").trim().slice(0, 800);
      if (!transcript) return res.status(422).json({ error: "NO_SPEECH_DETECTED" });
      const response = String(await answer(transcript, safeHistory(req.body?.history), controller.signal)).trim().slice(0, 320);
      if (!response) return res.status(502).json({ error: "AI_EMPTY_RESPONSE" });
      controller.signal.throwIfAborted();
      const audio = await speak(response, controller.signal);
      controller.signal.throwIfAborted();
      if (!validReplyWav(audio)) {
        return res.status(502).json({ error: "TTS_INVALID_WAV" });
      }
      res.set("Cache-Control", "no-store");
      res.set("X-Max8-Transcript", encodeURIComponent(transcript));
      res.set("X-Max8-Reply", encodeURIComponent(response));
      return res.status(200).type("audio/wav").send(audio);
    };
    try {
      return await Promise.race([pipeline(), expired]);
    } catch (error) {
      console.error("MAX8 turn failed:", error?.name || "request_failure");
      return res.status(502).json({ error: "SPEECH_PIPELINE_UNAVAILABLE" });
    } finally {
      clearTimeout(timer);
    }
  };
}