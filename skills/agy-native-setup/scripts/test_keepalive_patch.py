"""Offline checks for the macOS patch's build binding and separate-copy behavior."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("keepalive", Path(__file__).with_name("agy_keepalive_patch.py"))
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


class KeepalivePatchTest(unittest.TestCase):
    def setUp(self):
        self.data = recipe.MACH_HEADER + bytes(24) + recipe.ORIGINAL + bytes(24)
        values = {"PATCH_OFFSET": 32, "BASE_SHA256": hashlib.sha256(self.data).hexdigest()}
        patches = [patch.object(recipe, key, value) for key, value in values.items()]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_only_function_entry_changes(self):
        result = recipe.patch_bytes(self.data)
        self.assertEqual(result[:32], self.data[:32])
        self.assertEqual(result[32:40], bytes.fromhex("c00080d2c0035fd6"))
        self.assertEqual(result[40:], self.data[40:])

    def test_unrelated_drift_and_double_patch_are_rejected(self):
        for data in [self.data[:-1] + b"x", recipe.patch_bytes(self.data)]:
            with self.assertRaises(ValueError):
                recipe.patch_bytes(data)

    def test_recipe_requires_matching_entry_even_with_matching_hash(self):
        data = self.data[:32] + bytes(8) + self.data[40:]
        with patch.object(recipe, "BASE_SHA256", hashlib.sha256(data).hexdigest()):
            with self.assertRaises(ValueError):
                recipe.patch_bytes(data)

    def test_apply_preserves_source_and_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "source", Path(directory) / "copy"
            source.write_bytes(self.data)
            source.chmod(0o755)
            with patch.object(recipe.platform, "system", return_value="Darwin"), \
                 patch.object(recipe.platform, "machine", return_value="arm64"), \
                 patch.object(recipe.subprocess, "run") as run, \
                 patch.object(recipe.subprocess, "check_output", return_value="1.4.12\n"):
                result = recipe.apply(source, output)
                self.assertEqual(source.read_bytes(), self.data)
                self.assertEqual(result["max_pings"], 6)
                self.assertEqual(run.call_count, 2)
                self.assertEqual(run.call_args.args[0][:3], ["codesign", "--verify", "--strict"])
                with self.assertRaises(FileExistsError):
                    recipe.apply(source, output)
                with self.assertRaises(ValueError):
                    recipe.apply(source, source)

    def test_signing_failure_does_not_install_a_broken_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "source", Path(directory) / "copy"
            source.write_bytes(self.data)
            with patch.object(recipe.platform, "system", return_value="Darwin"), \
                 patch.object(recipe.platform, "machine", return_value="arm64"), \
                 patch.object(recipe.subprocess, "run", side_effect=recipe.subprocess.CalledProcessError(1, "codesign")):
                with self.assertRaises(recipe.subprocess.CalledProcessError):
                    recipe.apply(source, output)
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(directory).iterdir()), [source])
            self.assertEqual(source.read_bytes(), self.data)

    def test_wrong_platform_never_writes(self):
        with patch.object(recipe.platform, "system", return_value="Windows"):
            with self.assertRaises(ValueError):
                recipe.apply(Path("missing-source"), Path("missing-output"))


if __name__ == "__main__":
    unittest.main()
