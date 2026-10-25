const AUDIO_MAX = 2 * 1024 * 1024;

export function createMax8Pipeline({ baseUrl, openai, model = "gpt-4o-mini", fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/$/, "");
  return {
    async transcribe(wavBytes, signal) {
      const form = new FormData();
      form.append("audio", new Blob([wavBytes], { type: "audio/wav" }), "max8.wav");
      const response = await fetchImpl(root + "/stt/transcribe", {
        method: "POST", body: form, signal, redirect: "error"
      });
      if (!response.ok) throw new Error("STT_UPSTREAM_FAILED");
      return response.json();
    },
    async answer(transcript, history, signal) {
      const result = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: "You are MAX-8, an original witty and slightly sarcastic miniature television personality. Be warm, fun and conversational, not an imitation of an existing character. Keep voice replies to 1-2 short sentences. Never claim to have performed actions you haven't done." },
          ...history, { role: "user", content: transcript }
        ],
        max_tokens: 120
      }, { signal, maxRetries: 0 });
      return result.choices?.[0]?.message?.content || "";
    },
    async speak(text, signal) {
      const response = await fetchImpl(root + "/tts/speak", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }), signal, redirect: "error"
      });
      if (!response.ok || !response.body) throw new Error("TTS_UPSTREAM_FAILED");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes >= AUDIO_MAX) throw new Error("TTS_TOO_LARGE");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
  };
}
