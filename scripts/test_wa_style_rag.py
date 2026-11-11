#!/usr/bin/env python3
"""Focused unit tests for the WhatsApp style-RAG ingestion safeguards."""
from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

import wa_style_rag


class StyleRagSanitizationTests(unittest.TestCase):
    def test_redact_text_removes_direct_identifiers_and_normalizes_space(self) -> None:
        source = "  Reach me at max@example.com, +49 151 23456789 — https://example.com/a?x=1  "
        result = wa_style_rag.redact_text(source)
        self.assertEqual(result, "Reach me at [email], [phone] — [link]")

    def test_sensitive_content_is_not_eligible_for_style_retrieval(self) -> None:
        self.assertFalse(wa_style_rag.is_style_eligible("Can you send the invoice?", "I'll check the payment."))

    def test_short_casual_exchange_is_eligible(self) -> None:
        self.assertTrue(wa_style_rag.is_style_eligible("Bist du morgen erreichbar?", "Ja safe, schick einfach kurz wann."))

    def test_retrieval_text_uses_only_redacted_content(self) -> None:
        text = wa_style_rag.build_retrieval_text(
            "Can you email max@example.com?",
            "Ja, schick den Link an +49 151 23456789.",
            "de",
            "direct",
            "follow_up",
        )
        self.assertNotIn("max@example.com", text)
        self.assertNotIn("23456789", text)
        self.assertIn("[email]", text)
        self.assertIn("[phone]", text)


class StyleRagFormatTests(unittest.TestCase):
    def test_prompt_examples_are_capped_and_do_not_expose_source_identifiers(self) -> None:
        rows = [
            {
                "incoming_text": "Bist du morgen erreichbar?",
                "outgoing_text": "Ja safe, schick einfach kurz wann.",
                "language": "de",
                "chat_kind": "direct",
                "intent": "availability",
                "source_outbound_message_id": "main:private-id",
            }
        ]
        rendered = wa_style_rag.format_style_examples(rows, language=None, limit=1, max_chars=500)
        self.assertIn("Incoming: Bist du morgen erreichbar?", rendered)
        self.assertIn("Operator replied: Ja safe, schick einfach kurz wann.", rendered)
        self.assertNotIn("private-id", rendered)


class StyleRagUpsertTests(unittest.TestCase):
    def test_upsert_payload_splits_large_index_requests_into_bounded_batches(self) -> None:
        response = Mock()
        response.raise_for_status.return_value = None
        payload = [{"source_outbound_message_id": str(index)} for index in range(101)]
        with patch.object(wa_style_rag.requests, "post", return_value=response) as post:
            wa_style_rag.upsert_payload("https://example.test", "test-key", payload, batch_size=50)

        self.assertEqual(post.call_count, 3)
        self.assertEqual([len(call.kwargs["json"]) for call in post.call_args_list], [50, 50, 1])


if __name__ == "__main__":
    unittest.main()
