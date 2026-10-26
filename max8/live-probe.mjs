import { pathToFileURL } from "node:url";
import { validReplyWav, validPcmWav } from "./max8-turn.mjs";

export function toWatchWav(source) {
  if (!validReplyWav(source)) throw new Error("Fixture TTS did not return compatible PCM WAV");
  let format, samples;
  for (let at = 12; at + 8 <= source.length;) {
    const length = source.readUInt32LE(at + 4);
    const kind = source.toString("ascii", at, at + 4);
    if (kind === "fmt ") format = { channels: source.readUInt16LE(at + 10), rate: source.readUInt32LE(at + 12) };
    if (kind === "data") samples = source.subarray(at + 8, at + 8 + length);
    at += 8 + length + (length & 1);
  }
  const frames = samples.length / (format.channels * 2);
  const count = Math.floor(frames * 24000 / format.rate);
  if (count < 1 || count > 240000) throw new Error("Fixture must contain less than ten seconds of speech");
  const wav = Buffer.alloc(44 + count * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(count * 2, 40);
  const mono = frame => {
    let value = 0;
    for (let channel = 0; channel < format.channels; channel++) value += samples.readInt16LE((frame * format.channels + channel) * 2);
    return value / format.channels;
  };
  for (let i = 0; i < count; i++) {
    const position = i * format.rate / 24000;
    const a = Math.min(Math.floor(position), frames - 1), b = Math.min(a + 1, frames - 1);
    const fraction = position - a;
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono(a) * (1 - fraction) + mono(b) * fraction))), 44 + i * 2);
  }
  if (!validPcmWav(wav)) throw new Error("Resampled fixture failed watch contract");
  return wav;
}

export async function probe({ root, gateway, token, fetchImpl = fetch }) {
  const health = await fetchImpl(root + "/health", { signal: AbortSignal.timeout(10000) });
  const ready = await health.json();
  if (!health.ok || ready.service !== "max8-watch" || ready.contract !== "max8-wav-v1") throw new Error("Unexpected readiness response");
  const denied = await fetchImpl(root + "/api/max8/turn", { method: "POST", signal: AbortSignal.timeout(10000) });
  if (denied.status !== 401) throw new Error("Unauthenticated request was not rejected");
  const wrong = await fetchImpl(root + "/api/max8/turn", { method: "POST",
    headers: { Authorization: "Bearer invalid-test-token" }, signal: AbortSignal.timeout(10000) });
  if (wrong.status !== 401) throw new Error("Wrong-token request was not rejected");
  const fixture = await fetchImpl(gateway.replace(/\/$/, "") + "/tts/speak", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Hello Max. Say hello." }),
    redirect: "error", signal: AbortSignal.timeout(45000)
  });
  if (!fixture.ok) throw new Error("Fixture TTS HTTP " + fixture.status);
  const bytes = Buffer.from(await fixture.arrayBuffer());
  const audio = toWatchWav(bytes);
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "synthetic-test.wav");
  const started = Date.now();
  const response = await fetchImpl(root + "/api/max8/turn", {
    method: "POST", headers: { Authorization: "Bearer " + token },
    body: form, redirect: "error", signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) {
    const code = (await response.json().catch(() => ({}))).error;
    throw new Error("Conversation HTTP " + response.status + (typeof code === "string" && /^[A-Z_]+$/.test(code) ? " " + code : ""));
  }
  const reply = Buffer.from(await response.arrayBuffer());
  if (!validReplyWav(reply)) throw new Error("Conversation reply was not valid watch PCM");
  if (response.headers.get("cache-control") !== "no-store") throw new Error("Conversation response was cacheable");
  const transcript = decodeURIComponent(response.headers.get("x-max8-transcript") || "");
  const answer = decodeURIComponent(response.headers.get("x-max8-reply") || "");
  if (!transcript || !answer) throw new Error("Missing transcript or answer evidence");
  return { result: "PASS", test: "synthetic-server-conversation", elapsedMs: Date.now() - started,
    inputBytes: audio.length, replyBytes: reply.length, transcript, answer,
    hardwareVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probe({ root: process.env.MAX8_PROBE_ROOT || "http://127.0.0.1:8788",
      gateway: process.env.GATEWAY_BASE_URL || "https://api.sagewire.dev", token: process.env.MAX8_DEVICE_TOKEN });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Only our bounded diagnostic text is emitted, never upstream bodies or keys.
    console.error("MAX-8 live probe failed: " + (error?.message || "unknown failure"));
    process.exitCode = 1;
  }
}
