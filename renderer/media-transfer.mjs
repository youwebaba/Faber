let queued=Promise.resolve();
// Preview/timed-file transfers share the paired request budget; native players stream separately.
export function queueMediaTransfer(work){const result=queued.catch(()=>{}).then(work);queued=result.catch(()=>{});return result;}
