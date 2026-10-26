#!/usr/bin/env python3
"""Start and test only a loopback-bound MAX-8 service; never publish a route."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit

SOURCE_SHA = "93340a279ed8060210995da7a86d10aa1559d138"
SOURCE_HASHES = {'max8-turn.mjs': '07809220a5af291ac98170e9544a081c2a59a66fd1ffd78617277f0c6d708880', 'max8-router.mjs': '6572ebfcd661c768255ab0eeb00818b434a9789750e259a19a847dc2f7eefb8c', 'max8-pipeline.mjs': '09434fcc4d1aaba7969af0fdeee1989d5a2d6e4d6bde471f701cae324833e349', 'standalone.mjs': '15ec16b2b568cfa930b41c32fac80485e9573d94690e03c5f7567db4c26d8fd3', 'live-probe.mjs': 'a23a4594e11942dadb565789e05bfdf0d7524a82bc42b61e9f39e9ddbfb891cf'}
SOURCE_CONTAINER = "i3v0gv3l8keh4mbyr26zoj34-231300043942"
STAGE_NAME = "max8-watch-stage"
OWNER_LABEL = "ag.herdmate.max8.managed"
OWNER_VALUE = "private-stage-v1"
ROOT = Path("/opt/max8-watch")


def run(args, timeout=30):
    return subprocess.check_output(args, text=True, timeout=timeout, stderr=subprocess.DEVNULL).strip()


def inspect(name):
    try:
        return json.loads(run(["docker", "inspect", name]))[0]
    except subprocess.CalledProcessError:
        return None


def environment(config, token):
    original = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    key = original.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("Existing field logger has no model key; nothing was deployed")
    gateway = original.get("GATEWAY_BASE_URL", "https://api.sagewire.dev").rstrip("/")
    parsed = urlsplit(gateway)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        gateway = "https://api.sagewire.dev"
    values = {"OPENAI_API_KEY": key, "OPENAI_MODEL": original.get("OPENAI_MODEL") or "gpt-4o-mini",
              "GATEWAY_BASE_URL": gateway, "MAX8_DEVICE_TOKEN": token, "PORT": "8788"}
    if any(any(char in value for char in "\r\n\x00") for value in values.values()):
        raise RuntimeError("Unsupported environment encoding; nothing was deployed")
    return values


def verified_source(name, data):
    if name not in SOURCE_HASHES or hashlib.sha256(data).hexdigest() != SOURCE_HASHES[name]:
        raise RuntimeError("Source checksum mismatch: " + name)
    return data


def private_write(path, data):
    if path.is_symlink():
        raise RuntimeError("Refusing a symbolic-link output")
    temporary = path.with_name(path.name + ".new")
    if temporary.is_symlink():
        raise RuntimeError("Refusing a symbolic-link temporary output")
    temporary.write_bytes(data)
    temporary.chmod(0o600)
    temporary.replace(path)


def validate_existing(container):
    if container:
        labels = container["Config"].get("Labels") or {}
        if labels.get(OWNER_LABEL) != OWNER_VALUE or labels.get("ag.herdmate.max8.source") != SOURCE_SHA:
            raise RuntimeError("The staging container name is already in use; nothing was replaced")


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Run this installer through the existing root SSH session")
    os.umask(0o077)
    original = inspect(SOURCE_CONTAINER)
    if not original or not original["State"]["Running"]:
        raise RuntimeError("The inspected field logger container is no longer running; nothing was deployed")
    if original["Config"]["WorkingDir"].rstrip("/") != "/app":
        raise RuntimeError("Working directory changed; nothing was deployed")
    if "coolify" not in original["NetworkSettings"]["Networks"]:
        raise RuntimeError("Expected Docker network not found; nothing was deployed")
    current = inspect(STAGE_NAME)
    validate_existing(current)
    if ROOT.is_symlink():
        raise RuntimeError("Refusing a symbolic-link installation directory")
    state_path = ROOT / "state.json"
    if ROOT.exists() and any(ROOT.iterdir()):
        if not state_path.is_file() or state_path.is_symlink():
            raise RuntimeError("Installation directory already contains unrecognized files")
        state = json.loads(state_path.read_text())
        if state.get("owner") != OWNER_VALUE or state.get("source_sha") != SOURCE_SHA:
            raise RuntimeError("Another MAX-8 installation is present; nothing was replaced")
    else:
        state = {"owner": OWNER_VALUE, "source_sha": SOURCE_SHA, "container": STAGE_NAME,
                 "image_id": original["Image"], "private_test_passed": False}
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    ROOT.chmod(0o700)
    private_write(state_path, json.dumps(state, indent=2).encode())
    release = ROOT / "source"
    release.mkdir(mode=0o700, exist_ok=True)
    if release.is_symlink():
        raise RuntimeError("Refusing a symbolic-link source directory")
    print("Downloading checksum-pinned MAX-8 source...", flush=True)
    for name in SOURCE_HASHES:
        url = "https://raw.githubusercontent.com/voidwalker-sagewire/ptt-field-logger/" + SOURCE_SHA + "/max8/" + name
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(131073)
        if len(data) > 131072:
            raise RuntimeError("Unexpected source size")
        private_write(release / name, verified_source(name, data))
    token_path = ROOT / "device-token.txt"
    if token_path.exists():
        if token_path.is_symlink():
            raise RuntimeError("Refusing a symbolic-link token file")
        token = token_path.read_text().strip()
    else:
        token = secrets.token_hex(16)
        private_write(token_path, (token + "\n").encode())
    if len(token) != 32 or any(char not in "0123456789abcdef" for char in token):
        raise RuntimeError("Existing device token is invalid")
    values = environment(original["Config"], token)
    private_write(ROOT / "runtime.env", ("\n".join(key + "=" + value for key, value in values.items()) + "\n").encode())
    if not current:
        print("Starting private service on server loopback port 18788...", flush=True)
        run(["docker", "run", "-d", "--name", STAGE_NAME, "--network", "coolify",
             "--user", "0:0", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
             "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=256m", "--cpus=0.5", "--pids-limit=96",
             "--label", OWNER_LABEL + "=" + OWNER_VALUE,
             "--label", "ag.herdmate.max8.source=" + SOURCE_SHA, "--label", "traefik.enable=false",
             "--env-file", str(ROOT / "runtime.env"), "--mount", "type=bind,source=" + str(release) + ",target=/app/max8-stage,readonly",
             "-p", "127.0.0.1:18788:8788", "--entrypoint", "node", original["Image"], "/app/max8-stage/standalone.mjs"])
    elif not current["State"]["Running"]:
        run(["docker", "start", STAGE_NAME])
    ready = False
    for _ in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:18788/health", timeout=2) as response:
                payload = json.load(response)
            ready = payload.get("service") == "max8-watch" and payload.get("contract") == "max8-wav-v1"
            if ready:
                break
        except Exception:
            time.sleep(1)
    if not ready:
        raise RuntimeError("Private service did not become ready; existing apps are unchanged")
    print("Testing synthetic speech through STT -> model -> TTS (may take up to two minutes)...", flush=True)
    attempt = subprocess.run(["docker", "exec", STAGE_NAME, "node", "/app/max8-stage/live-probe.mjs"],
                             text=True, capture_output=True, timeout=150)
    if attempt.returncode:
        for line in attempt.stderr.splitlines():
            if line.startswith("MAX-8 live probe failed:"):
                print(line[:240], flush=True)
        raise RuntimeError("Synthetic conversation test failed; no public route was created")
    result = json.loads(attempt.stdout)
    if result.get("result") != "PASS" or result.get("hardwareVerified") is not False:
        raise RuntimeError("Unexpected probe evidence; no public route was created")
    private_write(ROOT / "private-test.json", json.dumps(result, indent=2).encode())
    state["private_test_passed"] = True
    private_write(state_path, json.dumps(state, indent=2).encode())
    print(json.dumps(result, indent=2))
    print("PRIVATE CONVERSATION TEST PASSED. Public route and existing containers are unchanged. Device token remains private on this server.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError:
        print("MAX-8 staging stopped: a Docker command or speech probe failed. No public route was created. Existing apps are unchanged.", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Do not print environment values, Docker inspect payloads or upstream bodies.
        if isinstance(error, RuntimeError):
            print("MAX-8 staging stopped: " + str(error), file=sys.stderr)
        else:
            print("MAX-8 staging stopped: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
