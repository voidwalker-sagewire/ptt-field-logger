# MAX-8 configuration and commissioning

This branch is a software candidate, not permission to flash or merge. No server
deployment, watch write, partition change, eFuse change, or OTA update is included.

## Configuration method

Use the pinned factory launcher **Settings > WLAN** for Wi-Fi selection and password
entry. Its resident `system_status` service configures the ESP Wi-Fi driver and
handles reconnects even after the settings page closes. Reuse this owner rather
than introducing a second Wi-Fi stack, captive access point or Bluetooth service.
Wi-Fi persistence/reconnect after cold boot still requires a physical test.

In the MAX-8 app, open **SETUP**. Enter the full HTTPS URL ending in
`/api/max8/turn`, and a device token of 32–128 ASCII letters, digits, `-` or `_`.
Only default HTTPS port 443 is accepted. Queries, fragments, userinfo and alternate
paths are rejected. Use a randomly generated dedicated token; never use an OpenAI
API key, SSH key, account password or shared gateway administrator credential.
Generate the token locally with a cryptographic random source (for example,
`openssl rand -hex 32`) when preparing the separately reviewed deployment. Do not
put its output in source, chat, GitHub Actions inputs or logs.

**SAVE** validates and writes endpoint and token as one versioned NVS blob under
`max8/config_v1`. It reports storage errors and never starts a network request or
microphone capture. Reopening setup shows the endpoint but does not populate the
saved token in the input field. A blank token keeps the saved value. Entering a
replacement rotates the device's local value; the matching server change is a
separate controlled operation. **CLEAR**, pressed twice consecutively, removes
only this MAX-8 configuration key. It does not erase Wi-Fi or the flash partition.
Old development `max8/endpoint` and `max8/token` string keys are not used or erased.

The server must be configured separately with the matching `MAX8_DEVICE_TOKEN`
and its existing server-side model credentials. Saving on the watch neither
deploys this route nor proves that the token is accepted. The current server uses
one deployment token: per-device enrollment, revocation and fleet management are
not implemented.

Tokens are masked during entry and are not logged. Ordinary NVS is **not** a
secure hardware vault; this patch does not enable NVS/flash encryption or secure
boot, and does not burn irreversible eFuses. A physical flash backup can contain
Wi-Fi credentials and the device token and must be kept private. Logical clear
is not a forensic secure erase. Token revocation remains a server responsibility.
The ESP-IDF NVS durability/encryption limits are documented at:
https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32s3/api-reference/storage/nvs_flash.html

## Conversation request contract

The watch explicitly sends `POST /api/max8/turn`, bearer authentication and
multipart field `audio` containing three seconds of 24 kHz mono 16-bit PCM WAV.
The server adapter calls gateway `/stt/transcribe`, then the server-side model,
then gateway `/tts/speak`, and returns raw PCM WAV. Direct STT/TTS and health
endpoints cannot substitute for this orchestration route. The firmware validates
TLS certificates and refuses HTTP redirects. It checks configuration and Wi-Fi
before acquiring the microphone. It uses a 90-second transport timeout; the server
pipeline has a 75-second total deadline, aborts upstream requests, and disables AI
request retries. These are failure bounds, not a promise of acceptable latency.
The native UI still does not send conversation history.

Input is limited to 1 MiB, ten seconds, 16/24 kHz, 16-bit PCM and one/two channels.
Reply validation accepts 8–48 kHz 16-bit PCM, one/two channels, at most 45 seconds
and strictly less than 2 MiB. This includes Piper's 22050 Hz voices. HTTP tests
exercise real local multipart parsing with substituted STT/AI/TTS dependencies;
they do not contact production services. Native configuration tests compile the
actual storage implementation against an NVS test double. They test validation,
round trips, malformed storage and API failures, not physical flash durability.

## Evidence inspected on October 25, 2026

- PR #1 remains draft and unmerged. Its inspected head is
  `35ba8a0864857818eaed57bf3893ecc05cb706fe`.
- Its native build and voice-contract workflow passed in run
  https://github.com/voidwalker-sagewire/ptt-field-logger/actions/runs/40237998150
  (a newer baseline than the milestone's `51d4fbe` run).
- Reachability run
  https://github.com/voidwalker-sagewire/ptt-field-logger/actions/runs/40237998197
  returned HTTP 200 for the five public health/services URLs but HTTP 404 for
  unauthenticated POST `/api/max8/turn` on both `headset.herdmate.ag` and
  `api.sagewire.dev`. Neither host established a deployed MAX-8 route.
- DigitalOcean inventory lists active `dave-brain-server`, `piper-tts` and
  `forgekeeper-worker` droplets. Inventory status does not inspect processes,
  prove which code is running, or verify a conversation.
- Inspected repository source in
  https://github.com/voidwalker-sagewire/sagewire-api-gateway/blob/main/server.py
  (file blob `4be736873d23845d5a3f15166964680f66b51b0e`) provides multipart
  `/stt/transcribe` and JSON `{text}` `/tts/speak` proxies. These match the
  adapter's upstream requests. It has no MAX-8 orchestration route. This is
  source compatibility, not evidence that this exact source is running or
  that its upstream voices return compatible PCM in production.
- Existing CI firmware artifacts are left in place. Their original retention
  deadlines remain in effect; this work does not extend them.

## First safe physical-watch test

The first session must preserve the current installation. Record the watch's
current behavior/version and confirm the exact Waveshare board and USB recovery
connection. Using the ROM loader's **read-only** commands, identify the chip and
flash size and obtain two full-flash reads with matching hashes. Keep the backup
private. Do not erase flash, write NVS, change partitions or flash the candidate.
A successful backup establishes a recovery asset, not a verified restoration.
If the tablet cannot reliably reach the ROM loader, stop before any watch write.

Before authorizing a later candidate installation, review the exact CI commit and
binary hashes, existing partition map, bootloader/flash settings, complete backup
and USB rescue instructions. Demonstrate restoration on a spare equivalent board
where possible. No verified rollback exists yet. Keep the existing partition
layout for this work; do not describe this candidate as OTA safe.

After those gates and explicit installation authorization, the first candidate
test is **local configuration only**: open setup with no configuration, press
TALK and confirm it refuses capture; reject invalid endpoint/token; save a test
pair without network activity; cold boot and confirm persistence; replace and
clear the pair, cold boot again, confirm Wi-Fi is retained and TALK refuses
capture. Check logs/audio instrumentation for the no-capture assertion; UI text
alone is insufficient evidence. Then test Wi-Fi loss and reconnect, TLS trust and
clock synchronization, and wrong-token errors before sending personal speech.

## Later validation gates

1. Deploy a separately reviewed staging adapter with a dedicated test token,
   keeping existing services intact. Send an intentional, non-sensitive speech
   fixture through the exact authenticated HTTPS route. Confirm recognized text,
   model reply, fully decoded PCM WAV, timing, wrong-token rejection and no disk
   or Sheets retention. This is a server conversation test, not a watch test.
2. On an authorized candidate watch, validate actual microphone channel, duration,
   audible output, memory use and error recovery. Complete one recorded spoken
   question -> transcription -> answer -> audible watch reply, then a second turn.
3. Validate music playback separately, then codec ownership contention and user
   navigation. Automatic conversation music pause/resume, original avatar,
   offline soundboard and watch-held history remain unfinished.

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| ESP-IDF native build | Exact candidate compiles | Safe flashing or working hardware |
| Native/HTTP software tests | Tested policies and local request contract | Live model/STT/TTS operation |
| Public health checks | DNS/TLS/HTTP reachability | Deployed MAX-8 route or conversation |
| Authenticated real speech fixture | Server pipeline works for that fixture | Watch capture, playback or power reliability |
| Physical commissioning record | Behavior observed on that board/build | Untested release gates or rollback |
