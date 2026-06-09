"""Tests for the Self-Fix assistant.

The safety guardrail is the highest-stakes part of this feature, so it gets the
most coverage. All tests run offline (no network, no API key) — respond() falls
back to the rule-based responder when no key is configured.

Run:  python3 selffix/test_assistant.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import assistant  # noqa: E402


class SafetyGuardrailTests(unittest.TestCase):
    # Phrases that MUST be blocked and routed to booking.
    DANGEROUS = [
        "my outlet is sparking when I plug things in",
        "there's smoke coming from the wall socket",
        "I smell burning near the breaker panel",
        "the wire is exposed and looks frayed",
        "I got a shock touching the light switch",
        "the outlet is hot to the touch",
        "there are flames near the panel",
        "the plug melted",
        "water is flooding near the outlet",
        "the socket is buzzing loudly",
    ]

    # Phrases that should be allowed through to the helpful path.
    SAFE = [
        "my living room outlets aren't working",
        "how do I reset a tripped breaker",
        "the bathroom GFCI outlet has no power",
        "I need to change a light bulb",
        "which fuse do I replace",
        "the lights are flickering a little",
    ]

    def test_dangerous_messages_are_blocked(self):
        for msg in self.DANGEROUS:
            with self.subTest(msg=msg):
                verdict = assistant.check_safety(msg)
                self.assertTrue(verdict["blocked"], f"should block: {msg!r}")
                self.assertEqual(verdict["level"], "danger")
                self.assertTrue(verdict["matched"])

    def test_safe_messages_are_not_blocked(self):
        for msg in self.SAFE:
            with self.subTest(msg=msg):
                verdict = assistant.check_safety(msg)
                self.assertFalse(verdict["blocked"], f"should NOT block: {msg!r}")
                self.assertEqual(verdict["level"], "safe")

    def test_blocked_response_redirects_to_booking_without_steps(self):
        result = assistant.respond("my outlet is sparking and there's smoke")
        self.assertTrue(result["safety"]["blocked"])
        self.assertTrue(result["redirect_to_booking"])
        self.assertEqual(result["source"], "guardrail")
        self.assertEqual(result["suggested_steps"], [])

    def test_guardrail_runs_before_llm(self):
        # Even with a (fake) API key set, a dangerous message must be blocked in
        # code and never reach the network. We point at an unroutable base URL;
        # if the guardrail failed to short-circuit, this would try to connect.
        result = assistant.respond(
            "sparks everywhere",
            config={"api_key": "fake", "base_url": "http://127.0.0.1:1", "model": "x"},
        )
        self.assertEqual(result["source"], "guardrail")
        self.assertTrue(result["redirect_to_booking"])


class HelpfulPathTests(unittest.TestCase):
    def test_breaker_question_gets_offline_steps(self):
        result = assistant.respond("my living room outlets aren't working")
        self.assertFalse(result["redirect_to_booking"])
        self.assertEqual(result["source"], "offline")
        self.assertTrue(result["suggested_steps"])  # KB matched -> steps returned

    def test_empty_message_is_handled(self):
        result = assistant.respond("   ")
        self.assertFalse(result["redirect_to_booking"])
        self.assertIn("reply", result)

    def test_unknown_topic_falls_back_gracefully(self):
        result = assistant.respond("tell me about your company history")
        self.assertFalse(result["redirect_to_booking"])
        self.assertIn("reply", result)

    def test_llm_failure_degrades_to_offline(self):
        # Valid-looking config but unroutable endpoint -> should not raise, should
        # fall back to the offline responder.
        result = assistant.respond(
            "how do I reset my breaker",
            config={"api_key": "fake", "base_url": "http://127.0.0.1:1", "model": "x"},
        )
        self.assertEqual(result["source"], "offline")


class RetrievalTests(unittest.TestCase):
    def test_retrieve_kb_ranks_relevant_entries(self):
        hits = assistant.retrieve_kb("the gfci outlet in my bathroom tripped")
        self.assertTrue(hits)
        self.assertIn("GFCI", hits[0]["title"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
