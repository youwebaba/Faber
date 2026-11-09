import {createHash} from 'node:crypto';
import {dueOccurrences,overlapDecision,resolveLocalTime} from './scheduling.mjs';
import {scanStableFiles} from './file-triggers.mjs';

const stamp=value=>new Date(value).toISOString(),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createRoutineScheduler({state,save,enqueue,scope,clock=Date.now,signal,onError=error=>console.error('Routine scheduler failed:',error)}){
  state.scheduler??={cursors:{},receipts:[],notices:[]};
  if(!state.scheduler.cursors||!Array.isArray(state.scheduler.receipts)||!Array.isArray(state.scheduler.notices))throw new Error('Invalid scheduler journal');
  const handled=new Set(state.scheduler.receipts.map(receipt=>receipt.key)),observations=new Map();
  let polling=false,closed=false,timer,lastSaved=0,pollDone=Promise.resolve();
  function notice(routine,key,reason,source,status='needs_attention'){if(state.scheduler.notices.some(value=>value.key===key))return;state.scheduler.notices.push({id:hash([routine.id,key]),key,routineId:routine.id,routineName:routine.definition.name,status,reason,source,createdAt:stamp(clock())});}
  function outputs(routine,relative){
    const paths=state.jobs.filter(job=>job.routineId===routine.id).flatMap(job=>[...(job.outputs||[]).map(output=>output.result?.path),...state.runs.filter(run=>run.jobId===job.id).flatMap(run=>(run.toolEvents||[]).filter(event=>event.name==='files_write'&&event.intent?.phase!=='not_executed').map(event=>event.args?.path)),job.report?.path]).filter(value=>typeof value==='string').map(value=>value.replaceAll('\\','/').replace(/^\.\//,''));
    return paths.includes(relative);
  }
  function admit(routine,key,source,now){
    if(handled.has(key))return false;
    if(state.workerQueue.paused||!routine.enabled||routine.revokedAt)return false;
    const decision=overlapDecision(routine.definition.schedule?.overlap||routine.definition.fileOverlap||'coalesce',state.jobs,routine.id);
    let job;
    if(decision.action==='enqueue')job=enqueue(routine,{inputs:'',preview:false,trigger:source});
    else if(decision.action==='coalesce'){job=state.jobs.find(job=>job.id===decision.jobId);(job.triggers??=[]).push(source);}
    const receipt={key,routineId:routine.id,revision:routine.revision,status:decision.action==='skip'?'skipped_overlap':decision.action,source,at:stamp(now),...(job?{jobId:job.id}:{})};state.scheduler.receipts.push(receipt);handled.add(key);return true;
  }
  async function poll(now=clock()){
    if(closed||polling||state.workerQueue.paused)return {polled:false};
    if(!Number.isSafeInteger(now))throw new Error('Invalid scheduler time');polling=true;let finishPoll;pollDone=new Promise(resolve=>finishPoll=resolve);let changed=false,touched=false;
    try{
      for(const routine of state.routines){
        signal?.throwIfAborted();if(!routine.enabled||routine.revokedAt)continue;
        const definition=routine.definition;if(!definition.schedule&&!definition.fileTrigger)continue;touched=true;const configuration=hash([definition.schedule,definition.fileTrigger]),previous=state.scheduler.cursors[routine.id];
        let cursor=previous;
        if(!cursor||cursor.configuration!==configuration){
          let start=Date.parse(routine.updatedAt||routine.revisions?.at(-1)?.createdAt||routine.createdAt);
          if(definition.schedule?.kind==='once'){
            const values=resolveLocalTime(definition.schedule.date,definition.schedule.time,definition.schedule.timeZone,definition.schedule);if(values.length)start=Math.min(start,Date.parse(values[0].dueAt)-1);
          }
          cursor=state.scheduler.cursors[routine.id]={configuration,at:stamp(start)};observations.delete(routine.id);changed=true;
        }
        if(definition.schedule){
          const result=dueOccurrences(definition.schedule,cursor.at,now);
          if(result.clockMovedBack){notice(routine,`clock:${cursor.at}`,'The clock moved backwards; the saved cursor prevents duplicate occurrences',{kind:'clock',at:cursor.at});changed=true;continue;}
          for(const occurrence of result.occurrences)changed=admit(routine,`${routine.id}:time:${occurrence.key}`,{kind:'schedule',...occurrence,timeZone:definition.schedule.timeZone},now)||changed;
          if(result.truncated||result.skipped){const key=`${routine.id}:missed:${cursor.at}:${result.cursor}`;notice(routine,key,result.truncated?'Older missed occurrences were bounded by the selected catch-up limit':`${result.skipped} missed occurrences skipped by the selected policy`,{kind:'catch_up',skipped:result.skipped,bounded:result.truncated},'info');changed=true;}
          cursor.at=result.cursor;
        }
        if(definition.fileTrigger){
          let entries=observations.get(routine.id);if(!entries){entries=new Map();observations.set(routine.id,entries);}
          const project=state.projects.find(project=>project.id===definition.projectId);
          try{
            const processed=new Set(state.scheduler.receipts.filter(receipt=>receipt.routineId===routine.id&&receipt.source?.kind==='file').map(receipt=>receipt.source.identity));
            const files=await scanStableFiles({projectRoot:project.path,trigger:definition.fileTrigger,observations:entries,processed,now,signal,allowed:target=>scope(definition,target),isOutput:name=>outputs(routine,name)});
            for(const file of files.events)changed=admit(routine,`${routine.id}:file:${file.key}`,{kind:'file',identity:file.key,...file},now)||changed;
            for(const error of files.errors){const count=state.scheduler.notices.length;notice(routine,`${routine.id}:file-error:${error.key}`,error.message,{kind:'file_error',path:error.path});changed||=count!==state.scheduler.notices.length;}
          }catch(error){if(signal?.aborted)throw error;const count=state.scheduler.notices.length;notice(routine,`${routine.id}:watch-error:${hash(error.message)}`,error.message,{kind:'watcher'});changed||=count!==state.scheduler.notices.length;}
          cursor.at=stamp(Math.max(Date.parse(cursor.at),now));
        }
      }
      if(changed||touched&&now-lastSaved>=60000){await save();lastSaved=now;}
      return {polled:true,changed};
    }finally{polling=false;finishPoll();}
  }
  return {poll,notices:()=>structuredClone(state.scheduler.notices),
    refresh(){for(const receipt of state.scheduler.receipts)handled.add(receipt.key);},
    start(){if(timer||closed)return;timer=setInterval(()=>void poll().catch(onError),1000);timer.unref?.();},
    async close(){closed=true;clearInterval(timer);await pollDone;},
    acknowledge(id){const notice=state.scheduler.notices.find(value=>value.id===id);if(!notice)throw new Error('Unknown work notice');notice.status='acknowledged';notice.acknowledgedAt=stamp(clock());},
  };
}
