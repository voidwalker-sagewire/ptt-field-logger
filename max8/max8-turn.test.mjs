import test from "node:test";
import assert from "node:assert/strict";
import { authorized, validPcmWav, createMax8TurnHandler } from "./max8-turn.mjs";

function wav(rate=24000, channels=1, seconds=1) {
  const bytes = rate * channels * 2 * seconds;
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF",0);b.writeUInt32LE(36+bytes,4);b.write("WAVEfmt ",8);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);
  b.writeUInt16LE(channels,22);b.writeUInt32LE(rate,24);
  b.writeUInt32LE(rate*channels*2,28);b.writeUInt16LE(channels*2,32);
  b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(bytes,40);
  return b;
}
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(n){this.statusCode=n;return this;},
    set(k,v){this.headers[k]=v;return this;},
    type(v){this.headers["Content-Type"]=v;return this;},
    json(v){this.body=v;return this;},
    send(v){this.body=v;return this;}
  };
}
function req(bytes, token="secret") {
  return { file: bytes?{buffer:bytes}:undefined, get: name => name==="authorization" ? "Bearer "+token : undefined };
}
test("accepts valid PCM WAV and rejects common malformed inputs", ()=>{
  assert.equal(validPcmWav(wav()),true);
  assert.equal(validPcmWav(wav(16000,2,2)),true);
  assert.equal(validPcmWav(wav(44100)),false);
  assert.equal(validPcmWav(Buffer.alloc(12)),false);
  const broken=wav();broken.writeUInt16LE(3,20);
  assert.equal(validPcmWav(broken),false);
  const huge=wav(24000,2,11);
  assert.equal(validPcmWav(huge),false);
});
test("token check requires a configured secret and exact match",()=>{
  assert.equal(authorized("Bearer secret","secret"),true);
  assert.equal(authorized("Bearer secrex","secret"),false);
  assert.equal(authorized("Bearer secret",""),false);
  assert.equal(authorized(undefined,"secret"),false);
});
test("unauthorized requests never call speech services",async()=>{
  let calls=0;
  const h=createMax8TurnHandler({token:"secret",
    transcribe:async()=>{calls++;return{text:"hi"};},
    answer:async()=>{calls++;return"hello";},
    speak:async()=>{calls++;return wav();}
  });
  const res=mockRes();
  await h(req(wav(),"wrong"),res);
  assert.equal(res.statusCode,401);
  assert.equal(calls,0);
});
test("valid turn transcribes, generates answer and streams Piper WAV",async()=>{
  let actualWav, actualTranscript, actualReply;
  const h=createMax8TurnHandler({token:"secret",
    transcribe:async b=>{actualWav=b;return{text:"Hello Max!"};},
    answer:async t=>{actualTranscript=t;return"What's up, carbon unit?";},
    speak:async r=>{actualReply=r;return wav();}
  });
  const input=wav(24000,1,3);
  const res=mockRes();
  await h(req(input),res);
  assert.equal(res.statusCode,200);
  assert.strictEqual(actualWav,input);
  assert.equal(actualTranscript,"Hello Max!");
  assert.equal(actualReply,"What's up, carbon unit?");
  assert.equal(decodeURIComponent(res.headers["X-Max8-Reply"]),actualReply);
  assert.equal(res.headers["Cache-Control"],"no-store");
  assert.ok(Buffer.isBuffer(res.body));
});
test("no speech fails closed without calling AI or voice",async()=>{
  let calls=0;
  const h=createMax8TurnHandler({token:"secret",
    transcribe:async()=>({text:" "}),
    answer:async()=>{calls++;return"no";},
    speak:async()=>{calls++;return wav()}
  });
  const res=mockRes(); await h(req(wav()),res);
  assert.equal(res.statusCode,422);assert.equal(calls,0);
});
test("invalid TTS response gives honest upstream error",async()=>{
  const h=createMax8TurnHandler({token:"secret",
    transcribe:async()=>({text:"hi"}),
    answer:async()=>("hey"),
    speak:async()=>Buffer.from("not-a-wav")
  });
  const res=mockRes();await h(req(wav()),res);
  assert.equal(res.statusCode,502);
  assert.equal(res.body.error,"TTS_INVALID_WAV");
});
