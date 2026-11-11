#!/usr/bin/env python3
"""Long-lived style-RAG worker for the autoreply sidecar.

Loads the local sentence-transformers model once and answers style queries over
a JSON-lines stdin/stdout protocol, so drafting does not pay the multi-second
torch cold start on every incoming message. Spawned and supervised by
autoreply-style-rag.ts; the one-shot wa_style_rag.py path remains the fallback.
With SECOND_BRAIN_BACKEND=brain-api there is no local model: the worker probes
the brain API health endpoint instead and reports the result on stderr.

Protocol:
  ready signal:  {"ready": true}
  request line:  {"id": 1, "query": "...", "language": "de", "chat_kind": "direct", "limit": 4}
  response line: {"id": 1, "ok": true, "result": "..."}
                 {"id": 1, "ok": false, "error": "..."}
"""
from __future__ import annotations

import json
import sys

import brain_api
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


def probe_brain_api() -> None:
    """Log one HEALTH line; never blocks the ready signal."""
    try:
        status = brain_api.health()
    except Exception as error:  # noqa: BLE001 - startup must not die on a probe
        brain_api.log_failure("RETRIEVAL_ERROR", error, backend=brain_api.BRAIN_API, kind="health")
        return
    index = status.get("index") if isinstance(status.get("index"), dict) else {}
    brain_api.log_event(
        "HEALTH",
        backend=brain_api.BRAIN_API,
        ok=bool(status.get("ok")),
        notes=index.get("notes"),
        chunks=index.get("chunks"),
    )


def warm_up() -> None:
    backend = brain_api.backend_label()
    if backend == brain_api.BRAIN_API:
        probe_brain_api()
    elif backend == brain_api.SUPABASE:
        # Pay the model load up front so the ready signal means "fast from now on".
        embed_texts(["warmup"])
    else:
        brain_api.log_event("RETRIEVAL_ERROR", backend=backend, kind="health", reason="config", detail='"invalid SECOND_BRAIN_BACKEND"')


def main() -> int:
    load_runtime_env()
    warm_up()
    print(json.dumps({"ready": True}), flush=True)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        print(json.dumps(handle_request(line)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
