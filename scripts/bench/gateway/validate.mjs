import assert from 'node:assert/strict';
export function validateSse(text) {
 const data=text.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim());
 assert.equal(data.at(-1),'[DONE]','terminal must be last');
 const events=data.slice(0,-1).map(s=>JSON.parse(s));
 assert(events.some(e=>e.choices?.[0]?.delta?.content?.length),'missing content');
 assert(events.some(e=>e.choices?.[0]?.finish_reason==='stop'),'missing finish_reason');
 assert(!events.some(e=>e.error),'error event');
}
export function summary(values) {
 assert(values.length>0);assert(values.every(v=>Number.isFinite(v)&&v>=0));
 const sorted=[...values].sort((a,b)=>a-b);
 return {n:values.length,p50:sorted[Math.ceil(values.length*.5)-1],p95:values.length>=100?sorted[Math.ceil(values.length*.95)-1]:null,tailWarning:values.length<100?'undersampled':null};
}
