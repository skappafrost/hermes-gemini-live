const {readFileSync}=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict')
const source=readFileSync(require('node:path').join(__dirname,'../desktop/plugin.js'),'utf8').replace(/^import .*$/gm,'').replace('export default {','globalThis.plugin = {')
const contributions=[]
const atom={get:()=> 'chat_a',listen:()=>()=>{}}
const c=vm.createContext({console,Date,setTimeout,clearTimeout,
 host:{state:{focusedStoredSessionId:atom,focusedSessionProfile:atom,busy:{get:()=>false}}},
 h:(type,props,...children)=>({type,props,children}),useEffect(){},useState:v=>[v,()=>{}],icons:{}})
vm.runInContext(source,c)
const rows=[{id:1,role:'assistant',content:'I am checking the Android screen before editing it.',reasoning_content:'PRIVATE REASONING',tool_calls:[{id:'t1',function:{name:'read_file',arguments:JSON.stringify({path:'C:/project/ExampleScreen.kt'})}}]}]
c.rows=rows
const a=vm.runInContext('describeActivity(rows)',c)
assert.equal(a.description,'Reading ExampleScreen.kt')
assert.equal(a.progress,rows[0].content)
assert.ok(!JSON.stringify(a).includes('PRIVATE REASONING'))
c.rows=[...rows,{id:2,role:'tool',tool_call_id:'t1',tool_name:'read_file',content:'{"content":"file body"}'}]
assert.equal(vm.runInContext('describeActivity(rows).pendingTool',c),false)
c.rows=[{id:3,role:'assistant',tool_calls:[{id:'t2',function:{name:'write_file',arguments:'{"path":"ExampleScreen.kt"}'}}]},{id:4,role:'tool',tool_call_id:'t2',content:'{"error":"Refusing to overwrite: partial view","stale_write_blocked":true}'}]
assert.ok(vm.runInContext('describeActivity(rows).problem',c).includes('full current file'))
vm.runInContext("conversationView.status='running'; conversationView.activity='Reading ExampleScreen.kt';conversationView.progress='Checking the approved design';conversationView.updatedAt=Date.now();",c)
const view=vm.runInContext('ConversationProgress()',c)
assert.equal(view.props['data-gemini-work-status'],'')
assert.equal(view.props.style.order,-1)
assert.ok(JSON.stringify(view).includes('Reading ExampleScreen.kt'))
c.ctx={rest:async()=>({tasks:[]}),setInterval(){},onDispose(){},register:x=>contributions.push(x)}
vm.runInContext('plugin.register(ctx)',c)
assert.equal(contributions.find(x=>x.id==='progress').area,'composer.underside')
assert.equal(contributions.find(x=>x.id==='talk').area,'composer.actions')
console.log('PASS visible activity, truthful tool status, write blocker, above-input placement and unchanged microphone slot')
