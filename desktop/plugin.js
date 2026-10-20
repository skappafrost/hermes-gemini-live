// hermes-gemini-live — voice control that lives IN the composer, beside core's own voice
// affordances. Uncompiled ESM, one self-contained file: the loader resolves only
// @hermes/plugin-sdk and react*, and JSX is unavailable in this format, so every element
// goes through createElement.
//
// Audio leaves this window as 16 kHz s16le frames over a sibling WebSocket; the Gemini
// key is never sent here and never read here. The relay owns it.
import { host, icons, resolveSiblingWsUrl, Dialog, DialogContent, DialogTitle, DialogDescription } from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useState } from 'react'

const RELAY_PATH = '/api/plugins/hermes-gemini-live/relay'
const SEND_RATE = 16000
const SEND_CHUNK = 1600
const DEFAULT_TUNING = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, halfDuplex: false }

// Read-only Hermes history has its own lifetime; it never opens a paid Live socket.
const taskHistory = { rows: [], selected: '', detail: null, open: false, error: '', busy: false }
const conversationView = { busy: false, revisions: new Map(), status: '', activity: '', progress: '', problem: '', updatedAt: 0, toolCount: 0, error: '' }

// Native receipts belong to the conversation, never to the paid audio socket.
const NATIVE_KEY = 'hermes-gemini-native-v1'
let nativeReceipts = []
try { nativeReceipts = JSON.parse(localStorage.getItem(NATIVE_KEY) || '[]') } catch {}
const nativePending = new Map()
function saveNative () { localStorage.setItem(NATIVE_KEY, JSON.stringify(nativeReceipts.slice(-200))) }
function nativeOwner () { return host.state.focusedSessionOwner?.get() }
function sameOwner (a, b) { return a?.connectionId === b?.connectionId && a?.profile === b?.profile }
async function nativeRoute (owner) {
  const routes = await host.profileRoutes()
  const route = routes.find(r => sameOwner(r, owner))
  if (!route) throw new Error('The native conversation owner is unavailable.')
  return route
}
function nativeTasks () {
  const sid = host.state.focusedStoredSessionId.get(), owner = nativeOwner()
  return nativeReceipts.filter(r => (r.sid === sid || r.aliases?.includes(sid)) && sameOwner(r.owner, owner) && !r.correction)
}
function reconcileNativeIndicators () {
  const terminal = new Set(nativeTasks().filter(task => ['completed', 'failed', 'interrupted', 'cancelled', 'rejected'].includes(task.status)).map(task => task.id))
  call.pending = call.pending.filter(id => !terminal.has(id))
  call.waiting = call.waiting.filter(id => !terminal.has(id))
  if (!call.pending.length) call.taskAt = 0
}
function voiceRequestText (text) {
  const label = '`Voice request`\n\n'
  return text.startsWith(label) ? text : label + text
}
function nativeView (task) {
  if (!task) return
  reconcileNativeIndicators()
  conversationView.status = task.status
  conversationView.activity = task.activity || ''
  conversationView.progress = task.progress || task.output || ''
  conversationView.updatedAt = task.updatedAt || Date.now()
  conversationView.error = task.status === 'uncertain' ? 'Delivery uncertain; check the chat before retrying.' : ''
  publish()
}
function nativeEvent (event) {
  for (const task of nativeReceipts.filter(r => !r.correction && ['submitted', 'running', 'waiting_for_user', 'waiting_for_approval'].includes(r.status))) {
    if (event.session_id !== task.runtime || (event.connectionId && event.connectionId !== task.owner.connectionId) ||
        (event.profile && event.profile !== task.owner.profile)) continue
    if (event.replayed || (event.seq && task.seq >= event.seq)) continue
    if (event.seq) task.seq = event.seq
    const p = event.payload || {}
    if (event.type === 'message.start') { task.status = 'running'; nativePending.get(task.id)?.(true) }
    if (event.type === 'message.interim') task.progress = String(p.text || '').slice(-1200)
    if (event.type === 'message.delta') task.progress = ((task.progress || '') + (p.text || '')).slice(-1200)
    if (event.type === 'tool.start' || event.type === 'tool.complete') {
      task.activity = String(p.name || 'Tool').replaceAll('_', ' ') + (event.type === 'tool.complete' ? ' · result received' : '')
      task.toolIds = [...new Set([...(task.toolIds || []), p.tool_id].filter(Boolean))]
    }
    if (['approval.request', 'clarify.request', 'secret.request', 'sudo.request'].includes(event.type)) {
      task.status = event.type === 'clarify.request' ? 'waiting_for_user' : 'waiting_for_approval'
      task.activity = 'Answer the native request in this chat'
    }
    if (event.type === 'message.complete') {
      task.status = p.status === 'error' ? 'failed' : p.status === 'interrupted' ? 'interrupted' : 'completed'
      task.output = typeof p.text === 'string' ? p.text.slice(-6000) : JSON.stringify(p.text)
      task.progress = task.output
      const ws = call.socket
      if (ws?.readyState === WebSocket.OPEN && nativeTasks().includes(task)) ws.send(JSON.stringify({ type: 'native_notice', text: 'Existing Hermes task ' + task.id + ' ' + task.status + '. Result DATA: ' + task.output + '\nSpeak a short summary only; do not start another task.' }))
    }
    task.updatedAt = Date.now()
    saveNative()
    if (nativeTasks().includes(task)) nativeView(task)
  }
}
async function nativeCommand (command) {
  const { id, action, payload = {} } = command
  const previous = nativeReceipts.find(r => r.id === id)
  if (previous) {
    const sid = host.state.focusedStoredSessionId.get()
    if (!sameOwner(previous.owner, nativeOwner()) || (previous.sid !== sid && !previous.aliases?.includes(sid))) return { status: 'rejected', detail: 'Receipt belongs to another conversation.' }
    return previous.result || { status: previous.status, task_id: previous.task_id || previous.id }
  }
  if (action === 'board') {
    reconcileNativeIndicators()
    publish()
    return { status: 'ok', tasks: nativeTasks().map(r => ({ task_id: r.id, status: r.status, prompt: r.prompt, output: r.output, progress: r.progress, activity: r.activity })) }
  }
  const sid = host.state.focusedStoredSessionId.get(), runtime = host.state.focusedSessionId.get(), owner = nativeOwner()
  if (!sid || !runtime || !owner || (call.conversationId && sid !== call.conversationId)) return { status: 'rejected', detail: 'The exact owning conversation is not available.' }
  const original = String(payload.text || '').trim()
  const text = original ? voiceRequestText(original) : ''
  const active = nativeTasks().findLast(r => ['running', 'submitted', 'waiting_for_user', 'waiting_for_approval'].includes(r.status))
  const requested = payload.task_id ? nativeTasks().find(r => r.id === payload.task_id) : active
  if (action !== 'submit' && !requested) return { status: 'rejected', detail: 'Task does not belong to this conversation.' }
  if (action === 'stop' || action === 'deny') return { status: 'rejected', detail: 'Use the native Stop or approval controls in this chat. End voice only ends audio.' }
  if (!text) return { status: 'rejected', detail: 'No task text supplied.' }
  // Persist intent BEFORE dispatch; an uncertain delivery is never replayed automatically.
  const record = { id, sid, runtime, owner, prompt: text, status: 'submitted', createdAt: Date.now(), updatedAt: Date.now() }
  nativeReceipts.push(record); saveNative()
  try {
    if (host.state.busy.get()) {
      if (requested && requested.runtime !== runtime) throw new Error('Task runtime changed; reconnect before steering.')
      const task = requested || record
      const response = await host.requestProfile(await nativeRoute(owner), 'session.steer', { session_id: runtime, text })
      if (response.status !== 'queued') throw new Error('Native turn did not accept steering; no extra run was started.')
      record.correction = task !== record
      record.task_id = task.id
      record.status = 'running'
      record.result = { status: 'steered', task_id: task.id }
      task.activity = 'Steering accepted by the running Hermes task'
      nativeView(task)
    } else {
      if (action === 'steer') throw new Error('That task is no longer running; no new task was started.')
      // Listen before dispatch. message.start is a gateway acknowledgment, not optimistic UI busy.
      let timer
      const accepted = new Promise(resolve => { nativePending.set(id, resolve); timer = setTimeout(() => resolve(false), 20000) })
      // The event tap stores callbacks in a Set. Reusing nativeEvent here
      // would let temporary cleanup remove the permanent progress listener.
      const dispose = host.onEvent('*', event => nativeEvent(event))
      try {
        if (!host.composer.submit(sid, text)) throw new Error('No exact native composer accepted delivery.')
        if (!await accepted) { record.status = 'uncertain'; record.result = { status: 'uncertain', task_id: id, detail: 'No native start acknowledgment. Check the chat; do not retry automatically.' } }
        else { record.status = 'running'; record.result = { status: 'running', task_id: id } }
      } finally { clearTimeout(timer); nativePending.delete(id); dispose() }
      nativeView(record)
    }
  } catch (error) {
    record.status = 'rejected'; record.result = { status: 'rejected', detail: message(error) }
  }
  saveNative()
  return record.result
}

function describeActivity (messages) {
  const publicNote = [...messages].reverse().find(row => row.role === 'assistant' &&
    typeof (row.display_content || row.content) === 'string' && (row.display_content || row.content).trim())
  const progress = publicNote ? (publicNote.display_content || publicNote.content).replace(/\s+/g, ' ').trim().slice(0, 260) : ''
  const calls = messages.flatMap(row => toolCalls(row))
  const tool = calls.at(-1)
  if (!tool) return { description: '', progress, problem: '', pendingTool: false, toolCount: 0 }
  const name = tool.function?.name || tool.name || 'tool'
  let args = tool.function?.arguments || tool.arguments || {}
  try { if (typeof args === 'string') args = JSON.parse(args) } catch { args = {} }
  const path = args.path || args.file_path || args.filepath || ''
  const file = String(path).split(/[\\/]/).at(-1)
  const verbs = { read_file: 'Reading', write_file: 'Writing', patch: 'Editing', terminal: 'Running command', execute_code: 'Running code', web_search: 'Searching the web', browser: 'Using browser' }
  const description = (verbs[name] || name.replaceAll('_', ' ')) + (file ? ' ' + file : '')
  const result = [...messages].reverse().find(row => row.role === 'tool' && row.tool_call_id === tool.id)
  let payload = result?.content || {}
  try { if (typeof payload === 'string') payload = JSON.parse(payload) } catch { payload = {} }
  const problem = payload?.stale_write_blocked ? 'File update blocked: read the full current file before replacing it.'
    : payload?.error ? 'Tool reported an error; see its result in the thread.' : ''
  return { description, progress, problem, pendingTool: !result, toolCount: calls.length }
}

async function ensureConversation (rest) {
  let sid = host.state.focusedStoredSessionId.get()
  if (!sid) {
    const created = await host.requestProfile(await nativeRoute(nativeOwner()), 'session.create', { source: 'desktop' })
    sid = created.stored_session_id
    if (!sid) throw new Error('Native conversation creation was not acknowledged.')
    await host.openSession(sid, { profile: host.state.focusedSessionProfile.get(), awaitHydration: true, intent: 'in-place' })
  }
  return sid
}

async function refreshConversation (rest) {
  const sid = host.state.focusedStoredSessionId.get()
  const native = nativeTasks().at(-1)
  if (native) {
    nativeView(native)
    // Native events own live rendering. Read persisted history only to recover
    // an attached turn's final acknowledgment after a renderer/plugin reload.
    if (['submitted', 'running', 'uncertain'].includes(native.status) && !host.state.busy.get() && !conversationView.busy) {
      conversationView.busy = true
      try {
        const prompts = nativeReceipts.filter(r => r.id === native.id || r.task_id === native.id).map(r => r.prompt)
        const recovered = await rest('/conversations/' + encodeURIComponent(sid) + '/native-completion', {
          method: 'POST', body: { since: (native.createdAt || native.updatedAt) / 1000, prompts } })
        if (recovered.completion && !host.state.busy.get()) {
          native.status = recovered.completion.status
          native.output = recovered.completion.output
          native.progress = native.output
          native.updatedAt = recovered.completion.timestamp * 1000
          saveNative(); nativeView(native)
        }
      } catch { /* No confirmed final means pending, never a new coding run. */ }
      finally { conversationView.busy = false }
    }
    return
  }
  if (!sid || conversationView.busy) return
  conversationView.busy = true
  try {
    const data = await rest('/tasks?conversation_id=' + encodeURIComponent(sid))
    const rows = (data.tasks || []).filter(row => row.conversation_id === sid)
    if (!rows.length) { conversationView.status = ''; conversationView.progress = ''; conversationView.activity = ''; conversationView.problem = ''; return }
    const detail = await rest('/tasks/' + encodeURIComponent(rows[0].run_id))
    if (host.state.focusedStoredSessionId.get() !== sid) return
    conversationView.status = detail.status
    const messages = detail.messages || []
    const currentMessages = messages.filter(row => !row.timestamp || row.timestamp >= (rows[0].created_at || 0) - 1)
    const activity = describeActivity(currentMessages)
    conversationView.activity = activity.description + (activity.description && !activity.pendingTool ? ' · result received' : '')
    conversationView.progress = activity.progress
    conversationView.problem = activity.problem
    conversationView.toolCount = activity.toolCount
    const revision = [rows[0].run_id, detail.status, messages.length, messages.at(-1)?.id, messages.at(-1)?.content?.length].join('/')
    if (conversationView.revisions.get(sid) !== revision) {
      conversationView.updatedAt = currentMessages.at(-1)?.timestamp ? currentMessages.at(-1).timestamp * 1000 : Date.now()
    }
    if (conversationView.revisions.get(sid) !== revision && !host.state.busy.get()) {
      // The SDK refreshes the native transcript in place; it never opens a window,
      // changes focus, sends a new prompt, or starts another model turn.
      await host.openSession(sid, { refreshInPlace: true, awaitHydration: true,
        profile: host.state.focusedSessionProfile.get() })
      conversationView.revisions.set(sid, revision)
    }
    conversationView.error = ''
  } catch (error) {
    conversationView.error = message(error)
  } finally {
    conversationView.busy = false
    publish()
  }
}

function ConversationProgress () {
  useCall()
  const state = conversationView.status
  if (!state && !conversationView.error) return null
  if (state === 'completed' && !conversationView.error) return null
  const active = ['submitted', 'queued', 'running', 'waiting_for_approval', 'waiting_for_user'].includes(state)
  const seconds = conversationView.updatedAt ? Math.max(0, Math.floor((Date.now() - conversationView.updatedAt) / 1000)) : 0
  const age = seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's'
  const label = conversationView.error ? 'Progress connection unavailable'
    : state === 'queued' || state === 'submitted' ? 'Hermes queued'
      : state === 'waiting_for_approval' ? 'Hermes needs approval'
        : state === 'waiting_for_user' ? 'Hermes needs you'
        : active ? 'Hermes working' : 'Hermes · ' + state
  const detail = conversationView.problem || conversationView.activity || (active ? conversationView.progress : '')
  return h('div', { 'data-gemini-work-status': '',
    style: { order: -1, boxSizing: 'border-box', width: 'calc(100% - 10px)', margin: '0 5px 6px', padding: '5px 10px', borderRadius: '8px', border: '1px solid color-mix(in srgb, currentColor 18%, transparent)', background: 'color-mix(in srgb, var(--dt-input) 94%, currentColor 6%)', fontSize: '12px', minWidth: 0 },
    title: detail || 'Real run status from this conversation. Voice can be off.' },
    h('style', null, '[data-slot="composer-dock"] > div:has(> [data-gemini-work-status]){display:contents} @keyframes gemini-work-pulse{50%{opacity:.35}} @media(prefers-reduced-motion:reduce){[data-gemini-work-dot]{animation:none!important}}'),
    h('div', { role: 'status', style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
      h('span', { 'data-gemini-work-dot': '', 'aria-hidden': 'true', style: { width: '7px', height: '7px', flexShrink: 0, borderRadius: '50%', background: conversationView.problem || conversationView.error ? '#d99a35' : active ? '#65a8ed' : '#74ad84', animation: active ? 'gemini-work-pulse 1.5s ease-in-out infinite' : 'none' } }),
      h('strong', { style: { flexShrink: 0, whiteSpace: 'nowrap' } }, label),
      h('span', { 'data-gemini-work-summary': '', style: { flex: 1, minWidth: 0, opacity: .75, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, detail),
      h('span', { style: { flexShrink: 0, marginLeft: 'auto', opacity: .65, fontSize: '11px', whiteSpace: 'nowrap' } }, conversationView.updatedAt ? 'Updated ' + age + ' ago' : '')))
}

async function refreshTasks (rest) {
  if (taskHistory.busy) return
  taskHistory.busy = true
  try {
    const data = await rest('/tasks')
    taskHistory.rows = data.tasks || []
    if (!taskHistory.selected && taskHistory.rows.length) taskHistory.selected = taskHistory.rows[0].run_id
    if (taskHistory.open && taskHistory.selected) {
      const selected = taskHistory.selected
      const detail = await rest('/tasks/' + encodeURIComponent(selected))
      if (taskHistory.selected === selected) taskHistory.detail = detail
    }
    taskHistory.error = ''
  } catch (error) {
    taskHistory.error = message(error)
  } finally {
    taskHistory.busy = false
    publish()
  }
}

function toolCalls (row) {
  try { return typeof row.tool_calls === 'string' ? JSON.parse(row.tool_calls) : (row.tool_calls || []) } catch { return [] }
}

function displayText (value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function TaskHistoryControl ({ rest }) {
  useCall()
  const detail = taskHistory.detail
  const button = h('button', {
    type: 'button', 'aria-label': 'Gemini tasks',
    title: 'Hermes task progress, tool calls and results — works with voice off',
    className: 'rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted',
    onClick: () => { taskHistory.open = true; publish(); void refreshTasks(rest) }
  }, 'Gemini tasks', taskHistory.rows.length ? ` (${taskHistory.rows.length})` : '')
  return h('div', { className: 'inline-flex' }, button,
    h(Dialog, { open: taskHistory.open, onOpenChange: value => { taskHistory.open = value; publish() } },
      h(DialogContent, { style: { width: 'min(1000px, 92vw)', maxWidth: '1000px', maxHeight: '85vh', overflow: 'auto' } },
        h(DialogTitle, null, 'Gemini tasks · Hermes / Hermes'),
        h(DialogDescription, null, 'Voice can be off. Submitted Hermes tasks continue; reopen voice to ask about or steer an existing task.'),
        taskHistory.error && h('p', { role: 'alert' }, 'Task history unavailable: ' + taskHistory.error),
        !taskHistory.rows.length && h('p', null, 'No delegated tasks recorded yet.'),
        h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start' } },
          h('div', { style: { width: '240px', flexShrink: 0 } }, taskHistory.rows.map(row =>
            h('button', { key: row.run_id, type: 'button',
              'aria-pressed': taskHistory.selected === row.run_id,
              className: 'mb-2 block w-full rounded border p-2 text-left text-sm hover:bg-muted',
              onClick: () => { taskHistory.selected = row.run_id; taskHistory.detail = null; publish(); void refreshTasks(rest) }
            }, row.prompt.split('\n')[0], h('small', { className: 'block text-muted-foreground' },
              row.status + ' · ' + new Date(row.created_at * 1000).toLocaleTimeString())))),
          h('div', { style: { flex: 1, minWidth: 0 }, 'aria-label': 'Hermes task transcript' },
            !detail && taskHistory.rows.length ? h('p', null, 'Loading task transcript…') : null,
            detail && h('div', null,
              h('p', { role: 'status' }, 'Status: ' + detail.status + ' · Executing model: ' + (detail.session?.model || 'waiting for model')),
              h('small', { className: 'block text-muted-foreground' }, 'Session: ' + detail.session_id),
              detail.status_detail && h('p', { role: 'alert' }, detail.status_detail),
              detail.transcript_detail && h('p', null, detail.transcript_detail),
              detail.error && h('p', { role: 'alert' }, displayText(detail.error)),
              detail.messages?.map((row, index) => h('div', { key: row.id || index, className: 'my-3 border-b pb-2' },
                h('strong', null, row.role === 'tool' ? 'Tool result · ' + (row.tool_name || '') : row.role === 'user' ? 'Task' : 'Hermes'),
                (row.display_content || row.content) && h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '12px' } }, displayText(row.display_content || row.content)),
                toolCalls(row).map((tool, i) => h('details', { key: i, className: 'my-2' },
                  h('summary', null, 'Tool call · ' + (tool.function?.name || tool.name || 'tool')),
                  h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '12px' } }, displayText(tool.function?.arguments || tool.arguments || {}))))
              )),
              detail.output && h('section', { className: 'mt-3 rounded border p-3' }, h('strong', null, 'Result'),
                h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, displayText(detail.output))),
              detail.pagination?.has_more && h('p', null, 'Showing the latest 500 transcript entries.')
            ))))))
}

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

/** Stream each 24kHz chunk immediately at native pitch; never wait for task completion. */
async function createPlayer () {
  const context = new AudioContext()
  await context.resume()
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
 * (`apps/desktop/src/app/chat/composer/voice-activity.tsx`): the same five-bar meter with
 * weights [0.5, 0.78, 1, 0.78, 0.5], the same mono `m:ss` clock, the same primary-tinted
 * disc. The row itself keeps core's geometry but no fill of its own — it sits on the
 * composer, so a second box inside it reads as a panel rather than as the app's voice lane.
 */
const PILL = 'flex h-8 items-center gap-2 px-1 text-xs text-muted-foreground'
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

/**
 * The call is owned at module scope, not by the component. A `composer.actions` row is
 * remounted whenever the chat route changes — opening a session, switching pane — and a
 * call that dies with its row dies while the user is still talking, so the row only
 * subscribes and renders. Nothing here tears the socket down except Stop, a dropped
 * relay, or a frame that says the call failed.
 */
const call = {
  state: 'idle', detail: '', level: 0, elapsed: 0, speaking: false, pending: [], waiting: [],
  status: null,
  muted: false, providerReady: false, capturePending: false,
  socket: null, player: null, stopCapture: null,
  lastAudio: 0, lastInText: 0, awaitingReply: false, startedAt: 0, taskAt: 0, micPeak: 0,
  tuning: DEFAULT_TUNING, raf: 0, listeners: new Set()
}

function publish () {
  for (const listener of call.listeners) listener()
}

function useCall () {
  const [, rerender] = useState(0)
  useEffect(() => {
    const listener = () => rerender((n) => n + 1)
    call.listeners.add(listener)
    return () => call.listeners.delete(listener)
  }, [])
  return call
}

const message = (error) => (error && error.message ? error.message : String(error))

// One loop drives meter, speaking and the clock for the life of the call — not of the row.
function beginMeter () {
  if (call.raf) return
  const tick = () => {
    const now = Date.now()
    const played = call.player ? call.player.level() : 0
    call.speaking = now - call.lastAudio < 400 || played > 0.02
    call.level = call.speaking ? played : call.micPeak
    call.elapsed = (now - call.startedAt) / 1000
    publish()
    call.raf = window.requestAnimationFrame(tick)
  }
  call.raf = window.requestAnimationFrame(tick)
}

/** Stop everything the call holds. `note` replaces the visible reason; omit it to keep. */
function tearDown (note) {
  if (call.raf) {
    window.cancelAnimationFrame(call.raf)
    call.raf = 0
  }
  const ws = call.socket
  call.socket = null
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'close' }))
    ws.close()
  }
  if (call.stopCapture) {
    call.stopCapture()
    call.stopCapture = null
  }
  call.player?.flush()
  call.state = 'idle'
  call.providerReady = false
  call.capturePending = false
  call.level = 0
  call.speaking = false
  call.pending = []
  call.waiting = []
  call.lastAudio = 0
  call.lastInText = 0
  call.micPeak = 0
  call.taskAt = 0
  call.muted = false
  if (note !== undefined) call.detail = note
  publish()
}

function toggleMute () {
  call.muted = !call.muted
  publish()
}

async function loadStatus (rest) {
  try {
    call.status = await rest('/status')
  } catch (error) {
    // Keep the backend's own words: "404 Plugin not found" means this home has the
    // plugin disabled, which is a different fix from a missing key.
    call.status = { ok: false, detail: 'backend: ' + message(error) }
  }
  call.tuning = { ...DEFAULT_TUNING, ...((call.status && call.status.audio) || {}) }
  publish()
}

function appendChunk (bytes, peak) {
  // Mute drops the frame at the last step before the socket, so the Live session, its
  // context and any run in flight all stay alive — the model just stops hearing the room.
  // There is no wire-level equivalent: pushToTalk, serverVad and activityEnd all close 1007.
  if (call.muted) return
  call.micPeak = peak
  const tuning = call.tuning
  // Half-duplex: when a loudspeaker beats the canceller, the model's own reply arrives
  // at the mic and Live reads it as a listener interrupting. Muting the uplink while it
  // speaks costs talk-over interruption and buys back a call that actually finishes.
  if (tuning.halfDuplex && Date.now() - call.lastAudio < 600) return
  const ws = call.socket
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'audio', data: toBase64(bytes) }))
}

function receive (event) {
  let frame
  try {
    frame = JSON.parse(event.data)
  } catch {
    return
  }
  if (['ready', 'audio', 'in_text', 'out_text', 'tool_call', 'turn_complete'].includes(frame.type)) call.providerReady = true
  if (frame.type === 'ready') {
    publish()
  } else if (frame.type === 'native_request') {
    // A queued frame from an ended call cannot target a newly focused chat.
    if (event.target !== call.socket) return
    const ws = call.socket
    void nativeCommand(frame).then(result => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'native_response', id: frame.id, result })) })
  } else if (frame.type === 'audio') {
    call.awaitingReply = false
    call.lastAudio = Date.now()
    call.player?.play(fromBase64(frame.data))
  } else if (frame.type === 'speech_started') {
    call.player?.flush()
    call.lastAudio = 0
  } else if (frame.type === 'in_text' && frame.text) {
    // The user's own words are the only honest start of a "thinking" window: an
    // extended-thinking model is silent while it works, and silence alone reads dead.
    call.lastInText = Date.now()
    call.awaitingReply = true
  } else if (frame.type === 'turn_complete') {
    call.awaitingReply = false
  } else if (frame.type === 'task_started') {
    if (!call.taskAt) call.taskAt = Date.now()
    if (!call.pending.includes(frame.id)) call.pending = [...call.pending, frame.id]
    reconcileNativeIndicators()
    publish()
  } else if (frame.type === 'task_done') {
    call.pending = call.pending.filter((id) => id !== frame.id)
    call.waiting = call.waiting.filter((id) => id !== frame.id)
    if (frame.state && frame.state !== 'completed') {
      call.detail = 'Hermes could not finish that task (' + frame.state + ')'
    }
    publish()
  } else if (frame.type === 'task_needs_input') {
    // A run parked on an approval is not "still working" — it is waiting for a human, and
    // the difference is the one thing the user cannot hear while the model is quiet.
    if (!call.waiting.includes(frame.id)) call.waiting = [...call.waiting, frame.id]
    call.detail = frame.question || 'Hermes is asking you something'
    publish()
  } else if (frame.type === 'task_update') {
    if (frame.action === 'stop') {
      call.pending = call.pending.filter((id) => id !== frame.id)
      call.waiting = call.waiting.filter((id) => id !== frame.id)
    } else {
      call.waiting = call.waiting.filter((id) => id !== frame.id)
    }
    publish()
  } else if (frame.type === 'task_failed') {
    call.detail = frame.detail || 'Hermes refused that'
    publish()
  } else if (frame.type === 'lane') {
    tearDown('Hermes is temporarily unavailable: ' + (frame.detail || frame.status) + '. Voice ended; existing tasks continue. Try again shortly.')
  } else if (frame.type === 'go_away') {
    call.detail = 'Gemini is ending this session' +
      (frame.timeLeft ? ' (' + frame.timeLeft + ')' : '') + ' — press Start to go on'
    publish()
  } else if (frame.type === 'error') {
    tearDown(String(frame.detail || 'the voice call failed'))
  }
}

/**
 * The user's own answer to a run parked on an approval. This press is the only thing that
 * can approve one: the voice model has no approve verb, because it also hears the room and
 * reads run output, and neither may unlock a command.
 */
function answerApproval (choice) {
  const id = call.waiting[0]
  const ws = call.socket
  if (!id || !ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'approval', id, choice }))
}

async function start (rest) {
  if (call.state !== 'idle') return
  call.state = 'connecting'
  call.providerReady = false
  call.detail = ''
  call.pending = []
  call.waiting = []
  call.level = 0
  call.speaking = false
  call.lastAudio = 0
  call.lastInText = 0
  call.awaitingReply = false
  call.taskAt = 0
  call.startedAt = Date.now()
  beginMeter()
  publish()
  void loadStatus(rest)
  let url
  try {
    call.player = call.player || await createPlayer()
    call.conversationId = await ensureConversation(rest)
    url = await resolveSiblingWsUrl({}, RELAY_PATH)
    const target = new URL(url)
    target.searchParams.set('conversation_id', call.conversationId)
    target.searchParams.set('native', '1')
    url = target.toString()
  } catch (error) {
    tearDown(message(error))
    return
  }
  const ws = new WebSocket(url)
  call.socket = ws
  ws.onopen = async () => {
    call.state = 'live'
    call.capturePending = true
    publish()
    try {
      const capture = await startCapture(appendChunk, call.tuning)
      if (call.socket !== ws || ws.readyState !== WebSocket.OPEN) { capture(); return }
      call.stopCapture = capture
      publish()
    } catch (error) {
      if (call.socket !== ws) return
      call.detail = 'microphone unavailable: ' + message(error)
    } finally {
      if (call.socket === ws) { call.capturePending = false; publish() }
    }
  }
  ws.onmessage = receive
  ws.onclose = () => {
    // Only the live socket matters: Stop replaces it before its own close arrives. Keep
    // the frame that caused it (goAway, an error) when the server told us one.
    if (call.socket !== ws) return
    tearDown(call.detail || 'the voice call dropped')
  }
  ws.onerror = () => {
    call.detail = 'the relay socket failed'
    publish()
  }
}

function VoiceConnectionBadge () {
  useCall()
  let tone = 'off', label = 'Off', detail = 'Live voice is disconnected'
  if (call.state !== 'idle') {
    tone = 'connecting'; label = 'Connecting'; detail = 'Connecting live voice'
    if (call.state === 'live' && call.providerReady && call.socket?.readyState === WebSocket.OPEN) {
      if (call.capturePending) { tone = 'connecting'; label = 'Starting mic'; detail = 'Preparing the microphone' }
      else if (!call.stopCapture) { tone = 'unavailable'; label = 'Mic unavailable'; detail = 'Voice connected, but the microphone is unavailable' }
      else if (call.muted) { tone = 'muted'; label = 'Muted'; detail = 'Voice connected, microphone muted' }
      else { tone = 'live'; label = 'Live'; detail = 'Voice connected, microphone on' }
    }
  }
  const color = tone === 'live' ? 'light-dark(#166534, #86efac)' : ['muted', 'unavailable'].includes(tone) ? 'light-dark(#92400e, #fcd34d)' : 'var(--muted-foreground, #6b7280)'
  return h('span', { 'data-gemini-voice-connection': '', 'data-tone': tone, role: 'status',
    'aria-label': 'Live voice: ' + detail, title: detail,
    style: { display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0, padding: '2px 5px', borderRadius: '5px', fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap', color, background: 'color-mix(in srgb, currentColor 8%, transparent)' } },
    h('span', { 'aria-hidden': 'true', style: { width: '5px', height: '5px', borderRadius: '50%', background: 'currentColor' } }), label)
}

function TalkControl ({ rest }) {
  useCall()
  const status = call.status
  const blocked = !!(status && !status.ok)

  useEffect(() => {
    if (!status) void loadStatus(rest)
  }, [rest, status])

  if (call.state === 'idle') {
    return h('div', { className: 'inline-flex items-center gap-1' }, h('button', {
      type: 'button',
      title: call.detail || (blocked && status ? status.detail : 'Start a Gemini Live call'),
      'aria-label': 'Start Gemini Live call',
      disabled: blocked,
      onClick: () => void start(rest),
      className: 'inline-flex size-7 shrink-0 items-center justify-center rounded-full ' +
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50'
    }, h(icons.Mic, { className: icons.iconSize.sm })), h(VoiceConnectionBadge))
  }

  // A Hermes run takes tens of seconds and an extended-thinking model goes silent while
  // it works, so neither gap may look like a frozen app. Each gets its own label, clock
  // and disc, all built from chrome the app already uses: a spinning Loader2 to mean
  // "not idle", and the meter's own pulse (core's `animate-pulse opacity-45`) to mean
  // "alive, nothing coming out".
  const now = Date.now()
  const pending = call.pending
  const working = pending.length > 0
  // A task parked on an approval is still "working" by the count, but saying so hides the
  // one thing the user can act on — so the ask wins the label.
  const waiting = call.waiting.length > 0
  const thinking = call.state === 'live' && !working && !call.speaking &&
    call.awaitingReply
  const busy = working || thinking || call.state === 'connecting'
  const counted = working ? call.taskAt : (thinking ? call.lastInText : call.startedAt)
  const shownSeconds = working || thinking ? (now - counted) / 1000 : call.elapsed
  const label = call.state === 'connecting' ? 'Connecting'
    : waiting ? (call.waiting.length > 1 ? `Hermes needs you · ${call.waiting.length} tasks`
      : 'Hermes needs you')
      : working ? (pending.length > 1 ? `Hermes is working · ${pending.length} tasks` : 'Hermes is working')
        : thinking ? 'Thinking'
          : call.speaking ? 'Speaking'
            : call.muted ? 'Muted'
              : call.detail || 'Listening'

  return h('div', { 'aria-live': 'polite', role: 'status', className: PILL },
    h('div', { className: DISC },
      busy
        ? h(icons.Loader2, { className: ['animate-spin', icons.iconSize.xs].join(' ') })
        : h(call.muted ? icons.MicOff : (call.speaking ? icons.Volume2 : icons.Mic),
          { className: icons.iconSize.xs })),
    h('div', { className: 'flex min-w-0 flex-1 items-center gap-2' },
      h('span', { className: 'truncate font-medium text-foreground/85' }, label),
      h('span', { 'aria-hidden': 'true', className: 'font-mono text-[0.6875rem] text-muted-foreground/85' },
        formatElapsed(shownSeconds))),
    h(VoiceLevelBars, { active: !thinking, level: call.level }),
    waiting && h('button', {
      type: 'button',
      'aria-label': 'Approve what Hermes is asking, once',
      title: call.detail || 'Approve once',
      onClick: () => answerApproval('approve'),
      className: 'inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[0.6875rem] ' +
        'bg-muted text-foreground transition-colors hover:bg-muted/70'
    }, 'Approve'),
    waiting && h('button', {
      type: 'button',
      'aria-label': 'Deny what Hermes is asking',
      title: call.detail || 'Deny',
      onClick: () => answerApproval('deny'),
      className: 'inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[0.6875rem] ' +
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
    }, 'Deny'),
    h(VoiceConnectionBadge),
    h('button', {
      type: 'button',
      'aria-label': call.muted ? 'Unmute the microphone' : 'Mute the microphone',
      'aria-pressed': call.muted,
      title: call.muted
        ? 'The model still hears nothing; tasks it started keep running'
        : 'Stop hearing the room without hanging up',
      onClick: toggleMute,
      className: 'inline-flex size-6 shrink-0 items-center justify-center rounded-full ' +
        (call.muted ? 'bg-muted text-foreground' : 'text-muted-foreground') +
        ' transition-colors hover:bg-muted hover:text-foreground'
    }, h(call.muted ? icons.MicOff : icons.Mic, { className: icons.iconSize.xs })),
    h('button', {
      type: 'button',
      'aria-label': 'Stop Gemini Live call',
      title: 'End paid voice connection; Hermes tasks keep working',
      onClick: () => tearDown(),
      className: 'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[0.6875rem] ' +
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
    }, h(icons.VolumeX, { className: icons.iconSize.xs }), 'End voice'))
}

export default {
  id: 'hermes-gemini-live',
  name: 'Gemini Live',
  defaultEnabled: true,
  register (ctx) {
    if (host.onEvent) ctx.onDispose(host.onEvent('*', nativeEvent))
    void refreshConversation(ctx.rest)
    ctx.setInterval(() => void refreshConversation(ctx.rest), 3000)
    ctx.onDispose(() => tearDown())
    const unsubscribe = host.state.focusedStoredSessionId.listen(sid => {
      // Focus changes can arrive before the runtime/owner atoms update. A matching
      // runtime is not proof of compaction: never alias or move a voice call here.
      // End audio on every visible chat change; the native model turn stays alive.
      if (call.state !== 'idle' && call.conversationId && sid !== call.conversationId) {
        tearDown('Conversation changed. Voice ended; coding tasks continue.')
      }
      conversationView.status = ''; conversationView.activity = ''; conversationView.progress = ''; conversationView.problem = ''; conversationView.error = ''
      publish()
      void refreshConversation(ctx.rest)
    })
    ctx.onDispose(unsubscribe)
    ctx.register({ id: 'progress', area: 'composer.underside', order: 39,
      render: () => h(ConversationProgress) })
    ctx.register({
      id: 'talk',
      area: 'composer.actions',
      order: 40,
      render: () => h(TalkControl, { rest: ctx.rest })
    })
  }
}
