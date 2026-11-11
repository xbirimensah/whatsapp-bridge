#!/usr/bin/env python3
"""Client for the brain REST API used by the style-RAG and personal-context scripts.

This module is the ONLY place that knows the brain API's paths and field names.
The scripts call it when the backend flag says so and otherwise keep their
Supabase path for rollback.

Environment (read after the scripts' load_runtime_env, so the bridge .env wins):
  SECOND_BRAIN_BACKEND         brain-api | supabase   (unset = supabase, the old path)
  BRAIN_API_URL                base URL; must be https or a loopback host
                               (127.0.0.1, localhost, ::1), default loopback
  BRAIN_API_TOKEN              style token (style search, style upsert, health);
  BRAIN_API_TOKEN_FILE         read from this file when the variable is unset
  BRAIN_API_SEARCH_TOKEN       read-only search token for /v1/search;
  BRAIN_API_SEARCH_TOKEN_FILE  read from this file when the variable is unset
  BRAIN_API_SEARCH_FOLDERS     optional comma list, limits /v1/search to folders

Token files must be owner-only (no group or world permission bits). Token values
are only ever sent in the Authorization header and never logged.

The server embeds queries and examples itself, so nothing here loads a model.
Every failure or empty result is reported as one stderr line starting with
"[wa-brain]" plus a stable token (RETRIEVAL_ERROR, RETRIEVAL_EMPTY,
RETRIEVAL_DEGRADED, INDEX_ERROR, HEALTH). Lines never contain query text,
message text or secrets.
"""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

import requests

BRAIN_API = "brain-api"
SUPABASE = "supabase"
BACKENDS = (BRAIN_API, SUPABASE)

DEFAULT_URL = "http://127.0.0.1:8790"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
STYLE_TOKEN = ("BRAIN_API_TOKEN", "BRAIN_API_TOKEN_FILE", "~/.config/onyankopon/token-style-writer")
SEARCH_TOKEN = ("BRAIN_API_SEARCH_TOKEN", "BRAIN_API_SEARCH_TOKEN_FILE", "~/.config/onyankopon/token-search")
REQUEST_TIMEOUT_SECONDS = 30
UPSERT_TIMEOUT_SECONDS = 120
UPSERT_BATCH_SIZE = 50
MAX_STYLE_RESULTS = 6
LOG_PREFIX = "[wa-brain]"

# Columns of the style-examples table sent to /v1/style/upsert.
# The embedding (and its model/timestamp) is computed by the server.
STYLE_UPSERT_FIELDS = (
    "source_outbound_message_id",
    "incoming_text",
    "outgoing_text",
    "language",
    "chat_kind",
    "intent",
    "eligible_for_retrieval",
    "is_sensitive",
    "metadata",
    "retrieval_text",
    "content_hash",
)
# Fields of a /v1/style/search result, same names as the old RPC rows.
STYLE_RESULT_FIELDS = ("incoming_text", "outgoing_text", "language", "chat_kind", "intent", "similarity")


class BrainApiError(RuntimeError):
    """Configuration or protocol problem whose message is safe to log."""

    def __init__(self, message: str, reason: str = "protocol") -> None:
        super().__init__(message)
        self.reason = reason


def selected_backend() -> str:
    value = os.environ.get("SECOND_BRAIN_BACKEND", "").strip().lower()
    if not value:
        return SUPABASE
    if value not in BACKENDS:
        raise BrainApiError(f"SECOND_BRAIN_BACKEND must be one of {', '.join(BACKENDS)}", reason="config")
    return value


def backend_label() -> str:
    """Backend name for log lines; never raises."""
    try:
        return selected_backend()
    except BrainApiError:
        return "invalid"


def base_url() -> str:
    """Configured base URL; refuses plain http to anything but loopback."""
    url = os.environ.get("BRAIN_API_URL", "").strip().rstrip("/") or DEFAULT_URL
    parts = urlsplit(url)
    if parts.scheme == "https" and parts.hostname:
        return url
    if parts.scheme == "http" and (parts.hostname or "").lower() in LOOPBACK_HOSTS:
        return url
    raise BrainApiError("BRAIN_API_URL must use https or a loopback host", reason="config")


def read_token(token_source: tuple[str, str, str] = STYLE_TOKEN) -> str:
    env_name, file_env_name, default_file = token_source
    token = os.environ.get(env_name, "").strip()
    if token:
        return token
    path = Path(os.path.expanduser(os.environ.get(file_env_name, "").strip() or default_file))
    try:
        mode = path.stat().st_mode
    except OSError as error:
        raise BrainApiError(f"brain API token file is not readable: {path}", reason="config") from error
    if stat.S_IMODE(mode) & 0o077:
        raise BrainApiError(f"brain API token file is group- or world-accessible: {path}", reason="config")
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise BrainApiError(f"brain API token file is not readable: {path}", reason="config") from error
    if not token:
        raise BrainApiError(f"brain API token file is empty: {path}", reason="config")
    return token


def _request_target(path: str, token_source: tuple[str, str, str]) -> tuple[str, dict[str, str]]:
    # Validate the URL before the token is even read, so a bad URL can never
    # receive it.
    url = f"{base_url()}{path}"
    headers = {"Authorization": f"Bearer {read_token(token_source)}", "Content-Type": "application/json"}
    return url, headers


def _json_object(response: requests.Response) -> dict[str, Any]:
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise BrainApiError("brain API returned a non-object JSON body")
    return payload


def _post(
    path: str,
    body: dict[str, Any],
    token_source: tuple[str, str, str] = STYLE_TOKEN,
    timeout: int = REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    url, headers = _request_target(path, token_source)
    return _json_object(requests.post(url, headers=headers, json=body, timeout=timeout))


def _results(payload: dict[str, Any]) -> list[dict[str, Any]]:
    results = payload.get("results")
    if not isinstance(results, list):
        raise BrainApiError("brain API response has no results list")
    return [row for row in results if isinstance(row, dict)]


def health() -> dict[str, Any]:
    url, headers = _request_target("/v1/health", STYLE_TOKEN)
    return _json_object(requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS))


UPSERT_COUNTERS = ("upserted", "skipped", "embedded")


def style_upsert(rows: Iterable[dict[str, Any]], batch_size: int = UPSERT_BATCH_SIZE) -> dict[str, int]:
    """POST /v1/style/upsert in bounded batches; returns summed counters.

    `skipped` counts examples the server's secret guard rejected, `embedded`
    the ones it (re-)embedded. Only documented columns are sent, since the
    server answers unknown fields with 400.
    """
    examples = [{field: row[field] for field in STYLE_UPSERT_FIELDS if field in row} for row in rows]
    totals = dict.fromkeys(UPSERT_COUNTERS, 0)
    for start in range(0, len(examples), batch_size):
        batch = examples[start : start + batch_size]
        payload = _post("/v1/style/upsert", {"examples": batch}, timeout=UPSERT_TIMEOUT_SECONDS)
        for counter in UPSERT_COUNTERS:
            totals[counter] += int(payload.get(counter) or 0)
    return totals


def style_search(query: str, limit: int, language: str | None, chat_kind: str | None) -> list[dict[str, Any]]:
    """POST /v1/style/search; rows carry the same keys the Supabase RPC returned."""
    body: dict[str, Any] = {"query": query, "limit": max(1, min(limit, MAX_STYLE_RESULTS))}
    if language:
        body["language"] = language
    if chat_kind:
        body["chat_kind"] = chat_kind
    rows = _results(_post("/v1/style/search", body))
    return [{field: row.get(field) for field in STYLE_RESULT_FIELDS} for row in rows]


def count_missing_incoming(rows: Iterable[dict[str, Any]]) -> int:
    """Rows with operator text but no incoming side (a token scope that hides it)."""
    return sum(
        1
        for row in rows
        if str(row.get("outgoing_text") or "").strip() and not str(row.get("incoming_text") or "").strip()
    )


def search_folders_from_env() -> list[str] | None:
    raw = os.environ.get("BRAIN_API_SEARCH_FOLDERS", "")
    folders = [part.strip() for part in raw.split(",") if part.strip()]
    return folders or None


def search(query: str, limit: int, text_chars: int, folders: list[str] | None = None) -> list[dict[str, str]]:
    """POST /v1/search (hybrid) with the search token; returns [{title, text}].

    `text` is the best chunk widened up to `text_chars`; `snippet` is only the
    fallback for servers that do not return it.
    """
    body: dict[str, Any] = {"query": query, "mode": "hybrid", "limit": limit, "text_chars": text_chars}
    if folders:
        body["folders"] = folders
    items: list[dict[str, str]] = []
    for row in _results(_post("/v1/search", body, token_source=SEARCH_TOKEN)):
        items.append(
            {
                "title": str(row.get("title") or row.get("path") or ""),
                "text": str(row.get("text") or row.get("snippet") or ""),
            }
        )
    return items


def failure_fields(error: BaseException) -> dict[str, Any]:
    """Secret-free log fields: class name, HTTP status, or our own reason + message."""
    if isinstance(error, requests.HTTPError) and error.response is not None:
        return {"error": "HTTPError", "status": error.response.status_code}
    if isinstance(error, BrainApiError):
        return {"error": "BrainApiError", "reason": error.reason, "detail": f'"{error}"'}
    return {"error": type(error).__name__}


def log_event(token: str, **fields: Any) -> None:
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"{LOG_PREFIX} {token} {details}".rstrip(), file=sys.stderr, flush=True)


def log_failure(token: str, error: BaseException, **fields: Any) -> None:
    log_event(token, **fields, **failure_fields(error))
