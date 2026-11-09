import {validate} from './registry.mjs';
import {cleanUsage} from './usage.mjs';

const optionalNumber=maximum=>({anyOf:[{type:'null'},{type:'number',minimum:0,maximum}]});
export const workLimitsSchema={type:'object',additionalProperties:false,required:['runtimeMs','maxAttempts','maxConcurrent','maxTokens','maxSpend','perCallOutputTokens','unknownUsage','localPriority','idleUnloadMs'],properties:{
  runtimeMs:{anyOf:[{const:0},{type:'integer',minimum:1000,maximum:2147483647}]},maxAttempts:{type:'integer',minimum:1,maximum:10},maxConcurrent:{type:'integer',minimum:1,maximum:32},
  maxTokens:{anyOf:[{type:'null'},{type:'integer',minimum:1,maximum:1000000000}]},maxSpend:optionalNumber(1000000),perCallOutputTokens:{type:'integer',minimum:1,maximum:1000000},
  unknownUsage:{enum:['pause','charge_reserved']},localPriority:{enum:['foreground_first','fair_queue']},idleUnloadMs:{type:'integer',minimum:0,maximum:2147483647},
}};
export const defaultWorkLimits=Object.freeze({runtimeMs:600000,maxAttempts:3,maxConcurrent:2,maxTokens:null,maxSpend:null,perCallOutputTokens:1024,unknownUsage:'pause',localPriority:'foreground_first',idleUnloadMs:0});
export const createWorkLedger=()=>({calls:[]});
const finite=value=>Number.isFinite(value)&&value>=0;
const tokenCount=value=>Number.isSafeInteger(value)&&value>=0;
function totals(ledger){
  let tokens=0,spend=0,unknownTokens=false,unknownSpend=false,overrun=false;
  for(const call of ledger.calls){tokens+=call.chargedTokens??call.reservedTokens??0;spend+=call.chargedCost??call.reservedCost??0;unknownTokens||=call.tokensKnown===false;unknownSpend||=call.costKnown===false;overrun||=call.overrun===true;}
  return {tokens,spend,unknownTokens,unknownSpend,overrun};
}
export function workBudgetStatus(ledger,limits){
  validate(limits,workLimitsSchema);if(!Array.isArray(ledger?.calls))throw new Error('Invalid work budget ledger');
  const result=totals(ledger);
  return {...result,remainingTokens:limits.maxTokens===null?null:Math.max(0,limits.maxTokens-result.tokens),remainingSpend:limits.maxSpend===null?null:Math.max(0,limits.maxSpend-result.spend),
    blocked:result.overrun||limits.unknownUsage==='pause'&&(limits.maxTokens!==null&&result.unknownTokens||limits.maxSpend!==null&&result.unknownSpend)};
}

// The adapter supplies an enforceable input/output bound or a strict budget refuses dispatch.
export function reserveWorkCall(ledger,limits,{id,inputUpperBound=null,outputLimit=limits.perCallOutputTokens,costUpperBound=null,local=false}){
  const state=workBudgetStatus(ledger,limits);
  if(typeof id!=='string'||!id||!tokenCount(outputLimit)||!outputLimit||inputUpperBound!==null&&!tokenCount(inputUpperBound)||costUpperBound!==null&&!finite(costUpperBound))throw new Error('Invalid model-call reservation');
  const previous=ledger.calls.find(call=>call.id===id);if(previous)return {ok:true,reservation:previous,reused:true};
  if(state.blocked)return {ok:false,reason:'Previous usage or effects could not be bounded; review the budget before continuing',code:'unknown_usage'};
  let maximum=Math.min(outputLimit,limits.perCallOutputTokens);
  if(limits.maxTokens!==null){
    if(inputUpperBound===null)return {ok:false,reason:'This provider cannot enforce a total-token bound before dispatch',code:'token_bound_unavailable'};
    maximum=Math.min(maximum,state.remainingTokens-inputUpperBound);
    if(maximum<1)return {ok:false,reason:'Token budget is exhausted before the next model call',code:'tokens_exhausted'};
  }
  const cost=local?0:costUpperBound;
  if(limits.maxSpend!==null){
    if(cost===null)return {ok:false,reason:'A cost ceiling is unavailable for this provider; no paid call was dispatched',code:'cost_bound_unavailable'};
    if(cost>state.remainingSpend)return {ok:false,reason:'Spend budget is exhausted before the next model call',code:'spend_exhausted'};
  }
  const reservation={id,status:'reserved',inputUpperBound,outputLimit:maximum,reservedTokens:inputUpperBound===null?null:inputUpperBound+maximum,reservedCost:cost,local,createdAt:new Date().toISOString()};
  ledger.calls.push(reservation);return {ok:true,reservation,reused:false};
}

export function settleWorkCall(ledger,id,usage,{cost=null}={}){
  const call=ledger.calls.find(value=>value.id===id);if(!call)throw new Error('Model call has no durable budget reservation');
  if(call.status==='settled')return call;
  const counts=cleanUsage(usage),known=tokenCount(counts.inputTokens)&&tokenCount(counts.outputTokens),actual=known?counts.inputTokens+counts.outputTokens:null;
  if(cost!==null&&!finite(cost))throw new Error('Invalid reported model cost');
  call.status='settled';call.usage=counts;call.tokensKnown=known;call.costKnown=call.local||cost!==null;
  call.chargedTokens=known?actual:call.reservedTokens;call.chargedCost=call.local?0:cost??call.reservedCost;
  call.overrun=actual!==null&&call.reservedTokens!==null&&actual>call.reservedTokens||cost!==null&&call.reservedCost!==null&&cost>call.reservedCost;
  call.settledAt=new Date().toISOString();return call;
}
export function recoverWorkReservations(ledger){for(const call of ledger.calls)if(call.status==='reserved'){call.status='unknown';call.tokensKnown=false;call.costKnown=call.local;call.chargedTokens=call.reservedTokens;call.chargedCost=call.reservedCost;}return ledger;}

export function routineRuntimeRemaining(limits,startedAt,now,lastObservedAt){
  validate(limits,workLimitsSchema);if(limits.runtimeMs===0)return {remainingMs:null,clockMovedBack:false};
  const started=Date.parse(startedAt),observed=lastObservedAt?Date.parse(lastObservedAt):started;
  if(!Number.isFinite(started)||!Number.isFinite(observed)||!Number.isFinite(now))throw new Error('Invalid routine runtime clock');
  if(now<observed)return {remainingMs:0,clockMovedBack:true};
  return {remainingMs:Math.max(0,limits.runtimeMs-(now-started)),clockMovedBack:false};
}
export function routineConcurrencyAvailable(limits,runs,jobId){validate(limits,workLimitsSchema);return runs.filter(run=>run.jobId===jobId&&['running','waiting_approval'].includes(run.status)).length<limits.maxConcurrent;}
export function waitForForeground({policy,local,providerId,resourceKey,jobId,runs}){
  if(policy!=='foreground_first'||!local)return false;
  return runs.some(run=>!run.jobId&&run.jobId!==jobId&&['running','waiting_approval'].includes(run.status)&&(run.providerId===providerId||resourceKey&&run.resourceKey===resourceKey));
}
