"""Pump one browser WebSocket against one Live socket, and hand real work to Hermes.

Two tasks own the sockets, and either side dying closes both: a call with no browser is
a metered Live session with no listener.

The agent lane obeys one rule above all others: nothing about a run may be awaited on the
loop that carries audio. A tool call therefore answers the model with a receipt
immediately and the result arrives later, from a worker thread, as a spoken-note — the
same shape the voice domain learned a waiting tool is a dead microphone.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from . import agent_lane, config, wire, tools as tools_module
from .config import ConfigError
from .live_client import LiveError, LiveSession

logger = logging.getLogger(__name__)

#: Audio frames arrive ~10/s; anything bigger than this is a bug or an attack.
MAX_BROWSER_FRAME_BYTES = 1 << 20
#: Forwarded, then the call ends — waiting for the socket to die on its own would only
#: turn an announced goodbye into a silent one.
TERMINAL_FRAME_TYPES = frozenset({"go_away"})
RESULT_NOTE = (
    "Hermes finished task #{task_id} ({state}). Result: {text}\n"
    "Tell the user that outcome now in one short spoken sentence. Do not invent details, "
    "do not add commentary, and do not start another task about it."
)


async def _browser_to_live(browser: Any, live: LiveSession, note: dict) -> None:
    while True:
        message = await browser.receive_text()
        if len(message) > MAX_BROWSER_FRAME_BYTES:
            continue
        kind = _frame_type(message)
        if kind == "audio":
            await live.send_audio(_b64(message))
        elif kind == "text":
            await live.send_text(_text(message))
        elif kind == "close":
            note["reason"] = "browser closed the call"
            return


async def _handle_tool_call(call: dict, live: LiveSession, browser: Any,
                            book: agent_lane.RunBook, session_key: str | None,
                            profile: str | None,
                            loop: asyncio.AbstractEventLoop) -> None:
    """Receipt first, work in the pool. The only await here is a small local socket send.

    The rule is about not waiting on a *run* (seconds to minutes), not about never
    awaiting: a receipt frame is what lets the model keep talking, so it goes out now.
    """
    task = tools_module.compose_prompt(call.get("args") or {})
    call_id = str(call.get("id") or "")
    name = call.get("name")
    if not call_id:
        logger.warning("hermes-gemini-live: tool call with no id was dropped")
        return
    if not task:
        await live.send_function_response(call_id, "No task text was supplied.", name)
        return

    await live.send_function_response(
        call_id,
        f"WORK_STARTED {call_id}: Hermes is running it. Do not describe any result yet.",
        name)
    await browser.send_text(_dump({"type": "task_started", "id": call_id, "prompt": task[:200]}))
    agent_lane.start_task(
        task,
        on_finished=_make_finisher(live, browser, call_id, loop),
        session_key=session_key,
        book=book,
        profile=profile,
    )


def _make_finisher(live: LiveSession, browser: Any, call_id: str,
                   loop: asyncio.AbstractEventLoop):
    def on_finished(task_id: str, state: str, text: str) -> None:
        async def deliver() -> None:
            try:
                await live.send_text(RESULT_NOTE.format(task_id=task_id, state=state,
                                                        text=text or "no output"))
                await browser.send_text(_dump({"type": "task_done", "id": task_id,
                                               "state": state}))
            except (LiveError, RuntimeError) as exc:
                # The result is real even if nobody is left to hear it spoken.
                logger.info("hermes-gemini-live: task %s finished but the call ended (%s)",
                            task_id, exc)

        try:
            asyncio.run_coroutine_threadsafe(deliver(), loop)
        except RuntimeError:
            # The loop is already gone: the call ended while Hermes was still working.
            # The run keeps going and its answer simply goes unspoken, which is said here
            # rather than dying quietly on a worker thread.
            logger.info("hermes-gemini-live: task %s finished after its call closed", task_id)

    return on_finished


async def _live_to_browser(browser: Any, live: LiveSession, note: dict,
                           book: agent_lane.RunBook, session_key: str | None,
                           profile: str | None) -> None:
    loop = asyncio.get_running_loop()
    while True:
        raw = await live.recv()
        for frame in wire.browser_frames(raw):
            await browser.send_text(_dump(frame))
            if frame["type"] == "error":
                note["reason"] = frame["detail"]
                return
            if frame["type"] in TERMINAL_FRAME_TYPES:
                note["reason"] = f"server ended the session ({frame.get('timeLeft') or 'now'})"
                return
            if frame["type"] == "tool_call":
                for call in frame["calls"]:
                    await _handle_tool_call(call, live, browser, book, session_key,
                                            profile, loop)


def _loads(message: str) -> dict:
    try:
        value = json.loads(message)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _frame_type(message: str) -> str:
    value = _loads(message)
    kind = value.get("type")
    if kind == "audio" and not str(value.get("data") or "").strip():
        return ""
    if kind == "text" and not str(value.get("text") or "").strip():
        return ""
    return kind if kind in ("audio", "text", "close") else ""


def _b64(message: str) -> str:
    return str(_loads(message).get("data") or "")


def _text(message: str) -> str:
    return str(_loads(message).get("text") or "")[:4000]


def _dump(frame: dict) -> str:
    return json.dumps(frame, separators=(",", ":"))


async def run_relay(browser: Any, session_key: str | None = None,
                     profile: str | None = None) -> None:
    """Own the whole call. The caller has already accepted the upgrade."""
    note: dict = {"reason": ""}
    # The serving home decides the profile, not a query parameter a client could send:
    # an unprefixed run resumes in the DEFAULT profile's store, so this is the one place
    # that must be right for delegated work to land in the right memory.
    profile = profile or config.serving_profile()
    # Off the audio loop: a probe is a network round trip, and a slow gateway must not
    # cost the user a dropped syllable.
    lane_status, lane_detail = await asyncio.to_thread(agent_lane.probe, session_key, profile)
    model = config.model()
    # Two different refusals, one visible outcome: no delegate offered. Either one has to
    # reach the user, or a talk-only call looks like a broken assistant.
    reason = ""
    if lane_status != agent_lane.STATUS_OK:
        reason = lane_detail
    elif not config.supports_tool_calling(model):
        reason = f"{model} cannot call tools"
    if reason:
        logger.warning("hermes-gemini-live: Hermes work is off for this call: %s", reason)
    try:
        live = await LiveSession.open(
            None if reason else tools_module.declarations())
    except (LiveError, ConfigError) as exc:
        logger.warning("hermes-gemini-live: call refused: %s", exc)
        await browser.send_text(_dump({"type": "error", "detail": str(exc)}))
        return
    if reason:
        await browser.send_text(_dump({"type": "lane", "status": lane_status,
                                       "detail": reason}))

    book = agent_lane.RunBook()
    up = asyncio.create_task(_browser_to_live(browser, live, note))
    down = asyncio.create_task(_live_to_browser(browser, live, note, book, session_key, profile))
    try:
        done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            error = task.exception()
            if error:
                note["reason"] = str(error)
                logger.warning("hermes-gemini-live: relay pump failed: %s: %s",
                               type(error).__name__, error)
                await browser.send_text(_dump({"type": "error",
                                               "detail": _safe(error),
                                               "ended": True}))
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        await live.close()
        if book.pending():
            logger.info("hermes-gemini-live: call ended with %d run(s) still going: %s",
                        len(book.pending()), ",".join(book.pending()))
        logger.info("hermes-gemini-live: call ended (%s)", note["reason"] or "ended")


def _safe(error: BaseException) -> str:
    text = str(error) or type(error).__name__
    return text if "key=" not in text else "the Gemini Live socket failed"
