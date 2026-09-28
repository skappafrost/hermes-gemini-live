"""Fail-closed configuration: every refusal is louder than a guessed default."""

from __future__ import annotations

import pytest

from hermes_gemini_live import config


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for name in ("GEMINI_LIVE_API_KEY", "GEMINI_API_KEY", "GEMINI_LIVE_MODEL",
                 "GEMINI_LIVE_VOICE", "GEMINI_LIVE_THINKING_LEVEL",
                 "GEMINI_LIVE_SILENCE_MS", "GEMINI_LIVE_PREFIX_MS",
                 "GEMINI_LIVE_ECHO_CANCELLATION", "GEMINI_LIVE_NOISE_SUPPRESSION",
                 "GEMINI_LIVE_AUTO_GAIN", "GEMINI_LIVE_HALF_DUPLEX"):
        monkeypatch.delenv(name, raising=False)


def _set_key(monkeypatch, value):
    # A plugin may run under a secret scope; the env is the unscoped fallback path,
    # so pin the scope absent to keep these tests about the reading rules.
    monkeypatch.setenv("GEMINI_API_KEY", value)


def test_blank_key_refuses_instead_of_falling_through(monkeypatch):
    _set_key(monkeypatch, "   ")
    with pytest.raises(config.ConfigError, match="set but empty"):
        config.resolve_key()


def test_missing_key_names_both_accepted_vars(monkeypatch):
    with pytest.raises(config.ConfigError, match="GEMINI_LIVE_API_KEY or GEMINI_API_KEY"):
        config.resolve_key()


def test_scoped_key_beats_shared_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "shared-key-value")
    monkeypatch.setenv("GEMINI_LIVE_API_KEY", "scoped-key-value")
    assert config.resolve_key() == "scoped-key-value"


@pytest.mark.parametrize("voice", ["Puck", "Kore", "Aoede"])
def test_known_voices_pass(monkeypatch, voice):
    monkeypatch.setenv("GEMINI_LIVE_VOICE", voice)
    assert config.voice() == voice


@pytest.mark.parametrize("voice", ["puck", "PUCK", "notavoice", " puck "])
def test_voice_is_case_sensitive_and_fails_closed(monkeypatch, voice):
    monkeypatch.setenv("GEMINI_LIVE_VOICE", voice)
    with pytest.raises(config.ConfigError, match="not a Gemini Live voice"):
        config.voice()


def test_thinking_level_only_applies_to_extended_thinking():
    assert config.thinking_level("gemini-3.1-flash-live-preview") is None
    assert config.thinking_level("gemini-3.8-live") is None
    assert config.thinking_level("gemini-3.8-live-extended-thinking") in config.THINKING_LEVELS


def test_unsupported_thinking_level_refuses(monkeypatch):
    # The endpoint itself rejects these two ("...not supported for this model" /
    # "Invalid value"), so the plugin must not put them on the wire.
    monkeypatch.setenv("GEMINI_LIVE_THINKING_LEVEL", "minimal")
    with pytest.raises(config.ConfigError, match="refuses minimal and auto"):
        config.thinking_level("gemini-3.8-live-extended-thinking")


def test_status_never_contains_the_key(monkeypatch):
    _set_key(monkeypatch, "super-secret-key-value")
    blob = repr(config.status_dict())
    assert "super-secret" not in blob
    assert config.status_dict()["ok"] is True


def test_status_reports_the_reason_when_no_key():
    status = config.status_dict()
    assert status["ok"] is False
    assert "Gemini key" in status["detail"]


def test_serving_profile_comes_from_the_home_not_from_a_client(tmp_path, monkeypatch):
    # An unprefixed run resumes in the DEFAULT profile's store, so guessing this wrong
    # writes one profile's memories into another's.
    import hermes_constants
    nested = tmp_path / "profiles" / "vex_agent"
    nested.mkdir(parents=True)
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: nested)
    assert config.serving_profile() == "vex_agent"
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    assert config.serving_profile() is None


def test_serving_profile_can_be_pinned_and_default_is_unprefixed(tmp_path, monkeypatch):
    import hermes_constants
    monkeypatch.setattr(hermes_constants, "get_hermes_home",
                        lambda: tmp_path / "profiles" / "vex_agent")
    monkeypatch.setenv("GEMINI_LIVE_API_SERVER_PROFILE", "zen_agent")
    assert config.serving_profile() == "zen_agent"
    monkeypatch.setenv("GEMINI_LIVE_API_SERVER_PROFILE", "default")
    assert config.serving_profile() is None


def test_activity_detection_offers_only_the_fields_the_endpoint_accepts():
    # Probed against the live endpoint: silenceDurationMs and prefixPaddingMs are taken,
    # while threshold / voiceActivityConfig / serverVad / pushToTalk all close 1007.
    rtc = config.activity_detection()["automaticActivityDetection"]
    assert rtc == {"silenceDurationMs": config.DEFAULT_SILENCE_MS,
                   "prefixPaddingMs": config.DEFAULT_PREFIX_MS}
    assert "threshold" not in rtc


def test_turn_bounds_refuse_silly_values(monkeypatch):
    monkeypatch.setenv("GEMINI_LIVE_SILENCE_MS", "60000")
    with pytest.raises(config.ConfigError, match="outside"):
        config.silence_ms()
    monkeypatch.setenv("GEMINI_LIVE_PREFIX_MS", "soon")
    with pytest.raises(config.ConfigError, match="whole number"):
        config.prefix_ms()


def test_echo_cancellation_is_on_by_default():
    # A loudspeaker feeds the model's own reply back into the mic, and Live's server VAD
    # reads that as a listener interrupting — so the canceller is the fix, not a nicety.
    audio = config.audio_tuning()
    assert audio["echoCancellation"] is True
    assert audio["halfDuplex"] is False


@pytest.mark.parametrize("raw", ["0", "false", "off"])
def test_the_canceller_can_be_switched_off(monkeypatch, raw):
    monkeypatch.setenv("GEMINI_LIVE_ECHO_CANCELLATION", raw)
    assert config.audio_tuning()["echoCancellation"] is False


def test_a_bad_boolean_refuses_instead_of_guessing(monkeypatch):
    monkeypatch.setenv("GEMINI_LIVE_HALF_DUPLEX", "maybe")
    with pytest.raises(config.ConfigError, match="not a boolean"):
        config.audio_tuning()


def test_status_reveals_a_bad_knob_even_when_the_key_is_fine(monkeypatch):
    _set_key(monkeypatch, "real-key-value")
    monkeypatch.setenv("GEMINI_LIVE_SILENCE_MS", "60000")
    status = config.status_dict()
    assert status["ok"] is False
    assert status["key_present"] is True
    assert "SILENCE_MS" in status["detail"]


def test_status_ships_the_capture_rules_the_panel_must_apply(monkeypatch):
    _set_key(monkeypatch, "real-key-value")
    status = config.status_dict()
    assert status["audio"]["echoCancellation"] is True
    assert status["turn"]["silenceDurationMs"] == config.DEFAULT_SILENCE_MS
