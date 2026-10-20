const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict')
const source=fs.readFileSync(require('node:path').join(__dirname,'../desktop/plugin.js'),'utf8').replace(/^import .*$/gm,'').replace('export default {','globalThis.plugin = {')
const storage=new Map(),events=new Set();let submits=0,steers=0,sid='chat',busy=false
const atom=get=>({get,listen:()=>()=>{}})
const host={state:{focusedStoredSessionId:atom(()=>sid),focusedSessionId:atom(()=> 'runtime'),focusedSessionProfile:atom(()=> 'default'),focusedSessionOwner:atom(()=>({connectionId:'local',profile:'default'})),busy:atom(()=>busy)},
 composer:{submit:(s,text)=>{submits++;setTimeout(()=>events.forEach(f=>f({type:'message.start',session_id:'runtime',profile:'default',connectionId:'local'})),0);return true}},
 profileRoutes:async()=>[{connectionId:'local',profile:'default',targetProfile:'default'}],
 requestProfile:async(o,m,p)=>{assert.equal(o.targetProfile,'default');steers++;return {status:'queued'}},onEvent:(type,fn)=>{events.add(fn);return()=>events.delete(fn);}}
const c=vm.createContext({console,Date,JSON,Map,Promise,setTimeout,clearTimeout,host,WebSocket:{OPEN:1},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
 h(){},useEffect(){},useState:v=>[v,()=>{}],icons:{}})
vm.runInContext(source,c)
c.ctx={rest:async()=>({tasks:[]}),setInterval(){},onDispose(){},register(){}}
vm.runInContext('plugin.register(ctx)',c)
;(async()=>{
 const run=(id,action,text)=>{c.command={id,action,payload:{text}};return vm.runInContext('nativeCommand(command)',c)}
 let r=await run('first','submit','Full request with 19 exact details')
 assert.equal(r.status,'running');assert.equal(submits,1)
 assert.equal((await run('first','submit','Full request with 19 exact details')).task_id,r.task_id)
 assert.equal(submits,1)
 busy=true
 assert.equal((await run('second','submit','Additional correction')).task_id,r.task_id)
 assert.equal(steers,1);assert.equal(submits,1)
 assert.equal((await run('third','board','')).tasks.length,1)
 sid='other';c.command={id:'wrong',action:'steer',payload:{task_id:r.task_id,text:'wrong chat'}}
 assert.equal((await vm.runInContext('nativeCommand(command)',c)).status,'rejected')
 assert.equal((await run('first','submit','Old delivery in another chat')).status,'rejected')
 assert.equal(steers,1)
 sid='chat'
 c.ev={type:'tool.start',session_id:'runtime',profile:'default',connectionId:'local',seq:3,payload:{name:'terminal',tool_id:'tool1'}}
 events.forEach(fn=>fn(c.ev))
 assert.ok(JSON.parse(storage.get('hermes-gemini-native-v1'))[0].toolIds?.includes('tool1'),'permanent event subscription must survive acknowledgment cleanup')
 c.ev={type:'message.interim',session_id:'runtime',profile:'default',connectionId:'local',seq:4,payload:{text:'The file was checked; now validating.'}}
 vm.runInContext('nativeEvent(ev)',c)
 assert.ok(JSON.parse(storage.get('hermes-gemini-native-v1')).some(r=>r.progress==='The file was checked; now validating.'))
 c.ev={type:'tool.complete',session_id:'runtime',profile:'default',connectionId:'local',seq:5,payload:{name:'terminal',tool_id:'tool1',result:'ok'}}
 vm.runInContext('nativeEvent(ev)',c)
 c.ev={type:'message.complete',session_id:'runtime',profile:'default',connectionId:'local',seq:6,payload:{status:'complete',text:'Verified final result'}}
 vm.runInContext('nativeEvent(ev)',c)
 let board=await run('fourth','board','')
 assert.equal(board.tasks[0].status,'completed');assert.equal(board.tasks[0].output,'Verified final result')
 assert.equal(submits,1)
 console.log('PASS native acceptance, duplicate protection, same-task steering, reconnect board, owner isolation')
})().catch(e=>{console.error(e);process.exitCode=1})
