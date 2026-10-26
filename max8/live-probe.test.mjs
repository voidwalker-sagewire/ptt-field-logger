import test from "node:test";
import assert from "node:assert/strict";
import { toWatchWav, probe } from "./live-probe.mjs";
import { validPcmWav } from "./max8-turn.mjs";

function wav(rate = 22050, channels = 1, seconds = 1) {
  const n = Math.round(rate * seconds), b = Buffer.alloc(44 + n * channels * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(c ? -2000 : 4000, 44 + (i * channels + c) * 2);
  return b;
}
test("synthetic Piper fixture converts to watch PCM without changing duration", () => {
  for (const rate of [8000, 16000, 22050, 24000, 44100, 48000]) {
    const out = toWatchWav(wav(rate));
    assert.equal(validPcmWav(out), true); assert.equal(out.length, 48044);
    assert.equal(out.readInt16LE(44), 4000);
  }
  assert.equal(toWatchWav(wav(22050, 2)).readInt16LE(44), 1000);
  assert.throws(() => toWatchWav(Buffer.alloc(44)), /compatible PCM/);
  assert.throws(() => toWatchWav(wav(16000, 1, 11)), /ten seconds/);
});
test("probe requires authentication rejection and a complete actual request contract", async () => {
  let turns = 0;
  const result = await probe({ root: "http://stage", gateway: "https://gateway", token: "test-device-token",
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/health")) return Response.json({ service: "max8-watch", contract: "max8-wav-v1" });
      if (url.endsWith("/tts/speak")) {
        assert.deepEqual(JSON.parse(options.body), { text: "Hello Max. Say hello." });
        return new Response(wav());
      }
      if (options.headers?.Authorization !== "Bearer test-device-token") return Response.json({}, { status: 401 });
      turns++;
      assert.equal(validPcmWav(Buffer.from(await options.body.get("audio").arrayBuffer())), true);
      return new Response(wav(), { headers: { "Cache-Control": "no-store", "X-Max8-Transcript": "Hello%20Max", "X-Max8-Reply": "Hello" } });
    } });
  assert.equal(result.result, "PASS"); assert.equal(result.hardwareVerified, false); assert.equal(turns, 1);
});
test("probe stops before speech if authentication is not enforced", async () => {
  let calls = 0;
  await assert.rejects(probe({ root: "http://stage", gateway: "https://gateway", token: "x", fetchImpl: async url => {
    calls++;
    return url.endsWith("/health") ? Response.json({ service: "max8-watch", contract: "max8-wav-v1" }) : new Response("unexpected");
  } }), /not rejected/);
  assert.equal(calls, 2);
});
