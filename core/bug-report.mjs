import { releaseLabel } from '../renderer/release.mjs';
export { releaseLabel };

export function redactReport(value) {
  return String(value ?? '').slice(0, 24000)
    .replace(/data:[^\s,]+;base64,[A-Za-z0-9+/=]+/gi, '[image omitted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[authorization redacted]')
    .replace(/\b(?:sk|sess|org)-[A-Za-z0-9_-]{8,}/g, '[credential redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token redacted]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|client_secret|code_verifier|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
      catch { return '[URL redacted]'; }
    })
    .replace(/\b[A-Z]:[\\/][^\r\n"<>|]*/gi, '[local path redacted]')
    .replace(/\\\\[^\r\n"<>|]+/g, '[network path redacted]')
    .replace(/\/(?:Users|home)\/[^\s"<>]+/g, '[home path redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]');
}

export function bugReportDraft({ description = '', steps = '', errors = [] } = {}) {
  const recent = [...new Set(errors.map(error => redactReport(error).slice(0, 600)).filter(Boolean))].slice(-5);
  return {
    title: `[${releaseLabel}] ${redactReport(description).split('\n')[0].slice(0, 100) || 'Bug report'}`,
    body: `Faber ${releaseLabel}\n\n## What happened\n${redactReport(description).slice(0, 2000) || '(Describe the problem)'}\n\n## Steps to reproduce\n${redactReport(steps).slice(0, 2000) || '(Add the steps)'}\n\n## Expected behavior\n(Describe what you expected)\n\n## Recent errors\n${recent.length ? recent.map(error => `- ${error.replaceAll('\n', '\n  ')}`).join('\n') : 'No recent errors captured.'}\n\nReview this report for private information before posting. GitHub issues are public.`,
  };
}

export function reportIssueUrl({ title, body }) {
  const url = new URL('https://github.com/youwebaba/Faber/issues/new');
  url.searchParams.set('title', redactReport(title).slice(0, 150));
  url.searchParams.set('body', redactReport(body));
  if (url.href.length > 24000) throw new Error('This report is too long to open in the browser. Shorten the draft and retry.');
  return url.href;
}

export function externalWebUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || String(value).length > 8192) throw new Error('Only HTTP or HTTPS links without embedded credentials can be opened');
  return url.href;
}
