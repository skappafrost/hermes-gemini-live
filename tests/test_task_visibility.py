import importlib
import json
import pytest

from hermes_gemini_live import agent_lane


def test_submission_is_persisted_before_the_voice_call_can_end(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(agent_lane.httpx, 'post', lambda *a, **k:
                        agent_lane.httpx.Response(202, json={'run_id': 'run_visible'}))
    assert agent_lane.submit('Build a tiny program') == 'run_visible'
    store = importlib.import_module('hermes_gemini_live.task_store')
    assert store.list_tasks()[0]['run_id'] == 'run_visible'
    # A new module read simulates reconnect/reload; no Live socket is involved.
    importlib.reload(store)
    assert store.list_tasks()[0]['prompt'] == 'Build a tiny program'


def test_task_history_is_scoped_and_does_not_allow_unknown_ids(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    store = importlib.import_module('hermes_gemini_live.task_store')
    store.record('run_a', 'Task A', profile=None)
    store.record('run_b', 'Task B', profile='other')
    assert [t['run_id'] for t in store.list_tasks(profile=None)] == ['run_a']
    assert store.get_task('run_b', profile=None) is None
    assert store.get_task('../state.db') is None


def test_routes_expose_transcript_and_real_model_without_live_socket(tmp_path, monkeypatch):
    from tests.test_routes import _load_plugin_api
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    store = importlib.import_module('hermes_gemini_live.task_store')
    store.record('run_a', 'Task A')
    module = _load_plugin_api()
    monkeypatch.setattr(module.agent_lane, 'fetch', lambda *a, **k:
                        {'status': 'completed', 'session_id': 'actual_session', 'output': 'Done'})
    async def detail(sid, profile=None):
        assert sid == 'actual_session'
        return {'model': 'deepseek-v4.1-flash', 'tool_call_count': 1, 'title': 'Task A'}
    async def messages(sid, **kwargs):
        return {'messages': [{'role': 'tool', 'tool_name': 'write_file', 'content': 'saved'},
                             {'role': 'assistant', 'content': 'Done', 'finish_reason': 'stop'}]}
    monkeypatch.setattr(module, '_task_session_detail', detail)
    monkeypatch.setattr(module, '_task_session_messages', messages)
    app = FastAPI(); app.include_router(module.router)
    with TestClient(app) as client:
        assert client.get('/tasks').json()['tasks'][0]['run_id'] == 'run_a'
        response = client.get('/tasks/run_a')
        assert response.status_code == 200
        data = response.json()
        assert data['status'] == 'completed'
        assert data['session']['model'] == 'deepseek-v4.1-flash'
        assert data['messages'][0]['tool_name'] == 'write_file'
        assert client.get('/tasks/unregistered').status_code == 404


def test_reopened_call_recovers_same_run_and_can_refresh_without_resubmitting(monkeypatch):
    store = importlib.import_module('hermes_gemini_live.task_store')
    store.record('run_existing', 'Build code')
    monkeypatch.setattr(agent_lane, 'submit', lambda *a, **k: pytest.fail('must not resubmit'))
    status = {'status': 'running'}
    monkeypatch.setattr(agent_lane, 'fetch', lambda *a, **k: dict(status))
    book = agent_lane.RunBook()
    assert book.restore() == 1
    assert book.run_id('run_existing') == 'run_existing'
    assert book.pending() == ['run_existing']
    status.update(status='completed', output='Program saved and tested')
    book.restore()
    assert book.pending() == []
    assert 'Program saved and tested' in book.board()


def test_task_history_still_reads_transcript_when_run_server_is_down(monkeypatch):
    from tests.test_routes import _load_plugin_api
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    store = importlib.import_module('hermes_gemini_live.task_store')
    store.record('run_offline', 'Keep the saved result')
    module = _load_plugin_api()
    def offline(*a, **k):
        raise agent_lane.LaneUnavailable('Run server is offline')
    monkeypatch.setattr(module.agent_lane, 'fetch', offline)
    async def detail(*a, **k): return {'model': 'deepseek-v4.1-flash', 'system_prompt': 'private'}
    async def messages(*a, **k):
        return {'messages': [{'role': 'assistant', 'content': 'Saved result', 'reasoning': 'private reasoning'}]}
    monkeypatch.setattr(module, '_task_session_detail', detail)
    monkeypatch.setattr(module, '_task_session_messages', messages)
    app = FastAPI(); app.include_router(module.router)
    with TestClient(app) as client:
        data = client.get('/tasks/run_offline').json()
        assert data['messages'][0]['content'] == 'Saved result'
        assert data['status_detail'] == 'Run server is offline'
        assert 'private' not in json.dumps(data)


@pytest.mark.asyncio
async def test_reconnected_voice_steers_the_same_run_not_a_new_one(monkeypatch):
    from tests.test_relay import FakeLive, FakeBrowser
    from hermes_gemini_live import relay
    store = importlib.import_module('hermes_gemini_live.task_store')
    store.record('run_existing', 'Build code')
    monkeypatch.setattr(agent_lane, 'fetch', lambda *a, **k: {'status': 'running'})
    monkeypatch.setattr(agent_lane, 'submit', lambda *a, **k: pytest.fail('duplicate submission'))
    calls = []
    monkeypatch.setattr(agent_lane, 'steer', lambda run_id, text, **k: calls.append((run_id, text)) or {})
    book = agent_lane.RunBook(); book.restore()
    live = FakeLive(); browser = FakeBrowser()
    await relay._update_task('steer_call', {'task': 'run_existing', 'action': 'steer', 'answer': 'Use blue'},
                             live, browser, book, None, None)
    assert calls == [('run_existing', 'Use blue')]
    assert book.run_id('run_existing') == 'run_existing'
