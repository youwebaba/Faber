import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoutineScheduler} from '../core/routine-scheduler.mjs';

const definition={name:'Scheduled fixture',schedule:{kind:'interval',timeZone:'UTC',everyMinutes:1,anchor:'2026-11-09T00:00:00Z',gap:'skip',fold:'first',catchUp:'queue',maxCatchUp:3,overlap:'queue'}};
function fixture(){const state={routines:[{id:'r',revision:1,enabled:true,createdAt:'2026-11-09T00:00:00Z',definition}],jobs:[],runs:[],workerQueue:{paused:false}};let saves=0;const options={state,save:async()=>saves++,scope:async()=>true,enqueue:(routine,{trigger})=>{const job={id:'job-'+state.jobs.length,routineId:routine.id,status:'queued',triggers:[trigger]};state.jobs.push(job);return job;}};return {state,options,get saves(){return saves;}};}
test('persistent occurrence receipts deduplicate restart and duplicate polling while catch-up remains capped',async()=>{
  const f=fixture(),scheduler=createRoutineScheduler(f.options);await scheduler.poll(Date.parse('2026-11-09T00:10:00Z'));assert.equal(f.state.jobs.length,3);assert.equal(f.state.scheduler.receipts.length,3);await scheduler.close();const restarted=createRoutineScheduler(f.options);f.state.scheduler.cursors.r.at='2026-11-09T00:00:00Z';await restarted.poll(Date.parse('2026-11-09T00:10:00Z'));assert.equal(f.state.jobs.length,3);await restarted.close();
});
test('pause retains missed work for the configured policy and coalescing retains source identities',async()=>{
  const f=fixture();f.state.routines[0].definition={...definition,schedule:{...definition.schedule,overlap:'coalesce'}};const scheduler=createRoutineScheduler(f.options);f.state.workerQueue.paused=true;await scheduler.poll(Date.parse('2026-11-09T00:05:00Z'));assert.equal(f.state.jobs.length,0);f.state.workerQueue.paused=false;await scheduler.poll(Date.parse('2026-11-09T00:05:00Z'));assert.equal(f.state.jobs.length,1);assert.equal(f.state.jobs[0].triggers.length,3);assert.equal(f.state.scheduler.receipts.filter(receipt=>receipt.status==='coalesce').length,2);await scheduler.close();
});
