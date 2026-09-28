"""The agent lane: four named outcomes, a speakable answer, and no waiting on callers."""

from __future__ import annotations

import httpx
import pytest

from hermes_gemini_live import agent_lane, tools


def test_probe_reports_absent_rather_than_a_bare_exception(monkeypatch):
    def explode(*a, **k):
        raise httpx.ConnectError("nothing listening")

    monkeypatch.setattr(agent_lane.httpx, "get", explode)
    monkeypatch.setenv("API_SERVER_KEY", "a-key")
    status, detail = agent_lane.probe()
    assert status == agent_lane.STATUS_ABSENT
    assert "ConnectError" in detail


def test_probe_distinguishes_a_wrong_key_from_a_dead_server(monkeypatch):
    monkeypatch.setenv("API_SERVER_KEY", "a-key")
    monkeypatch.setattr(agent_lane.httpx, "get",
                        lambda *a, **k: httpx.Response(403, json={}))
    assert agent_lane.probe()[0] == agent_lane.STATUS_UNAUTHORIZED


def test_probe_says_unauthorized_without_touching_the_network_when_no_key(monkeypatch):
    monkeypatch.delenv("API_SERVER_KEY", raising=False)
    called = []
    monkeypatch.setattr(agent_lane.httpx, "get",
                        lambda *a, **k: called.append(1))
    assert agent_lane.probe()[0] == agent_lane.STATUS_UNAUTHORIZED
    assert called == []


def test_a_profile_refusal_names_the_env_to_fix(monkeypatch):
    # A multiplexed gateway will not inherit the owner's key for /p/<profile>/, so the
    # one string the user acts on has to carry which home's .env is empty.
    monkeypatch.delenv("API_SERVER_KEY", raising=False)
    monkeypatch.setattr(agent_lane.httpx, "get", lambda *a, **k: None)
    assert "vex_agent" in agent_lane.probe(profile="vex_agent")[1]
    assert "vex_agent" not in agent_lane.probe()[1]


def test_a_profile_refusal_names_the_env_to_fix(monkeypatch):
    # A multiplexed gateway will not inherit the owner's key for /p/<profile>/, so the
    # one string the user acts on has to carry which home's .env is empty.
    monkeypatch.delenv("API_SERVER_KEY", raising=False)
    monkeypatch.setattr("hermes_gemini_live.config.serving_profile", lambda: "vex_agent")
    monkeypatch.setattr(agent_lane.httpx, "get", lambda *a, **k: None)
    status, detail = agent_lane.probe(profile="vex_agent")
    assert status == agent_lane.STATUS_UNAUTHORIZED
    assert "vex_agent" in detail and ".env" in detail


def test_probe_refuses_a_server_that_cannot_take_runs(monkeypatch):
    monkeypatch.setenv("API_SERVER_KEY", "a-key")
    response = httpx.Response(200, json={"features": {"run_submission": False}})
    monkeypatch.setattr(agent_lane.httpx, "get", lambda *a, **k: response)
    status, detail = agent_lane.probe()
    assert status == agent_lane.STATUS_ERROR
    assert "run submission" in detail


def test_submit_sends_the_prompt_and_reads_the_run_id(monkeypatch):
    seen = {}

    def post(url, json=None, headers=None, timeout=None):
        seen["url"], seen["body"], seen["headers"] = url, json, headers
        return httpx.Response(202, json={"run_id": "run_42", "status": "queued"})

    monkeypatch.setenv("API_SERVER_KEY", "a-key")
    monkeypatch.setattr(agent_lane.httpx, "post", post)
    assert agent_lane.submit("count files", session_key="vex") == "run_42"
    assert seen["body"] == {"input": "count files"}
    assert seen["headers"]["X-Hermes-Session-Key"] == "vex"
    assert seen["headers"]["Authorization"] == "Bearer a-key"


def test_submit_rejects_a_run_with_no_id(monkeypatch):
    monkeypatch.setattr(agent_lane.httpx, "post",
                        lambda *a, **k: httpx.Response(201, json={"status": "queued"}))
    with pytest.raises(agent_lane.LaneUnavailable, match="no id"):
        agent_lane.submit("anything")


def test_await_result_polls_to_a_terminal_status_then_returns_speakable_text(monkeypatch):
    script = iter([
        {"status": "running"},
        {"status": "completed", "output": "# Result\n`web/`\nfour files"},
    ])
    monkeypatch.setattr(agent_lane.time, "sleep", lambda _s: None)
    monkeypatch.setattr(agent_lane, "fetch",
                        lambda run_id, session_key=None, profile=None: next(script))
    state, text = agent_lane.await_result("run_1")
    assert state == "completed"
    assert text == "Result web/ four files"


def test_await_result_gives_up_on_a_deadline_instead_of_forever(monkeypatch):
    monkeypatch.setattr(agent_lane, "fetch",
                        lambda run_id, session_key=None, profile=None: {"status": "running"})
    clock = iter([0.0, 10_000.0])
    monkeypatch.setattr(agent_lane.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(agent_lane.time, "sleep", lambda _s: None)
    state, text = agent_lane.await_result("run_1", deadline_seconds=5)
    assert state == "timed_out"
    assert "5 seconds" in text


@pytest.mark.parametrize("raw,expected", [
    ("keep it short", "keep it short"),
    ("**bold** and `code`", "bold and code"),
    ("line\n```\nprint(1)\n```\ndone", "line (code omitted) done"),
    ("", ""),
])
def test_speakable_strips_what_cannot_be_said(raw, expected):
    assert agent_lane.speakable(raw) == expected


def test_speakable_keeps_the_tail_and_bounds_the_length():
    text = agent_lane.speakable("x" * 9000)
    assert len(text) == agent_lane.MAX_SPEAKABLE_CHARS


def test_a_named_profile_is_routed_to_its_own_ingress(monkeypatch):
    # A multiplexed gateway serves every profile from the default listener at
    # /p/<profile>/, and an unprefixed run resumes in the DEFAULT profile's store — so
    # naming the profile is what keeps one profile's work out of another's memory.
    monkeypatch.delenv("GEMINI_LIVE_API_SERVER_URL", raising=False)
    assert agent_lane.base_url() == agent_lane.DEFAULT_API_SERVER_URL
    assert agent_lane.base_url("default") == agent_lane.DEFAULT_API_SERVER_URL
    assert agent_lane.base_url("vex_agent") == "http://127.0.0.1:8642/p/vex_agent"
    assert agent_lane.base_url("a b") == "http://127.0.0.1:8642/p/a%20b"


def test_submit_and_poll_carry_the_profile_ingress(monkeypatch):
    urls = []

    def post(url, json=None, headers=None, timeout=None):
        urls.append(url)
        return httpx.Response(202, json={"run_id": "run_9"})

    def get(url, headers=None, timeout=None):
        urls.append(url)
        return httpx.Response(200, json={"status": "completed", "output": "done"})

    monkeypatch.setattr(agent_lane.httpx, "post", post)
    monkeypatch.setattr(agent_lane.httpx, "get", get)
    run_id = agent_lane.submit("task", profile="vex_agent")
    agent_lane.await_result(run_id, profile="vex_agent")
    assert urls == ["http://127.0.0.1:8642/p/vex_agent/v1/runs",
                    "http://127.0.0.1:8642/p/vex_agent/v1/runs/run_9"]


def test_a_foreign_profile_reads_its_own_key_not_the_launch_env(monkeypatch):
    # The shared listener authenticates /p/<profile>/ with that profile's key, and
    # os.environ holds the launch profile's value for every one of them.
    from contextlib import contextmanager

    bound = []

    @contextmanager
    def fake_scope(profile):
        bound.append(profile)
        monkeypatch.setenv("API_SERVER_KEY", "key-of-" + profile)
        try:
            yield None
        finally:
            monkeypatch.setenv("API_SERVER_KEY", "launch-key")

    monkeypatch.setenv("API_SERVER_KEY", "launch-key")
    monkeypatch.setattr(agent_lane, "_foreign_profile_scope", fake_scope)
    monkeypatch.setattr("hermes_gemini_live.config.serving_profile", lambda: "vex_agent")

    assert agent_lane.key() == "launch-key"
    assert agent_lane.key("zen_agent") == "key-of-zen_agent"
    assert bound == ["zen_agent"]
    assert agent_lane.key("vex_agent") == "launch-key"
    assert bound == ["zen_agent"]


def test_the_delegate_is_one_call_and_its_schema_types_are_uppercase():
    declarations = tools.declarations()
    assert len(declarations) == 1
    # Async-only on the extended-thinking Live models; blocking returns a hard error there.
    assert declarations[0]["behavior"] == "NON_BLOCKING"
    parameters = declarations[0]["parameters"]
    assert parameters["type"] == "OBJECT"
    assert parameters["properties"]["task"]["type"] == "STRING"
    assert parameters["required"] == ["task"]


def test_compose_prompt_folds_context_in_and_refuses_empty():
    assert tools.compose_prompt({"task": "  list pods  "}) == "list pods"
    assert tools.compose_prompt({}).strip() == ""
    assert tools.compose_prompt({"task": "why?", "context": "prod cluster"}).startswith(
        "why?\n\nContext from the voice call: prod cluster")


def test_run_book_tracks_only_live_runs():
    book = agent_lane.RunBook()
    book.add("run_b")
    book.add("run_a")
    assert book.pending() == ["run_a", "run_b"]
    book.discard("run_a")
    assert book.pending() == ["run_b"]
