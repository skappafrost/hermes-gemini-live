"""The Live wire contract. Frames below are shapes the endpoint actually sent back."""

from __future__ import annotations

import base64

from hermes_gemini_live import wire


def types(frames):
    return [frame["type"] for frame in frames]


def audio_frame(b64):
    return {"serverContent": {"modelTurn": {"parts": [
        {"inlineData": {"mimeType": wire.OUT_MIME, "data": b64}}]}}}


def test_setup_carries_the_google_owned_trim():
    # Without this an audio-only call hard-stops near 15 minutes, which reads to the
    # user as the voice dying on its own.
    setup = wire.build_setup(model="gemini-3.8-live", voice="Puck", instructions="be brief")
    assert setup["setup"]["contextWindowCompression"] == {"slidingWindow": {}}
    assert setup["setup"]["sessionResumption"] == {}
    assert setup["setup"]["model"] == "models/gemini-3.8-live"


def test_activity_lands_under_realtime_input_config_only_when_supplied():
    with_activity = wire.build_setup(
        model="gemini-3.8-live", voice="Puck", instructions="x",
        activity={"automaticActivityDetection": {"silenceDurationMs": 1200,
                                                 "prefixPaddingMs": 300}})
    assert with_activity["setup"]["realtimeInputConfig"] == {
        "automaticActivityDetection": {"silenceDurationMs": 1200, "prefixPaddingMs": 300}}
    plain = wire.build_setup(model="gemini-3.8-live", voice="Puck", instructions="x")
    assert "realtimeInputConfig" not in plain["setup"]


def test_thinking_level_lands_where_the_endpoint_reads_it():
    with_level = wire.build_setup(model="gemini-3.8-live-extended-thinking", voice="Puck",
                                  instructions="x", thinking_level="high")
    assert with_level["setup"]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "high"}
    without = wire.build_setup(model="gemini-3.1-flash-live-preview", voice="Puck", instructions="x")
    assert "thinkingConfig" not in without["setup"]["generationConfig"]


def test_model_prefix_is_added_exactly_once():
    assert wire.wire_model("gemini-3.8-live") == "models/gemini-3.8-live"
    assert wire.wire_model("models/gemini-3.8-live") == "models/gemini-3.8-live"
    setup = wire.build_setup(model="models/gemini-3.8-live", voice="Puck", instructions="x")
    assert setup["setup"]["model"] == "models/gemini-3.8-live"


def test_text_input_never_carries_turn_complete():
    # The endpoint answers Unknown name "turnComplete" at 'realtime_input' and closes 1007.
    frame = wire.text_input("hello")
    assert frame["realtimeInput"] == {"text": "hello"}
    assert "turnComplete" not in frame["realtimeInput"]


def test_audio_up_is_16k_and_down_is_24k():
    assert wire.audio_chunk("AAA=")["realtimeInput"]["audio"]["mimeType"] == wire.IN_MIME
    assert wire.OUT_MIME == "audio/pcm;rate=24000"


def test_setup_complete_opens_the_call():
    assert types(wire.browser_frames({"setupComplete": {}})) == ["ready"]


def test_inline_audio_becomes_a_playback_frame():
    frames = wire.browser_frames(audio_frame(base64.b64encode(b"\x00\x01" * 8).decode()))
    assert frames[0]["type"] == "audio"
    assert frames[0]["mime"] == wire.OUT_MIME
    assert base64.b64decode(frames[0]["data"]) == b"\x00\x01" * 8


def test_interruption_is_a_flush_signal_not_an_upstream_command():
    frames = wire.browser_frames({"serverContent": {"interrupted": True}})
    assert types(frames) == ["speech_started"]


def test_turn_complete_closes_the_loop():
    assert types(wire.browser_frames({"serverContent": {"turnComplete": True}})) == ["turn_complete"]


def test_tool_call_survives_with_parsed_args():
    raw = {"toolCall": {"functionCalls": [
        {"id": "call_1", "name": "echo_back", "args": {"phrase": "hi"}}]}}
    frames = wire.browser_frames(raw)
    assert frames[0]["type"] == "tool_call"
    assert frames[0]["calls"] == [{"id": "call_1", "name": "echo_back",
                                   "args": {"phrase": "hi"}}]


def test_function_response_is_the_only_thing_sent_back_for_a_call():
    frame = wire.function_response("call_1", "three files", "echo_back")
    assert frame == {"toolResponse": {"functionResponses": [
        {"id": "call_1", "response": {"result": "three files"}, "name": "echo_back"}]}}


def test_error_frame_reaches_the_surface_verbatim():
    frames = wire.browser_frames({"error": {"message": "quota exhausted", "code": 429}})
    assert frames == [{"type": "error", "detail": "quota exhausted", "code": 429}]


def test_go_away_is_surfaced_as_its_own_frame():
    # Terminal by protocol: the socket dies ABORTED immediately after, so a call that just
    # stops must still tell the user why.
    assert wire.browser_frames({"goAway": {"timeLeft": "45s"}}) == [
        {"type": "go_away", "timeLeft": "45s"}]


def test_unrelated_server_frames_are_dropped_not_forwarded():
    # The renderer's message contract is closed; a new field must not become an
    # unhandled frame type on a live call.
    assert wire.browser_frames({"someFutureField": {"a": 1}}) == []
