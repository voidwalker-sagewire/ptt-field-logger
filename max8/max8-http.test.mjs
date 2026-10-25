import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createMax8Router } from "./max8-router.mjs";
import { createMax8Pipeline } from "./max8-pipeline.mjs";
import { validReplyWav } from "./max8-turn.mjs";

const token = "test-only-" + "a".repeat(32);
function wav(rate = 24000) {
  const b = Buffer.alloc(44 + rate * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
async function host(t, options) {
  const app = express(); app.use(createMax8Router(options));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/api/max8/turn`;
}
function upload(bytes = wav(), extra = {}) {
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: "audio/wav" }), "max8.wav");
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return { method: "POST", headers: { Authorization: "Bearer " + token }, body: form };
}
test("HTTP multipart watch request traverses STT, AI, TTS adapters and returns playable PCM", async t => {
  const calls = [];
  const reply = wav(22050);
  const pipeline = createMax8Pipeline({ baseUrl: "https://gateway.example", openai: {
    chat: { completions: { create: async (body, options) => {
      calls.push("ai"); assert.equal(body.messages.at(-1).content, "Hello MAX-8");
      assert.equal(body.messages[1].content, "Earlier question");
      assert.ok(options.signal); return { choices: [{ message: { content: "Hello Massive" } }] };
    } } }
  }, fetchImpl: async (url, options) => {
    assert.ok(options.signal); assert.equal(options.redirect, "error");
    if (url.endsWith("/stt/transcribe")) {
      calls.push("stt");
      assert.deepEqual(Buffer.from(await options.body.get("audio").arrayBuffer()), wav());
      return Response.json({ text: "Hello MAX-8" });
    }
    assert.equal(url, "https://gateway.example/tts/speak");
    calls.push("tts"); assert.deepEqual(JSON.parse(options.body), { text: "Hello Massive" });
    return new Response(reply, { headers: { "Content-Type": "audio/wav" } });
  } });
  const url = await host(t, { token, ...pipeline });
  const res = await fetch(url, upload(wav(), { history: JSON.stringify([{ role: "user", content: "Earlier question" }]) }));
  assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-type"), /^audio\/wav/);
  assert.equal(decodeURIComponent(res.headers.get("x-max8-transcript")), "Hello MAX-8");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), reply);
  assert.deepEqual(calls, ["stt", "ai", "tts"]);
});
test("HTTP authentication precedes upload parsing and speech work", async t => {
  let calls = 0;
  const url = await host(t, { token, transcribe: () => { calls++; } });
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "multipart/form-data" }, body: "broken" });
  assert.equal(res.status, 401); assert.equal(calls, 0);
  const disabled = await host(t, {});
  assert.equal((await fetch(disabled, { method: "POST" })).status, 503);
});
test("HTTP upload bounds reject oversized files and excessive form fields before STT", async t => {
  let calls = 0;
  const url = await host(t, { token, transcribe: () => { calls++; } });
  assert.equal((await fetch(url, upload(Buffer.alloc(1048577)))).status, 413);
  assert.equal((await fetch(url, upload(wav(), { history: "[]", unexpected: "x" }))).status, 400);
  assert.equal((await fetch(url, upload(wav(), { history: "x".repeat(8193) }))).status, 400);
  assert.equal(calls, 0);
});
test("deadline aborts the pipeline and prevents later AI/TTS stages", async t => {
  let signal, finish, calls = 0;
  const url = await host(t, { token, timeoutMs: 20,
    transcribe: (_wav, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); },
    answer: () => { calls++; return "late"; }, speak: () => { calls++; return wav(); }
  });
  const res = await fetch(url, upload());
  assert.equal(res.status, 502); assert.equal(signal.aborted, true);
  finish({ text: "late transcript" }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});
test("Piper reply validation rejects truncation, compressed data, invalid alignment and oversized audio", () => {
  assert.equal(validReplyWav(wav(22050)), true);
  assert.equal(validReplyWav(wav(44100)), true);
  assert.equal(validReplyWav(wav().subarray(0, 100)), false);
  const compressed = wav(); compressed.writeUInt16LE(3, 20);
  assert.equal(validReplyWav(compressed), false);
  const badRate = wav(); badRate.writeUInt32LE(1, 28);
  assert.equal(validReplyWav(badRate), false);
  assert.equal(validReplyWav(Buffer.alloc(2097152)), false);
});
test("TTS adapter stops an oversized upstream stream", async () => {
  const pipeline = createMax8Pipeline({ baseUrl: "https://gateway.example", openai: {},
    fetchImpl: async () => new Response(Buffer.alloc(2097152)) });
  await assert.rejects(pipeline.speak("hello", new AbortController().signal), /TTS_TOO_LARGE/);
});
