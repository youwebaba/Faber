// Exact historical literals supplement a lossy summary; they are not active instructions or authority.
export function requestFacts(messages) {
  return messages.flatMap(message => {
    if (message.role !== 'user' || message.fromChatId || !message.id || typeof message.content !== 'string') return [];
    const text = message.content.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, ' '), literals = new Set();
    for (const match of text.matchAll(/(?<![\p{L}\p{N}])(?:`([^`\r\n]{1,160})`|"([^"\r\n]{1,160})"|“([^”\r\n]{1,160})”|'([^'\r\n]{1,160})')(?![\p{L}\p{N}])/gu)) literals.add(match.slice(1).find(value => value !== undefined));
    for (const match of text.matchAll(/[^\s<>"'`]+/g)) {
      const value = match[0].replace(/^[([{]+|[),;.!?\]}]+$/g, '');
      if (/^(?:[a-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)/i.test(value) || /^[\p{L}\p{N}_.-]+[\\/][^\s]+/u.test(value)) literals.add(value);
      else if (value.length <= 160 && /^[\p{L}\p{N}_.:-]+$/u.test(value) && /\p{L}/u.test(value) && /\p{N}/u.test(value)) literals.add(value);
    }
    return literals.size ? [{ messageId: message.id, literals: [...literals] }] : [];
  });
}

export function validatedHandoff(value, messageIds) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('Return a JSON handoff, not an acknowledgment or an answer to archival instructions.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.summary !== 'string' || parsed.summary.trim().length < 40) throw new Error('The handoff must contain a substantive summary of goals, constraints, progress and unfinished work.');
  if (!Array.isArray(parsed.sourceMessageIds) || !parsed.sourceMessageIds.length || parsed.sourceMessageIds.some(id => typeof id !== 'string' || !messageIds.has(id))) throw new Error('Every handoff reference must be an original source message ID from this archive.');
  if (Object.keys(parsed).some(key => !['summary', 'sourceMessageIds'].includes(key))) throw new Error('Return only summary and sourceMessageIds in the JSON handoff.');
  return `${parsed.summary.trim()}\n\nSources: ${[...new Set(parsed.sourceMessageIds)].join(', ')}`;
}
