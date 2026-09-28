# hermes-gemini-live

Full-duplex **Gemini Live** voice inside Hermes Desktop, with real work delegated to Hermes.

You press the mic control in the composer, talk, and hear Gemini answer. When you ask for
something that needs files, terminals or the web, the voice model hands the task to Hermes
over the api server, keeps talking to you, and reads the outcome aloud when it lands.

The audio relays through Hermes' own backend. Your `GEMINI_API_KEY` lives server-side only:
the Live API carries the key in the socket URL, so a browser or Electron window can never be
given it directly, and nothing here pretends otherwise.

## Setup

1. A Google AI Studio API key (the free tier works; this lane has no OAuth path).
2. Enable it **per home** — profiles do not inherit the default home's plugins:

```bash
hermes plugins enable hermes-gemini-live
for p in neo_agent nexus_agent vex_agent zen_agent; do hermes -p "$p" plugins enable hermes-gemini-live; done
```

If a profile answers `No plugin named 'hermes-gemini-live'`, that profile has no folder for
it. Point one at the shared clone (one source of truth) and retry:

```powershell
New-Item -ItemType Junction `
  -Path "$env:LOCALAPPDATA\hermes\profiles\<profile>\plugins\hermes-gemini-live" `
  -Target "$env:LOCALAPPDATA\hermes\plugins\hermes-gemini-live"
```

3. Put the key in **that home's** `.env` (never in the plugin folder — Hermes does not read a
   `.env` from there):

```
GEMINI_API_KEY=...
```

(`TALK_*` keys belong to `hermes-talk`, not here.)

4. Restart Hermes Desktop. Two separate reasons, both real:
   plugin routes are mounted **once at web-server import**, and the Desktop half is a
   **copy** under `~/.hermes/desktop-plugins/` refreshed when the source is newer.

## Configuration

Every key is read from the environment of the profile that serves the call. A key that is
**set but blank** is a refusal, never a silent fall-through.

| Key | Default | What it does |
|---|---|---|
| `GEMINI_LIVE_API_KEY` → `GEMINI_API_KEY` | — | Live credential, server-side only |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live-extended-thinking` | Live model id, `models/` added once. Any of the four probed ids below works; `gemini-3.8-live` answers ~0.17 s faster |
| `GEMINI_LIVE_THINKING_LEVEL` | `high` | extended-thinking models **require** a level; only `high`/`low` are accepted |
| `GEMINI_LIVE_VOICE` | `Puck` | `Puck` `Charon` `Kore` `Fenrir` `Aoede`, **case-sensitive** |
| `GEMINI_LIVE_SILENCE_MS` | `1200` | how long silence must run before the turn ends (400–5000) |
| `GEMINI_LIVE_PREFIX_MS` | `300` | lead-in kept before speech (100–1500) |
| `GEMINI_LIVE_ECHO_CANCELLATION` | on | keep ON unless you know why |
| `GEMINI_LIVE_NOISE_SUPPRESSION` / `GEMINI_LIVE_AUTO_GAIN` | on | capture tuning |
| `GEMINI_LIVE_HALF_DUPLEX` | off | stop sending mic while the model speaks — for a speaker loud enough to beat the canceller; costs talk-over interruption |
| `GEMINI_LIVE_API_SERVER_URL` | `http://127.0.0.1:8642` | gateway api server the lane posts runs to |
| `GEMINI_LIVE_API_SERVER_PROFILE` | derived from the serving home | pin the profile delegated runs belong to |
| `GEMINI_LIVE_SESSION_KEY` | unset | stable memory scope for delegated runs |
| `GEMINI_LIVE_INSTRUCTIONS` | — | extra persona sentences appended to the system instruction |

## What was checked against the real endpoint

| Model | Result |
|---|---|
| `gemini-3.8-live` | setup accepted, audio returned at `audio/pcm;rate=24000`; **called `hermes_task`** when asked something it cannot know |
| `gemini-3.8-live-extended-thinking` | accepted **only** with `generationConfig.thinkingConfig.thinkingLevel`; `minimal` and `auto` are refused. Calls `hermes_task` as well — **but only under an instruction that forbids it from answering**, see below |
| `gemini-3.1-flash-live-preview` | accepted; returned a `toolCall` for both the canonical test function and `hermes_task` |
| `gemini-2.5-flash-native-audio-latest` | accepted; returned a `toolCall` |

**The delegate is where the two models differ most, and the numbers are not close.** Five
trials each, same question ("current time in Tokyo — you must call hermes_task, do not
guess"), same strong order in the system instruction, 90 s window:

| Configuration | Handed the work to Hermes |
|---|---|
| `gemini-3.8-live` | **8/8** across every run tried, with and without `behavior` |
| `gemini-3.8-live-extended-thinking` + `behavior: NON_BLOCKING` | 2/5 |
| `gemini-3.8-live-extended-thinking` alone | 0/5 |

So the flag helps rather than hurts: Google's page for that model says its function calling is
async-only, and the field belongs on the **FunctionDeclaration** — on the Tool entry the
endpoint answers `Unknown name "behavior" at 'setup.tools[0]'`.

This 2/5 is a decision, not a dropped frame. A second run gave the socket 90 s past
`turnComplete` before scoring a miss (Google warns that `turnComplete` no longer means idle
here) and the rate was unchanged at 2/5 — and in both of those trials `turnComplete` arrived at
~3.3 s while the call landed at **5.9 s and 13.5 s after the question**, so the late-delivery
path works and is what the relay already relies on. In the three misses the model answered in
about the same 3 s, meaning it never hesitated: it simply chose to answer. Nothing on the wire
changes that — `toolConfig`, `mode: ANY` and function scheduling are all unsupported on this
model, so there is no way to mandate a call. Even with it, extended-thinking
answers from itself about three times in five, which is the honest cost of choosing it: it
scores higher on speech quality and on agentic benchmarks, but the one thing the voice lane
needs — noticing that it cannot know and asking Hermes — is unreliable on it. The default stays
extended-thinking because that is the accuracy the user asked for; set
`GEMINI_LIVE_MODEL=gemini-3.8-live` to trade thinking for a delegate that fires.

Other measured dead ends: `toolConfig` and `mode: ANY` do not exist on this wire (close 1007 at
both `setup` and `setup.generation_config`), so no call can be forced from outside;
`responseModalities: ["AUDIO","TEXT"]` is refused outright; the question arriving as
`clientContent` instead of `realtimeInput.text` changes nothing. And `turnComplete` no longer
means idle on the thinking model, so a listener that stops there scores a late call as a miss —
beware when re-measuring.

Accepted setup fields: `contextWindowCompression.slidingWindow`, `sessionResumption`,
`inputAudioTranscription`, `outputAudioTranscription`, `tools.functionDeclarations`,
`realtimeInputConfig.automaticActivityDetection.{silenceDurationMs,prefixPaddingMs}`,
`realtimeInput.text` (mid-session text works on the 3.8 ids).
Rejected with close code 1007: `threshold`, `voiceActivityConfig`, `serverVad`, `pushToTalk`,
`turnCoverage`, and `turnComplete` inside `realtimeInput`.

## Limits, stated rather than discovered mid-call

- **Google owns the context trim.** The sliding window cuts at 80% of the window toward half
  of that and never trims the system instruction. Without it an audio-only session hard-caps
  near 15 minutes. There is **no** way to delete context mid-session (`RemoveContext` has no
  Live equivalent), so a long conversation is bounded by that trim plus `goAway`.
- `goAway` is terminal: the socket dies immediately after. The panel says so instead of
  letting the call go quiet.
- **No upstream cancel or truncate.** Interruption is the server's VAD; the client only stops
  its own playback.
- Rate ceiling for these Live models is **64k tokens/minute** (no RPM/RPD/TPD per Google), and
  audio tokens stream continuously rather than per prompt, so the practical limit is call
  length, not message count.
- One delegated tool by design (`hermes_task`). Hermes' own agent decides which of its 30+
  toolsets to use, so the setup frame carries no tool schemas. A Hermes run measured **75.5 s**
  for a one-word answer, which is why the receipt-then-speak shape is not optional.
- A delegated run is routed to `/p/<profile>/` when this process serves a named profile:
  an unprefixed run would resume in the **default** profile's memory.
- Not supported: Discord, the terminal lane, wake word, cascade TTS, memory write-back from
  the panel, and appearing as a row in core's own voice-engine dropdown (that menu starts
  core's engines and offers no plugin seam).

## Tests

```bash
python -m pytest plugins/hermes-gemini-live -q     # needs a Python with pytest; the
                                                   # runtime venv is a payload and has none
```

79 tests cover config refusals, the wire contract (including the fields the endpoint rejects),
relay teardown from either side, the agent lane's four outcomes, and route mounting through
the same file-path import the host uses. The renderer path — real mic, real speaker, real
interruption — is only provable by making a call.
