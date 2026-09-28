// hermes-gemini-live — voice control that lives IN the composer, beside core's own voice
// affordances. Uncompiled ESM, one self-contained file: the loader resolves only
// @hermes/plugin-sdk and react*, and JSX is unavailable in this format, so every element
// goes through createElement.
//
// Audio leaves this window as 16 kHz s16le frames over a sibling WebSocket; the Gemini
// key is never sent here and never read here. The relay owns it.
import { icons, resolveSiblingWsUrl } from '@hermes/plugin-sdk'
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'

const RELAY_PATH = '/api/plugins/hermes-gemini-live/relay'
const SEND_RATE = 16000
const SEND_CHUNK = 1600
const DEFAULT_TUNING = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, halfDuplex: false }

const WORKLET_SOURCE = `
class ResampleToPcm extends AudioWorkletProcessor {
  constructor () {
    super()
    this.queue = new Float32Array(${SEND_CHUNK * 4})
    this.length = 0
    this.carry = 0
  }
  push (frame) {
    if (this.length + frame.length > this.queue.length) {
      const grown = new Float32Array((this.queue.length + frame.length) * 2)
      grown.set(this.queue.subarray(0, this.length))
      this.queue = grown
    }
    this.queue.set(frame, this.length)
    this.length += frame.length
  }
  drain () {
    const step = sampleRate / ${SEND_RATE}
    const out = new Int16Array(Math.max(0, Math.floor(this.length / step)))
    for (let i = 0; i < out.length; i++) {
      const at = i * step + this.carry
      const low = Math.floor(at)
      const high = Math.min(low + 1, this.length - 1)
      const value = this.queue[low] * (1 - (at - low)) + this.queue[high] * (at - low)
      out[i] = Math.max(-1, Math.min(1, value)) * 32767
    }
    this.carry = (this.length / step) % 1
    this.queue.copyWithin(0, Math.floor(out.length * step))
    this.length -= Math.floor(out.length * step)
    return out
  }
  process (inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) {
      this.push(Float32Array.prototype.slice.call(channel))
      if (this.length >= Math.ceil(${SEND_CHUNK} * (sampleRate / ${SEND_RATE}))) {
        const pcm = this.drain()
        if (pcm.length) this.port.postMessage({ pcm, peak: peakOf(pcm) }, [pcm.buffer])
      }
    }
    return true
  }
}
function peakOf (pcm) {
  let peak = 0
  for (let i = 0; i < pcm.length; i += 8) peak = Math.max(peak, Math.abs(pcm[i]))
  return peak / 32767
}
registerProcessor('pcm-out', ResampleToPcm)
`

function toBase64 (pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64 (text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Capture one mic stream into 16 kHz s16le chunks. Constraints come from the backend,
 * because echo cancellation is the difference between a call and a model that keeps
 * interrupting itself through a loudspeaker.
 */
async function startCapture (onChunk, tuning) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: tuning.autoGainControl,
      echoCancellation: tuning.echoCancellation,
      noiseSuppression: tuning.noiseSuppression
    }
  })
  const context = new AudioContext()
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const sink = context.createGain()
  sink.gain.value = 0
  source.connect(sink)
  sink.connect(context.destination)

  const stop = () => {
    stream.getTracks().forEach((track) => track.stop())
    void context.close().catch(() => {})
  }

  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
    await context.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const node = new AudioWorkletNode(context, 'pcm-out')
    node.port.onmessage = (event) => onChunk(event.data.pcm, event.data.peak)
    source.connect(node)
    return stop
  } catch {
    // Chromium without a worklet URL path: same math on the main thread, same contract.
    const node = context.createScriptProcessor(2048, 1, 1)
    let carry = 0
    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const step = context.sampleRate / SEND_RATE
      const count = Math.floor(input.length / step)
      if (!count) return
      const pcm = new Int16Array(count)
      for (let i = 0; i < count; i++) {
        const at = i * step + carry
        pcm[i] = Math.max(-1, Math.min(1, input[Math.min(Math.floor(at), input.length - 1)])) * 32767
      }
      carry = (input.length / step) % 1
      let peak = 0
      for (let i = 0; i < pcm.length; i += 8) peak = Math.max(peak, Math.abs(pcm[i]))
      onChunk(pcm, peak / 32767)
    }
    source.connect(node)
    node.connect(sink)
    return stop
  }
}

/** Playback for the model's 24 kHz speech, flushed the moment the user talks over it. */
function createPlayer () {
  const context = new AudioContext()
  const gain = context.createGain()
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.65
  const bins = new Uint8Array(analyser.frequencyBinCount)
  gain.connect(analyser)
  analyser.connect(context.destination)
  let next = 0
  const live = new Set()

  return {
    play (bytes) {
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
      const buffer = context.createBuffer(1, samples.length, 24000)
      const channel = buffer.getChannelData(0)
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32767
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(gain)
      next = Math.max(next, context.currentTime)
      node.start(next)
      next += buffer.duration
      live.add(node)
      node.onended = () => live.delete(node)
    },
    level () {
      analyser.getByteFrequencyData(bins)
      let peak = 0
      for (let i = 0; i < bins.length; i++) peak = Math.max(peak, bins[i])
      return Math.sqrt(peak / 255)
    },
    flush () {
      live.forEach((node) => {
        try {
          node.stop()
        } catch {
          /* already finished */
        }
      })
      live.clear()
      next = 0
    },
    close () {
      this.flush()
      void context.close().catch(() => {})
    }
  }
}

/**
 * Chrome copied from core's own voice surfaces
 * (`apps/desktop/src/app/chat/composer/voice-activity.tsx`): the same pill, the same
 * five-bar meter with weights [0.5, 0.78, 1, 0.78, 0.5], the same mono `m:ss` clock. A
 * plugin voice lane should be indistinguishable from the app's own one.
 */
const PILL = 'flex h-8 items-center gap-2 rounded-xl border border-border/55 bg-muted/55 ' +
  'px-2.5 text-xs text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] backdrop-blur-sm'
const DISC = 'flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary'
const BAR_WEIGHTS = [0.5, 0.78, 1, 0.78, 0.5]

function formatElapsed (seconds) {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${(safe % 60).toString().padStart(2, '0')}`
}

function VoiceLevelBars ({ level, active }) {
  const normalized = Math.max(0, Math.min(level, 1))
  return h('div', { 'aria-hidden': 'true', className: 'flex h-4 items-center gap-0.5' },
    ...BAR_WEIGHTS.map((weight, index) => {
      const height = active ? 0.25 + Math.min(0.68, normalized * weight) : 0.25
      return h('span', {
        key: index,
        className: ['w-0.5 rounded-full bg-current transition-[height,opacity] duration-100 ease-out',
          active ? 'opacity-80' : 'animate-pulse opacity-45'].join(' '),
        style: { height: `${height * 100}%` }
      })
    }))
}

function TalkControl ({ rest }) {
  const [state, setState] = useState('idle')
  const [detail, setDetail] = useState('')
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [speaking, setSpeaking] = useState(false)
  const [pending, setPending] = useState([])
  const [status, setStatus] = useState(null)
  const socket = useRef(null)
  const player = useRef(null)
  const stopCapture = useRef(null)
  const micPeak = useRef(0)
  const lastAudio = useRef(0)
  const lastInText = useRef(0)
  const startedAt = useRef(0)
  const taskAt = useRef(0)
  const tuningRef = useRef(DEFAULT_TUNING)

  const tuning = { ...DEFAULT_TUNING, ...((status && status.audio) || {}) }
  tuningRef.current = tuning

  useEffect(() => {
    let alive = true
    Promise.resolve(rest('/status'))
      .then((value) => { if (alive) setStatus(value) })
      .catch((error) => {
        if (!alive) return
        // Keep the backend's own words: "404 Plugin not found" means this home has the
        // plugin disabled, which is a different fix from a missing key.
        setStatus({
          ok: false,
          detail: 'backend: ' + (error && error.message ? error.message : String(error))
        })
      })
    return () => { alive = false }
  }, [rest])

  // One rAF loop drives meter, speaking and the clock while a call is up — and stops with
  // it, so an idle plugin costs the composer nothing.
  useEffect(() => {
    if (state === 'idle') return
    let raf = 0
    const tick = () => {
      const now = Date.now()
      const played = player.current ? player.current.level() : 0
      const isSpeaking = now - lastAudio.current < 400 || played > 0.02
      setSpeaking(isSpeaking)
      setLevel(isSpeaking ? played : micPeak.current)
      setElapsed((now - startedAt.current) / 1000)
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [state])

  useEffect(() => () => {
    socket.current?.close()
    stopCapture.current?.()
    player.current?.close()
  }, [])

  const append = useCallback((bytes, peak) => {
    micPeak.current = peak
    const active = tuningRef.current
    // Half-duplex: when a loudspeaker beats the canceller, the model's own reply arrives
    // at the mic and Live reads it as a listener interrupting. Muting the uplink while it
    // speaks costs talk-over interruption and buys back a call that actually finishes.
    if (active.halfDuplex && Date.now() - lastAudio.current < 600) return
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) return
    socket.current.send(JSON.stringify({ type: 'audio', data: toBase64(bytes) }))
  }, [])

  const speak = useCallback(async () => {
    setState('connecting')
    setDetail('')
    setSpeaking(false)
    setPending([])
    taskAt.current = 0
    lastAudio.current = 0
    lastInText.current = 0
    startedAt.current = Date.now()
    player.current = player.current || createPlayer()
    let url
    try {
      url = await resolveSiblingWsUrl({}, RELAY_PATH)
    } catch (error) {
      setState('idle')
      setDetail(error && error.message ? error.message : String(error))
      return
    }
    const ws = new WebSocket(url)
    socket.current = ws
    ws.onopen = async () => {
      setState('live')
      try {
        stopCapture.current = await startCapture(append, tuningRef.current)
      } catch (error) {
        setDetail('microphone unavailable: ' + (error && error.message ? error.message : String(error)))
      }
    }
    ws.onmessage = (event) => {
      let frame
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      if (frame.type === 'audio') {
        lastAudio.current = Date.now()
        player.current?.play(fromBase64(frame.data))
      } else if (frame.type === 'speech_started') {
        player.current?.flush()
        lastAudio.current = 0
      } else if (frame.type === 'in_text' && frame.text) {
        // The user's own words are the only honest start of a "thinking" window: an
        // extended-thinking model is silent while it works, and silence alone reads dead.
        lastInText.current = Date.now()
      } else if (frame.type === 'task_started') {
        if (!taskAt.current) taskAt.current = Date.now()
        setPending((ids) => (ids.includes(frame.id) ? ids : [...ids, frame.id]))
      } else if (frame.type === 'task_done') {
        setPending((ids) => ids.filter((id) => id !== frame.id))
        if (frame.state && frame.state !== 'completed') {
          setDetail('Hermes could not finish that task (' + frame.state + ')')
        }
      } else if (frame.type === 'lane') {
        setDetail('Hermes work is unavailable: ' + (frame.detail || frame.status))
      } else if (frame.type === 'go_away') {
        setDetail('Gemini is ending this session' +
          (frame.timeLeft ? ' (' + frame.timeLeft + ')' : '') + ' — press Start to go on')
      } else if (frame.type === 'error') {
        setState('idle')
        setDetail(String(frame.detail || 'the voice call failed'))
        stopCapture.current?.()
      }
    }
    ws.onclose = () => {
      stopCapture.current?.()
      stopCapture.current = null
      setState('idle')
    }
    ws.onerror = () => setDetail('the relay socket failed')
  }, [append])

  const stop = useCallback(() => {
    if (socket.current && socket.current.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'close' }))
      socket.current.close()
    }
    socket.current = null
    stopCapture.current?.()
    stopCapture.current = null
    player.current?.flush()
    lastAudio.current = 0
    lastInText.current = 0
    micPeak.current = 0
    taskAt.current = 0
    setLevel(0)
    setPending([])
    setState('idle')
  }, [])

  const blocked = !!(status && !status.ok)

  if (state === 'idle') {
    return h('button', {
      type: 'button',
      title: detail || (blocked && status ? status.detail : 'Start a Gemini Live call'),
      'aria-label': 'Start Gemini Live call',
      disabled: blocked,
      onClick: () => void speak(),
      className: 'inline-flex size-7 shrink-0 items-center justify-center rounded-full ' +
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50'
    }, h(icons.Mic, { className: icons.iconSize.sm }))
  }

  // A Hermes run takes tens of seconds and an extended-thinking model goes silent while
  // it works, so neither gap may look like a frozen app. Each gets its own label, clock
  // and disc, all built from chrome the app already uses: a spinning Loader2 to mean
  // "not idle", and the meter's own pulse (core's `animate-pulse opacity-45`) to mean
  // "alive, nothing coming out".
  const now = Date.now()
  const working = pending.length > 0
  const thinking = state === 'live' && !working && !speaking &&
    lastInText.current > 0 && now - lastInText.current < 20000
  const busy = working || thinking || state === 'connecting'
  const counted = working ? taskAt.current : (thinking ? lastInText.current : startedAt.current)
  const shownSeconds = working || thinking
    ? (now - counted) / 1000
    : elapsed
  const label = state === 'connecting' ? 'Connecting'
    : working ? (pending.length > 1 ? `Hermes is working · ${pending.length} tasks` : 'Hermes is working')
      : thinking ? 'Thinking'
        : speaking ? 'Speaking'
          : detail || 'Listening'

  return h('div', { 'aria-live': 'polite', role: 'status', className: PILL },
    h('div', { className: DISC },
      busy
        ? h(icons.Loader2, { className: ['animate-spin', icons.iconSize.xs].join(' ') })
        : h(speaking ? icons.Volume2 : icons.Mic, { className: icons.iconSize.xs })),
    h('div', { className: 'flex min-w-0 flex-1 items-center gap-2' },
      h('span', { className: 'truncate font-medium text-foreground/85' }, label),
      h('span', { 'aria-hidden': 'true', className: 'font-mono text-[0.6875rem] text-muted-foreground/85' },
        formatElapsed(shownSeconds))),
    h(VoiceLevelBars, { active: !thinking, level }),
    h('button', {
      type: 'button',
      'aria-label': 'Stop Gemini Live call',
      onClick: stop,
      className: 'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[0.6875rem] ' +
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
    }, h(icons.VolumeX, { className: icons.iconSize.xs }), 'Stop'))
}

export default {
  id: 'hermes-gemini-live',
  name: 'Gemini Live',
  defaultEnabled: true,
  register (ctx) {
    ctx.register({
      id: 'talk',
      area: 'composer.actions',
      order: 40,
      render: () => h(TalkControl, { rest: ctx.rest })
    })
  }
}
