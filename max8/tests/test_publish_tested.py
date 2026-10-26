import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("publish_tested", Path(__file__).parents[1] / "publish-tested.py")
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)


class PublishTests(unittest.TestCase):
    def fixtures(self):
        state = {"owner": "private-stage-v1", "source_sha": publish.SOURCE_SHA,
                 "private_test_passed": True, "image_id": "sha256:tested"}
        proof = {"result": "PASS", "test": "synthetic-server-conversation", "hardwareVerified": False}
        stage = {"State": {"Running": True}, "Image": "sha256:tested", "Config": {"Labels": {
            publish.LABEL: "private-stage-v1", "ag.herdmate.max8.source": publish.SOURCE_SHA}}}
        return state, proof, stage

    def test_missing_or_mismatched_private_evidence_prevents_publication(self):
        state, proof, stage = self.fixtures()
        publish.validate_stage(state, proof, stage)
        for bad in [{**state, "private_test_passed": False}, {**state, "source_sha": "other"}, {**state, "image_id": "other"}]:
            with self.assertRaises(RuntimeError):
                publish.validate_stage(bad, proof, stage)
        with self.assertRaises(RuntimeError):
            publish.validate_stage(state, {**proof, "result": "FAIL"}, stage)

    def test_public_command_routes_only_exact_turn_path_and_uses_no_host_port(self):
        args = publish.command("sha256:tested")
        self.assertIn("traefik.http.routers.max8-watch-turn.rule=Host(`headset.herdmate.ag`) && Path(`/api/max8/turn`)", args)
        self.assertNotIn("-p", args)
        self.assertNotIn("--privileged", args)
        self.assertIn("--read-only", args)
        self.assertEqual(args[-2:], ["sha256:tested", "/app/max8-stage/standalone.mjs"])

    def test_publisher_verifies_the_same_source_hashes_as_staging(self):
        for name, digest in publish.SOURCE_HASHES.items():
            self.assertEqual(hashlib.sha256((Path(__file__).parents[1] / name).read_bytes()).hexdigest(), digest)

    def run_flow(self, failure=False):
        state, proof, stage = self.fixtures()
        env = {"OPENAI_API_KEY": "test-secret", "OPENAI_MODEL": "gpt-4o-mini", "GATEWAY_BASE_URL": "https://gateway.example",
               "MAX8_DEVICE_TOKEN": "a" * 32, "PORT": "8788"}
        stage["Config"]["Env"] = [key + "=" + value for key, value in env.items()]
        public = {"State": {"Running": True}, "Config": {"Labels": {
            publish.LABEL: publish.OWNER, "ag.herdmate.max8.source": publish.SOURCE_SHA}}}
        commands, started = [], False
        def inspect(name):
            if name == "max8-watch-stage": return stage
            return public if started else None
        def run(args, **kwargs):
            nonlocal started
            commands.append(args)
            if args[:2] == ["docker", "run"]: started = True
            return "ok"
        result = {"result": "PASS", "conversationScope": "public-https", "hardwareVerified": False}
        attempt = subprocess.CompletedProcess([], 1 if failure else 0,
            stdout=json.dumps(result), stderr="MAX-8 public probe failed: Conversation HTTP 502" if failure else "")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "state.json").write_text(json.dumps(state))
            (root / "private-test.json").write_text(json.dumps(proof))
            (root / "runtime.env").write_text("\n".join(key + "=" + value for key, value in env.items()))
            (root / "runtime.env").chmod(0o600)
            (root / "source").mkdir()
            for name in publish.SOURCE_HASHES:
                (root / "source" / name).write_bytes((Path(__file__).parents[1] / name).read_bytes())
            responses = [(200, b'logger'), (404, b''), (401, b''), (200, b'logger')]
            with patch.object(publish, "ROOT", root), patch.object(publish.os, "geteuid", return_value=0), \
                    patch.object(publish, "inspect", side_effect=inspect), patch.object(publish, "run", side_effect=run), \
                    patch.object(publish, "request", side_effect=responses), patch.object(publish.subprocess, "run", return_value=attempt), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                if failure:
                    with self.assertRaises(RuntimeError): publish.main()
                    self.assertFalse((root / "public-test.json").exists())
                else:
                    publish.main()
                    self.assertTrue((root / "public-test.json").exists())
                self.assertNotIn("test-secret", out.getvalue())
        return commands

    def test_success_persists_evidence_and_only_enables_restart_for_new_service(self):
        commands = self.run_flow()
        self.assertEqual(commands[-1], ["docker", "update", "--restart", "unless-stopped", "max8-watch"])
        self.assertFalse(any(args[:2] == ["docker", "rm"] for args in commands))

    def test_failed_public_test_removes_only_new_owned_container(self):
        commands = self.run_flow(failure=True)
        self.assertEqual(commands[-1], ["docker", "rm", "-f", "max8-watch"])
        self.assertFalse(any("max8-watch-stage" in args for args in commands))


if __name__ == "__main__":
    unittest.main()
