from hermes_gemini_live import task_store


def test_task_remains_visible_after_its_chat_compacts(monkeypatch):
    task_store.record('run_live', 'Build approved design', conversation_id='original')
    task_store.record('run_other', 'Unrelated private task', conversation_id='unrelated')
    task_store.record('run_profile', 'Other profile', profile='other', conversation_id='original')
    monkeypatch.setattr(task_store, '_canonical_conversation_ids',
                        lambda ids: {x: 'continued' if x == 'original' else x for x in ids}, raising=False)
    rows = task_store.list_tasks(conversation_id='continued')
    assert [r['run_id'] for r in rows] == ['run_live']
    assert rows[0]['conversation_id'] == 'continued'
    assert rows[0]['origin_conversation_id'] == 'original'
    assert task_store.get_task('run_live')['conversation_id'] == 'original'
    assert task_store.list_tasks(conversation_id='unrelated')[0]['run_id'] == 'run_other'
