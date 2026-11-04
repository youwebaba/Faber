import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { atomicWrite } from './recovery.mjs';

export const CHATGPT_BASE_URL = 'https://api.openai.com/v1';
const issuer = 'https://auth.openai.com';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const knownEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const terminalRefreshErrors = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const accountId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function validateChatGPTIDToken(token, { jwks, clientId, nonce, subject, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 32000) throw new Error('Invalid OpenAI identity token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid OpenAI identity token');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new Error('Invalid OpenAI identity token'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) throw new Error('Unsupported OpenAI identity signature');
  const keys = jwks?.keys?.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256')) || [];
  if (keys.length !== 1) throw new Error('OpenAI identity signing key unavailable');
  let valid = false;
  try { valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: keys[0], format: 'jwk' }), Buffer.from(parts[2], 'base64url')); } catch { /* Reject invalid public keys/signatures. */ }
  if (!valid) throw new Error('OpenAI identity signature did not verify');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId)) throw new Error('OpenAI identity issuer or audience did not match');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now + 30000)) || (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat * 1000 > now + 30000))) throw new Error('OpenAI identity token is expired or not yet valid');
  if (nonce !== undefined && !same(claims.nonce, nonce)) throw new Error('OpenAI identity nonce did not match');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512 || (subject && claims.sub !== subject)) throw new Error('OpenAI account identity did not match');
  return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.slice(0, 300) : '' };
}

export function chatGPTModels(body) {
  if (!Array.isArray(body?.models) || body.models.length > 5000) throw new Error('ChatGPT returned an invalid model catalog');
  const ids = new Set(), result = [];
  for (const item of body.models) {
    if (item?.visibility !== 'list') continue;
    if (typeof item.slug !== 'string' || !item.slug || item.slug.length > 300 || typeof item.display_name !== 'string' || !item.display_name || item.display_name.length > 300) throw new Error('ChatGPT returned an invalid model entry');
    if (ids.has(item.slug)) continue;
    ids.add(item.slug);
    const declared = item.supported_reasoning_efforts ?? item.supported_reasoning_levels ?? item.reasoning_efforts;
    const reasoningEfforts = Array.isArray(declared) ? [...new Set(declared.map(value => typeof value === 'string' ? value : value?.effort).filter(value => knownEfforts.has(value)))] : [];
    const contextTokens = Number.isSafeInteger(item.context_window) && item.context_window > 0 ? item.context_window : null;
    const defaultReasoningEffort = reasoningEfforts.includes(item.default_reasoning_effort) ? item.default_reasoning_effort : null;
    result.push({ id: item.slug, name: item.display_name, contextTokens, reasoningEfforts, defaultReasoningEffort });
  }
  return result;
}

function authURL(value) {
  const url = new URL(value);
  if (url.origin !== issuer || url.username || url.password || url.search || url.hash) throw new Error('OpenAI authentication metadata contained an unexpected endpoint');
  return url.href;
}

async function jsonResponse(response) {
  const reader = response.body?.getReader();
  let text = '', bytes = 0;
  if (reader) {
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('ChatGPT response was too large'); }
        chunks.push(value);
      }
      text = Buffer.concat(chunks, bytes).toString('utf8');
    } finally { reader.releaseLock(); }
  }
  if (!response.ok) {
    let code = '';
    try { const body = JSON.parse(text); const candidate = typeof body.error === 'string' ? body.error : body.error?.code; if (typeof candidate === 'string' && /^[a-z_]{1,100}$/.test(candidate)) code = candidate; } catch { /* Do not expose OAuth response bodies. */ }
    const error = new Error(`ChatGPT request failed (${response.status}${code ? `: ${code}` : ''}).${response.status === 401 || terminalRefreshErrors.has(code) ? ' Sign in again.' : ''}`);
    error.code = code; error.status = response.status; throw error;
  }
  try { return JSON.parse(text); } catch { throw new Error('ChatGPT returned invalid JSON'); }
}

export async function createChatGPT({ dataDir, secureStorage, openExternal, emit = () => {}, syncProviders = async () => {}, stopProvider = async () => {}, fetchImpl = fetch, now = Date.now, signInTimeoutMs = 5 * 60 * 1000 }) {
  const file = path.join(dataDir, 'chatgpt-credentials.bin'), hostFile = path.join(dataDir, 'chatgpt-host.json');
  let vault = { version: 1, accounts: [], activeAccountId: null }, pending = null, flow = { status: 'idle' }, queue = Promise.resolve(), closed = false;
  let metadata, keys, hostId;
  const refreshes = new Map(), revoking = new Set();
  try {
    const bytes = await fs.readFile(file);
    if (bytes.length > 4 * 1024 * 1024 || !secureStorage.isEncryptionAvailable()) throw new Error('ChatGPT credential storage cannot be opened');
    vault = JSON.parse(secureStorage.decryptString(bytes));
    if (vault.version !== 1 || !Array.isArray(vault.accounts) || vault.accounts.length > 50 || (vault.pendingClientId !== undefined && !validClientId(vault.pendingClientId)) || vault.accounts.some(account => !accountId(account.id) || !validClientId(account.clientId) || typeof account.subject !== 'string' || !Array.isArray(account.models))) throw new Error('ChatGPT credential storage is invalid');
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('ChatGPT credentials could not be loaded. Restore access to Windows credential encryption before connecting again.'); }
  try { hostId = JSON.parse(await fs.readFile(hostFile, 'utf8')).hostId; if (!/^urn:uuid:[a-f0-9-]{36}$/.test(hostId)) throw new Error('Invalid ChatGPT host ID'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; hostId = `urn:uuid:${randomUUID()}`; await atomicWrite(hostFile, JSON.stringify({ hostId })); }

  function validClientId(value) { return typeof value === 'string' && value !== 'dynamic_agent_client' && /^[A-Za-z0-9_-]{1,300}$/.test(value); }
  function getAccount(id) { const account = vault.accounts.find(item => item.id === id); if (!account) throw new Error('Select a saved ChatGPT account'); return account; }
  function connected(account) { return !!account.accessToken && !revoking.has(account.id); }
  function planEnabled(account) { return connected(account) && account.scopes?.includes('chatgpt.tokens.use.direct') === true; }
  function status() {
    return { accounts: vault.accounts.map(account => ({ id: account.id, providerId: `chatgpt:${account.id}`, label: account.label, email: account.email, connected: connected(account), planEnabled: planEnabled(account), models: structuredClone(account.models), ...(account.error ? { error: account.error } : {}) })), activeAccountId: vault.activeAccountId, signIn: { ...flow } };
  }
  async function publish() {
    await syncProviders(vault.accounts.map(account => ({ id: `chatgpt:${account.id}`, name: `ChatGPT · ${account.label}`, kind: 'openai-responses', authKind: 'chatgpt', accountId: account.id, baseUrl: CHATGPT_BASE_URL, model: '', hasKey: true, connected: planEnabled(account), models: structuredClone(account.models) })));
    emit({ type: 'chatgpt', ...status() });
  }
  async function mutate(change, { guard, onCommit } = {}) {
    const operation = queue.catch(() => {}).then(async () => {
      if (guard && !guard()) throw new Error('ChatGPT sign-in was canceled');
      const next = structuredClone(vault); change(next);
      if (!secureStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable; ChatGPT credentials were not saved');
      const previous = guard ? secureStorage.encryptString(JSON.stringify(vault)) : null;
      const bytes = secureStorage.encryptString(JSON.stringify(next));
      await atomicWrite(file, bytes);
      if (guard && !guard()) {
        // The queue prevents another credential mutation from overtaking this rollback.
        // Keep a canceled reauthorization's previous session, not the new token set.
        await atomicWrite(file, previous);
        throw new Error('ChatGPT sign-in was canceled');
      }
      vault = next; onCommit?.(); await publish();
    });
    queue = operation; return operation;
  }
  async function requestJSON(url, options = {}) {
    try { return await jsonResponse(await fetchImpl(url, { ...options, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })); }
    catch (error) { if (error.status) throw error; throw new Error(error.name === 'AbortError' || error.name === 'TimeoutError' ? 'ChatGPT request canceled or timed out.' : 'Could not reach ChatGPT. Check the connection and try again.'); }
  }
  async function discovery() {
    if (!metadata) {
      const value = await requestJSON(`${issuer}/.well-known/openid-configuration`);
      if (value.issuer !== issuer) throw new Error('OpenAI authentication issuer did not match');
      metadata = { authorization: authURL(value.authorization_endpoint), token: authURL(value.token_endpoint), jwks: authURL(value.jwks_uri), revoke: value.revocation_endpoint ? authURL(value.revocation_endpoint) : null };
    }
    return metadata;
  }
  async function identity(token, options) {
    const config = await discovery();
    if (!keys) keys = await requestJSON(config.jwks);
    try { return validateChatGPTIDToken(token, { ...options, jwks: keys, now: now() }); }
    catch (error) {
      if (error.message !== 'OpenAI identity signing key unavailable') throw error;
      keys = await requestJSON(config.jwks); return validateChatGPTIDToken(token, { ...options, jwks: keys, now: now() });
    }
  }
  function tokenFields(value, previous) {
    if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 32000 || String(value.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error('ChatGPT returned an invalid token response');
    const refreshToken = value.refresh_token ?? previous?.refreshToken;
    if (refreshToken !== undefined && (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 32000)) throw new Error('ChatGPT returned an invalid renewable session');
    if (value.scope !== undefined && (typeof value.scope !== 'string' || value.scope.length > 5000)) throw new Error('ChatGPT returned invalid permissions');
    return { accessToken: value.access_token, refreshToken, idToken: value.id_token ?? previous?.idToken, expiresAt: now() + value.expires_in * 1000, scopes: value.scope === undefined ? previous?.scopes || [] : value.scope.split(/\s+/).filter(Boolean), error: undefined };
  }
  async function accessToken(providerId, signal) {
    const id = typeof providerId === 'string' && providerId.startsWith('chatgpt:') ? providerId.slice(8) : '';
    let account = getAccount(id);
    if (!planEnabled(account)) throw new Error('Connect this ChatGPT account and enable ChatGPT plan usage before sending a message.');
    signal?.throwIfAborted();
    if (account.expiresAt > now() + 60000) return account.accessToken;
    if (!refreshes.has(id)) {
      const before = account;
      const operation = (async () => {
        if (!before.refreshToken) throw new Error('This ChatGPT session expired. Sign in again.');
        const config = await discovery();
        try {
          const value = await requestJSON(config.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: before.clientId, refresh_token: before.refreshToken, resource: CHATGPT_BASE_URL }) });
          const replacement = tokenFields(value, before);
          if (value.id_token) await identity(value.id_token, { clientId: before.clientId, subject: before.subject });
          await mutate(next => {
            const current = next.accounts.find(item => item.id === id);
            if (revoking.has(id) || !current || current.refreshToken !== before.refreshToken || current.accessToken !== before.accessToken) throw new Error('ChatGPT session changed while renewing; try again.');
            Object.assign(current, replacement);
          });
        } catch (error) {
          if (terminalRefreshErrors.has(error.code)) await mutate(next => { const current = next.accounts.find(item => item.id === id); if (current?.refreshToken === before.refreshToken) { delete current.accessToken; delete current.refreshToken; delete current.idToken; delete current.expiresAt; current.error = 'This ChatGPT session expired or was revoked. Sign in again.'; } });
          throw error;
        }
      })().finally(() => refreshes.delete(id));
      refreshes.set(id, operation);
    }
    await refreshes.get(id); signal?.throwIfAborted(); account = getAccount(id);
    if (!planEnabled(account)) throw new Error('ChatGPT plan usage is not enabled for this account.');
    return account.accessToken;
  }
  async function models(id, refresh = false) {
    const account = getAccount(id);
    if (!refresh && account.models.length) return { accountId: id, providerId: `chatgpt:${id}`, models: structuredClone(account.models) };
    const token = await accessToken(`chatgpt:${id}`);
    const catalog = chatGPTModels(await requestJSON(`${CHATGPT_BASE_URL}/models`, { headers: { Authorization: `Bearer ${token}` } }));
    await mutate(next => { const current = next.accounts.find(item => item.id === id); if (revoking.has(id) || current?.accessToken !== token) throw new Error('ChatGPT account changed while loading models'); current.models = catalog; delete current.error; });
    return { accountId: id, providerId: `chatgpt:${id}`, models: structuredClone(catalog) };
  }
  function endAttempt(attempt) {
    clearTimeout(attempt.timer); attempt.controller.abort(); attempt.server.close(); attempt.server.closeIdleConnections?.();
    if (pending === attempt) pending = null;
  }
  async function signIn(id) {
    if (closed) throw new Error('Faber is closing');
    if (pending) throw new Error('A ChatGPT sign-in is already open');
    if (!secureStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable');
    const saved = id ? getAccount(id) : null;
    if (!saved && vault.accounts.length >= 50) throw new Error('The maximum number of saved ChatGPT accounts has been reached');
    const attempt = { controller: new AbortController(), state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url'), accountId: id, clientId: saved?.clientId || vault.pendingClientId, subject: saved?.subject };
    pending = attempt; flow = { status: 'pending', ...(id ? { accountId: id } : {}) }; emit({ type: 'chatgpt', ...status() });
    try {
      const config = await discovery();
      if (pending !== attempt) throw new Error('ChatGPT sign-in was canceled');
      attempt.server = http.createServer((request, response) => {
        const reply = (code, text) => { response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' }); response.end(text); };
        void (async () => {
          if (pending !== attempt || request.method !== 'GET' || request.headers.host !== new URL(attempt.redirectUri).host || (request.url?.length || 0) > 32000) return reply(400, 'Invalid sign-in callback.');
          const url = new URL(request.url, attempt.redirectUri);
          if (url.pathname !== '/auth/callback') return reply(404, 'Not found.');
          if (['state', 'code', 'client_id', 'error'].some(key => url.searchParams.getAll(key).length > 1) || !same(url.searchParams.get('state'), attempt.state)) return reply(400, 'This sign-in callback did not match. Return to the sign-in window.');
          if (attempt.exchanging) return reply(409, 'Sign-in is already being completed.');
          attempt.exchanging = true;
          if (url.searchParams.has('error')) throw new Error(url.searchParams.get('error') === 'access_denied' ? 'ChatGPT sign-in was declined.' : 'ChatGPT sign-in did not complete. Try again.');
          const clientId = url.searchParams.get('client_id') || attempt.clientId, code = url.searchParams.get('code');
          if (!validClientId(clientId) || (attempt.clientId && clientId !== attempt.clientId) || !code || code.length > 16000) throw new Error('ChatGPT registration did not return a valid client and authorization code.');
          flow = { status: 'exchanging', ...(id ? { accountId: id } : {}) }; emit({ type: 'chatgpt', ...status() });
          // Registration is already issued even if its one-use code later fails.
          // Retain only this identifier until a token's identity has been verified.
          if (!attempt.clientId) await mutate(next => { next.pendingClientId = clientId; });
          if (pending !== attempt || attempt.controller.signal.aborted) throw new Error('ChatGPT sign-in was canceled');
          const value = await requestJSON(config.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: attempt.controller.signal, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: CHATGPT_BASE_URL }) });
          const verified = await identity(value.id_token, { clientId, nonce: attempt.nonce, subject: attempt.subject });
          const credentials = tokenFields(value);
          if (pending !== attempt || attempt.controller.signal.aborted) throw new Error('ChatGPT sign-in was canceled');
          const duplicate = vault.accounts.find(item => item.clientId === clientId && item.subject === verified.subject);
          const selectedId = id || duplicate?.id || randomUUID();
          await mutate(next => {
            if (pending !== attempt || attempt.controller.signal.aborted) throw new Error('ChatGPT sign-in was canceled');
            let account = next.accounts.find(item => item.id === selectedId);
            if (!account) { account = { id: selectedId, label: `Account ${next.accounts.length + 1}`, models: [] }; next.accounts.push(account); }
            Object.assign(account, { clientId, ...verified, ...credentials }); next.activeAccountId = selectedId;
            if (next.pendingClientId === clientId) delete next.pendingClientId;
          }, { guard: () => pending === attempt && !attempt.controller.signal.aborted, onCommit: () => {
            // Cancellation applies until the durable commit; completion wins after it.
            flow = { status: 'complete', accountId: selectedId }; endAttempt(attempt);
          } });
          reply(200, 'Connected to Faber. You can close this browser tab and return to Faber.');
          emit({ type: 'chatgpt', ...status() });
          if (planEnabled(getAccount(selectedId))) {
            try { await models(selectedId, true); }
            catch (error) { await mutate(next => { const current = next.accounts.find(item => item.id === selectedId); if (current) current.error = error.message; }); }
          }
        })().catch(error => { if (!response.headersSent) reply(400, 'Sign-in could not complete. Return to Faber for details.'); if (pending === attempt) { flow = { status: 'error', error: error.message }; endAttempt(attempt); emit({ type: 'chatgpt', ...status() }); } });
      });
      attempt.server.requestTimeout = 10000; attempt.server.headersTimeout = 10000;
      await new Promise((resolve, reject) => { attempt.server.once('error', reject); attempt.server.listen(0, '127.0.0.1', resolve); });
      attempt.redirectUri = `http://127.0.0.1:${attempt.server.address().port}/auth/callback`;
      attempt.timer = setTimeout(() => { if (pending === attempt) { flow = { status: 'error', error: 'ChatGPT sign-in timed out. Try again.' }; endAttempt(attempt); emit({ type: 'chatgpt', ...status() }); } }, signInTimeoutMs);
      const url = new URL(config.authorization);
      url.search = new URLSearchParams({ client_id: attempt.clientId || 'dynamic_agent_client', ext_agent_host_id: hostId, ...(attempt.clientId ? {} : { agent_name_hint: 'Faber' }), ...(saved?.idToken ? { id_token_hint: saved.idToken } : {}), ...(saved?.email ? { login_hint: saved.email } : {}), response_type: 'code', redirect_uri: attempt.redirectUri, scope: scopes, resource: CHATGPT_BASE_URL, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') }).toString();
      try { await openExternal(url.href); } catch { throw new Error('Could not open the ChatGPT sign-in page. Check your default browser and try again.'); }
      return status();
    } catch (error) { if (pending === attempt) { if (attempt.server) endAttempt(attempt); else { pending = null; attempt.controller.abort(); } flow = { status: 'error', error: error.message }; emit({ type: 'chatgpt', ...status() }); } throw error; }
  }
  function cancel() { if (!pending) return status(); if (pending.server) endAttempt(pending); else { pending.controller.abort(); pending = null; } flow = { status: 'idle' }; emit({ type: 'chatgpt', ...status() }); return status(); }
  async function signOut(id) {
    const account = getAccount(id); revoking.add(id);
    try {
      if (pending?.accountId === id) cancel();
      await stopProvider(`chatgpt:${id}`);
      await mutate(next => { const current = next.accounts.find(item => item.id === id); delete current.accessToken; delete current.refreshToken; delete current.idToken; delete current.expiresAt; delete current.error; });
      let revoked = !account.refreshToken;
      if (account.refreshToken) {
        try {
          const config = await discovery();
          if (config.revoke) for (let attempt = 0; attempt < 2; attempt++) {
            try { const response = await fetchImpl(config.revoke, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }) }); revoked = response.status === 200; await response.body?.cancel(); if (revoked || response.status < 500) break; } catch { /* Retry once without exposing the refresh token. */ }
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
          }
        } catch { /* Local sign-out remains effective when discovery is unavailable. */ }
      }
      return { ...status(), revoked, ...(!revoked ? { warning: 'Signed out locally. Remote revocation was not confirmed; disconnect Faber in ChatGPT Settings.' } : {}) };
    } finally { revoking.delete(id); emit({ type: 'chatgpt', ...status() }); }
  }
  const manager = {
    status, accessToken,
    controls(providerId, model) {
      if (!providerId.startsWith('chatgpt:')) return undefined;
      const entry = getAccount(providerId.slice(8)).models.find(item => item.id === model), efforts = entry?.reasoningEfforts || [];
      return { context: { configurable: false, mode: 'fixed', capacityTokens: entry?.contextTokens ?? null }, thinking: { supported: efforts.includes('none') && efforts.some(effort => effort !== 'none'), mode: 'responses', effective: null }, reasoning: { supported: efforts.length > 0, efforts: [...efforts], default: entry?.defaultReasoningEffort ?? null } };
    },
    assertAvailable(providerId, model, options = {}) {
      if (!providerId.startsWith('chatgpt:')) return;
      const account = getAccount(providerId.slice(8));
      if (!planEnabled(account)) throw new Error('Connect this ChatGPT account and enable ChatGPT plan usage first.');
      const entry = account.models.find(item => item.id === model);
      if (!entry) throw new Error('Refresh ChatGPT models and select one available to this account.');
      if (options.reasoningEffort != null && !entry.reasoningEfforts.includes(options.reasoningEffort)) throw new Error('This reasoning effort is not advertised for the selected ChatGPT model.');
    },
    async request(method, params = {}) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid ChatGPT request');
      const allowed = { 'chatgpt.status': [], 'chatgpt.signIn': ['accountId'], 'chatgpt.cancel': [], 'chatgpt.signOut': ['accountId'], 'chatgpt.select': ['accountId'], 'chatgpt.models': ['accountId', 'refresh'], 'chatgpt.usage': [] }[method];
      if (!allowed || Object.keys(params).some(key => !allowed.includes(key)) || (params.accountId !== undefined && !accountId(params.accountId)) || (params.refresh !== undefined && typeof params.refresh !== 'boolean')) throw new Error('Invalid ChatGPT request');
      if (method === 'chatgpt.status') return status();
      if (method === 'chatgpt.signIn') return signIn(params.accountId);
      if (method === 'chatgpt.cancel') return cancel();
      if (method === 'chatgpt.signOut') return signOut(params.accountId);
      if (method === 'chatgpt.select') { getAccount(params.accountId); await mutate(next => { next.activeAccountId = params.accountId; }); return status(); }
      if (method === 'chatgpt.models') return models(params.accountId, params.refresh);
      await openExternal('https://chatgpt.com/settings/usage'); return { opened: true };
    },
    async close() { closed = true; cancel(); await Promise.allSettled([queue, ...refreshes.values()]); },
  };
  await publish(); return manager;
}
