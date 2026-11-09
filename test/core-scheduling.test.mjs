import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSchedule,resolveLocalTime,dueOccurrences,previewSchedule,overlapDecision} from '../core/scheduling.mjs';

const daily=(overrides={})=>({kind:'daily',timeZone:'America/New_York',time:'09:00',gap:'skip',fold:'first',catchUp:'queue',maxCatchUp:3,overlap:'queue',...overrides});
test('civil-time resolution handles spring gaps, autumn folds and half-hour transitions explicitly',()=>{
  assert.deepEqual(resolveLocalTime('2026-03-08','02:30','America/New_York'),[]);
  assert.equal(resolveLocalTime('2026-03-08','02:30','America/New_York',{gap:'next_valid'})[0].dueAt,'2026-03-08T07:00:00.000Z');
  assert.deepEqual(resolveLocalTime('2026-11-01','01:30','America/New_York',{fold:'both'}).map(value=>value.dueAt),['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z']);
  assert.equal(resolveLocalTime('2026-11-01','01:30','America/New_York',{fold:'second'})[0].dueAt,'2026-11-01T06:30:00.000Z');
  assert.deepEqual(resolveLocalTime('2026-04-05','01:45','Australia/Lord_Howe',{fold:'both'}).map(value=>value.dueAt),['2026-04-04T14:45:00.000Z','2026-04-04T15:15:00.000Z']);
});
test('daily previews preserve wall time as the UTC offset changes and weekly choices remain exact',()=>{
  assert.deepEqual(previewSchedule(daily(),Date.parse('2026-03-07T12:00:00Z'),3).map(value=>value.dueAt),['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-09T13:00:00.000Z']);
  assert.deepEqual(previewSchedule(daily({kind:'weekly',weekdays:[1,5]}),'2026-11-09T15:00:00Z',2).map(value=>value.date),['2026-11-13','2026-11-16']);
});
test('missed occurrence policy skips, coalesces once or queues only the newest configured count',()=>{
  const after='2026-11-01T15:00:00Z',through='2026-11-08T15:00:00Z';
  assert.equal(dueOccurrences(daily({catchUp:'skip'}),after,through).occurrences.length,0);
  assert.deepEqual(dueOccurrences(daily({catchUp:'once'}),after,through).occurrences.map(value=>value.date),['2026-11-08']);
  const queued=dueOccurrences(daily(),after,through);assert.deepEqual(queued.occurrences.map(value=>value.date),['2026-11-06','2026-11-07','2026-11-08']);assert.equal(queued.truncated,true);assert.equal(queued.skipped,null);
  assert.equal(dueOccurrences(daily(),queued.cursor,through).occurrences.length,0);
});
test('interval scheduling counts downtime without enumerating it and a backwards clock cannot duplicate occurrences',()=>{
  const schedule=daily({kind:'interval',everyMinutes:1,anchor:'2026-01-01T00:00:00Z'});const due=dueOccurrences(schedule,'2026-01-01T00:00:00Z','2026-11-09T00:00:00Z');assert.equal(due.occurrences.length,3);assert.ok(due.skipped>400000);
  const backwards=dueOccurrences(schedule,due.cursor,'2026-11-08T00:00:00Z');assert.equal(backwards.cursor,due.cursor);assert.equal(backwards.clockMovedBack,true);assert.equal(backwards.occurrences.length,0);
});
test('one-time missing-time and overlap policies are deterministic and invalid input fails before admission',()=>{
  const once=daily({kind:'once',date:'2026-03-08',time:'02:30',gap:'next_valid'});assert.equal(previewSchedule(once,'2026-03-01T00:00:00Z')[0].dueAt,'2026-03-08T07:00:00.000Z');
  assert.deepEqual(overlapDecision('coalesce',[{id:'pending',routineId:'r',status:'queued'}],'r'),{action:'coalesce',jobId:'pending'});assert.equal(overlapDecision('skip',[{routineId:'r',status:'running'}],'r').action,'skip');assert.equal(overlapDecision('coalesce',[{routineId:'r',status:'running'}],'r').action,'enqueue');
  for(const value of [daily({timeZone:'Invalid/Zone'}),daily({time:'25:00'}),daily({kind:'once',date:'2026-02-30'}),daily({kind:'weekly',weekdays:[1,1]})])assert.throws(()=>validateSchedule(value));
});
