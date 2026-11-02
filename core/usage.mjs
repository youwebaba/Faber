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
