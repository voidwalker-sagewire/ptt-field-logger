# MAX-8: conversational watch + music

STATUS: Integration branch. Backend code is prepared; native MAX-8 watch firmware is NOT built or ready to flash. The deployed services and current watch firmware are unchanged.

## Verified foundations
- Board: Waveshare ESP32-S3 Touch AMOLED 2.06 (410x502), ES8311 speaker output, ES7210 microphones.
- Vendor: https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.06 at commit 30f3b23b3d4bb38d32f7d0cddffb66759668a855.
- Native factory firmware provides Recorder, MusicPlayer, audio session ownership, SD card, and Wi-Fi.
- Factory recorder uses 24kHz, 16-bit signed PCM, 4-slot ES7210 TDM RX with MIC1 slot 0 and MIC2 slot 2; ES8311 uses standard I2S TX. Our Arduino recorder did not reproduce this correctly.
- SageWire gateway services: STT multipart /stt/transcribe and Piper WAV synthesis /tts/speak; PTT Field Logger already uses an AI reply stage.

## New MAX-8 voice endpoint (not yet deployed)
- POST /api/max8/turn to the PTT Field Logger host.
- Authorization: Bearer [MAX8_DEVICE_TOKEN from deployment secret]. Never commit a real token or hard-code it in a public firmware repository.
- Multipart field audio: RIFF/WAV PCM, signed 16-bit, 16kHz or 24kHz, 1 or 2 channels, 10 seconds maximum, 1MiB maximum.
- Returns raw Piper WAV, plus URI-encoded X-Max8-Transcript and X-Max8-Reply headers; Cache-Control: no-store.
- 401 for failed authorization, 400 for invalid PCM, 422 for no speech, 502 for gateway/TTS/AI faults.
- In this route audio is processed in memory, not stored locally or sent to ranch logger/Google Sheets. The upstream STT, AI and TTS processors still receive user audio/text.
- Currently single-turn: conversational history support and watch client integration remain open.

## Watch integration design (pending)
1. Port the retained MAX-8 steady character, battery, voice animation and TALK/MUTE/MENU to the native factory SDK.
2. Reuse factory MusicPlayer for MP3/WAV SD music under /music (or /Music), with Play, Pause, Next, Previous and volume.
3. When TALK is pressed, pause music and release audio ownership. Use native Recorder to capture correctly and verify sample rate and duration.
4. Send the WAV to the authenticated SageWire endpoint over verified TLS, fetch the PCM WAV response, animate mouth from audio amplitude, and optionally resume music.
5. Keep original offline ElevenLabs lines; never stream microphone in standby. Provide immediate visible error messages and bounded timeouts.
6. Only one audio owner at a time. Do not concurrently open TDM capture and music output through independent drivers.

## Release gates
- Build exact native factory source in CI using ESP-IDF v5.5.5.
- Verify new MAX-8 voice endpoint unit tests and real SageWire connectivity.
- Implement and compile MAX-8 custom UI with factory Recorder/MusicPlayer; verify memory/I2S/session handling.
- Verify auth/provisioning and TLS without exposing user keys in source.
- Prepare dual OTA partitions and rollback/USB rescue before any OTA attempt.
- Do not ask user to flash another unverified binary or wipe current MAX-8.
