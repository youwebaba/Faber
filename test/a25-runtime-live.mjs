// Opt-in local inference acceptance. Requires an existing verified runner/model and isolated output directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRuntime } from '../core/runtime.mjs';
import { streamProvider } from '../core/provider.mjs';
import { runnerEnvironment } from '../local-models/hardware.mjs';
import { createRemoteHost, createRemoteController } from '../desktop/remote-transport.mjs';
import { createRelayHostAdapter, connectRelayController, generateRouteSecret, deriveRouteId } from '../desktop/remote-relay.mjs';
import { createRelayServer } from '../relay/server.mjs';

const executable = process.env.FABER_A25_LLAMA_EXECUTABLE, model = process.env.FABER_A25_MODEL_FILE, root = process.env.FABER_A25_LIVE_DIR;
for (const value of [executable, model, root]) if (!value || !path.isAbsolute(value)) throw new Error('Set absolute FABER_A25_LLAMA_EXECUTABLE, FABER_A25_MODEL_FILE and isolated FABER_A25_LIVE_DIR');
await fs.mkdir(root, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, timeout = 120000) { const started = Date.now(); while (Date.now() - started < timeout) { const value = await check(); if (value) return value; await pause(25); } throw new Error('Local runtime acceptance timed out'); }
const vault = () => { const values = new Map(); return { getSecret: id => values.get(id), setSecret: (id, value) => values.set(id, value) }; };
const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const secret = randomBytes(24).toString('hex'), baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(executable, ['--model', model, '--alias', 'steering-fixture', '--host', '127.0.0.1', '--port', String(port), '--api-key', secret, '--ctx-size', '8192', '--parallel', '1', '--n-gpu-layers', '0', '--device', 'none', '--threads', '2', '--threads-batch', '2', '--offline', '--jinja'], { env: runnerEnvironment(executable), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', runtime, receiver, controller, adapter, relay, spawnError;
child.on('error', error => { spawnError = error; });
for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', text => { logs = (logs + text).slice(-1024 * 1024); });
const report = { liveLocalInference: true, model: path.basename(model), cpu: true, contextTokens: 8192, threads: 2, advertisedTools: ['fixture_write'], sampling: { temperature: 0, seed: 42 }, checks: [], physicalTwoPc: false, apiWebSocketLive: false, subscriptionLive: false };
try {
  await until(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('Isolated local runner exited before health readiness');
    try { return (await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  });
  const secrets = vault();
  runtime = await createRuntime({ dataDir: path.join(root, 'host-profile'), sourceDir: path.resolve(import.meta.dirname, '..'),
    provider: args => streamProvider({ ...args, tools: args.tools.filter(tool => tool.name === 'fixture_write'), fetchImpl: (url, init) => fetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), temperature: 0, seed: 42 }) }) }),
    host: { ...secrets,
    providerControls: () => ({ context: { mode: 'managed', capacityTokens: 8192 }, thinking: { supported: true, mode: 'llama_cpp' } }),
  } });
  await runtime.request('settings.update', { runTimeoutMs: 120000 });
  const provider = await runtime.request('provider.save', { name: 'Isolated CPU runner', kind: 'openai', baseUrl: `${baseUrl}/v1`, model: 'steering-fixture', apiKey: secret });
  const effects = [];
  runtime.registerTools([{ name: 'fixture_write', description: 'Write the requested HTML file once, using the exact selected filename and full HTML content.', permission: 'files',
    parameters: { type: 'object', properties: { name: { enum: ['obsolete.html', 'corrected.html'] }, content: { type: 'string', maxLength: 100000 } }, required: ['name', 'content'], additionalProperties: false },
    execute: async ({ name, content }, ctx) => {
      const file = path.join(ctx.project.path, name); await ctx.authorizePath(file); ctx.signal.throwIfAborted();
      await fs.writeFile(file, content, { flag: 'wx', signal: ctx.signal }); effects.push({ projectId: ctx.project.id, name, bytes: Buffer.byteLength(content) });
      return { written: true, name, bytes: Buffer.byteLength(content) };
    },
  }]);
  async function prepare(label) {
    const workspace = path.join(root, label); await fs.mkdir(workspace);
    const project = await runtime.request('project.create', { name: label, path: workspace });
    const chat = await runtime.request('chat.create', { projectId: project.id });
    await runtime.request('chat.update', { id: chat.id, providerId: provider.id, thinking: false, grants: ['files'], systemPrompt: 'You are a tool calling assistant. Follow the latest user request. To create a file you must call fixture_write. Never claim to have written a file without a successful fixture_write tool result. Do not use shell tools. After the tool returns written:true, answer briefly and stop.' });
    return { project, chat, workspace };
  }
  const original = 'Call fixture_write to write obsolete.html. Its content must be a complete HTML page with 60 sections. Each section needs a heading and a different 80-word paragraph. Start generating the full HTML in the tool arguments now. Do not shorten the page.';
  const correction = 'Change of plan. Create a different file by calling fixture_write now with these exact arguments: {"name":"corrected.html","content":"<!doctype html><html><body>CORRECTED</body></html>"}. Do not create obsolete.html. Your next output must be the fixture_write tool call.';
  async function generation(chatId) {
    const state = await runtime.request('state.get'), run = state.runs.find(run => run.chatId === chatId);
    if (run && !['running', 'waiting_approval'].includes(run.status)) throw new Error(`Task ended before argument steering: ${run.status}: ${run.error || ''}`);
    const stream = state.streams.find(stream => stream.chatId === chatId && stream.phase === 'preparing_tools' && stream.metrics.generatedOutputTokens >= 20);
    return stream && { stream, run };
  }
  async function result(setup, sent, steered, started) {
    await until(async () => { const state = await runtime.request('state.get'); return state.runs.find(run => run.id === sent.runId)?.endedAt && state.runs.find(run => run.id === sent.runId)?.modelCalls.every(call => call.endedAt) && state; });
    await runtime.request('chat.forceStop', { chatId: setup.chat.id });
    const state = await runtime.request('state.get'), run = state.runs.find(run => run.id === sent.runId), writes = effects.filter(effect => effect.projectId === setup.project.id);
    assert.equal(run.status, 'completed', run.error); assert.equal(steered.runId, sent.runId); assert.equal(run.modelCalls[0].status, 'interrupted');
    assert.equal(writes.length, 1); assert.equal(writes[0].name, 'corrected.html'); await assert.rejects(fs.stat(path.join(setup.workspace, 'obsolete.html')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(setup.workspace, 'corrected.html'), 'utf8'), '<!doctype html><html><body>CORRECTED</body></html>'); assert.equal(run.steering.length, 1); assert.equal(run.steering[0].status, 'applied');
    assert.equal(state.chats.find(chat => chat.id === setup.chat.id).messages.filter(message => message.id === steered.messageId).length, 1);
    return { sameRun: true, obsoleteWrites: 0, correctedWrites: writes.length, progressBeforeDispatch: started.stream.metrics, modelCalls: run.modelCalls.map(call => ({ status: call.status, usage: call.usage || null, metrics: call.metrics })), promptUsage: run.promptUsage, correctionStatus: run.steering[0].status };
  }
  const local = await prepare('local-work');
  const localSent = await runtime.request('chat.send', { chatId: local.chat.id, text: original }); const localStarted = await until(() => generation(local.chat.id));
  assert.equal(localStarted.run.toolEvents.length, 0);
  const localSteered = await runtime.request('chat.steer', { chatId: local.chat.id, runId: localSent.runId, text: correction, correctionId: randomUUID() });
  report.checks.push({ name: 'local-generation-steer', ...await result(local, localSent, localSteered, localStarted) });
  console.log('Local live generation steering passed');

  const remote = await prepare('remote-work'), committed = deferred(); let loseAcknowledgement = true;
  await fs.mkdir(path.join(root, 'controller-profile'));
  receiver = await createRemoteHost({ host: vault(), allowLocalRelay: true, dispatch: async (method, envelope, authority) => {
    assert.equal(method, 'workspace.rpc');
    const value = await runtime.remoteRequest(envelope.method, envelope.params, { ...authority, requestId: envelope.requestId });
    if (envelope.method === 'chat.steer' && loseAcknowledgement) {
      loseAcknowledgement = false; committed.resolve(value);
      await new Promise((_resolve, reject) => { if (authority.signal.aborted) reject(authority.signal.reason); else authority.signal.addEventListener('abort', () => reject(authority.signal.reason), { once: true }); });
    }
    return value;
  } });
  const { port: targetPort } = await receiver.start(), registrationSecret = generateRouteSecret(), routeId = deriveRouteId(registrationSecret);
  relay = createRelayServer({ allowedRouteIds: [routeId] }); const relayAddress = await relay.start();
  const route = { relayUrl: `ws://127.0.0.1:${relayAddress.port}`, routeId };
  adapter = await createRelayHostAdapter({ ...route, registrationSecret, targetPort, allowLocalRelay: true });
  const controllerVault = vault(), controllerOptions = { host: controllerVault, allowLocalRelay: true, dial: (route, { signal } = {}) => connectRelayController(route, { signal, allowLocalRelay: true }) };
  controller = await createRemoteController(controllerOptions);
  const invitation = await receiver.createInvitation({ ...route, hostName: 'Isolated steering host' }); const pending = await controller.pair({ ...invitation, deviceName: 'Isolated steering controller' }); await receiver.acceptPairing(pending.id); const { connection } = await controller.completePairing();
  const rpc = (method, params, signal) => controller.request(connection.id, 'workspace.rpc', { method, params, requestId: randomUUID() }, { signal });
  const remoteSent = await rpc('chat.send', { chatId: remote.chat.id, text: original }); const remoteStarted = await until(() => generation(remote.chat.id));
  assert.equal(remoteStarted.run.toolEvents.length, 0);
  const correctionParams = { chatId: remote.chat.id, runId: remoteSent.runId, correctionId: randomUUID(), text: correction }, lost = new AbortController();
  const lostRequest = rpc('chat.steer', correctionParams, lost.signal); const rejected = assert.rejects(lostRequest);
  const firstReceipt = await committed.promise; lost.abort(new Error('Fixture drops the steering acknowledgement')); await rejected;
  await until(async () => { const state = await runtime.request('state.get'); return state.runs.find(run => run.id === remoteSent.runId)?.endedAt; });
  await controller.dispose(); controller = await createRemoteController(controllerOptions);
  const reconciled = await rpc('chat.steer', correctionParams); assert.equal(reconciled.messageId, firstReceipt.messageId); assert.equal(reconciled.status, 'applied');
  report.checks.push({ name: 'pinned-TLS-relay-lost-acknowledgement', acknowledgementLost: true, reconciledOnce: true, ...await result(remote, remoteSent, reconciled, remoteStarted) });
  await controller.dispose(); controller = undefined; await adapter.close(); adapter = undefined; await receiver.dispose(); receiver = undefined;
  await until(() => relay.status().sockets === 0 && relay.status().rooms === 0 && relay.status().sessions === 0); report.finalRelay = relay.status();
  console.log('Real TLS relay correction reconciliation passed');
  report.ok = true;
} catch (error) { report.ok = false; report.error = String(error.message).split(secret).join('[redacted]').replaceAll(root, '[isolated-output]').replaceAll(model, '[model]').replaceAll(executable, '[runner]'); throw error; }
finally {
  await controller?.dispose(); await adapter?.close(); await receiver?.dispose(); await relay?.close(); await runtime?.close();
  if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'close'), pause(5000)]); }
  report.runnerStopped = child.exitCode !== null || child.signalCode !== null;
  const safeLogs = logs.split(secret).join('[redacted]').replaceAll(root, '[isolated-output]').replaceAll(model, '[model]').replaceAll(executable, '[runner]');
  await fs.writeFile(path.join(root, 'runner.log'), safeLogs); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.map(check => check.name), runnerStopped: report.runnerStopped, physicalTwoPc: false }));
}
