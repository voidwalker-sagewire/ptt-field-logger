# PTT Field Logger

A tiny browser/PWA prototype for testing the 3M Pro-Comms headset PTT button as a hands-free workflow trigger.

## Current status

Working proof chain:

```text
3M Pro-Comms headset
  -> BLE service FFE0
  -> BLE characteristic FFE1
  -> Chrome on Android
  -> JavaScript web app
  -> PTT session logs
```

Known observed values:

```text
FFE1 = 01 -> PTT pressed
FFE1 = 00 -> PTT released
```

## Version 0.2.1

This version adds:

- Connect to headset
- Subscribe to FFE1 notifications
- Detect PTT press/release
- Start/end session objects
- Show timer
- Display a simple VU meter microphone preview
- Export session logs as JSON
- PWA manifest and service worker

## Notes

This is not an official 3M product.

This does not modify headset firmware.

This is a user-controlled field logging experiment using hardware the user owns.
