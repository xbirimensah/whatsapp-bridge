#!/usr/bin/env python3
"""Long-lived style-RAG worker for the autoreply sidecar.

Loads the local sentence-transformers model once and answers style queries over
a JSON-lines stdin/stdout protocol, so drafting does not pay the multi-second
torch cold start on every incoming message. Spawned and supervised by
autoreply-style-rag.ts; the one-shot wa_style_rag.py path remains the fallback.

Protocol:
  ready signal:  {"ready": true}
  request line:  {"id": 1, "query": "...", "language": "de", "chat_kind": "direct", "limit": 4}
  response line: {"id": 1, "ok": true, "result": "..."}
                 {"id": 1, "ok": false, "error": "..."}
"""
from __future__ import annotations

import json
import sys

from wa_style_rag import embed_texts, load_runtime_env, query_examples

MAX_ERROR_CHARS = 500


def handle_request(line: str) -> dict[str, object]:
    request_id: object = None
    try:
        request = json.loads(line)
        request_id = request.get("id")
        result = query_examples(
            str(request.get("query") or ""),
            request.get("language") or None,
            request.get("chat_kind") or None,
            int(request.get("limit") or 4),
        )
        return {"id": request_id, "ok": True, "result": result}
    except Exception as error:  # noqa: BLE001 - the worker must survive any bad request
        return {"id": request_id, "ok": False, "error": str(error)[:MAX_ERROR_CHARS]}


def main() -> int:
    load_runtime_env()
    # Pay the model load up front so the ready signal means "fast from now on".
    embed_texts(["warmup"])
    print(json.dumps({"ready": True}), flush=True)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        print(json.dumps(handle_request(line)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
