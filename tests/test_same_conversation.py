import importlib
import pytest
from hermes_gemini_live import agent_lane, tools


def test_voice_submission_uses_the_selected_conversation(monkeypatch):
    seen = []
    monkeypatch.setattr(agent_lane.httpx, 'post', lambda url, **kw:
                        seen.append(kw['json']) or agent_lane.httpx.Response(202, json={'run_id':'run_same'}))
    agent_lane.submit('Build code', session_id='chat_a')
    assert seen[0]['session_id'] == 'chat_a'
    store = importlib.import_module('hermes_gemini_live.task_store')
    assert store.list_tasks(conversation_id='chat_a')[0]['run_id'] == 'run_same'
    assert store.list_tasks(conversation_id='chat_b') == []


def test_reopened_voice_board_excludes_other_chats(monkeypatch):
    store = importlib.import_module('hermes_gemini_live.task_store')
    store.record('run_a','Build blue UI',conversation_id='chat_a')
    store.record('run_b','Private unrelated work',conversation_id='chat_b')
    monkeypatch.setattr(agent_lane,'fetch',lambda *a,**k:{'status':'running'})
    board=agent_lane.RunBook(); board.restore(conversation_id='chat_a')
    assert 'Build blue UI' in board.board()
    assert 'Private unrelated' not in board.board()


def test_briefing_is_bounded_and_excludes_system_reasoning_and_tool_payloads():
    from hermes_gemini_live.conversation import briefing
    rows=[{'role':'system','content':'SECRET SYSTEM'},
          {'role':'user','content':'Build the blue interface'},
          {'role':'assistant','content':'I will build it','reasoning':'PRIVATE THOUGHT'},
          {'role':'tool','tool_name':'terminal','content':'SECRET ENVIRONMENT'},
          {'role':'user','content':'Make that green'}]
    text=briefing(rows)
    assert 'Build the blue interface' in text and 'Make that green' in text
    assert 'terminal' in text
    assert 'SECRET' not in text and 'PRIVATE THOUGHT' not in text
    assert len(briefing([{'role':'user','content':'a'*30000}])) <= 6000


def test_same_chat_written_answer_is_not_forced_to_be_voice_only():
    assert 'No markdown' not in tools.compose_prompt({'task':'Build code'}, voice_summary=False)


@pytest.mark.asyncio
async def test_relay_passes_chat_identity_to_the_worker(monkeypatch):
    from hermes_gemini_live import relay
    from tests.test_relay import FakeLive, FakeBrowser
    seen=[]
    monkeypatch.setattr(agent_lane,'start_task',lambda prompt,**kwargs:seen.append((prompt,kwargs)))
    book=agent_lane.RunBook('chat_a'); live=FakeLive()
    await relay._handle_tool_call({'id':'c1','name':'hermes_task','args':{'task':'Build code'}},
                                 live,FakeBrowser(),book,None,None,relay.NoteQueue(live))
    assert seen[0][1]['conversation_id']=='chat_a'
    assert seen[0][0]=='Build code'


def test_websocket_checks_chat_and_sends_only_that_briefing(monkeypatch):
    from tests.test_routes import _load_plugin_api
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    module=_load_plugin_api(); seen=[]
    monkeypatch.setattr(module,'_upgrade_authorized',lambda ws:True)
    async def detail(sid,profile=None):
        if sid!='chat_a':raise HTTPException(404,'not owned')
        return {'id':sid,'title':'Blue interface'}
    async def history(*a,**k):return {'messages':[{'role':'user','content':'Make it green'}]}
    async def relay(ws,**kwargs):seen.append(kwargs);await ws.send_json({'ok':True})
    monkeypatch.setattr(module,'_task_session_detail',detail)
    monkeypatch.setattr(module,'_task_session_messages',history)
    monkeypatch.setattr(module.relay,'run_relay',relay)
    app=FastAPI();app.include_router(module.router)
    with TestClient(app) as client:
        with client.websocket_connect('/relay?conversation_id=chat_a') as ws:
            assert ws.receive_json()['ok']
        assert seen[0]['conversation_id']=='chat_a'
        assert 'Make it green' in seen[0]['context']
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect('/relay?conversation_id=not_owned'):pass
        assert error.value.code==4404
        assert len(seen)==1


@pytest.mark.asyncio
async def test_fresh_voice_chats_do_not_reuse_a_unique_title(monkeypatch):
    from tests.test_routes import _load_plugin_api
    module=_load_plugin_api(); seen=[]
    monkeypatch.setattr(agent_lane.httpx,'post',lambda url,**kwargs:
                        seen.append(kwargs['json']) or agent_lane.httpx.Response(201,json={}))
    a=await module.create_conversation();b=await module.create_conversation()
    assert a['session_id']!=b['session_id']
    assert 'title' not in seen[0]
    assert seen[0]['source']=='desktop'

def test_native_empty_chat_can_open_before_first_message_is_persisted(monkeypatch):
    from tests.test_routes import _load_plugin_api
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    module = _load_plugin_api()
    monkeypatch.setattr(module, '_upgrade_authorized', lambda ws: True)
    async def missing(*a, **kw): raise HTTPException(404, 'Session not found')
    async def run(ws, **kwargs): await ws.send_json(kwargs)
    monkeypatch.setattr(module, '_task_session_detail', missing)
    monkeypatch.setattr(module.relay, 'run_relay', run)
    app = FastAPI(); app.include_router(module.router)
    with TestClient(app).websocket_connect('/relay?native=1&conversation_id=native_empty') as ws:
        result = ws.receive_json()
        assert result['native'] is True
        assert result['conversation_id'] == 'native_empty'

def test_native_recovery_requires_own_prompt_and_a_persisted_final():
    from hermes_gemini_live.conversation import native_completion
    rows = [{'role':'user','content':'Exact voice request','timestamp':10},
            {'role':'assistant','content':'Checking files','timestamp':11,'finish_reason':'tool_calls'},
            {'role':'tool','content':'PRIVATE TOOL BODY','timestamp':12},
            {'role':'assistant','content':'Verified answer','timestamp':13,'finish_reason':'stop','reasoning':'PRIVATE REASONING'}]
    assert native_completion(rows, 10, ['Exact voice request']) == {'status':'completed','output':'Verified answer','timestamp':13}
    assert native_completion(rows[:-1], 10, ['Exact voice request']) is None
    assert native_completion(rows, 10, ['Different request']) is None
    assert native_completion(rows, 20, ['Exact voice request']) is None
