# PTT Field Logger

A tiny browser/PWA prototype for testing the 3M Pro-Comms headset PTT button as a hands-free field voice logger.

## Current status

Working proof chain:

```text
3M Pro-Comms headset
  -> BLE service FFE0
  -> BLE characteristic FFE1
  -> Chrome on Android
  -> JavaScript web app
  -> PTT session logs
  -> local audio clips
```

Known observed values:

```text
FFE1 = 01 -> PTT pressed
FFE1 = 00 -> PTT released
```

## Version 0.2.3

This version adds:

- Connect to headset
- Subscribe to FFE1 notifications
- Detect PTT press/release
- Start recording audio on PTT press
- Stop recording audio on PTT release
- Manual Start/Stop recording buttons
- Mic Test / Wake Audio button
- Big visible VU meter
- Save session metadata to localStorage
- Save audio clips locally in IndexedDB
- Playback saved audio clips
- Download individual audio clips
- Export session logs as JSON metadata
- Register service worker for PWA caching

## Important note

The JSON export does **not** include the audio file bytes. It exports session metadata only.

Audio clips stay inside the same browser/device storage until manually downloaded or cleared.

## Notes

This is not an official 3M product.

This does not modify headset firmware.

This is a user-controlled field logging experiment using hardware the user owns.
