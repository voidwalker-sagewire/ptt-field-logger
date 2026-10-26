# Private MAX-8 conversation test

`stage-private.py` is an operator-run installer for the inspected Dave Brain
server. It reuses the exact image and server-side model credential of the running
PTT Field Logger, without stopping or changing that container. It downloads five
small source modules from a fixed Git commit and verifies each SHA-256 hash.

It creates only `max8-watch-stage`, on network `coolify`, with host port
`127.0.0.1:18788` forwarding to service port 8788. `traefik.enable=false` prevents
public routing. Code is mounted read-only, Linux capabilities are dropped, and
CPU/memory limits apply. Credentials remain in root-only `/opt/max8-watch` files;
the device receives a separate random token, not the model API key. No new droplet
or paid infrastructure is provisioned. The live probe uses the existing speech
services and one model request.

The probe checks readiness, missing-token/wrong-token rejection, then synthesizes
the non-sensitive phrase “Hello Max. Say hello.” Piper PCM is converted in memory
to 24 kHz mono WAV and submitted to the exact authenticated conversation route.
Passing requires transcript and reply headers plus fully validated reply PCM.
Only synthetic-text test evidence is retained, in `private-test.json`.

This installer does not publish HTTPS routing, modify the watch, merge a PR,
replace an existing application, or prove physical microphone/speaker operation.
On failure, existing applications and routes remain unchanged; the private test
container and restricted test files are retained for diagnosis. Rerunning is
allowed only for the same marked source version. Conflicting names or unknown
installation directories are refused.

Local validation before operator handoff: 19 Node tests and five Python tests
passed. Python tests exercise the staging command construction with substituted
Docker/network calls; only a server run can validate the real speech pipeline.
