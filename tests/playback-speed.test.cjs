const {readFileSync}=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict')
const source=readFileSync(require('node:path').join(__dirname,'../desktop/plugin.js'),'utf8').replace(/^import .*$/gm,'').replace('export default {','globalThis.plugin = {')
const nodes=[]
class C {
 constructor(){this.currentTime=10;this.destination={}}
 resume(){return Promise.resolve()}
 createGain(){return {connect(){}}}
 createMediaElementSource(){return {connect(){},disconnect(){}}}
 createAnalyser(){return {connect(){},getByteFrequencyData(){},frequencyBinCount:256}}
 createBuffer(ch,n,rate){return {duration:n/rate,getChannelData:()=>new Float32Array(n)}}
 createBufferSource(){var n={playbackRate:{value:1},connect(){},start(t){this.at=t},stop(){this.stopped=true}};nodes.push(n);return n}
 close(){return Promise.resolve()}
}
const c=vm.createContext({console,AudioContext:C,Audio:class{play(){return Promise.resolve()}},h(){},useEffect(){},useState(){},host:{},icons:{},setTimeout,clearTimeout})
vm.runInContext(source,c)
;(async()=>{
 const p=await vm.runInContext('createPlayer()',c)
 p.play(new Uint8Array(4800))
 assert.equal(nodes.length,1,'play the FIRST 100ms chunk immediately without waiting for turn_complete')
 assert.equal(nodes[0].playbackRate.value,1,'natural voice pitch')
 p.play(new Uint8Array(4800))
 assert.ok(Math.abs(nodes[1].at-nodes[0].at-0.1)<0.0001,'stream chunks sequentially, without overlap')
 p.flush();assert.ok(nodes.every(n=>n.stopped),'interrupt queued audio immediately')
 p.close()
 console.log('PASS immediate streaming, native pitch, sequential timing and interruption')
})().catch(e=>{console.error(e);process.exitCode=1})
