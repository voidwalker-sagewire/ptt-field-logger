# PTT Field Logger v1.0

Gateway-centered rewrite of the PTT Field Logger.

## Architecture

The browser is a thin client:

1. Connect headset
2. Record audio
3. Capture GPS
4. Send one multipart request to `/api/field-session`
5. Play the returned EmberVox reply

The server orchestrates through SageWire Gateway:

- STT: `https://api.sagewire.dev/stt/transcribe`
- LOC: `https://api.sagewire.dev/loc/stamp`
- TTS: `https://api.sagewire.dev/tts/speak`
- WX: `https://weather.herdmate.ag`
- LOG: Google Apps Script webhook

## Required environment variables

```txt
OPENAI_API_KEY=...
GATEWAY_BASE_URL=https://api.sagewire.dev
WEATHER_BASE_URL=https://weather.herdmate.ag
PUBLIC_BASE_URL=https://headset.herdmate.ag
GOOGLE_SHEET_WEBHOOK_URL=...
PORT=8787
```

## Endpoints

```txt
GET  /health
POST /api/field-session
POST /api/transcribe   legacy alias
```

## Main request

`POST /api/field-session`

Multipart form fields:

```txt
audio     audio file
metadata  JSON string
```

## Google Apps Script Logger

The file `google-apps-script.gs` is included for the Google Sheet/Drive logger.

It saves uploaded audio to Drive when `audioBase64` is provided, writes the Drive audio URL into the `PTT_Log` sheet, and records transcript, reply, GPS, weather, LOC, STT, and device metadata.

Expected sheet tab:

```txt
PTT_Log
```

Expected Drive audio folder:

```txt
1ANLKiljvno8a4pwG-otgXd8U0gYfQMms
```

## Notes

Hazel naming has been removed from the frontend and main pipeline. Reply audio is stored as `embervox-*.wav`.
