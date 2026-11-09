const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : undefined;

export function liveOutputLabel(run, stream) {
  const call = run?.modelCalls?.at(-1);
  if (!call || call.status !== 'running') return '';
  const metrics = stream && (!stream.modelCallId || stream.modelCallId === call.id) ? stream.metrics ?? call.metrics : call.metrics;
  const count = tokens(metrics?.generatedOutputTokens);
  if (count === undefined || metrics.outputTokensStatus === 'pending') return 'Token count pending';
  return `${metrics.outputTokensStatus === 'estimated' ? '≈ ' : ''}${count} output tokens`;
}

export function promptUsageLabel(row) {
  if (row.allocation === 'shared') return {text:'Prompt usage · Included with the next prompt',title:'The model received these messages in one call. Its tokens are counted once with that prompt.'};
  const details = [];
  for (const [name, reported, estimate] of [['input', row.inputTokens, row.estimatedInputTokens], ['output', row.outputTokens, row.estimatedOutputTokens]]) {
    const count = tokens(reported), estimated = tokens(estimate);
    if (count !== undefined) details.push(`${count} ${name}`);
    if (estimated !== undefined && (estimate > 0 || count === undefined)) details.push(`≈ ${estimated} ${name} estimated`);
  }
  if (!details.length) details.push('Usage unavailable');
  if (row.unknownCalls) details.push(`${row.unknownCalls} call${row.unknownCalls === 1 ? '' : 's'} without provider counts`);
  if (row.partialCalls) details.push(`${row.partialCalls} partial call${row.partialCalls === 1 ? '' : 's'}`);
  const subsets = [];
  if (tokens(row.cachedInputTokens) !== undefined) subsets.push(`${tokens(row.cachedInputTokens)} cached input`);
  if (tokens(row.reasoningTokens) !== undefined) subsets.push(`${tokens(row.reasoningTokens)} reasoning output`);
  return { text: `Prompt usage · ${details.join(' · ')}`, title: [`${row.calls} model call${row.calls === 1 ? '' : 's'}`, ...subsets.map(value => `${value} (included)`)].join(' · ') };
}

export function correctionLabel(correction) {
  if (!correction) return '';
  if (correction.status === 'queued') return correction.waitingFor === 'approval' ? 'Steer queued for approval' : correction.waitingFor === 'tool' ? 'Steer queued until tool finishes' : 'Steer queued';
  return ({accepted:'Steer accepted', applied:'Steer applied', failed:'Steer failed'})[correction.status] || 'Steer received';
}

// Keep the request identity across a lost reply. Editing the draft starts a new correction.
export function correctionRequest(previous, runId, text, files) {
  const attachmentIds = files.map(file => file.id);
  const same = previous?.runId === runId && previous.text === text && attachmentIds.length === previous.attachmentIds.length && attachmentIds.every((id, i) => previous.attachmentIds[i] === id);
  return same ? previous : { correctionId: globalThis.crypto.randomUUID(), runId, text, attachmentIds };
}
