import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createChatGPT, validateChatGPTIDToken, chatGPTModels } from '../desktop/chatgpt.mjs';
import { streamProvider } from '../core/provider.mjs';
import { responsesBody, responseEvents } from '../core/responses.mjs';
import { configuredControls } from '../core/controls.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] };
const issuer = 'https://auth.openai.com', base = 'https://api.openai.com/v1';
function token(claims) {
  const parts = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')];
  return `${parts.join('.')}.${sign('RSA-SHA256', Buffer.from(parts.join('.')), privateKey).toString('base64url')}`;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Fixture condition not reached'); }

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'faber-chatgpt-test-'));
  const encryptionKey = randomBytes(32);
  const secureStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      if (result.cancelDuringCredentialWrite && JSON.parse(value).accounts.some(account => account.accessToken === result.cancelDuringCredentialWrite)) {
        result.cancelDuringCredentialWrite = null; queueMicrotask(() => { void result.manager.request('chatgpt.cancel'); });
      }
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv), bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) { const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(); },
  };
  const result = { dataDir, browserUrls: [], calls: [], providers: [], events: [], clock: Date.now(), refreshCount: 0, revokeStatus: 200 };
  result.claims = (clientId, nonce) => ({ iss: issuer, aud: clientId, sub: 'fixture-subject', email: 'fixture@example.test', nonce, exp: Math.floor(result.clock / 1000) + 3600 });
  const fetchImpl = async (url, init = {}) => {
    result.calls.push({ url: String(url), init });
    if (String(url).endsWith('/.well-known/openid-configuration')) return json({ issuer, authorization_endpoint: `${issuer}/api/accounts/authorize`, token_endpoint: `${issuer}/api/accounts/oauth/token`, revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`, jwks_uri: `${issuer}/.well-known/jwks.json` });
    if (String(url).endsWith('/jwks.json')) return json(jwks);
    if (String(url).endsWith('/oauth/token')) {
      const params = new URLSearchParams(init.body), auth = new URL(result.browserUrls.at(-1));
      const refresh = params.get('grant_type') === 'refresh_token';
      if (refresh && result.refreshNetworkError) throw new Error('network fixture initial-refresh-secret');
      if (refresh && result.refreshError) return json({ error: result.refreshError, error_description: 'initial-refresh-secret' }, result.refreshStatus || 400);
      if (!refresh && result.exchangeError) return json({ error: result.exchangeError }, 400);
      if (refresh) { result.refreshCount++; if (result.refreshGate) await result.refreshGate; }
      else {
        assert.equal(params.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
        assert.equal(params.get('client_id'), auth.searchParams.get('client_id') === 'dynamic_agent_client' ? 'oaiapp_fixture' : auth.searchParams.get('client_id'));
        assert.ok(params.get('code_verifier').length >= 43);
      }
      return json({ access_token: refresh ? 'replacement-access-secret' : result.nextAccessToken || 'initial-access-secret', refresh_token: refresh ? 'replacement-refresh-secret' : 'initial-refresh-secret', id_token: token({ ...result.claims(params.get('client_id'), refresh ? undefined : auth.searchParams.get('nonce')), ...result.claimsOverride }), token_type: 'Bearer', expires_in: 3600, scope: options.noPlan ? 'openid profile email' : 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
    }
    if (String(url).endsWith('/oauth/revoke')) return new Response('', { status: result.revokeStatus });
    if (String(url) === `${base}/models`) {
      assert.match(init.headers.Authorization, /^Bearer (initial|replacement)-access-secret$/);
      return json({ models: [{ slug: 'fixture-model', display_name: 'Fixture Model', visibility: 'list', context_window: 128000, supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }], default_reasoning_effort: 'high' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }] });
    }
    throw new Error('Unexpected fixture URL');
  };
  const manager = await createChatGPT({ dataDir, secureStorage, fetchImpl, now: () => result.clock, openExternal: async url => { result.browserUrls.push(url); if (result.browserError) throw new Error(url); }, emit: event => result.events.push(event), syncProviders: async providers => { result.providers = providers; }, stopProvider: async id => { result.stopped = id; }, ...options.manager });
  result.manager = manager;
  result.secureStorage = secureStorage; result.fetchImpl = fetchImpl;
  result.saved = async () => JSON.parse(secureStorage.decryptString(await fs.readFile(path.join(dataDir, 'chatgpt-credentials.bin'))));
  result.callback = async (changes = {}) => {
    const auth = new URL(result.browserUrls.at(-1)), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture-code', client_id: 'oaiapp_fixture', ...changes });
    return fetch(callback);
  };
  result.connect = async () => { await manager.request('chatgpt.signIn'); const response = await result.callback(); assert.equal(response.status, 200); await response.text(); await until(() => manager.status().signIn.status === 'complete' && (options.noPlan || manager.status().accounts[0]?.models.length > 0)); return manager.status().accounts[0]; };
  t.after(async () => { await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return result;
}

test('OIDC signature and identity validation rejects issuer, audience, nonce, expiry, and account substitution', () => {
  const now = Date.now(), claims = { iss: issuer, aud: 'oaiapp_fixture', sub: 'user', nonce: 'attempt', exp: now / 1000 + 3600 };
  const options = { jwks, clientId: 'oaiapp_fixture', nonce: 'attempt', now };
  assert.equal(validateChatGPTIDToken(token(claims), options).subject, 'user');
  for (const patch of [{ iss: 'https://evil.test' }, { aud: 'another-client' }, { nonce: 'old-attempt' }, { exp: now / 1000 - 1 }, { aud: ['oaiapp_fixture', 'other'], azp: 'other' }]) assert.throws(() => validateChatGPTIDToken(token({ ...claims, ...patch }), options));
  assert.throws(() => validateChatGPTIDToken(token(claims), { ...options, subject: 'different-user' }), /identity/);
  const signed = token(claims).split('.'); signed[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'attacker' })).toString('base64url');
  assert.throws(() => validateChatGPTIDToken(signed.join('.'), options), /signature/);
});

test('loopback sign-in checks state, saves encrypted credentials, and exposes only redacted account/catalog', async t => {
  const f = await fixture(t);
  const state = await f.manager.request('chatgpt.signIn');
  assert.equal(state.signIn.status, 'pending');
  const auth = new URL(f.browserUrls[0]);
  assert.equal(auth.origin, issuer); assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(auth.searchParams.get('agent_name_hint'), 'Faber'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(auth.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
  const wrong = await f.callback({ state: 'incorrect' }); assert.equal(wrong.status, 400); await wrong.text();
  assert.equal(f.calls.filter(call => call.url.endsWith('/oauth/token')).length, 0);
  assert.equal(f.manager.status().signIn.status, 'pending');
  const valid = await f.callback(); assert.equal(valid.status, 200); await valid.text();
  await until(() => f.manager.status().accounts[0]?.models.length === 1);
  const account = f.manager.status().accounts[0];
  assert.equal(account.planEnabled, true); assert.equal(account.models[0].contextTokens, 128000);
  assert.deepEqual(account.models[0].reasoningEfforts, ['none', 'high']);
  assert.ok(!JSON.stringify([f.manager.status(), f.providers, f.events]).includes('access-secret'));
  assert.ok(!(await fs.readFile(path.join(f.dataDir, 'chatgpt-credentials.bin'))).includes(Buffer.from('initial-access-secret')));
  await f.manager.request('chatgpt.signIn', { accountId: account.id });
  const returning = new URL(f.browserUrls.at(-1));
  assert.equal(returning.searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(returning.searchParams.get('agent_name_hint'), null);
  assert.equal(returning.searchParams.get('ext_agent_host_id'), auth.searchParams.get('ext_agent_host_id'));
  f.manager.request('chatgpt.cancel');
});

test('login without plan scope retains identity but cannot call models or inference', async t => {
  const f = await fixture(t, { noPlan: true }), account = await f.connect();
  assert.equal(account.connected, true); assert.equal(account.planEnabled, false);
  await assert.rejects(f.manager.accessToken(account.providerId), /plan usage/);
  assert.equal(f.calls.filter(call => call.url === `${base}/models`).length, 0);
});

test('invalid nonce callback never saves a connected account', async t => {
  const f = await fixture(t); f.claimsOverride = { nonce: 'wrong-nonce' };
  await f.manager.request('chatgpt.signIn'); const response = await f.callback(); assert.equal(response.status, 400); await response.text();
  await until(() => f.manager.status().signIn.status === 'error');
  assert.equal(f.manager.status().accounts.length, 0);
});

test('concurrent refresh is serialized and signout retains registration without tokens', async t => {
  const f = await fixture(t), account = await f.connect(); f.clock += 3601 * 1000;
  assert.deepEqual(await Promise.all([f.manager.accessToken(account.providerId), f.manager.accessToken(account.providerId)]), ['replacement-access-secret', 'replacement-access-secret']);
  assert.equal(f.refreshCount, 1);
  const result = await f.manager.request('chatgpt.signOut', { accountId: account.id });
  assert.equal(result.revoked, true); assert.equal(f.stopped, account.providerId);
  assert.equal(result.accounts[0].connected, false); await assert.rejects(f.manager.accessToken(account.providerId), /Connect/);
  await f.manager.request('chatgpt.signIn', { accountId: account.id });
  const auth = new URL(f.browserUrls.at(-1)); assert.equal(auth.searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(auth.searchParams.get('id_token_hint'), null);
  await f.manager.request('chatgpt.cancel');
});

test('a late refresh cannot restore credentials after signout', async t => {
  const f = await fixture(t), account = await f.connect(); f.clock += 3601 * 1000;
  let release; f.refreshGate = new Promise(resolve => { release = resolve; });
  const refreshing = f.manager.accessToken(account.providerId); const rejected = assert.rejects(refreshing, /session changed/);
  await until(() => f.refreshCount === 1);
  await f.manager.request('chatgpt.signOut', { accountId: account.id }); release(); await rejected;
  assert.equal(f.manager.status().accounts[0].connected, false);
});

test('every documented terminal refresh error clears credentials without exposing response details', async t => {
  for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) await t.test(code, async t => {
    const f = await fixture(t), account = await f.connect(); f.clock += 3601 * 1000; f.refreshError = code;
    await assert.rejects(f.manager.accessToken(account.providerId), error => /Sign in again/.test(error.message) && !error.message.includes('secret'));
    assert.equal(f.manager.status().accounts[0].connected, false);
    assert.ok(!JSON.stringify(f.manager.status()).includes('secret'));
    const saved = await f.saved(); assert.equal(saved.accounts[0].accessToken, undefined); assert.equal(saved.accounts[0].refreshToken, undefined);
    await f.manager.request('chatgpt.signIn', { accountId: account.id });
    assert.equal(new URL(f.browserUrls.at(-1)).searchParams.get('client_id'), 'oaiapp_fixture');
  });
});

test('temporary refresh network and server failures preserve renewable credentials', async t => {
  for (const failure of ['network', '503', 'invalid_client']) await t.test(failure, async t => {
    const f = await fixture(t), account = await f.connect(); f.clock += 3601 * 1000;
    if (failure === 'network') f.refreshNetworkError = true;
    else { f.refreshError = failure === '503' ? 'server_error' : 'invalid_client'; f.refreshStatus = failure === '503' ? 503 : 400; }
    await assert.rejects(f.manager.accessToken(account.providerId));
    assert.equal(f.manager.status().accounts[0].connected, true);
    assert.equal((await f.saved()).accounts[0].refreshToken, 'initial-refresh-secret');
  });
});

test('cancel during first credential write rolls back persisted tokens before publishing', async t => {
  const f = await fixture(t); f.cancelDuringCredentialWrite = 'initial-access-secret';
  await f.manager.request('chatgpt.signIn'); const response = await f.callback(); assert.equal(response.status, 400); await response.text();
  assert.equal(f.manager.status().signIn.status, 'idle'); assert.equal(f.manager.status().accounts.length, 0);
  assert.equal((await f.saved()).accounts.length, 0);
  assert.ok(!f.events.some(event => event.signIn.status === 'complete' || event.accounts.some(account => account.connected)));
  assert.equal(f.providers.length, 0);
});

test('cancel during reauthorization credential write preserves the previous session on disk and in memory', async t => {
  const f = await fixture(t), account = await f.connect(), eventIndex = f.events.length;
  f.nextAccessToken = 'new-access-secret'; f.cancelDuringCredentialWrite = f.nextAccessToken;
  await f.manager.request('chatgpt.signIn', { accountId: account.id });
  const response = await f.callback(); assert.equal(response.status, 400); await response.text();
  assert.equal(f.manager.status().signIn.status, 'idle');
  assert.equal(await f.manager.accessToken(account.providerId), 'initial-access-secret');
  assert.equal((await f.saved()).accounts[0].accessToken, 'initial-access-secret');
  assert.ok(!f.events.slice(eventIndex).some(event => event.signIn.status === 'complete'));
});

test('failed initial code exchange retains the issued registration for a fresh retry after restart', async t => {
  const f = await fixture(t); f.exchangeError = 'invalid_grant';
  await f.manager.request('chatgpt.signIn'); const first = new URL(f.browserUrls.at(-1));
  const response = await f.callback(); assert.equal(response.status, 400); await response.text();
  assert.equal(f.manager.status().accounts.length, 0);
  assert.equal((await f.saved()).pendingClientId, 'oaiapp_fixture');
  await f.manager.close();
  const restored = await createChatGPT({ dataDir: f.dataDir, secureStorage: f.secureStorage, fetchImpl: f.fetchImpl, openExternal: url => { f.browserUrls.push(url); } });
  try {
    await restored.request('chatgpt.signIn'); const retry = new URL(f.browserUrls.at(-1));
    assert.equal(retry.searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(retry.searchParams.get('agent_name_hint'), null);
    assert.notEqual(retry.searchParams.get('state'), first.searchParams.get('state'));
    assert.notEqual(retry.searchParams.get('code_challenge'), first.searchParams.get('code_challenge'));
  } finally { await restored.close(); }
});

test('browser launch errors redact authorization URLs and identity hints', async t => {
  const f = await fixture(t), account = await f.connect(); f.browserError = true;
  await assert.rejects(f.manager.request('chatgpt.signIn', { accountId: account.id }), /Could not open the ChatGPT sign-in page/);
  assert.equal(new URL(f.browserUrls.at(-1)).searchParams.has('id_token_hint'), true);
  assert.ok(!JSON.stringify(f.manager.status()).includes('id_token_hint'));
  assert.ok(!JSON.stringify(f.manager.status()).includes('auth.openai.com'));
});

test('returning registration rejects a substituted client and canceled callbacks do not sign in', async t => {
  const f = await fixture(t), account = await f.connect(), calls = f.calls.filter(call => call.url.endsWith('/oauth/token')).length;
  await f.manager.request('chatgpt.signIn', { accountId: account.id });
  const bad = await f.callback({ client_id: 'oaiapp_other' }); assert.equal(bad.status, 400); await bad.text();
  await until(() => f.manager.status().signIn.status === 'error');
  assert.equal(f.calls.filter(call => call.url.endsWith('/oauth/token')).length, calls);
  await f.manager.request('chatgpt.signIn'); await f.manager.request('chatgpt.cancel');
  await assert.rejects(f.callback());
  assert.equal(f.manager.status().accounts.length, 1);
});

test('failed remote revocation still signs out locally and reports the unresolved remote connection', async t => {
  const f = await fixture(t), account = await f.connect(); f.revokeStatus = 503;
  const result = await f.manager.request('chatgpt.signOut', { accountId: account.id });
  assert.equal(result.revoked, false); assert.match(result.warning, /not confirmed/);
  assert.equal(result.accounts[0].connected, false);
  assert.equal(f.calls.filter(call => call.url.endsWith('/oauth/revoke')).length, 2);
});

test('unknown catalog capabilities stay unknown and controls enforce declared effort', () => {
  assert.deepEqual(chatGPTModels({ models: [{ slug: 'unknown', display_name: 'Unknown', visibility: 'list' }] }), [{ id: 'unknown', name: 'Unknown', contextTokens: null, reasoningEfforts: [], defaultReasoningEffort: null }]);
  const provider = { id: 'chatgpt:fixture', authKind: 'chatgpt', kind: 'openai-responses', baseUrl: base, model: 'fixture' };
  const declared = { context: { capacityTokens: 128000 }, reasoning: { efforts: ['none', 'high'], default: 'high' } };
  assert.throws(() => configuredControls(provider, { reasoningEffort: 'medium' }, declared), /not advertised/);
  const controls = configuredControls(provider, { reasoningEffort: 'high' }, declared);
  assert.equal(controls.context.configurable, false); assert.equal(controls.context.capacityTokens, 128000); assert.equal(controls.reasoning.selected, 'high');
  const onlyNone = { reasoning: { efforts: ['none'], default: 'none' } };
  assert.equal(configuredControls(provider, { reasoningEffort: 'none' }, onlyNone).thinking.supported, false);
  assert.throws(() => configuredControls(provider, { thinking: true }, onlyNone), /Thinking on\/off is unsupported/);
});

test('account inference uses only official endpoint and never generic API credentials', async () => {
  const provider = { id: 'chatgpt:fixture', authKind: 'chatgpt', kind: 'openai-responses', baseUrl: base, hasKey: true, model: 'fixture' };
  let tokenReads = 0, fetched = 0;
  const host = { getChatGPTToken: async () => { tokenReads++; return 'oauth-secret'; }, getSecret: () => { throw new Error('Must not read API key'); } };
  const fetchImpl = async (url, init) => { fetched++; assert.equal(url, `${base}/responses`); assert.equal(init.headers.Authorization, 'Bearer oauth-secret'); const body = JSON.parse(init.body); assert.equal(body.store, false); assert.equal(body.stream, true); return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } }) + '\n\n'); };
  const collect = async p => { const events = []; for await (const event of streamProvider({ provider: p, host, fetchImpl, messages: [], tools: [] })) events.push(event); return events; };
  assert.ok((await collect(provider)).some(event => event.type === 'delta' && event.text === 'ok'));
  await assert.rejects(collect({ ...provider, baseUrl: 'https://evil.test/v1' }), /official Responses/);
  assert.equal(tokenReads, 1); assert.equal(fetched, 1);
});

test('account Responses payload uses developer instructions and namespaced tools', async () => {
  const provider = { id: 'chatgpt:fixture', authKind: 'chatgpt', kind: 'openai-responses', baseUrl: base, model: 'fixture', chatOptions: { reasoningEffort: 'high' } };
  const body = responsesBody({ provider, messages: [{ role: 'system', content: 'Instructions' }], tools: [{ name: 'system_time', description: 'Time', parameters: { type: 'object', properties: {} } }] });
  assert.equal(body.input[0].role, 'developer'); assert.equal(body.tools[0].type, 'namespace'); assert.equal(body.tools[0].name, 'faber'); assert.equal(body.reasoning.effort, 'high');
  const frame = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', namespace: 'other', call_id: 'call', name: 'system_time', arguments: '{}' }] } };
  await assert.rejects(async () => { for await (const _ of responseEvents([frame], provider)) {} }, /namespace/);
});
