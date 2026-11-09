// Provider-reported counts only. Missing or malformed values remain unknown.
export function cleanUsage(values) {
  return Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']
    .filter(key => Number.isSafeInteger(values?.[key]) && values[key] >= 0).map(key => [key, values[key]]));
}

export function providerUsage(value, kind) {
  if (kind === 'ollama') return cleanUsage({ inputTokens: value?.prompt_eval_count, outputTokens: value?.eval_count, cachedInputTokens: value?.prompt_eval_cached_count });
  if (kind === 'openai') return cleanUsage({ inputTokens: value?.prompt_tokens, outputTokens: value?.completion_tokens, cachedInputTokens: value?.prompt_tokens_details?.cached_tokens, reasoningTokens: value?.completion_tokens_details?.reasoning_tokens });
  return cleanUsage({ inputTokens: value?.input_tokens, outputTokens: value?.output_tokens, cachedInputTokens: value?.input_tokens_details?.cached_tokens, reasoningTokens: value?.output_tokens_details?.reasoning_tokens });
}

// Cached input and reasoning are subsets of input/output, never extra tokens.
export function usageSummary(calls) {
  const unique = [...new Map(calls.map(call => [call.id, call])).values()];
  const result = { callIds: unique.map(call => call.id), calls: unique.length, reportedCalls: 0, unknownCalls: 0, partialCalls: 0 };
  for (const call of unique) {
    const usage = cleanUsage(call.usage), complete = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
    if (complete) result.reportedCalls++; else if (Object.keys(usage).length) result.partialCalls++; else result.unknownCalls++;
    for (const [key, count] of Object.entries(usage)) result[key] = (result[key] || 0) + count;
    for (const [estimate, reported] of [['estimatedInputTokens', 'inputTokens'], ['estimatedOutputTokens', 'outputTokens']]) {
      const count = call.metrics?.[estimate];
      if (usage[reported] === undefined && Number.isSafeInteger(count) && count > 0) result[estimate] = (result[estimate] || 0) + count;
    }
  }
  result.status = !unique.length ? 'pending' : result.reportedCalls === unique.length ? 'reported' : result.reportedCalls || result.partialCalls ? 'partial' : 'unknown';
  return result;
}

export function closeIterator(iterator) {
  // A generator can be stuck in next(); transport cancellation must not wait for return().
  try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Preserve the original stream failure. */ }
}
