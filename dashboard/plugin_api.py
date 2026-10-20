"""Backend half of hermes-gemini-live, mounted by the Hermes web server.

Landed at ``/api/plugins/hermes-gemini-live/`` by
``hermes_cli/web_server.py::_mount_plugin_api_routes``, which imports THIS FILE BY PATH.
There is no parent package at that point, so the plugin root goes on ``sys.path`` and
the package is imported by absolute name — the same shim hermes-talk's dashboard half
uses, and the reason this plugin keeps its code in one prefixed package.

Two invariants:

- **The key never leaves this process.** It is read per call, spent only inside
  :mod:`hermes_gemini_live.live_client`, and never enters a response body or a log line.
- **The WebSocket authorizes itself.** Starlette's HTTP middleware never runs for a WS
  upgrade, so the runtime "plugin is disabled" gate cannot protect this endpoint; it
  calls core's canonical upgrade gate rather than inventing a second answer.
"""

from __future__ import annotations

import importlib
import asyncio
import logging
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from hermes_gemini_live import agent_lane, config, relay, task_store, conversation  # noqa: E402

logger = logging.getLogger(__name__)
router = APIRouter()


async def _task_session_detail(sid, profile=None):
    from hermes_cli.web_routers.sessions import get_session_detail
    return await get_session_detail(sid, profile=profile)


async def _task_session_messages(sid, profile=None):
    from hermes_cli.web_routers.sessions import get_session_messages
    return await get_session_messages(sid, profile=profile, limit=500, offset=0,
                                      order='latest', include_compacted=False,
                                      inline_images=False)


@router.get('/tasks')
async def tasks(conversation_id: str | None = None):
    return {'tasks': await asyncio.to_thread(task_store.list_tasks, config.serving_profile(), conversation_id)}


@router.post('/conversations')
async def create_conversation():
    import uuid
    sid = 'voice_' + uuid.uuid4().hex
    profile = config.serving_profile()
    def create():
        response = agent_lane.httpx.post(agent_lane.base_url(profile) + '/api/sessions',
            json={'id': sid, 'source': 'desktop'},
            headers=agent_lane.headers(config.api_server_session_key(), profile), timeout=30)
        if response.status_code // 100 != 2:
            raise HTTPException(503, 'Hermes could not create the voice conversation')
    await asyncio.to_thread(create)
    return {'session_id': sid}


@router.get('/conversations/{session_id}/briefing')
async def conversation_briefing(session_id: str):
    profile = config.serving_profile()
    session = await _task_session_detail(session_id, profile=profile)
    history = await _task_session_messages(session_id, profile=profile)
    return {'session_id': session.get('id') or session_id, 'title': session.get('title'),
            'briefing': conversation.briefing(history['messages'])}


@router.get('/tasks/{run_id}')
async def task_detail(run_id: str):
    profile = config.serving_profile()
    receipt = await asyncio.to_thread(task_store.get_task, run_id, profile)
    if receipt is None:
        raise HTTPException(404, 'Gemini task not found in this profile')
    data = dict(receipt)
    try:
        status = await asyncio.to_thread(agent_lane.fetch, run_id,
                                         config.api_server_session_key(), profile)
        data['status'] = status.get('status', 'unknown')
        data['output'] = status.get('output', '')
        data['error'] = status.get('error', '')
        sid = status.get('session_id') or run_id
        await asyncio.to_thread(task_store.update, run_id, data['status'], profile)
    except agent_lane.LaneUnavailable as exc:
        # Durable transcript remains readable if the run server is down/restarted.
        sid = receipt.get('conversation_id') or run_id
        data['status_detail'] = str(exc)
    data['session_id'] = sid
    try:
        session = await _task_session_detail(sid, profile=profile)
        data['session'] = {k: session.get(k) for k in
                           ('id', 'title', 'model', 'tool_call_count', 'message_count')}
        history = await _task_session_messages(sid, profile=profile)
        # Explicit display allowlist: never expose system prompts or private reasoning.
        allowed = ('id', 'role', 'content', 'display_content', 'tool_name', 'tool_calls',
                   'tool_call_id', 'finish_reason', 'timestamp')
        data['messages'] = [{k: m[k] for k in allowed if k in m}
                            for m in history['messages']]
        data['pagination'] = history.get('pagination', {})
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        data['messages'] = []
        data['transcript_detail'] = 'Waiting for Hermes to create the task session.'
    return data


@router.post('/conversations/{session_id}/native-completion')
async def native_completion(session_id: str, payload: dict):
    history = await _task_session_messages(session_id, profile=config.serving_profile())
    since = float(payload.get('since') or 0)
    prompts = [str(p) for p in (payload.get('prompts') or [])[:20]]
    return {'completion': conversation.native_completion(history['messages'], since, prompts)}


def _upgrade_authorized(ws: WebSocket) -> bool:
    """Core's own gate, so this endpoint can never drift from dashboard auth.

    ``import_module`` is deliberate: ``from hermes_cli import web_server_chat`` resolves
    through the package attribute and would keep serving the real module even when a
    harness replaced it in ``sys.modules``.

    Every way this can break fails CLOSED, not open, because the route mints a live
    provider session and can start Hermes runs: the module missing (older hosts that
    predate ``web_server_chat`` still serve a real dashboard with real auth), core renaming
    or removing ``_ws_auth_ok``, or the call raising.
    """
    try:
        gate = importlib.import_module("hermes_cli.web_server_chat")
    except ModuleNotFoundError:
        logger.warning("hermes-gemini-live: this host has no hermes_cli.web_server_chat "
                       "auth gate; refusing the upgrade")
        return False
    except Exception as exc:
        logger.warning("hermes-gemini-live: cannot load the dashboard auth gate (%s); "
                       "refusing the upgrade", type(exc).__name__)
        return False
    authorize = getattr(gate, "_ws_auth_ok", None)
    if not callable(authorize):
        logger.warning("hermes-gemini-live: the host no longer exposes _ws_auth_ok; "
                       "refusing the upgrade rather than guessing")
        return False
    try:
        return bool(authorize(ws))
    except Exception as exc:
        logger.warning("hermes-gemini-live: auth gate raised %s; refusing", type(exc).__name__)
        return False


def _profile_of(ws: WebSocket) -> str:
    """Named profile for multiplexed hosts: the route's own ``?profile=``, never env."""
    return (ws.query_params.get("profile") or "").strip()


@router.get("/status")
async def status(profile: str = "") -> dict:
    """Readiness for the panel. Key material is never reported, only presence.

    Logged on every read: when the panel's button goes dark, the question is whether this
    line appears in the backend log at all. Absent here means core's per-home gate
    refused the request before the plugin's router ever ran.

    The agent lane is reported as *configured*, never as *reachable*: probing it is a
    network round trip and this handler runs on the web server's event loop.
    """
    payload = config.status_dict()
    payload["lane"] = {
        "configured": bool(agent_lane.key()),
        "url": agent_lane.base_url(),
        "profile": config.serving_profile() or "default",
        "scope": config.api_server_session_key() or "default",
    }
    logger.info(
        "hermes-gemini-live: /status profile=%s ok=%s model=%s lane=%s detail=%r",
        profile or "-",
        payload["ok"],
        payload["model"],
        payload["lane"]["configured"],
        payload["detail"],
    )
    return payload


@router.websocket("/relay")
async def live_relay(ws: WebSocket) -> None:
    if not _upgrade_authorized(ws):
        logger.warning("hermes-gemini-live: refused an unauthorized /relay upgrade")
        await ws.close(code=4401)
        return
    if _profile_of(ws):
        logger.debug("hermes-gemini-live: relay serving profile %s", _profile_of(ws))
    conversation_id = (ws.query_params.get('conversation_id') or '').strip()
    extra = {}
    if ws.query_params.get('native') == '1':
        if not conversation_id:
            await ws.close(code=4400)
            return
        extra['native'] = True
    if conversation_id:
        try:
            brief = await conversation_briefing(conversation_id)
        except HTTPException as exc:
            # Native session.create is lazy: its empty chat has no durable row
            # until the first prompt. The authenticated renderer still owns
            # that runtime and validates the exact mounted composer on submit.
            if extra.get('native') and exc.status_code == 404:
                brief = {'session_id': conversation_id, 'title': '', 'briefing': 'New empty native conversation; no previous work.'}
            else:
                await ws.close(code=4404)
                return
        extra.update({'conversation_id': brief['session_id'],
                 'context': 'Conversation title: ' + str(brief.get('title') or '') + '\n' + brief['briefing']})
    await ws.accept()
    try:
        # No client-supplied profile reaches the lane: relay derives it from the home this
        # process actually serves. The query value is log-only, to spot a mis-pooled backend.
        await relay.run_relay(ws, session_key=config.api_server_session_key(), **extra)
    except WebSocketDisconnect:
        logger.debug("hermes-gemini-live: browser went away mid-call")
    finally:
        try:
            await ws.close()
        except Exception:
            pass
