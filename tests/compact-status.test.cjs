const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict')
const source=fs.readFileSync(require('node:path').join(__dirname,'../desktop/plugin.js'),'utf8').replace(/^import .*$/gm,'').replace('export default {','globalThis.plugin = {')
const atom={get:()=> 'chat',listen:()=>()=>{}}
const c=vm.createContext({console,Date,JSON,Map,Promise,setTimeout,clearTimeout,WebSocket:{OPEN:1},
 localStorage:{getItem:()=>null,setItem(){}},
 host:{state:{focusedStoredSessionId:atom,focusedSessionProfile:atom,focusedSessionOwner:{get:()=>({connectionId:'local',profile:'default'})},busy:{get:()=>false}}},
 h:(type,props,...children)=>({type,props,children}),useEffect(){},useState:v=>[v,()=>{}],icons:{iconSize:{xs:'',sm:''}}})
vm.runInContext(source,c)
vm.runInContext(`nativeReceipts = ['completed','failed','interrupted','running','waiting_for_approval','uncertain'].map((status,i)=>({id:'t'+i,sid:'chat',owner:{connectionId:'local',profile:'default'},runtime:'r'+i,status}));
 call.pending=['t0','t1','t2','t3','t4','t5','legacy'];call.waiting=['t1','t4'];nativeView(nativeReceipts[0]);`,c)
assert.deepEqual(Array.from(vm.runInContext('call.pending',c)),['t3','t4','t5','legacy'],'only positively terminal native receipts retire')
assert.deepEqual(Array.from(vm.runInContext('call.waiting',c)),['t4'])
vm.runInContext(`nativeEvent({type:'message.complete',session_id:'r3',profile:'default',connectionId:'local',payload:{status:'complete',text:'Finished'}})`,c)
assert.ok(!vm.runInContext('call.pending.includes("t3")',c),'native completion clears voice badge immediately')
vm.runInContext(`receive({data:JSON.stringify({type:'task_started',id:'t0'})})`,c)
assert.ok(!vm.runInContext('call.pending.includes("t0")',c),'late or replayed acknowledgments cannot resurrect completed work')
vm.runInContext(`conversationView.status='running';conversationView.activity='terminal · result received';conversationView.progress='LONG DUPLICATED ANSWER SHOULD STAY IN CHAT';conversationView.updatedAt=Date.now();`,c)
const view=vm.runInContext('ConversationProgress()',c)
assert.ok(!JSON.stringify(view).includes('LONG DUPLICATED ANSWER'),'do not repeat the answer below the chat')
function find(n,p){if(!n||typeof n!=='object')return; if(p(n))return n;for(const k of n.children||[]){const x=find(k,p);if(x)return x}}
const summary=find(view,n=>n.props?.['data-gemini-work-summary']==='')
assert.equal(summary.props.style.whiteSpace,'nowrap')
assert.equal(summary.props.style.textOverflow,'ellipsis')
assert.equal(summary.props.style.overflow,'hidden')
vm.runInContext(`call.state='live';call.status={ok:true};call.pending=['t0','t1','t2'];call.waiting=[];nativeView(nativeReceipts[0]);`,c)
const control=vm.runInContext('TalkControl({rest:async()=>({ok:true})})',c)
assert.ok(JSON.stringify(control).includes('Listening'),'a live call with finished tasks returns to listening')
assert.ok(!JSON.stringify(control).includes('3 tasks'))
console.log('PASS compact one-line activity, terminal-count reconciliation, conservative waiting/unknown handling and late-ack protection')
