// Opt-in, actual local inference only: node test/core-live-smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../core/runtime.mjs';
import { fileTools } from '../tools/files.mjs';
import { shellTool } from '../tools/process.mjs';

const sourceDir = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'sophia-live-smoke-'));
const dataDir = join(directory, 'data'), workspace = join(directory, 'workspace');
await mkdir(workspace);
await writeFile(join(workspace, 'README.txt'), 'This isolated harness smoke fixture contains the verification token HARNESS_FILE_READY.\n');
const runtime = await createRuntime({ dataDir, sourceDir });
const report = { model: 'qwen3.5:9b', baseUrl: 'http://127.0.0.1:11434', startedAt: new Date().toISOString(), checks: [] };
let succeeded = false;
try {
  runtime.registerTools([...fileTools(), shellTool()]);
  await runtime.request('settings.update', { maxAgents: 4, maxDepth: 2, runTimeoutMs: 120000 });
  const configured = (await runtime.request('state.get')).providers[0];
  assert.equal(configured.kind, 'ollama'); assert.equal(configured.baseUrl, report.baseUrl); assert.equal(configured.model, report.model);
  const availability = await runtime.request('provider.test', { id: configured.id });
  assert.ok(availability.ok, availability.error); assert.ok(availability.models.includes(report.model), 'Required model is not installed; no download or fallback is allowed');
  const project = await runtime.request('project.create', { name: 'Isolated actual-local smoke', path: workspace });
  async function runCheck(name, prompt, expected, grants = []) {
    const chat = await runtime.request('chat.create', { projectId: project.id, title: name });
    if (grants.length) await runtime.request('chat.update', { id: chat.id, grants });
    const started = Date.now();
    const { runId } = await runtime.request('chat.send', { chatId: chat.id, text: prompt });
    await new Promise((resolveDone, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error(`${name}: test deadline exceeded`)); }, 125000);
      const unsubscribe = runtime.subscribe(event => {
        if (event.type !== 'state') return;
        const run = event.state.runs.find(item => item.id === runId);
        if (run && !['running', 'waiting_approval'].includes(run.status)) { clearTimeout(timer); unsubscribe(); resolveDone(); }
      });
    });
    const state = await runtime.request('state.get'), run = state.runs.find(item => item.id === runId);
    const record = { name, runId, status: run.status, elapsedMs: Date.now() - started, tools: run.toolEvents.map(event => ({ name: event.name, status: event.status, error: event.error })), error: run.error };
    report.checks.push(record);
    assert.equal(run.status, 'completed', `${name}: ${run.error || run.status}`);
    for (const tool of expected) assert.ok(run.toolEvents.some(event => event.name === tool && event.status === 'completed'), `${name}: missing successful ${tool}`);
    assert.ok(state.chats.find(item => item.id === chat.id).messages.some(message => message.role === 'assistant' && message.content.trim()), `${name}: missing final answer`);
    return { state, run };
  }
  await runCheck('workspace read', 'Use project_list, then use files_read with path README.txt in this current workspace. Report the exact verification token from the file. Do not delegate this check.', ['project_list', 'files_read']);
  const delegated = await runCheck('delegation', 'Use agent_create to start exactly one child agent with this task: "Use files_read with path README.txt in your current workspace and report its verification token. Do not delegate." Then use agent_wait on its runId with timeoutMs 60000. If still running, wait again. Report the child result. Do not read the file yourself.', ['agent_create', 'agent_wait']);
  const children = delegated.state.runs.filter(run => run.parentRunId === delegated.run.id);
  assert.equal(children.length, 1, 'Expected exactly one child run');
  assert.equal(children[0].status, 'completed', `Child did not complete: ${children[0].error || children[0].status}`);
  assert.ok(children[0].toolEvents.some(event => event.name === 'files_read' && event.status === 'completed'), 'Child did not actually read fixture');
  await runCheck('fixture shell', 'Use shell_run exactly once with command "Write-Output HARNESS_SHELL_READY" and timeoutMs 5000. Report its output. Do not create files or use any other shell command.', ['shell_run'], ['shell']);
  const persisted = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
  report.runtimeToolCount = (await runtime.request('state.get')).tools.length;
  report.persistedRunCount = persisted.runs.length;
  assert.ok(persisted.runs.every(run => run.status === 'completed'));
  succeeded = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
} finally {
  await runtime.close();
  report.completedAt = new Date().toISOString(); report.ok = succeeded;
  if (!succeeded) { report.evidenceDirectory = directory; await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report, null, 2));
  if (succeeded) {
    assert.ok(relative(resolve(tmpdir()), resolve(directory)).startsWith('sophia-live-smoke-'));
    await rm(directory, { recursive: true, force: true });
  }
}
