import {inspectMidi} from './timed.mjs';
const token=location.hash.slice(1),toolbar=document.querySelector('#toolbar'),page=document.querySelector('#page'),status=document.querySelector('#status'),controller=new AbortController();
let payload,context,synth,sequencer,analyser,gain,frame,stopped=false,opening;
const send=(type,data={})=>parent.postMessage({token,type,...data},'*');
const button=(label,action)=>{const node=document.createElement('button');node.type='button';node.textContent=label;node.addEventListener('click',()=>Promise.resolve(action()).catch(fail));toolbar.append(node);return node;};
const play=button('Play',async()=>{if(!payload)return;if(sequencer&&!sequencer.paused){sequencer.pause();play.textContent='Play';cancelAnimationFrame(frame);tick();return;}await initialize();controller.signal.throwIfAborted();await context.resume();sequencer.play();play.textContent='Pause';tick();});
const seek=document.createElement('input');seek.type='range';seek.min='0';seek.max='1';seek.step='.01';seek.value='0';seek.disabled=true;seek.setAttribute('aria-label','MIDI position');toolbar.append(seek);
const clock=document.createElement('span');clock.textContent='Not playing';toolbar.append(clock);
const volume=document.createElement('input');volume.type='range';volume.min='0';volume.max='1';volume.step='.01';volume.value='.5';volume.setAttribute('aria-label','MIDI volume');toolbar.append(volume);volume.addEventListener('input',()=>{if(gain)gain.gain.value=Number(volume.value);});
const details=document.createElement('details'),summary=document.createElement('summary'),info=document.createElement('p'),meter=document.createElement('meter');summary.textContent='MIDI inspector';meter.min=0;meter.max=1;meter.value=0;meter.setAttribute('aria-label','MIDI signal level');details.append(summary,info,meter);page.append(details);
function fail(error){if(controller.signal.aborted)return;status.textContent=error.message||'MIDI playback is unavailable';play.disabled=false;play.textContent='Play';send('error',{message:status.textContent});}
function stop(){stopped=true;controller.abort();cancelAnimationFrame(frame);sequencer?.pause();synth?.destroy();if(context&&context.state!=='closed')void context.close().catch(()=>{});play.textContent='Play';play.disabled=true;meter.value=0;}
async function initialize(){
  if(sequencer)return;if(opening)return opening;
  opening=(async()=>{
    status.textContent='Loading bundled synthesizer and sound bank…';play.disabled=true;
    context=new AudioContext({sampleRate:48000});await context.resume();controller.signal.throwIfAborted();
    const {WorkletSynthesizer,Sequencer}=await import('faber-preview://viewer/music/spessasynth_lib.js');
    await context.audioWorklet.addModule('faber-preview://viewer/music/spessasynth_processor.min.js');controller.signal.throwIfAborted();
    synth=new WorkletSynthesizer(context,{decodedSampleBudget:128*1024*1024});synth.setSystemParameter('voiceCap',128);analyser=context.createAnalyser();gain=context.createGain();gain.gain.value=Number(volume.value);synth.connect(analyser);analyser.connect(gain);gain.connect(context.destination);
    const bank=await fetch('faber-preview://viewer/music/FluidR3Mono_GM.sf3',{signal:controller.signal});if(!bank.ok||Number(bank.headers.get('content-length'))!==14563174)throw new Error('Bundled sound bank is unavailable');
    await synth.soundBankManager.addSoundBank(await bank.arrayBuffer(),'main');controller.signal.throwIfAborted();
    sequencer=new Sequencer(synth);sequencer.loopCount=0;sequencer.skipToFirstNoteOn=false;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('MIDI decoding exceeded 15 seconds')),15000);sequencer.eventHandler.addEvent('songChange','faber-ready',()=>{clearTimeout(timer);resolve();});sequencer.loadNewSongList([{binary:payload.bytes.slice(0),fileName:payload.ref.name}]);});
    controller.signal.throwIfAborted();if(!Number.isFinite(sequencer.duration)||sequencer.duration<=0||sequencer.duration>4*3600)throw new Error('MIDI duration exceeds the four-hour playback limit');
    seek.max=String(sequencer.duration);seek.disabled=false;status.textContent='';play.disabled=false;
  })();
  try{await opening;}catch(error){sequencer=undefined;synth?.destroy();if(context&&context.state!=='closed')void context.close().catch(()=>{});opening=undefined;throw error;}
}
function tick(){
  cancelAnimationFrame(frame);if(stopped||!sequencer)return;const time=Math.max(0,sequencer.currentHighResolutionTime),duration=sequencer.duration;seek.value=String(time);clock.textContent=`${time.toFixed(1)} / ${duration.toFixed(1)} s`;page.dataset.playbackTime=String(time);const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);meter.value=values.reduce((peak,value)=>Math.max(peak,Math.abs(value)),0);send('playback',{time,duration,playing:!sequencer.paused});
  if(!sequencer.paused&&!sequencer.isFinished)frame=requestAnimationFrame(tick);else{play.textContent='Play';meter.value=0;}
}
seek.addEventListener('input',()=>{if(sequencer){sequencer.currentTime=Number(seek.value);tick();}});
addEventListener('message',event=>{if(event.source!==parent||event.data?.token!==token)return;const value=event.data;if(value.type==='open'&&!payload){try{const metadata=inspectMidi(value.bytes);payload=value;info.textContent=`Format ${metadata.format}; ${metadata.tracks} tracks; ${metadata.events} events; ${metadata.division} ticks per quarter. SpessaSynth 4.4.7; FluidR3Mono GM 2.312. Sound bank loads on Play. Original MIDI is preserved.`;status.textContent='Ready. Choose Play to synthesize this MIDI.';send('loaded',{pages:1,frames:1,bridgeAbsent:typeof window.faber==='undefined'});send('state',{page:1,pages:1,zoom:1});}catch(error){fail(error);}}if(value.type==='stop')stop();if(value.type==='seek'&&sequencer&&Number.isFinite(value.time)&&value.time>=0&&value.time<=sequencer.duration){sequencer.currentTime=value.time;tick();}});
addEventListener('pagehide',stop);send('ready');
