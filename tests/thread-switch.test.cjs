const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict')
const source = fs.readFileSync(require('node:path').join(__dirname, '../desktop/plugin.js'), 'utf8').replace(/^import .*$/gm, '').replace('export default {', 'globalThis.plugin = {')
let sid = 'original', listener, closed = 0, released = 0, requests = 0
const owner = { connectionId: 'local', profile: 'default' }
const atom = get => ({ get, listen: fn => { listener = fn; return () => {} } })
const c = vm.createContext({ console, Date, JSON, Map, Promise, setTimeout, clearTimeout, cancelAnimationFrame() {},
  localStorage: { getItem: () => null, setItem() {} }, WebSocket: { OPEN: 1 },
  h() {}, useEffect() {}, useState: v => [v, () => {}], icons: {},
  host: { state: { focusedStoredSessionId: atom(() => sid), focusedSessionId: { get: () => 'reused-runtime' }, focusedSessionOwner: { get: () => owner }, busy: { get: () => true } }, requestProfile() { requests++; }, onEvent: () => () => {} }
})
vm.runInContext(source, c)
c.ctx = { rest: async () => ({ tasks: [] }), setInterval() {}, onDispose() {}, register() {} }
vm.runInContext(`plugin.register(ctx); nativeReceipts.push({id:'work',sid:'original',runtime:'reused-runtime',owner:{connectionId:'local',profile:'default'},status:'running'});call.state='live';call.conversationId='original';call.socket={readyState:1,send(){},close(){closed()}};call.stopCapture=()=>released()`, Object.assign(c, { closed: () => closed++, released: () => released++ }))
// Focus can change before the runtime atom updates. Matching that stale runtime
// is not evidence that a new visible chat is a compaction continuation.
sid = 'different-chat'; listener(sid)
assert.equal(vm.runInContext('call.state', c), 'idle', 'switching chats must end voice even while runtime still matches')
assert.equal(closed, 1); assert.equal(released, 1)
assert.equal(requests, 0, 'ending voice must not cancel or steer model work')
assert.equal(vm.runInContext('nativeReceipts[0].status', c), 'running')
assert.equal(vm.runInContext('nativeReceipts[0].aliases?.includes("different-chat") || false', c), false, 'navigation must not make another chat an alias')
console.log('PASS thread switch closes voice and microphone, preserves work, never aliases an unrelated chat')

