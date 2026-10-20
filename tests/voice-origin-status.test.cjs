const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict')
const source=fs.readFileSync(require('node:path').join(__dirname,'../desktop/plugin.js'),'utf8').replace(/^import .*$/gm,'').replace('export default {','globalThis.plugin = {')
const atom={get:()=> 'chat',listen:()=>()=>{}}
const c=vm.createContext({console,Date,JSON,Map,Promise,setTimeout,clearTimeout,WebSocket:{OPEN:1},
 localStorage:{getItem:()=>null,setItem(){}},
 host:{state:{focusedStoredSessionId:atom,focusedSessionProfile:atom,focusedSessionOwner:{get:()=>({connectionId:'local',profile:'default'})},busy:{get:()=>false}}},
 h:(type,props,...children)=>({type,props,children}),useEffect(){},useState:v=>[v,()=>{}],icons:{iconSize:{xs:'',sm:''}}})
vm.runInContext(source,c)
const text='Preserve 19 rows, all videos, and the exact URL.'
c.text=text
const tagged=vm.runInContext('voiceRequestText(text)',c)
assert.equal(tagged,'`Voice request`\n\n'+text)
c.text=tagged
assert.equal(vm.runInContext('voiceRequestText(text)',c),tagged,'retries cannot duplicate the source label')
function badge(){return vm.runInContext('VoiceConnectionBadge()',c)}
assert.equal(badge().props['data-tone'],'off')
vm.runInContext(`call.state='live';call.socket={readyState:1};call.stopCapture=()=>{};call.providerReady=false`,c)
assert.equal(badge().props['data-tone'],'connecting','open local socket alone is not a ready provider')
vm.runInContext(`receive({data:JSON.stringify({type:'ready'})})`,c)
assert.equal(badge().props['data-tone'],'live')
vm.runInContext('call.muted=true',c)
assert.equal(badge().props['data-tone'],'muted')
vm.runInContext('call.muted=false;call.stopCapture=null',c)
vm.runInContext('call.capturePending=true',c)
assert.equal(badge().props['data-tone'],'connecting','microphone setup is not a microphone failure')
vm.runInContext('call.capturePending=false',c)
assert.equal(badge().props['data-tone'],'unavailable','a missing microphone must not show green Live')
vm.runInContext('call.state="idle";conversationView.status="completed"',c)
assert.equal(badge().props['data-tone'],'off')
assert.equal(vm.runInContext('ConversationProgress()',c),null,'completion removes the working strip')
vm.runInContext('conversationView.status="running"',c)
assert.ok(vm.runInContext('ConversationProgress()',c))
vm.runInContext('conversationView.status="waiting_for_approval"',c)
assert.ok(vm.runInContext('ConversationProgress()',c),'waiting work stays visible')
vm.runInContext('conversationView.status="failed"',c)
assert.ok(vm.runInContext('ConversationProgress()',c),'a failure must remain visible')
console.log('PASS durable source tag, provider/mic/mute/off distinction, completed-strip hiding and actionable states')
