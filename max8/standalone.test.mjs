import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createStandaloneApp } from "./standalone.mjs";

test("isolated adapter refuses missing or invalid device tokens", () => {
  for (const token of [undefined, "", "short", "a".repeat(31) + "\n"]) {
    assert.throws(() => createStandaloneApp({ token, pipeline: {} }), /MAX8_DEVICE_TOKEN/);
  }
});

test("isolated adapter exposes readiness and authenticated voice only, without field logger routes", async t => {
  let calls = 0;
  const app = createStandaloneApp({ token: "a".repeat(64), pipeline: {
    transcribe: async () => { calls++; return { text: "hello" }; }
  } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = "http://127.0.0.1:" + server.address().port;
  const health = await fetch(root + "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { service: "max8-watch", contract: "max8-wav-v1", configured: true });
  const denied = await fetch(root + "/api/max8/turn", { method: "POST" });
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  for (const path of ["/api/field-session", "/api/transcribe", "/server.js", "/.env"]) {
    assert.equal((await fetch(root + path, { method: "POST" })).status, 404);
  }
});
