import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkLedger,defaultWorkLimits,reserveWorkCall,settleWorkCall,workBudgetStatus,recoverWorkReservations,routineRuntimeRemaining,routineConcurrencyAvailable,waitForForeground} from '../core/work-budget.mjs';

test('hard token reservations constrain output before dispatch and reconcile reported subsets once',()=>{
  const limits={...defaultWorkLimits,maxTokens:100},ledger=createWorkLedger();const first=reserveWorkCall(ledger,limits,{id:'call',inputUpperBound:60,outputLimit:80,local:true});assert.equal(first.reservation.outputLimit,40);assert.equal(workBudgetStatus(ledger,limits).remainingTokens,0);
  assert.equal(reserveWorkCall(ledger,limits,{id:'blocked',inputUpperBound:1,local:true}).ok,false);settleWorkCall(ledger,'call',{inputTokens:40,outputTokens:10,cachedInputTokens:20,reasoningTokens:5});assert.equal(workBudgetStatus(ledger,limits).tokens,50);assert.equal(workBudgetStatus(ledger,limits).spend,0);assert.equal(reserveWorkCall(ledger,limits,{id:'call',inputUpperBound:60,local:true}).reused,true);assert.equal(ledger.calls.length,1);
});
test('unknown input or cost bounds stop strict dispatch rather than inventing estimates',()=>{
  const ledger=createWorkLedger();assert.equal(reserveWorkCall(ledger,{...defaultWorkLimits,maxTokens:500},{id:'unknown'}).code,'token_bound_unavailable');assert.equal(reserveWorkCall(ledger,{...defaultWorkLimits,maxSpend:0},{id:'paid'}).code,'cost_bound_unavailable');assert.equal(ledger.calls.length,0);assert.equal(reserveWorkCall(ledger,{...defaultWorkLimits,maxSpend:0},{id:'local',local:true}).ok,true);
});
test('unknown usage charges the reserved worst case and obeys the explicit pause policy across a crash',()=>{
  const limits={...defaultWorkLimits,maxTokens:1000},ledger=createWorkLedger();reserveWorkCall(ledger,limits,{id:'lost',inputUpperBound:100,outputLimit:50,local:true});recoverWorkReservations(ledger);assert.equal(workBudgetStatus(ledger,limits).tokens,150);assert.equal(reserveWorkCall(ledger,limits,{id:'pause',inputUpperBound:100,local:true}).code,'unknown_usage');assert.equal(reserveWorkCall(ledger,{...limits,unknownUsage:'charge_reserved'},{id:'bounded',inputUpperBound:100,outputLimit:50,local:true}).ok,true);
});
test('actual adapter bound violations remain visible and block later calls',()=>{
  const limits={...defaultWorkLimits,maxTokens:1000},ledger=createWorkLedger();reserveWorkCall(ledger,limits,{id:'broken',inputUpperBound:10,outputLimit:10,local:true});settleWorkCall(ledger,'broken',{inputTokens:50,outputTokens:50});assert.equal(workBudgetStatus(ledger,limits).tokens,100);assert.equal(workBudgetStatus(ledger,limits).overrun,true);assert.equal(workBudgetStatus(ledger,limits).blocked,true);
});
test('shared child concurrency, independent runtime and foreground-first policy have explicit boundaries',()=>{
  const limits={...defaultWorkLimits,runtimeMs:60000,maxConcurrent:2},runs=[{jobId:'job',status:'running'},{jobId:'job',parentRunId:'parent',status:'waiting_approval'}];assert.equal(routineConcurrencyAvailable(limits,runs,'job'),false);assert.equal(routineRuntimeRemaining(limits,'2026-11-09T00:00:00Z',Date.parse('2026-11-09T00:00:45Z')).remainingMs,15000);assert.equal(routineRuntimeRemaining(limits,'2026-11-09T00:00:00Z',Date.parse('2026-11-09T00:00:05Z'),'2026-11-09T00:00:10Z').clockMovedBack,true);
  const interactive=[{providerId:'owned-local',status:'running'}];assert.equal(waitForForeground({policy:'foreground_first',local:true,providerId:'owned-local',jobId:'job',runs:interactive}),true);assert.equal(waitForForeground({policy:'fair_queue',local:true,providerId:'owned-local',runs:interactive}),false);assert.equal(waitForForeground({policy:'foreground_first',local:false,providerId:'owned-local',runs:interactive}),false);
});
