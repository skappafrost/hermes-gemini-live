"""The Hermes agent lane: one delegate tool call becomes a run on the api_server.

Hard rule taken from the voice domain: the relay pumps audio on this loop, so a tool that
waits is a microphone that stops. Nothing here blocks the caller — submission returns a
receipt instantly and the answer arrives later, spoken, from a worker thread.

Statuses are four named outcomes, never a bare exception, because the panel has to say
which one happened: ``ok`` (usable), ``absent`` (no server reachable), ``unauthorized``
(the key is wrong — a live server that refused us), ``error`` (it answered badly).
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

DEFAULT_API_SERVER_URL = "http://127.0.0.1:8642"
RUNS_PATH = "/v1/runs"
CAPABILITIES_PATH = "/v1/capabilities"

TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})

STATUS_OK = "ok"
STATUS_ABSENT = "absent"
STATUS_UNAUTHORIZED = "unauthorized"
STATUS_ERROR = "error"

#: Spoken output has to be short enough to say aloud, and a 40 KB tool dump would end
#: the call as monotone reading. The tail is kept because that is where answers live.
MAX_SPEAKABLE_CHARS = 4000
POLL_BACKOFF_S = (1.0, 2.0, 4.0)
MAX_RUN_SECONDS = 900.0

_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gml-agent-lane")


class LaneUnavailable(RuntimeError):
    """The lane cannot take work; the reason is already speakable."""


def base_url(profile: str | None = None) -> str:
    """The api_server origin, routed to ``profile`` when one is named.

    A running gateway is multiplexed: the default listener answers
    ``/p/<profile>/v1/...`` for every served profile (``api_server.py:1174,4452``), and an
    UNPREFIXED run resumes in the DEFAULT profile's store — core says so outright at
    ``api_server_runs.py:559-562``. So a named profile is not a nicety, it is what keeps
    one profile's work out of another's memory.
    """
    raw = (os.environ.get("GEMINI_LIVE_API_SERVER_URL") or "").strip()
    root = (raw or DEFAULT_API_SERVER_URL).rstrip("/")
    if not profile or profile == "default":
        return root
    return f"{root}/p/{quote(profile, safe='')}"


@contextmanager
def _foreign_profile_scope(profile: str):
    """Bind another profile's secret scope for the duration of one read.

    The gateway's shared listener authenticates ``/p/<profile>/`` with that profile's own
    key, and one process serves every profile, so ``os.environ`` would answer with the
    launch profile's credential for all of them.
    """
    try:
        from agent.secret_scope import (build_profile_secret_scope, reset_secret_scope,
                                        set_secret_scope)
        from hermes_cli.profiles import get_profile_dir
        home = get_profile_dir(profile)
    except Exception:
        yield None
        return
    token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    try:
        yield home
    finally:
        reset_secret_scope(token)


def key(profile: str | None = None) -> str | None:
    """Bearer key for ``profile``, or None to send no Authorization.

    Set-but-blank is a deliberate opt-out, not a miss: the api_server accepts
    unauthenticated requests when it holds no key of its own, so "no key" is a real
    configuration rather than a broken one.
    """
    from .config import serving_profile
    own = serving_profile()
    if not profile or profile == own or not own:
        return _read_key()
    with _foreign_profile_scope(profile):
        return _read_key()


def _read_key() -> str | None:
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
        raw = get_secret("API_SERVER_KEY")
    except ImportError:
        raw = os.environ.get("API_SERVER_KEY")
    except UnscopedSecretError:
        raw = os.environ.get("API_SERVER_KEY")
    if raw is None:
        return None
    return raw.strip() or None


def headers(session_key: str | None = None, profile: str | None = None) -> dict:
    out = {}
    secret = key(profile)
    if secret:
        out["Authorization"] = f"Bearer {secret}"
    if session_key:
        out["X-Hermes-Session-Key"] = session_key
    return out


def probe(session_key: str | None = None, profile: str | None = None) -> tuple[str, str]:
    """(status, detail) for whether this run lane can be offered to the model.

    The refusal names the home to fix, because a multiplexed gateway authorises
    ``/p/<profile>/`` with that profile's own key and deliberately does not inherit the
    owner's (``api_server.py:1530-1545``) — so "set API_SERVER_KEY" without a location
    sends people to the wrong ``.env``.
    """
    if not key(profile):
        return STATUS_UNAUTHORIZED, (
            "no API_SERVER_KEY configured"
            if not profile
            else f"no API_SERVER_KEY for profile '{profile}' — set it in that profile's .env"
        )
    try:
        response = httpx.get(f"{base_url(profile)}{CAPABILITIES_PATH}",
                             headers=headers(session_key, profile), timeout=8.0)
    except httpx.HTTPError as exc:
        return STATUS_ABSENT, f"{type(exc).__name__}"
    if response.status_code in (401, 403):
        return STATUS_UNAUTHORIZED, f"the api server refused our key ({response.status_code})"
    if response.status_code != 200:
        return STATUS_ERROR, f"the api server answered {response.status_code}"
    try:
        features = (response.json().get("features") or {})
    except (ValueError, AttributeError):
        return STATUS_ERROR, "the api server returned a non-JSON capability list"
    if not features.get("run_submission"):
        return STATUS_ERROR, "this api server does not allow run submission"
    return STATUS_OK, ""


def submit(prompt: str, session_id: str | None = None,
           session_key: str | None = None, profile: str | None = None) -> str:
    """POST /v1/runs. Returns the run id; accepts any 2xx, not only 202."""
    body: dict = {"input": prompt}
    if session_id:
        body["session_id"] = session_id
    try:
        response = httpx.post(f"{base_url(profile)}{RUNS_PATH}", json=body,
                              headers=headers(session_key, profile), timeout=30.0)
    except httpx.HTTPError as exc:
        raise LaneUnavailable(f"I couldn't reach the Hermes api server ({type(exc).__name__})") from exc
    if response.status_code // 100 != 2:
        raise LaneUnavailable(f"the Hermes api server refused the run ({response.status_code}): "
                              f"{response.text[:200] or 'no detail'}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise LaneUnavailable("the Hermes api server returned a run that was not JSON") from exc
    run_id = payload.get("run_id") if isinstance(payload, dict) else None
    if not isinstance(run_id, str) or not run_id:
        raise LaneUnavailable("the Hermes api server returned a run with no id")
    return run_id


def fetch(run_id: str, session_key: str | None = None,
          profile: str | None = None) -> dict:
    try:
        response = httpx.get(f"{base_url(profile)}{RUNS_PATH}/{run_id}",
                             headers=headers(session_key, profile), timeout=30.0)
    except httpx.HTTPError as exc:
        raise LaneUnavailable(f"I lost contact with the Hermes api server ({type(exc).__name__})") from exc
    if response.status_code != 200:
        raise LaneUnavailable(f"the Hermes api server answered {response.status_code} for that run")
    payload = response.json()
    if not isinstance(payload, dict):
        raise LaneUnavailable("the Hermes api server returned an invalid run status")
    return payload


def speakable(text: str) -> str:
    """Prose the model can read aloud: no markdown furniture, no bare paths, no code."""
    if not text:
        return ""
    body = text if len(text) <= MAX_SPEAKABLE_CHARS else text[-MAX_SPEAKABLE_CHARS:]
    body = re.sub(r"```.*?```", " (code omitted) ", body, flags=re.S)
    body = re.sub(r"`([^`]*)`", r"\1", body)
    body = re.sub(r"^#{1,6}\s*", "", body, flags=re.M)
    body = re.sub(r"[*_]{1,3}", "", body)
    body = re.sub(r"[A-Za-z]:\\\\[^\s]+", "a file path", body)
    body = re.sub(r"(?<!\w)(?:/[\w.-]){2,}/", "a file path", body)
    body = re.sub(r"\s+", " ", body)
    return body.strip()[:MAX_SPEAKABLE_CHARS]


def await_result(run_id: str, session_key: str | None = None,
                 deadline_seconds: float = MAX_RUN_SECONDS,
                 profile: str | None = None) -> tuple[str, str]:
    """Poll to a terminal status. Blocking — call it only from a worker thread."""
    started = time.monotonic()
    attempt = 0
    while True:
        status_row = fetch(run_id, session_key=session_key, profile=profile)
        state = str(status_row.get("status") or "")
        if state in TERMINAL_STATUSES:
            if state == "completed":
                return state, speakable(str(status_row.get("output") or ""))
            detail = status_row.get("error") or state
            return state, speakable(str(detail))
        if time.monotonic() - started > deadline_seconds:
            return "timed_out", f"Hermes was still working after {int(deadline_seconds)} seconds."
        time.sleep(POLL_BACKOFF_S[min(attempt, len(POLL_BACKOFF_S) - 1)])
        attempt += 1


class RunBook:
    """Live run ids started by one call, so leaving the call stops nothing silently."""

    def __init__(self) -> None:
        self._ids: set[str] = set()
        self._lock = threading.Lock()

    def add(self, run_id: str) -> None:
        with self._lock:
            self._ids.add(run_id)

    def discard(self, run_id: str) -> None:
        with self._lock:
            self._ids.discard(run_id)

    def pending(self) -> list[str]:
        with self._lock:
            return sorted(self._ids)


def start_task(prompt: str, on_finished, session_key: str | None = None,
               book: RunBook | None = None, profile: str | None = None) -> str:
    """Hand a task to the pool and return immediately.

    ``on_finished(task_id, state, text)`` is called later from a worker thread, so the
    caller owns whatever it takes to get that result back onto its event loop.
    """
    task_id = uuid.uuid4().hex[:8]

    def worker() -> tuple[str, str]:
        try:
            run_id = submit(prompt, session_key=session_key, profile=profile)
            if book is not None:
                book.add(run_id)
            try:
                return await_result(run_id, session_key=session_key, profile=profile)
            finally:
                if book is not None:
                    book.discard(run_id)
        except LaneUnavailable as exc:
            return "unavailable", speakable(str(exc))

    future = _POOL.submit(worker)

    def deliver() -> None:
        state, text = future.result()
        on_finished(task_id, state, text)

    watcher = threading.Thread(target=deliver, name=f"gml-deliver-{task_id}", daemon=True)
    future.add_done_callback(lambda _f: watcher.start())
    return task_id
