import express from "express";
import OpenAI from "openai";
import { pathToFileURL } from "node:url";
import { createMax8Router } from "./max8-router.mjs";
import { createMax8Pipeline } from "./max8-pipeline.mjs";

export function createStandaloneApp({ token, pipeline }) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token || "")) {
    throw new Error("MAX8_DEVICE_TOKEN must be a dedicated 32-128 character device token");
  }
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.set("Cache-Control", "no-store").json({
      service: "max8-watch", contract: "max8-wav-v1", configured: true
    });
  });
  app.use(createMax8Router({ token, ...pipeline }));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const baseUrl = process.env.GATEWAY_BASE_URL || "https://api.sagewire.dev";
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Gateway requires an HTTPS URL without embedded credentials");
  }
  const app = createStandaloneApp({
    token: process.env.MAX8_DEVICE_TOKEN,
    pipeline: createMax8Pipeline({
      baseUrl,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    })
  });
  const port = Number(process.env.PORT || 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  app.listen(port, "0.0.0.0", () => console.log("MAX-8 isolated voice adapter listening on " + port));
}
