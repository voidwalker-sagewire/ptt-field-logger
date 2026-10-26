import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("stage_private", Path(__file__).parents[1] / "stage-private.py")
stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage)


class StageTests(unittest.TestCase):
    def test_environment_reuses_only_needed_values_and_rejects_line_injection(self):
        config = {"Env": ["OPENAI_API_KEY=test-secret", "GOOGLE_SHEET_WEBHOOK_URL=private", "GATEWAY_BASE_URL=https://api.sagewire.dev"]}
        values = stage.environment(config, "a" * 32)
        self.assertEqual(values["OPENAI_API_KEY"], "test-secret")
        self.assertNotIn("GOOGLE_SHEET_WEBHOOK_URL", values)
        self.assertEqual(values["OPENAI_MODEL"], "gpt-4o-mini")
        with self.assertRaises(RuntimeError):
            stage.environment({"Env": ["OPENAI_API_KEY=bad\nINJECT=value"]}, "a" * 32)
        with self.assertRaises(RuntimeError):
            stage.environment({"Env": []}, "a" * 32)

    def test_unowned_or_different_stage_is_never_replaced(self):
        for labels in [{}, {stage.OWNER_LABEL: stage.OWNER_VALUE, "ag.herdmate.max8.source": "different"}]:
            with self.assertRaises(RuntimeError):
                stage.validate_existing({"Config": {"Labels": labels}})

    def test_sources_are_checksum_pinned(self):
        for name in stage.SOURCE_HASHES:
            source = Path(__file__).parents[1] / name
            self.assertEqual(stage.verified_source(name, source.read_bytes()), source.read_bytes())
        with self.assertRaises(RuntimeError):
            stage.verified_source("standalone.mjs", b"tampered")

    def test_private_write_has_restricted_permissions_and_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "secret"
            stage.private_write(path, b"test")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            link = Path(temp) / "link"
            link.symlink_to(path)
            with self.assertRaises(RuntimeError):
                stage.private_write(link, b"changed")
            self.assertEqual(path.read_bytes(), b"test")

    def test_full_staging_flow_stays_private_and_does_not_modify_original_container(self):
        original = {"State": {"Running": True}, "Image": "sha256:test-existing-image",
                    "Config": {"WorkingDir": "/app/", "Env": ["OPENAI_API_KEY=not-a-real-key"]},
                    "NetworkSettings": {"Networks": {"coolify": {}}}}
        commands = []
        def source_or_health(url, timeout=30):
            if url.endswith("/health"):
                return io.BytesIO(json.dumps({"service": "max8-watch", "contract": "max8-wav-v1"}).encode())
            return io.BytesIO((Path(__file__).parents[1] / url.rsplit("/", 1)[-1]).read_bytes())
        result = {"result": "PASS", "hardwareVerified": False, "transcript": "Hello Max", "answer": "Hello"}
        probe = subprocess.CompletedProcess([], 0, stdout=json.dumps(result), stderr="")
        with tempfile.TemporaryDirectory() as temp, patch.object(stage, "ROOT", Path(temp)), \
                patch.object(stage.os, "geteuid", return_value=0), \
                patch.object(stage, "inspect", side_effect=lambda name: original if name == stage.SOURCE_CONTAINER else None), \
                patch.object(stage.urllib.request, "urlopen", side_effect=source_or_health), \
                patch.object(stage, "run", side_effect=lambda args, **kw: commands.append(args) or "container-id"), \
                patch.object(stage.subprocess, "run", return_value=probe), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            stage.main()
            self.assertNotIn("not-a-real-key", output.getvalue())
            self.assertTrue(json.loads((Path(temp) / "state.json").read_text())["private_test_passed"])
            self.assertEqual(len(commands), 1)
            command = commands[0]
            self.assertIn("127.0.0.1:18788:8788", command)
            self.assertIn("traefik.enable=false", command)
            self.assertNotIn(stage.SOURCE_CONTAINER, command)
            self.assertNotIn("--restart", command)
            self.assertNotIn("not-a-real-key", command)


if __name__ == "__main__":
    unittest.main()
