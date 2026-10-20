const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../desktop/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default {', 'globalThis.plugin = {')
const context = vm.createContext({ console, setTimeout, clearTimeout, Date,
  window: { cancelAnimationFrame () {} },
  h: (type, props, ...children) => ({ type, props, children }),
  useEffect () {}, useState: x => [x, () => {}],
  Dialog: 'dialog', DialogContent: 'content', DialogTitle: 'title', DialogDescription: 'description',
  icons: { iconSize: {} }, WebSocket: { OPEN: 1 }
  ,host: {state:{focusedStoredSessionId:{get:()=> 'chat_a'}, focusedSessionProfile:{get:()=> 'default'},
    busy:{get:()=>false}},openSession:async(sid,options)=>{context.opened={sid,options}}}
})
vm.runInContext(source, context)
;(async () => {
  await vm.runInContext(`refreshTasks(async path => path === '/tasks'
    ? { tasks: [{run_id:'run_test',prompt:'Write code',status:'running'}] }
    : {run_id:'run_test',status:'completed',session:{model:'deepseek-v4.1-flash'},messages:[]})`, context)
  assert.equal(vm.runInContext('taskHistory.rows[0].run_id', context), 'run_test')
  vm.runInContext('tearDown()', context)
  assert.equal(vm.runInContext('taskHistory.rows[0].run_id', context), 'run_test')
  assert.equal(vm.runInContext('taskHistory.rows[0].status', context), 'running')
  vm.runInContext('taskHistory.open=true; taskHistory.selected="run_test"', context)
  await vm.runInContext(`refreshTasks(async path => path === '/tasks'
    ? { tasks: [{run_id:'run_test',status:'completed'}] }
    : {run_id:'run_test',status:'completed',session:{model:'deepseek-v4.1-flash'},messages:[]})`, context)
  assert.equal(vm.runInContext('taskHistory.detail.session.model', context), 'deepseek-v4.1-flash')
  vm.runInContext(`call.state='live'; receive({data:JSON.stringify({type:'lane',status:'absent',detail:'ReadTimeout'})})`, context)
  assert.equal(vm.runInContext('call.state', context), 'idle', 'unavailable Hermes must close paid voice')
  await vm.runInContext(`refreshConversation(async path=>path.startsWith('/tasks?')
    ? {tasks:[{run_id:'run_same',conversation_id:'chat_a',status:'completed'}]}
    : {status:'completed',messages:[{id:7,role:'assistant',content:'Done'}]})`, context)
  assert.equal(context.opened.sid,'chat_a')
  assert.equal(context.opened.options.refreshInPlace,true)
  vm.runInContext(`call.state='live'; call.pending=[]; call.speaking=false;
    receive({data:JSON.stringify({type:'in_text',text:'What is happening?'})});
    call.lastInText=Date.now()-60000`, context)
  const waitingView=vm.runInContext('TalkControl({rest:()=>{}})',context)
  assert.ok(JSON.stringify(waitingView).includes('Thinking'),'long voice waits must not falsely show Listening')
  vm.runInContext(`receive({data:JSON.stringify({type:'turn_complete'})})`,context)
  const completeView=vm.runInContext('TalkControl({rest:()=>{}})',context)
  assert.ok(!JSON.stringify(completeView).includes('Thinking'),'completed turns clear waiting state')
  console.log('PASS task history, refresh and honest voice waiting state')
})().catch(e => { console.error(e); process.exitCode = 1 })
