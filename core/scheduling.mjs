import {validate} from './registry.mjs';

const text={type:'string',minLength:1,maxLength:100};
export const scheduleSchema={type:'object',additionalProperties:false,required:['kind','timeZone','gap','fold','catchUp','maxCatchUp','overlap'],properties:{
  kind:{enum:['once','daily','weekly','interval']},timeZone:text,date:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},time:{type:'string',pattern:'^\\d{2}:\\d{2}$'},
  weekdays:{type:'array',minItems:1,maxItems:7,items:{type:'integer',minimum:0,maximum:6}},everyMinutes:{type:'integer',minimum:1,maximum:525600},anchor:text,
  gap:{enum:['skip','next_valid']},fold:{enum:['first','second','both']},catchUp:{enum:['skip','once','queue']},maxCatchUp:{type:'integer',minimum:1,maximum:100},overlap:{enum:['skip','queue','coalesce']},
}};
const formatters=new Map(),day=86400000,minute=60000;
const formatter=zone=>{let value=formatters.get(zone);if(!value){value=new Intl.DateTimeFormat('en-CA',{timeZone:zone,calendar:'iso8601',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});formatters.set(zone,value);}return value;};
function civil(timestamp,zone){const parts=Object.fromEntries(formatter(zone).formatToParts(new Date(timestamp)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};}
function civilStamp(date,time='00:00'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))throw new Error('Use a calendar date and 24-hour time');
  const [year,month,dateOfMonth]=date.split('-').map(Number),[hour,min]=time.split(':').map(Number),stamp=Date.UTC(year,month-1,dateOfMonth,hour,min);
  if(year<2000||hour>23||min>59||new Date(stamp).toISOString().slice(0,16)!==`${date}T${time}`)throw new Error('Invalid schedule date or time; use year 2000 or later');
  return stamp;
}
const iso=value=>new Date(value).toISOString();
const utc=value=>{const stamp=Date.parse(value);if(!Number.isFinite(stamp)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))throw new Error('Use an explicit UTC ISO timestamp');return stamp;};
function offsets(stamp,zone){const values=new Set();for(let delta=-2*day;delta<=2*day;delta+=6*3600000){const probe=stamp+delta,local=civil(probe,zone),[year,month,date]=local.date.split('-').map(Number),[hour,min]=local.time.split(':').map(Number);values.add(Date.UTC(year,month-1,date,hour,min)-probe);}return [...values];}
function candidates(stamp,zone,possibleOffsets){const wanted=new Date(stamp).toISOString().slice(0,16).replace('T',' ');return possibleOffsets.map(offset=>stamp-offset).filter(value=>{const actual=civil(value,zone);return `${actual.date} ${actual.time}`===wanted;}).sort((a,b)=>a-b);}

export function validateSchedule(schedule){
  validate(schedule,scheduleSchema);formatter(schedule.timeZone);
  if(['once','daily','weekly'].includes(schedule.kind)){if(!schedule.time)throw new Error('Choose a local time');civilStamp(schedule.date||'2026-01-01',schedule.time);}
  if(schedule.kind==='once'&&!schedule.date)throw new Error('Choose a one-time date');
  if(schedule.kind==='weekly'&&(!schedule.weekdays?.length||new Set(schedule.weekdays).size!==schedule.weekdays.length))throw new Error('Choose unique weekdays');
  if(schedule.kind==='interval'){if(!schedule.everyMinutes||!schedule.anchor)throw new Error('Choose an interval and UTC anchor');utc(schedule.anchor);}
  return schedule;
}

export function resolveLocalTime(date,time,timeZone,{gap='skip',fold='first'}={}){
  const requested=civilStamp(date,time),possibleOffsets=offsets(requested,timeZone);let values=candidates(requested,timeZone,possibleOffsets),shifted=false;
  if(!values.length&&gap==='next_valid'){
    // A skipped civil day is the largest IANA transition; bound the search rather than guessing a UTC offset.
    for(let advance=minute;advance<=2*day;advance+=minute){values=candidates(requested+advance,timeZone,possibleOffsets);if(values.length){shifted=true;break;}}
  }
  if(values.length>1&&fold!=='both')values=[fold==='second'?values.at(-1):values[0]];
  return values.map(value=>({dueAt:iso(value),requestedDate:date,requestedTime:time,...civil(value,timeZone),shifted}));
}
function wallOccurrences(schedule,after,through,limit){
  if(schedule.kind==='once')return {items:resolveLocalTime(schedule.date,schedule.time,schedule.timeZone,schedule).filter(value=>Date.parse(value.dueAt)>after&&Date.parse(value.dueAt)<=through),truncated:false};
  const first=civilStamp(civil(after+1,schedule.timeZone).date),last=civilStamp(civil(through,schedule.timeZone).date),items=[];let cursor=last;
  for(;cursor>=first;cursor-=day){
    if(schedule.kind==='weekly'&&!schedule.weekdays.includes(new Date(cursor).getUTCDay()))continue;
    const date=iso(cursor).slice(0,10);items.push(...resolveLocalTime(date,schedule.time,schedule.timeZone,schedule).filter(value=>Date.parse(value.dueAt)>after&&Date.parse(value.dueAt)<=through));
    if(items.length>limit){cursor-=day;break;}
  }
  return {items,truncated:cursor>=first};
}

// Pure evaluation: the caller persists cursor/occurrence receipts and queued jobs together.
export function dueOccurrences(schedule,after,through,{graceMs=60000}={}){
  validateSchedule(schedule);after=typeof after==='string'?utc(after):after;through=typeof through==='string'?utc(through):through;
  if(!Number.isSafeInteger(after)||!Number.isSafeInteger(through))throw new Error('Invalid scheduler clock');
  if(through<=after)return {occurrences:[],cursor:iso(after),skipped:0,truncated:false,clockMovedBack:through<after};
  const cap=schedule.catchUp==='queue'?schedule.maxCatchUp:1;let items,truncated=false,total;
  if(schedule.kind==='interval'){
    const anchor=utc(schedule.anchor),step=schedule.everyMinutes*minute,first=Math.max(0,Math.floor((after-anchor)/step)+1),last=Math.floor((through-anchor)/step);total=Math.max(0,last-first+1);items=[];
    for(let index=last;index>=Math.max(first,last-cap);index--){const stamp=anchor+index*step;items.push({dueAt:iso(stamp),...civil(stamp,schedule.timeZone),shifted:false});}
  }else{const found=wallOccurrences(schedule,after,through,cap);items=found.items;truncated=found.truncated;total=truncated?null:items.length;}
  items.sort((a,b)=>Date.parse(b.dueAt)-Date.parse(a.dueAt));
  if(schedule.catchUp==='skip')items=items.filter(value=>through-Date.parse(value.dueAt)<=graceMs).slice(0,1);else items=items.slice(0,cap);
  items.reverse();
  return {occurrences:items.map(value=>({...value,key:value.requestedDate?`${value.requestedDate}T${value.requestedTime}/${value.dueAt}`:value.dueAt})),cursor:iso(through),skipped:total===null?null:total-items.length,truncated,clockMovedBack:false};
}

export function previewSchedule(schedule,from,count=5){
  validateSchedule(schedule);const start=typeof from==='string'?utc(from):from;if(!Number.isSafeInteger(start)||!Number.isInteger(count)||count<1||count>100)throw new Error('Invalid preview request');
  if(schedule.kind==='interval'){const anchor=utc(schedule.anchor),step=schedule.everyMinutes*minute,first=Math.max(0,Math.floor((start-anchor)/step)+1);return Array.from({length:count},(_,index)=>{const dueAt=anchor+(first+index)*step;return {dueAt:iso(dueAt),...civil(dueAt,schedule.timeZone)};});}
  if(schedule.kind==='once')return resolveLocalTime(schedule.date,schedule.time,schedule.timeZone,schedule).filter(value=>Date.parse(value.dueAt)>start).slice(0,count);
  const result=[],first=civilStamp(civil(start,schedule.timeZone).date);
  for(let date=first;result.length<count&&date<=first+730*day;date+=day){if(schedule.kind==='weekly'&&!schedule.weekdays.includes(new Date(date).getUTCDay()))continue;result.push(...resolveLocalTime(iso(date).slice(0,10),schedule.time,schedule.timeZone,schedule).filter(value=>Date.parse(value.dueAt)>start));}
  return result.slice(0,count);
}

export function overlapDecision(policy,jobs,routineId){
  if(!['skip','queue','coalesce'].includes(policy))throw new Error('Choose an overlap policy');
  const outstanding=jobs.filter(job=>job.routineId===routineId&&['queued','running','waiting_approval','waiting_interaction','waiting_resource','loading_model','deferred_interactive'].includes(job.status));
  if(!outstanding.length||policy==='queue')return {action:'enqueue'};
  if(policy==='skip')return {action:'skip'};
  const queued=outstanding.find(job=>job.status==='queued');return queued?{action:'coalesce',jobId:queued.id}:{action:'enqueue'};
}
