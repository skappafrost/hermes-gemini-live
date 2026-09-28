"""The dashboard half loads the way the host loads it, and answers /status safely."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_ROOT = Path(__file__).resolve().parent.parent
_API = _ROOT / "dashboard" / "plugin_api.py"
_PREFIX = "/api/plugins/hermes-gemini-live"


def _load_plugin_api():
    """Byte-for-byte the host's mount path: importlib by file, no parent package."""
    name = "hermes_dashboard_plugin_hermes-gemini-live"
    spec = importlib.util.spec_from_file_location(name, _API)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-material-1234")
    module = _load_plugin_api()
    app = FastAPI()
    app.include_router(module.router, prefix=_PREFIX)
    return TestClient(app), module


def test_api_file_exists_and_declares_a_router():
    assert _API.is_file()
    assert _load_plugin_api().router is not None


def test_routes_are_mounted_at_the_namespace_the_panel_uses(client):
    _, module = client
    paths = {route.path for route in module.router.routes}
    assert "/status" in paths and "/relay" in paths


def test_status_reports_readiness_without_key_material(client):
    http, _ = client
    body = http.get(f"{_PREFIX}/status")
    assert body.status_code == 200
    payload = body.json()
    assert payload["ok"] is True
    assert payload["model"]
    assert "test-key-material" not in body.text


def test_status_explains_a_missing_key(client, monkeypatch):
    http, module = client
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    payload = http.get(f"{_PREFIX}/status").json()
    assert payload["ok"] is False
    assert "GEMINI_API_KEY" in payload["detail"]
    assert module.config.status_dict()["thinking_level"] in (None, "high", "low")


@pytest.mark.parametrize("verdict", [True, False])
def test_relay_authorizes_through_core_gate_not_a_private_copy(client, monkeypatch, verdict):
    # The invariant is the delegation, not the verdict: a WS route that invented its own
    # auth would silently drift from dashboard auth the first time core changes it.
    http, module = client
    seen = []

    class Gate:
        @staticmethod
        def _ws_auth_ok(ws):
            seen.append(ws)
            return verdict

    monkeypatch.setitem(sys.modules, "hermes_cli.web_server_chat", Gate)
    marker = object()
    assert module._upgrade_authorized(marker) is verdict
    assert seen == [marker]


def test_authorize_gate_is_permissive_only_for_a_bare_fastapi_host(client, monkeypatch):
    # A harness with no dashboard module has no auth to consult, and no credential to
    # steal. Anything narrower is a real host whose contract we must not guess about.
    http, module = client

    def missing(name):
        raise ModuleNotFoundError(name)

    monkeypatch.setattr(module.importlib, "import_module", missing)
    assert module._upgrade_authorized(object()) is True


def test_authorize_gate_refuses_when_the_host_moved_the_symbol(client, monkeypatch):
    # Fail-closed on drift: the route mints a live provider session, and silently
    # trusting every upgrade after a core rename would be the worst way to notice.
    http, module = client

    class Renamed:
        pass

    monkeypatch.setattr(module.importlib, "import_module", lambda name: Renamed())
    assert module._upgrade_authorized(object()) is False


def test_authorize_gate_refuses_when_the_gate_itself_raises(client, monkeypatch):
    http, module = client

    class Exploding:
        @staticmethod
        def _ws_auth_ok(ws):
            raise RuntimeError("backend gone")

    monkeypatch.setattr(module.importlib, "import_module", lambda name: Exploding())
    assert module._upgrade_authorized(object()) is False
