"""Durable, profile-scoped receipts. Closing audio never deletes or cancels a task."""
import os
import sqlite3
import time
from pathlib import Path
from contextlib import contextmanager


@contextmanager
def _db():
    try:
        from hermes_constants import get_hermes_home
        home = get_hermes_home()
    except ImportError:
        home = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes')))
    path = home / 'runtime' / 'gemini-live-tasks.sqlite3'
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS tasks (run_id TEXT PRIMARY KEY, profile TEXT, '
               'prompt TEXT, created_at REAL, status TEXT)')
    # Separate linkage table keeps existing plugin processes compatible during rollout.
    db.execute('CREATE TABLE IF NOT EXISTS task_conversations (run_id TEXT PRIMARY KEY, conversation_id TEXT)')
    try:
        with db:
            yield db
    finally:
        db.close()


def record(run_id, prompt, profile=None, conversation_id=None):
    with _db() as db:
        db.execute('INSERT OR IGNORE INTO tasks (run_id,profile,prompt,created_at,status) VALUES (?,?,?,?,?)',
                   (run_id, profile or 'default', prompt, time.time(), 'submitted'))
        if conversation_id:
            db.execute('INSERT OR IGNORE INTO task_conversations VALUES (?,?)', (run_id, conversation_id))


def update(run_id, status, profile=None):
    with _db() as db:
        db.execute('UPDATE tasks SET status=? WHERE run_id=? AND profile=?',
                   (status, run_id, profile or 'default'))


def _canonical_conversation_ids(ids):
    """Use core's continuation rules, which exclude subagents, forks and resets."""
    resolved = {sid: sid for sid in ids if sid}
    try:
        from hermes_constants import get_hermes_home
        path = get_hermes_home() / 'state.db'
        if not path.exists():
            return resolved
        from hermes_state import SessionDB
        from hermes_cli.web_server_sessions import _session_latest_descendant
        db = SessionDB(db_path=path, read_only=True)
        try:
            for sid in resolved:
                latest, _ = _session_latest_descendant(sid, db)
                resolved[sid] = latest or sid
        finally:
            db.close()
    except (ImportError, OSError, sqlite3.DatabaseError):
        # Older hosts retain exact-id scoping; never widen to other chats.
        pass
    return resolved


def list_tasks(profile=None, conversation_id=None):
    with _db() as db:
        rows = [dict(row) for row in db.execute(
            'SELECT tasks.*, task_conversations.conversation_id FROM tasks LEFT JOIN task_conversations USING(run_id) '
            'WHERE profile=? ORDER BY created_at DESC LIMIT 1000',
            (profile or 'default',))]
    if conversation_id is None:
        return rows[:100]
    canonical = _canonical_conversation_ids({conversation_id, *(row['conversation_id'] for row in rows)})
    wanted = canonical.get(conversation_id, conversation_id)
    return [{**row, 'origin_conversation_id': row['conversation_id'], 'conversation_id': conversation_id}
            for row in rows if row['conversation_id'] and canonical.get(row['conversation_id'], row['conversation_id']) == wanted][:100]


def get_task(run_id, profile=None):
    with _db() as db:
        row = db.execute('SELECT tasks.*, task_conversations.conversation_id FROM tasks LEFT JOIN task_conversations USING(run_id) '
                         'WHERE run_id=? AND profile=?',
                         (run_id, profile or 'default')).fetchone()
        return dict(row) if row else None
