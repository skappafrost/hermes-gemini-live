import asyncio
import json
import pytest
from hermes_gemini_live import native_lane

@pytest.mark.asyncio
async def test_native_ack_is_required_and_duplicate_request_is_not_sent_twice():
    sent = []
    class Browser:
        async def send_text(self, text):
            sent.append(json.loads(text))
    lane = native_lane.NativeLane(Browser())
    first = asyncio.create_task(lane.request('call1', 'submit', {'text': 'Do work'}))
    await asyncio.sleep(0)
    duplicate = asyncio.create_task(lane.request('call1', 'submit', {'text': 'Do work'}))
    await asyncio.sleep(0)
    assert len(sent) == 1
    assert not first.done()
    lane.receive({'id': 'call1', 'result': {'status': 'running', 'task_id': 'native1'}})
    assert (await first)['task_id'] == 'native1'
    assert (await duplicate)['task_id'] == 'native1'
    assert (await lane.request('call1', 'submit', {'text': 'Do work'}))['task_id'] == 'native1'
    assert len(sent) == 1

@pytest.mark.asyncio
async def test_disconnect_and_timeout_never_start_api_worker():
    class Browser:
        async def send_text(self, text): pass
    lane = native_lane.NativeLane(Browser(), timeout=.01)
    result = await lane.request('call2', 'submit', {'text': 'Do work'})
    assert result['status'] == 'uncertain'
    assert await lane.request('call2', 'submit', {'text': 'Do work'}) == result

@pytest.mark.asyncio
async def test_relay_native_submission_keeps_transcript_and_never_uses_worker(monkeypatch):
    from types import SimpleNamespace
    from hermes_gemini_live import relay, tools
    def forbidden(*a, **kw):
        raise AssertionError('Native Desktop must never start an API worker')
    monkeypatch.setattr(relay.agent_lane, 'start_task', forbidden)
    seen = []
    class Lane:
        async def request(self, request_id, action, payload):
            seen.append((request_id, action, payload))
            return {'status': 'running', 'task_id': 'same-native-turn'}
    class Live:
        async def send_function_response(self, *a): seen.append(a)
    class Browser:
        async def send_text(self, text): seen.append(json.loads(text))
    await relay._handle_tool_call({'id': 'voice1', 'name': tools.DELEGATE_NAME,
        'args': {'task': 'Check the file'}}, Live(), Browser(),
        SimpleNamespace(native=Lane()), None, None, None,
        transcript='Check exactly 19 rows, preserve all videos.')
    assert '19 rows' in seen[0][2]['text']
    assert seen[-1]['id'] == 'same-native-turn'

@pytest.mark.asyncio
async def test_native_provider_ready_is_sent_only_after_live_setup(monkeypatch):
    from hermes_gemini_live import relay
    from tests.test_relay import FakeLive, FakeBrowser
    live = FakeLive(end_after_script=False)
    browser = FakeBrowser([{'type':'close'}])
    async def opened(*a, **kw):
        assert not any(f.get('type') == 'ready' for f in browser.sent)
        return live
    monkeypatch.setattr(relay.LiveSession, 'open', opened)
    await relay.run_relay(browser, native=True, conversation_id='chat')
    assert any(f.get('type') == 'ready' for f in browser.sent)
