#!/usr/bin/env python3
"""Expose only a privately tested MAX-8 turn route, with automatic route rollback."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path("/opt/max8-watch")
SOURCE_SHA = "93340a279ed8060210995da7a86d10aa1559d138"
NAME = "max8-watch"
LABEL = "ag.herdmate.max8.managed"
OWNER = "public-tested-v1"
HOST = "https://headset.herdmate.ag"
SOURCE_HASHES = {'max8-turn.mjs': '07809220a5af291ac98170e9544a081c2a59a66fd1ffd78617277f0c6d708880', 'max8-router.mjs': '6572ebfcd661c768255ab0eeb00818b434a9789750e259a19a847dc2f7eefb8c', 'max8-pipeline.mjs': '09434fcc4d1aaba7969af0fdeee1989d5a2d6e4d6bde471f701cae324833e349', 'standalone.mjs': '15ec16b2b568cfa930b41c32fac80485e9573d94690e03c5f7567db4c26d8fd3', 'live-probe.mjs': 'a23a4594e11942dadb565789e05bfdf0d7524a82bc42b61e9f39e9ddbfb891cf'}

PUBLIC_PROBE = r'''
import { probe } from "/app/max8-stage/live-probe.mjs";
const root = "https://headset.herdmate.ag";
// /health belongs to the existing logger. Readiness is checked directly in
// this container; every conversation/authentication request traverses HTTPS.
const fetchImpl = (url, options) => fetch(url === root + "/health"
  ? "http://127.0.0.1:8788/health" : url, options);
try {
  const result = await probe({ root, gateway: process.env.GATEWAY_BASE_URL,
    token: process.env.MAX8_DEVICE_TOKEN, fetchImpl });
  console.log(JSON.stringify({ ...result, requestRoot: root,
    readinessScope: "container-loopback", conversationScope: "public-https" }));
} catch (error) {
  console.error("MAX-8 public probe failed: " + (error?.message || "unknown failure"));
  process.exitCode = 1;
}
'''


def run(args, timeout=30):
    return subprocess.check_output(args, text=True, timeout=timeout, stderr=subprocess.DEVNULL).strip()


def inspect(name):
    try:
        return json.loads(run(["docker", "inspect", name]))[0]
    except subprocess.CalledProcessError:
        return None


def request(path, method="GET"):
    try:
        with urllib.request.urlopen(urllib.request.Request(HOST + path, method=method), timeout=12) as response:
            return response.status, response.read(8192)
    except urllib.error.HTTPError as error:
        return error.code, error.read(8192)


def owned(container):
    labels = container["Config"].get("Labels") or {}
    return labels.get(LABEL) == OWNER and labels.get("ag.herdmate.max8.source") == SOURCE_SHA


def command(image):
    labels = {
        LABEL: OWNER, "ag.herdmate.max8.source": SOURCE_SHA,
        "traefik.enable": "true", "traefik.docker.network": "coolify",
        "traefik.http.routers.max8-watch-turn.rule": "Host(`headset.herdmate.ag`) && Path(`/api/max8/turn`)",
        "traefik.http.routers.max8-watch-turn.priority": "10000",
        "traefik.http.routers.max8-watch-turn.tls": "true",
        "traefik.http.routers.max8-watch-turn.tls.certresolver": "letsencrypt",
        "traefik.http.routers.max8-watch-turn.service": "max8-watch-turn",
        "traefik.http.services.max8-watch-turn.loadbalancer.server.port": "8788",
    }
    args = ["docker", "run", "-d", "--name", NAME, "--network", "coolify", "--user", "0:0",
            "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--memory=256m", "--cpus=0.5", "--pids-limit=96",
            "--env-file", str(ROOT / "runtime.env"), "--mount",
            "type=bind,source=" + str(ROOT / "source") + ",target=/app/max8-stage,readonly"]
    for key, value in labels.items():
        args += ["--label", key + "=" + value]
    return args + ["--entrypoint", "node", image, "/app/max8-stage/standalone.mjs"]


def validate_stage(state, proof, container):
    if state.get("owner") != "private-stage-v1" or state.get("source_sha") != SOURCE_SHA or not state.get("private_test_passed"):
        raise RuntimeError("Matching private staging has not passed")
    if proof.get("result") != "PASS" or proof.get("test") != "synthetic-server-conversation" or proof.get("hardwareVerified") is not False:
        raise RuntimeError("Missing private conversation evidence")
    if not container or not container["State"]["Running"]:
        raise RuntimeError("Private test container is not running")
    labels = container["Config"].get("Labels") or {}
    if labels.get(LABEL) != "private-stage-v1" or labels.get("ag.herdmate.max8.source") != SOURCE_SHA:
        raise RuntimeError("Private container source identity differs")
    if container["Image"] != state.get("image_id"):
        raise RuntimeError("Private container image differs from tested image")


def main():
    if os.geteuid() != 0 or ROOT.is_symlink():
        raise RuntimeError("Expected root session and private installation directory")
    os.umask(0o077)
    state = json.loads((ROOT / "state.json").read_text())
    proof = json.loads((ROOT / "private-test.json").read_text())
    stage = inspect("max8-watch-stage")
    validate_stage(state, proof, stage)
    for name, digest in SOURCE_HASHES.items():
        path = ROOT / "source" / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("Tested source checksum differs: " + name)
    env_file = ROOT / "runtime.env"
    if env_file.is_symlink() or env_file.stat().st_mode & 0o077:
        raise RuntimeError("Runtime credential file permissions must be private")
    file_env = dict(line.split("=", 1) for line in env_file.read_text().splitlines() if "=" in line)
    stage_env = dict(line.split("=", 1) for line in stage["Config"]["Env"] if "=" in line)
    for key in ["OPENAI_API_KEY", "OPENAI_MODEL", "GATEWAY_BASE_URL", "MAX8_DEVICE_TOKEN", "PORT"]:
        if not file_env.get(key) or file_env[key] != stage_env.get(key):
            raise RuntimeError("Runtime configuration differs from tested service")
    existing = inspect(NAME)
    if existing and not owned(existing):
        raise RuntimeError("Public container name is in use; nothing was replaced")
    status, before = request("/health")
    if status != 200:
        raise RuntimeError("Existing logger health check failed; no route was created")
    if not existing:
        status, _ = request("/api/max8/turn", "POST")
        if status != 404:
            raise RuntimeError("An unexpected conversation route is already present; nothing was replaced")
    created = False
    try:
        if not existing:
            print("Publishing only /api/max8/turn over existing HTTPS...", flush=True)
            created = True
            run(command(stage["Image"]))
        elif not existing["State"]["Running"]:
            raise RuntimeError("Existing MAX-8 public container is stopped; review before retry")
        for _ in range(30):
            status, _ = request("/api/max8/turn", "POST")
            if status == 401:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Public route did not become authenticated")
        print("Testing complete conversation over public HTTPS...", flush=True)
        attempt = subprocess.run(["docker", "exec", NAME, "node", "--input-type=module", "-e", PUBLIC_PROBE],
                                 text=True, capture_output=True, timeout=150)
        if attempt.returncode:
            for line in attempt.stderr.splitlines():
                if line.startswith("MAX-8 public probe failed:"):
                    print(line[:240], flush=True)
            raise RuntimeError("Public conversation test failed")
        result = json.loads(attempt.stdout)
        if result.get("result") != "PASS" or result.get("conversationScope") != "public-https":
            raise RuntimeError("Unexpected public conversation evidence")
        status, after = request("/health")
        if status != 200 or after != before:
            raise RuntimeError("Existing logger health response changed")
        run(["docker", "update", "--restart", "unless-stopped", NAME])
        (ROOT / "public-test.json").write_text(json.dumps(result, indent=2))
        (ROOT / "public-test.json").chmod(0o600)
        print(json.dumps(result, indent=2))
        print("PUBLIC HTTPS CONVERSATION TEST PASSED.")
        print("Watch endpoint: " + HOST + "/api/max8/turn")
        print("Device token remains private at /opt/max8-watch/device-token.txt")
    except BaseException:
        if created:
            container = inspect(NAME)
            if container and owned(container):
                run(["docker", "rm", "-f", NAME])
                print("Removed only the new MAX-8 route after failed verification.", flush=True)
        raise


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print("MAX-8 publication stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print("MAX-8 publication stopped: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
