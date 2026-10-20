"""Preserve spoken requirements instead of trusting a shortened tool argument."""
import pytest
from hermes_gemini_live import wire, tools, config, relay, agent_lane
from tests.test_relay import FakeLive, FakeBrowser


def test_nested_google_transcription_is_not_lost_or_duplicated():
    chunk = {'text': 'Compare live options, not offline TTS.', 'finished': True}
    nested = wire.browser_frames({'serverContent': {'inputTranscription': chunk}})
    assert any(f.get('text') == chunk['text'] for f in nested)
    frames = wire.browser_frames({'serverContent': {'inputTranscription': chunk},
                                  'inputTranscription': chunk})
    assert [f['text'] for f in frames if f['type'] == 'in_text'] == [chunk['text']]


def test_delegation_keeps_verbatim_details_beside_short_summary():
    prompt = tools.compose_prompt({'task': 'Compare voice options'}, voice_summary=False,
        transcript='Include interruptions, UK accents and cost for 20 minutes daily.\nActually use 30 minutes.')
    assert 'UK accents' in prompt and 'Actually use 30 minutes.' in prompt
    assert 'Compare voice options' in prompt


@pytest.mark.asyncio
async def test_relay_attaches_spoken_details_only_to_next_handoff(monkeypatch):
    spoken = 'Compare costs for thirty minutes daily, with male British voices and barge-in.'
    live = FakeLive([
        {'serverContent': {'inputTranscription': {'text': spoken}}},
        {'toolCall': {'functionCalls': [{'id': 'one', 'name': tools.DELEGATE_NAME,
                                        'args': {'task': 'Compare voice costs'}}]}},
        {'serverContent': {'inputTranscription': {'text': 'Now inspect disk space.'}}},
        {'toolCall': {'functionCalls': [{'id': 'two', 'name': tools.DELEGATE_NAME,
                                        'args': {'task': 'Inspect disk'}}]}},
        {'goAway': {'timeLeft': '0s'}}])
    submitted = []
    monkeypatch.setattr(agent_lane, 'start_task', lambda task, **kw: submitted.append(task))
    await relay._live_to_browser(FakeBrowser(), live, {}, agent_lane.RunBook(),
                                  None, None, relay.NoteQueue(live))
    assert spoken in submitted[0]
    assert spoken not in submitted[1]
    assert 'Now inspect disk space.' in submitted[1]


def test_instructions_describe_delegated_web_and_preserve_requirements():
    assert 'no web, nothing about this machine' not in config.DEFAULT_INSTRUCTIONS
    assert 'constraints' in config.DEFAULT_INSTRUCTIONS
    assert 'hermes_task' in config.DEFAULT_INSTRUCTIONS
