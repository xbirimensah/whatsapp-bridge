#!/usr/bin/env python3
"""Tests for the brain REST API backend of the style-RAG and personal-context scripts."""
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

import requests

import brain_api
import wa_personal_context
import wa_style_rag
import wa_style_rag_server

API = "https://brain.test:8790"
BRAIN_ENV = {
    "SECOND_BRAIN_BACKEND": "brain-api",
    "BRAIN_API_URL": f"{API}/",
    "BRAIN_API_TOKEN": "style-token",
    "BRAIN_API_SEARCH_TOKEN": "search-token",
}
CLEARED_KEYS = (
    "SECOND_BRAIN_BACKEND",
    "BRAIN_API_URL",
    "BRAIN_API_TOKEN",
    "BRAIN_API_TOKEN_FILE",
    "BRAIN_API_SEARCH_TOKEN",
    "BRAIN_API_SEARCH_TOKEN_FILE",
    "BRAIN_API_SEARCH_FOLDERS",
)


def json_response(payload: Any, status: int = 200) -> Mock:
    response = Mock()
    response.status_code = status
    response.json.return_value = payload
    if status >= 400:
        error = requests.HTTPError(f"{status} error")
        error.response = response
        response.raise_for_status.side_effect = error
    else:
        response.raise_for_status.return_value = None
    return response


def clean_env(**overrides: str) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key not in CLEARED_KEYS}
    env.update(overrides)
    return env


def write_token(path: Path, value: str, mode: int = 0o600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    path.chmod(mode)
    return path


class EnvTestCase(unittest.TestCase):
    """Isolate every test from the real .env files and process environment."""

    env: dict[str, str] = BRAIN_ENV

    def setUp(self) -> None:
        patches = [
            patch.dict(os.environ, clean_env(**self.env), clear=True),
            patch.object(wa_style_rag, "load_runtime_env", lambda: None),
            patch.object(wa_personal_context, "load_runtime_env", lambda: None),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.stderr = io.StringIO()
        redirect = contextlib.redirect_stderr(self.stderr)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)


class BackendSelectionTests(EnvTestCase):
    env: dict[str, str] = {}

    def test_unset_flag_keeps_the_supabase_path(self) -> None:
        self.assertEqual(brain_api.selected_backend(), brain_api.SUPABASE)

    def test_flag_is_case_and_space_insensitive(self) -> None:
        with patch.dict(os.environ, {"SECOND_BRAIN_BACKEND": " Brain-API "}):
            self.assertEqual(brain_api.selected_backend(), brain_api.BRAIN_API)

    def test_unknown_flag_fails_loudly_but_label_never_raises(self) -> None:
        with patch.dict(os.environ, {"SECOND_BRAIN_BACKEND": "pgvector"}):
            with self.assertRaises(brain_api.BrainApiError):
                brain_api.selected_backend()
            self.assertEqual(brain_api.backend_label(), "invalid")


class BaseUrlTests(EnvTestCase):
    env: dict[str, str] = {}

    def test_default_is_loopback(self) -> None:
        self.assertEqual(brain_api.base_url(), "http://127.0.0.1:8790")

    def test_https_and_loopback_http_are_accepted(self) -> None:
        accepted = {
            "https://brain.example:8790/": "https://brain.example:8790",
            "http://localhost:8790": "http://localhost:8790",
            "http://127.0.0.1:8790/": "http://127.0.0.1:8790",
            "http://[::1]:8790": "http://[::1]:8790",
        }
        for raw, expected in accepted.items():
            with patch.dict(os.environ, {"BRAIN_API_URL": raw}):
                self.assertEqual(brain_api.base_url(), expected)

    def test_plain_http_to_other_hosts_is_a_config_error(self) -> None:
        for raw in ("http://brain-host:8790", "http://100.64.0.7:8790", "ftp://127.0.0.1/", "https://"):
            with patch.dict(os.environ, {"BRAIN_API_URL": raw}):
                with self.assertRaises(brain_api.BrainApiError) as caught:
                    brain_api.base_url()
                self.assertEqual(caught.exception.reason, "config")

    def test_bad_url_never_sends_or_even_reads_the_token(self) -> None:
        with patch.dict(os.environ, {"BRAIN_API_URL": "http://brain-host:8790", "BRAIN_API_TOKEN": "style-token"}), patch.object(
            brain_api, "read_token", side_effect=AssertionError("token must not be read")
        ), patch.object(brain_api.requests, "post") as post, patch.object(brain_api.requests, "get") as get:
            with self.assertRaises(brain_api.BrainApiError):
                brain_api.style_search("hi", 4, None, None)
            with self.assertRaises(brain_api.BrainApiError):
                brain_api.health()
        post.assert_not_called()
        get.assert_not_called()


class TokenTests(EnvTestCase):
    env: dict[str, str] = {}

    def setUp(self) -> None:
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)

    def test_env_token_wins_even_over_an_unsafe_file(self) -> None:
        path = write_token(self.home / "token", "file-token", mode=0o644)
        with patch.dict(os.environ, {"BRAIN_API_TOKEN": "from-env", "BRAIN_API_TOKEN_FILE": str(path)}):
            self.assertEqual(brain_api.read_token(), "from-env")

    def test_owner_only_token_file_is_read(self) -> None:
        path = write_token(self.home / "token", "file-token\n")
        with patch.dict(os.environ, {"BRAIN_API_TOKEN_FILE": str(path)}):
            self.assertEqual(brain_api.read_token(), "file-token")

    def test_group_or_world_accessible_token_file_is_refused(self) -> None:
        for mode in (0o640, 0o604, 0o660):
            path = write_token(self.home / f"token-{mode:o}", "do-not-print-me", mode=mode)
            with patch.dict(os.environ, {"BRAIN_API_TOKEN_FILE": str(path)}):
                with self.assertRaises(brain_api.BrainApiError) as caught:
                    brain_api.read_token()
            self.assertEqual(caught.exception.reason, "config")
            self.assertIn(str(path), str(caught.exception))
            self.assertNotIn("do-not-print-me", str(caught.exception))

    def test_missing_or_empty_token_file_is_a_clear_error(self) -> None:
        empty = write_token(self.home / "empty", "  \n")
        for path in (self.home / "missing", empty):
            with patch.dict(os.environ, {"BRAIN_API_TOKEN_FILE": str(path)}):
                with self.assertRaises(brain_api.BrainApiError):
                    brain_api.read_token()

    def test_default_files_split_style_writer_and_search_tokens(self) -> None:
        write_token(self.home / ".config/onyankopon/token-style-writer", "style-file")
        write_token(self.home / ".config/onyankopon/token-search", "search-file")
        with patch.dict(os.environ, {"HOME": str(self.home), "SECOND_BRAIN_BACKEND": "brain-api"}), patch.object(
            brain_api.requests, "post", return_value=json_response({"results": []})
        ) as post:
            brain_api.style_search("hi", 4, None, None)
            brain_api.search("hi", 3, text_chars=600)
        headers = [call.kwargs["headers"]["Authorization"] for call in post.call_args_list]
        self.assertEqual(headers, ["Bearer style-file", "Bearer search-file"])

    def test_search_token_file_is_overridable_and_ignores_the_style_token(self) -> None:
        path = write_token(self.home / "search", "custom-search")
        env = {"BRAIN_API_TOKEN": "style-token", "BRAIN_API_SEARCH_TOKEN_FILE": str(path)}
        with patch.dict(os.environ, env), patch.object(
            brain_api.requests, "post", return_value=json_response({"results": []})
        ) as post:
            brain_api.search("hi", 3, text_chars=600)
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer custom-search")


class ClientTests(EnvTestCase):
    def test_style_upsert_batches_documented_columns_and_sums_counters(self) -> None:
        rows = [
            {
                "source_outbound_message_id": str(index),
                "incoming_text": "hi",
                "outgoing_text": "yo",
                "retrieval_text": "Incoming: hi",
                "chat_kind": "direct",
                "embedding": [0.1],
                "embedding_model": "local",
                "embedded_at": "2026-10-11T00:00:00Z",
                "unexpected": "dropped",
            }
            for index in range(101)
        ]
        responses = [
            json_response({"upserted": 50, "skipped": 0, "embedded": 50}),
            json_response({"upserted": 48, "skipped": 2, "embedded": 10}),
            json_response({"upserted": 1}),
        ]
        with patch.object(brain_api.requests, "post", side_effect=responses) as post:
            totals = brain_api.style_upsert(rows)

        self.assertEqual(totals, {"upserted": 99, "skipped": 2, "embedded": 60})
        sizes = [len(call.kwargs["json"]["examples"]) for call in post.call_args_list]
        self.assertEqual(sizes, [50, 50, 1])
        first = post.call_args_list[0]
        self.assertEqual(first.args[0], f"{API}/v1/style/upsert")
        self.assertEqual(first.kwargs["headers"]["Authorization"], "Bearer style-token")
        for example in first.kwargs["json"]["examples"]:
            self.assertEqual(
                set(example), {"source_outbound_message_id", "incoming_text", "outgoing_text", "retrieval_text", "chat_kind"}
            )

    def test_style_search_body_and_result_fields(self) -> None:
        response = json_response(
            {"results": [{"outgoing_text": "ja safe", "language": "de", "similarity": 0.9, "source_outbound_message_id": "x"}]}
        )
        with patch.object(brain_api.requests, "post", return_value=response) as post:
            rows = brain_api.style_search("wann passt es", 10, "de", "direct")

        self.assertEqual(post.call_args.args[0], f"{API}/v1/style/search")
        self.assertEqual(post.call_args.kwargs["json"], {"query": "wann passt es", "limit": 6, "language": "de", "chat_kind": "direct"})
        self.assertEqual(set(rows[0]), set(brain_api.STYLE_RESULT_FIELDS))
        self.assertNotIn("source_outbound_message_id", rows[0])

    def test_style_search_omits_unset_filters(self) -> None:
        with patch.object(brain_api.requests, "post", return_value=json_response({"results": []})) as post:
            brain_api.style_search("hi", 0, None, None)
        self.assertEqual(post.call_args.kwargs["json"], {"query": "hi", "limit": 1})

    def test_missing_results_list_is_an_error(self) -> None:
        with patch.object(brain_api.requests, "post", return_value=json_response({"detail": "nope"})):
            with self.assertRaises(brain_api.BrainApiError):
                brain_api.style_search("hi", 4, None, None)

    def test_failure_fields_never_echo_arbitrary_exception_text(self) -> None:
        self.assertEqual(brain_api.failure_fields(Exception("secret-value in message")), {"error": "Exception"})
        error = requests.HTTPError("401 for url")
        error.response = Mock(status_code=401)
        self.assertEqual(brain_api.failure_fields(error), {"error": "HTTPError", "status": 401})
        config = brain_api.failure_fields(brain_api.BrainApiError("bad url", reason="config"))
        self.assertEqual(config["reason"], "config")


class StyleRagBrainApiTests(EnvTestCase):
    CANDIDATE = {
        "source_outbound_message_id": "main:abc",
        "incoming_text": "Bist du morgen erreichbar?",
        "outgoing_text": "Ja safe, schick einfach kurz wann.",
        "language": "de",
        "chat_kind": "direct",
        "intent": "availability",
        "eligible_for_retrieval": True,
        "is_sensitive": False,
        "metadata": {"sanitized": True},
    }

    def run_index_main(self, response: Mock) -> tuple[int, str]:
        stdout = io.StringIO()
        with patch.object(sys, "argv", ["wa_style_rag.py", "index", "--limit", "100"]), patch.object(
            wa_style_rag, "candidates", return_value=[dict(self.CANDIDATE)]
        ), patch.object(wa_style_rag, "embed_texts", side_effect=AssertionError("local model must not load")), patch.object(
            brain_api.requests, "post", return_value=response
        ), contextlib.redirect_stdout(stdout):
            code = wa_style_rag.main()
        return code, stdout.getvalue()

    def test_index_posts_documented_columns_without_loading_a_local_model(self) -> None:
        response = json_response({"upserted": 1, "skipped": 0, "embedded": 1})
        with patch.object(wa_style_rag, "candidates", return_value=[dict(self.CANDIDATE)]), patch.object(
            wa_style_rag, "embed_texts", side_effect=AssertionError("local model must not load")
        ), patch.object(brain_api.requests, "post", return_value=response) as post:
            result = wa_style_rag.index_examples(100)

        self.assertEqual(
            result, {"ok": True, "candidates": 1, "indexed": 1, "skipped": 0, "embedded": 1, "backend": "brain-api"}
        )
        example = post.call_args.kwargs["json"]["examples"][0]
        self.assertEqual(set(example), set(brain_api.STYLE_UPSERT_FIELDS))
        self.assertIn("Operator replied: Ja safe", example["retrieval_text"])
        self.assertEqual(len(example["content_hash"]), 64)
        self.assertNotIn("sentence_transformers", sys.modules)
        self.assertEqual(self.stderr.getvalue(), "")

    def test_index_reports_secret_guard_skips_and_keeps_the_cron_ok_marker(self) -> None:
        code, output = self.run_index_main(json_response({"upserted": 0, "skipped": 1, "embedded": 0}))
        self.assertEqual(code, 0)
        self.assertIn('"ok": true', output)
        self.assertIn('"skipped": 1', output)
        self.assertIn('"embedded": 0', output)
        self.assertIn("[wa-brain] INDEX_SKIPPED backend=brain-api kind=style count=1", self.stderr.getvalue())

    def test_index_failure_is_logged_and_raised(self) -> None:
        with patch.object(wa_style_rag, "candidates", return_value=[dict(self.CANDIDATE)]), patch.object(
            brain_api.requests, "post", side_effect=requests.ConnectionError("refused")
        ):
            with self.assertRaises(requests.ConnectionError):
                wa_style_rag.index_examples(100)
        self.assertIn("[wa-brain] INDEX_ERROR backend=brain-api kind=style error=ConnectionError", self.stderr.getvalue())

    def test_index_with_a_non_loopback_http_url_is_a_config_error(self) -> None:
        with patch.dict(os.environ, {"BRAIN_API_URL": "http://brain-host:8790"}), patch.object(
            wa_style_rag, "candidates", return_value=[dict(self.CANDIDATE)]
        ), patch.object(brain_api.requests, "post") as post:
            with self.assertRaises(brain_api.BrainApiError):
                wa_style_rag.index_examples(100)
        post.assert_not_called()
        self.assertIn("INDEX_ERROR backend=brain-api kind=style error=BrainApiError reason=config", self.stderr.getvalue())

    def test_query_renders_brain_api_results_with_the_existing_formatter(self) -> None:
        response = json_response({"results": [dict(self.CANDIDATE, similarity=0.8)]})
        with patch.object(brain_api.requests, "post", return_value=response) as post:
            rendered = wa_style_rag.query_examples("Hast du morgen Zeit?", "de", "direct", 4)

        self.assertEqual(post.call_args.args[0], f"{API}/v1/style/search")
        self.assertIn("Operator replied: Ja safe, schick einfach kurz wann.", rendered)
        self.assertEqual(self.stderr.getvalue(), "")

    def test_empty_query_result_is_logged(self) -> None:
        with patch.object(brain_api.requests, "post", return_value=json_response({"results": []})):
            self.assertEqual(wa_style_rag.query_examples("Hast du morgen Zeit?", "de", "direct", 4), "")
        line = self.stderr.getvalue()
        self.assertIn("[wa-brain] RETRIEVAL_EMPTY backend=brain-api kind=style rows=0", line)
        self.assertNotIn("morgen", line)

    def test_rows_without_incoming_text_are_dropped_loudly(self) -> None:
        scoped = dict(self.CANDIDATE, incoming_text=None)
        with patch.object(brain_api.requests, "post", return_value=json_response({"results": [scoped]})):
            self.assertEqual(wa_style_rag.query_examples("Hast du morgen Zeit?", "de", "direct", 4), "")
        self.assertIn(
            "[wa-brain] RETRIEVAL_EMPTY backend=brain-api kind=style reason=no_incoming_text rows=1 missing=1",
            self.stderr.getvalue(),
        )

    def test_partial_incoming_text_still_renders_but_is_logged(self) -> None:
        rows = [dict(self.CANDIDATE), dict(self.CANDIDATE, incoming_text="")]
        with patch.object(brain_api.requests, "post", return_value=json_response({"results": rows})):
            rendered = wa_style_rag.query_examples("Hast du morgen Zeit?", "de", "direct", 4)
        self.assertIn("Operator replied:", rendered)
        self.assertIn("RETRIEVAL_DEGRADED backend=brain-api kind=style reason=no_incoming_text rows=2 missing=1", self.stderr.getvalue())

    def test_one_shot_query_fails_open_with_a_logged_error(self) -> None:
        stdout = io.StringIO()
        argv = ["wa_style_rag.py", "query", "--query", "Hast du morgen Zeit?", "--language", "de"]
        with patch.object(sys, "argv", argv), patch.object(
            brain_api.requests, "post", return_value=json_response({}, status=503)
        ), contextlib.redirect_stdout(stdout):
            self.assertEqual(wa_style_rag.main(), 0)
        self.assertEqual(stdout.getvalue(), "\n")
        self.assertIn("RETRIEVAL_ERROR backend=brain-api kind=style error=HTTPError status=503", self.stderr.getvalue())
        self.assertNotIn("morgen", self.stderr.getvalue())

    def test_worker_probes_health_instead_of_loading_the_model(self) -> None:
        health = json_response({"ok": True, "index": {"notes": 12, "chunks": 340}})
        with patch.object(wa_style_rag_server, "embed_texts", side_effect=AssertionError("no model")), patch.object(
            brain_api.requests, "get", return_value=health
        ) as get:
            wa_style_rag_server.warm_up()
        self.assertEqual(get.call_args.args[0], f"{API}/v1/health")
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer style-token")
        self.assertIn("[wa-brain] HEALTH backend=brain-api ok=True notes=12 chunks=340", self.stderr.getvalue())

    def test_worker_health_failure_is_logged_not_fatal(self) -> None:
        with patch.object(brain_api.requests, "get", side_effect=requests.ConnectionError("refused")):
            wa_style_rag_server.warm_up()
        self.assertIn("RETRIEVAL_ERROR backend=brain-api kind=health error=ConnectionError", self.stderr.getvalue())


class StyleRagSupabaseDefaultTests(EnvTestCase):
    env = {"SUPABASE_URL": "https://supabase.test", "SUPABASE_SERVICE_ROLE_KEY": "service-key"}

    def test_unset_flag_still_queries_the_supabase_rpc(self) -> None:
        with patch.object(wa_style_rag, "embed_texts", return_value=([[0.0] * 384], "local")), patch.object(
            wa_style_rag.requests, "post", return_value=json_response([])
        ) as post:
            wa_style_rag.query_examples("Hast du morgen Zeit?", "de", "direct", 4)
        self.assertEqual(post.call_args.args[0], "https://supabase.test/rest/v1/rpc/onyankopon_whatsapp_style_search")
        self.assertIn("query_embedding", post.call_args.kwargs["json"])

    def test_worker_still_warms_the_local_model(self) -> None:
        with patch.object(wa_style_rag_server, "embed_texts") as embed:
            wa_style_rag_server.warm_up()
        embed.assert_called_once_with(["warmup"])


class PersonalContextBrainApiTests(EnvTestCase):
    def test_search_request_uses_the_search_token_and_widened_text(self) -> None:
        response = json_response(
            {
                "results": [
                    {
                        "title": "Projects/Alpha",
                        "text": "  Alpha launch is on\nFriday, venue booked ",
                        "snippet": "Alpha launch",
                        "path": "Projects/Alpha.md",
                    },
                    {"title": "", "path": "Knowledge/Pricing.md", "snippet": "Coaching costs 2k"},
                    {"title": "Empty", "text": "", "snippet": ""},
                ]
            }
        )
        with patch.object(brain_api.requests, "post", return_value=response) as post:
            rendered = wa_personal_context.query_context("Wann ist der Alpha Launch?", 10, 2400)

        self.assertEqual(post.call_count, 1)
        self.assertEqual(post.call_args.args[0], f"{API}/v1/search")
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer search-token")
        self.assertEqual(
            post.call_args.kwargs["json"],
            {"query": "Wann ist der Alpha Launch?", "mode": "hybrid", "limit": 6, "text_chars": wa_personal_context.CONTEXT_TEXT_CHARS},
        )
        self.assertEqual(
            rendered.splitlines(),
            [
                wa_personal_context.BRAIN_CONTEXT_LABEL,
                "- Projects/Alpha: Alpha launch is on Friday, venue booked",
                "- Knowledge/Pricing.md: Coaching costs 2k",
            ],
        )

    def test_long_text_is_clipped_to_one_row(self) -> None:
        response = json_response({"results": [{"title": "Long", "text": "x" * 2000}]})
        with patch.object(brain_api.requests, "post", return_value=response):
            rendered = wa_personal_context.query_context("long", 3, 4000)
        self.assertEqual(rendered.splitlines()[1], "- Long: " + "x" * wa_personal_context.CONTEXT_ROW_CHARS)

    def test_folders_are_sent_only_when_configured(self) -> None:
        with patch.dict(os.environ, {"BRAIN_API_SEARCH_FOLDERS": "Knowledge, Projects ,"}), patch.object(
            brain_api.requests, "post", return_value=json_response({"results": []})
        ) as post:
            wa_personal_context.query_context("alpha", 3, 2400)
        self.assertEqual(post.call_args.kwargs["json"]["folders"], ["Knowledge", "Projects"])

    def test_empty_result_returns_nothing_and_is_logged(self) -> None:
        with patch.object(brain_api.requests, "post", return_value=json_response({"results": []})):
            self.assertEqual(wa_personal_context.query_context("alpha", 3, 2400), "")
        self.assertIn("[wa-brain] RETRIEVAL_EMPTY backend=brain-api kind=context rows=0", self.stderr.getvalue())

    def test_main_fails_open_and_logs_without_query_text(self) -> None:
        stdout = io.StringIO()
        argv = ["wa_personal_context.py", "--query", "geheime frage"]
        with patch.object(sys, "argv", argv), patch.object(
            brain_api.requests, "post", side_effect=requests.ConnectionError("refused")
        ), contextlib.redirect_stdout(stdout):
            self.assertEqual(wa_personal_context.main(), 0)
        self.assertEqual(stdout.getvalue(), "\n")
        log = self.stderr.getvalue()
        self.assertIn("[wa-brain] RETRIEVAL_ERROR backend=brain-api kind=context error=ConnectionError", log)
        self.assertNotIn("geheime", log)

    def test_main_with_a_bad_url_fails_open_as_a_config_error(self) -> None:
        stdout = io.StringIO()
        argv = ["wa_personal_context.py", "--query", "alpha"]
        with patch.dict(os.environ, {"BRAIN_API_URL": "http://brain-host:8790"}), patch.object(sys, "argv", argv), patch.object(
            brain_api.requests, "post"
        ) as post, contextlib.redirect_stdout(stdout):
            self.assertEqual(wa_personal_context.main(), 0)
        post.assert_not_called()
        self.assertEqual(stdout.getvalue(), "\n")
        self.assertIn("RETRIEVAL_ERROR backend=brain-api kind=context error=BrainApiError reason=config", self.stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
