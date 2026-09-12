import importlib.util
import io
import pathlib
import unittest
from contextlib import redirect_stderr
from importlib.machinery import SourceFileLoader
from unittest.mock import patch

SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "bin" / "oxen"
SPEC = importlib.util.spec_from_loader("oxen_cli", SourceFileLoader("oxen_cli", str(SCRIPT_PATH)))
oxen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oxen)


class OxenCliTests(unittest.TestCase):
    def parse(self, argv):
        return oxen.build_parser().parse_args(argv)

    def test_chat_request_is_openai_compatible(self):
        args = self.parse(
            [
                "chat",
                "--model",
                "claude-sonnet-4-6",
                "--prompt",
                "hello",
                "--system",
                "be concise",
                "--max-tokens",
                "25",
                "--json-object",
            ]
        )
        method, path, body, query = oxen.prepare_request(args)
        self.assertEqual((method, path, query), ("POST", "/chat/completions", None))
        self.assertEqual(body["messages"][0]["role"], "system")
        self.assertEqual(body["messages"][1]["content"], "hello")
        self.assertEqual(body["response_format"], {"type": "json_object"})

    def test_search_model_is_url_encoded_by_client(self):
        args = self.parse(["models", "--search", "flux 2"])
        method, path, body, query = oxen.prepare_request(args)
        response = oxen.api_request(method, path, body, query, dry_run=True)
        self.assertEqual(response["url"], "https://hub.oxen.ai/api/ai/models/search?search=flux+2")

    def test_queue_limits_batch_size_to_documented_range(self):
        args = self.parse(["queue", "--model", "flux-2-dev", "--prompt", "poster", "--count", "4"])
        _, path, body, _ = oxen.prepare_request(args)
        self.assertEqual(path, "/queue")
        self.assertEqual(body["num_generations"], 4)
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.parse(["queue", "--model", "flux-2-dev", "--prompt", "poster", "--count", "5"])

    def test_extra_must_be_json_object(self):
        args = self.parse(["image", "--model", "flux-2-dev", "--prompt", "poster", "--extra", "[]"])
        with self.assertRaises(oxen.OxenError):
            oxen.prepare_request(args)

    def test_environment_credential_takes_priority_over_keychain(self):
        with patch.dict("os.environ", {"OXEN_API_KEY": "test-key"}, clear=True):
            with patch.object(oxen.subprocess, "run") as keychain:
                self.assertEqual(oxen.require_api_key(), "test-key")
                keychain.assert_not_called()

    def test_prompt_file_supports_bounded_worker_packets(self):
        args = self.parse(["chat", "--model", "gpt-5-6-terra", "--prompt-file", "-"])
        with patch.object(oxen.sys, "stdin", io.StringIO("review this code")):
            _, _, body, _ = oxen.prepare_request(args)
        self.assertEqual(body["messages"][0]["content"], "review this code")


if __name__ == "__main__":
    unittest.main()
