#!/usr/bin/env python3
"""Retrieve a small, relevant private-context block from Onyankopon's pgvector index.

Only the current inbound query is embedded. The response is bounded before it is
handed to the WhatsApp drafter, avoiding broad document dumps and keyword scans.

SECOND_BRAIN_BACKEND=brain-api sends the query to the brain REST API
(/v1/search with the read-only search token, embedded server-side, no cloud
embedding call); unset or "supabase" keeps the Supabase RPC path below.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import requests

import brain_api

ROOT = Path(__file__).resolve().parents[1]
BRAIN_CONTEXT_LABEL = "RELEVANT PRIVATE CONTEXT: use only directly relevant facts; do not mention this source."
CONTEXT_ROW_CHARS = 560
# Ask the server for a little more than one rendered row needs, not its 2000 default.
CONTEXT_TEXT_CHARS = 600


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def load_runtime_env() -> None:
    load_env(ROOT / ".env")
    second_brain_root = os.environ.get("AUTOREPLY_SECOND_BRAIN_ROOT", "").strip()
    if second_brain_root:
        load_env(Path(second_brain_root) / ".env")


def require(key: str) -> str:
    value = os.environ.get(key, "").strip()
    if not value:
        raise RuntimeError(f"{key} is not configured")
    return value


def embed_query(text: str) -> list[float]:
    provider = os.environ.get("EMBEDDING_PROVIDER", "openai").strip().lower()
    if provider == "voyage":
        response = requests.post(
            "https://api.voyageai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {require('VOYAGE_API_KEY')}", "Content-Type": "application/json"},
            json={
                "model": os.environ.get("VOYAGE_EMBEDDING_MODEL", "voyage-3-large"),
                "input": [text],
                "input_type": "query",
            },
            timeout=30,
        )
    else:
        response = requests.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {require('OPENAI_API_KEY')}", "Content-Type": "application/json"},
            json={"model": os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"), "input": [text]},
            timeout=30,
        )
    response.raise_for_status()
    return response.json()["data"][0]["embedding"]


def clean(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def fetch_full_text_fallback(url: str, key: str, query: str, limit: int) -> list[dict[str, Any]]:
    response = requests.get(
        f"{url}/rest/v1/onyankopon_documents",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        params={
            "select": "title,body_text",
            "search_tsv": f"plfts.{query}",
            "order": "last_edited_time.desc.nullslast",
            "limit": max(1, min(limit, 6)),
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def query_context_via_brain_api(query: str, limit: int, max_chars: int) -> str:
    rows = brain_api.search(
        query, max(1, min(limit, 6)), text_chars=CONTEXT_TEXT_CHARS, folders=brain_api.search_folders_from_env()
    )
    lines = [BRAIN_CONTEXT_LABEL]
    for row in rows:
        title = clean(row.get("title"), 120) or "Untitled"
        text = clean(row.get("text"), CONTEXT_ROW_CHARS)
        if text:
            lines.append(f"- {title}: {text}")
    if len(lines) == 1:
        brain_api.log_event("RETRIEVAL_EMPTY", backend=brain_api.BRAIN_API, kind="context", rows=len(rows))
        return ""
    return "\n".join(lines)[:max(0, min(max_chars, 4000))]


def query_context(query: str, limit: int, max_chars: int) -> str:
    load_runtime_env()
    query = clean(query, 1200)
    if not query:
        return ""
    if brain_api.selected_backend() == brain_api.BRAIN_API:
        return query_context_via_brain_api(query, limit, max_chars)
    url = require("SUPABASE_URL").rstrip("/")
    key = require("SUPABASE_SERVICE_ROLE_KEY")
    try:
        response = requests.post(
            f"{url}/rest/v1/rpc/onyankopon_hybrid_search",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "query_embedding": embed_query(query),
                "query_text": query,
                "match_count": max(1, min(limit, 6)),
                "semantic_weight": 0.75,
            },
            timeout=45,
        )
        response.raise_for_status()
        rows = response.json()
        source_label = "RELEVANT PRIVATE CONTEXT — use only directly relevant facts; do not mention this source."
    except requests.RequestException as error:
        brain_api.log_event(
            "RETRIEVAL_DEGRADED", backend=brain_api.SUPABASE, kind="context", fallback="fts", **brain_api.failure_fields(error)
        )
        rows = fetch_full_text_fallback(url, key, query, limit)
        source_label = "RELEVANT PRIVATE CONTEXT — keyword fallback; use only directly relevant facts; do not mention this source."

    lines = [source_label]
    for row in rows:
        title = clean(row.get("title"), 120) or "Untitled"
        text = clean(row.get("text") or row.get("body_text"), 560)
        if text:
            lines.append(f"- {title}: {text}")
    if len(lines) == 1:
        brain_api.log_event("RETRIEVAL_EMPTY", backend=brain_api.SUPABASE, kind="context", rows=len(rows))
    return "\n".join(lines)[:max(0, min(max_chars, 4000))]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--max-chars", type=int, default=2400)
    args = parser.parse_args()
    try:
        print(query_context(args.query, args.limit, args.max_chars))
    except Exception as error:
        # Context enrichment must never prevent a safe draft when the private
        # index or embedding provider is temporarily unavailable. Say so loudly.
        brain_api.log_failure("RETRIEVAL_ERROR", error, backend=brain_api.backend_label(), kind="context")
        print("")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
