"""Retired AH498 collectors must stop before child processes or evidence creation."""

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


class RetiredCollectors(unittest.TestCase):
    def test_public_entrypoints_fail_before_dispatch_or_output_creation(self):
        root = Path(tempfile.mkdtemp(prefix="retired-collectors-"))
        for name in ("router-metadata", "native-preimages", "current-files"):
            with self.subTest(collector=name):
                path = Path(__file__).with_name("collect-migration-" + name + ".py")
                spec = importlib.util.spec_from_file_location("retired_" + name.replace("-", "_"), path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                output = root / name
                with patch.object(subprocess, "run") as run, patch.object(subprocess, "Popen") as popen, \
                        patch.object(sys, "argv", [str(path), "--output", str(output)]), \
                        patch.object(sys, "stdout", io.StringIO()) as stdout:
                    self.assertEqual(module.main(), 2)
                    response = json.loads(stdout.getvalue())
                self.assertEqual(response["error"]["code"], "COLLECTOR_RETIRED")
                self.assertIn("ntn-skills", response["error"]["message"])
                run.assert_not_called()
                popen.assert_not_called()
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
