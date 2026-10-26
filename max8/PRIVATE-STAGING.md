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

## Operator-returned private result

The operator ran the checksum-pinned private installer and returned a passing
synthetic conversation: recognized text `Hello Max, say hello.`, a nonempty model
reply, 100606 input bytes and 152340 reply bytes, in 14781 ms. This is real private
server evidence supplied by the operator, with `hardwareVerified: false`.

`publish-tested.py` is the separate next action. It checks that the private test,
image, environment and source hashes match; starts a new restricted container;
routes only `Host(headset.herdmate.ag)` plus exact path `/api/max8/turn`; and tests
authentication and a full conversation through public HTTPS. Readiness is checked
inside that container so the existing logger's `/health` is left in place. The
existing public health response must match before and after. If verification
fails after creating the service, only the newly owned MAX-8 container is removed.
A successful service receives an `unless-stopped` restart policy. No other running
container is stopped, changed or removed. There is no host port mapping on the
public MAX-8 container. Source credentials and the dedicated watch token remain
private. Ten Python tests cover private staging and publication/rollback behavior.
