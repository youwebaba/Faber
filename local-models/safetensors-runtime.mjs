import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputPath, noLinks, validFilePath } from '../model-hub/paths.mjs';
import { createSafetensorsProxy } from './safetensors-proxy.mjs';
import { createSafetensorsTransport } from './safetensors-transport.mjs';
import { verifySafetensorsRuntime } from './safetensors-integrity.mjs';

const supported = new Set(['llama', 'qwen2', 'qwen3', 'qwen3_moe', 'mistral']);
async function configAt(filename, maximum = 1024 * 1024) {
  await noLinks(filename); const before = await fs.lstat(filename);
  if (!before.isFile() || before.size > maximum) throw new Error('Model JSON exceeds the bounded inspection limit');
  const handle = await fs.open(filename, 'r');
  try {
    const bytes = Buffer.alloc(before.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
    if (bytesRead !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Model configuration changed; refresh the library');
    await noLinks(filename); const data = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid model configuration'); return data;
  } finally { await handle.close(); }
}
export async function inspectSafetensorsPackage(directory, model) {
  if (!model.complete || !model.files?.length || model.files.some(file => !file.endsWith('.safetensors'))) throw new Error(model.reason || 'Select a complete Safetensors weight package');
  const folder = path.posix.dirname(model.files[0]);
  if (model.files.some(file => path.posix.dirname(file) !== folder)) throw new Error('This native chat runtime accepts one language model, not a multi-component music or diffusion pipeline');
  const config = folder === '.' ? 'config.json' : `${folder}/config.json`;
  const data = await configAt(await outputPath(directory, config));
  if (!supported.has(data.model_type)) throw new Error(`This CPU runtime has not qualified architecture ${String(data.model_type || 'unknown').slice(0, 60)}. Use a supported Llama, Qwen2/Qwen3 or Mistral package, GGUF, or an external compatible connection.`);
  if (data.auto_map || data.quantization_config) throw new Error('This native CPU path does not load custom model code or prequantized Safetensors checkpoints. Choose original supported weights or a compatible external connection.');
  const files = [...new Set([...model.files, ...(model.supportFiles || [])])];
  const tokenizer = folder === '.' ? 'tokenizer.json' : `${folder}/tokenizer.json`;
  if (!files.includes(tokenizer)) throw new Error('This native chat runtime requires tokenizer.json beside config.json and the weights. Download a complete language-model package.');
  return { folder, files: files.filter(file => folder === '.' ? !file.includes('/') || /^(?:tokenizer|processor)\//.test(file) : file.startsWith(`${folder}/`)), architecture: data.model_type };
}

export async function createSafetensorsRuntime({ dataDir, executable, fetchImpl = fetch, verifyImpl } = {}) {
  const candidate = executable || fileURLToPath(new URL('../.runtime/safetensors-runtime/faber-safetensors.exe', import.meta.url));
  let installed = false, reason = 'The native Safetensors CPU runtime is unavailable. Install or repair the full Faber Windows application, or choose a compatible GGUF/external connection.';
  const verify=async()=>{await noLinks(candidate);if(verifyImpl)return verifyImpl(candidate);const manifest=JSON.parse(await fs.readFile(new URL('../build/safetensors-runtime-lock.json',import.meta.url),'utf8'));return verifySafetensorsRuntime(path.dirname(candidate),manifest);};
  try {if(await verify())installed=true;else reason='The native Safetensors runtime failed its pinned integrity check. Repair Faber before starting this model.';}catch(error){if(error.code!=='ENOENT')reason=`Native Safetensors runtime unavailable: ${error.message}`;}
  return {
    status: { available: installed, backend: 'cpu', runtime: 'mistralrs', version: '0.9.5', ...(!installed ? { reason } : {}) },
    async describe(directory, model) {
      if (!model.complete) return model;
      try { const info = await inspectSafetensorsPackage(directory, model); return { ...model, available: installed, runtime: 'mistralrs', architecture: info.architecture, reason: installed ? undefined : reason }; }
      catch (error) { return { ...model, available: false, reason: error.message }; }
    },
    async prepare({ directory, model, operation, nativePort, configuration, contextTokens }) {
      if (!installed) throw new Error(reason);
      if(!await verify())throw new Error('Native Safetensors integrity changed. Repair Faber before loading weights.');
      if (contextTokens !== null) throw new Error('This native Safetensors CPU loader currently supports Default context only. Select Default and start again, or use a configurable GGUF/external runtime.');
      if (configuration.mode === 'custom' || configuration.cpuIds.length || !configuration.memoryMap) throw new Error('This native CPU loader supports Automatic/CPU mode with automatic cores and disk-backed memory enabled. Change hardware settings before starting, or use GGUF for custom placement.');
      const info = await inspectSafetensorsPackage(directory, model), parent = await outputPath(directory, info.folder === '.' ? path.posix.basename(model.files[0]) : info.folder + '/config.json');
      const stage = await fs.mkdtemp(path.join(path.dirname(parent), '.faber-safetensors-'));
      let proxy;const transport=createSafetensorsTransport();
      const close = async () => { transport.close();await proxy?.close(); await noLinks(stage); if (!path.basename(stage).startsWith('.faber-safetensors-') || path.dirname(stage) !== path.dirname(parent)) throw new Error('Native staging directory identity changed; preserved'); await fs.rm(stage, { recursive: true, force: true }); };
      try {
        for (const relative of info.files) {
          operation.controller.signal.throwIfAborted();
          const source = await outputPath(directory, relative), name = info.folder === '.' ? relative : relative.slice(info.folder.length + 1), destination = await outputPath(stage, name);
          const before = await fs.lstat(source); if (!before.isFile() || before.isSymbolicLink()) throw new Error('A model asset changed; refresh the library');
          await fs.mkdir(path.dirname(destination), { recursive: true });
          if(model.files.includes(relative))await fs.link(source, destination);else await fs.copyFile(source,destination,constants.COPYFILE_EXCL);
          const after = await fs.lstat(source); if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('A model asset changed during preparation');
        }
        await inspectSafetensorsPackage(stage,{...model,files:model.files.map(file=>info.folder==='.'?file:file.slice(info.folder.length+1)),supportFiles:info.files.filter(file=>!model.files.includes(file)).map(file=>info.folder==='.'?file:file.slice(info.folder.length+1))});
        const weights=new Set(model.files.map(file=>path.posix.basename(file)));
        for(const name of await fs.readdir(stage))if(name.endsWith('.safetensors.index.json')){
          const index=await configAt(path.join(stage,name),2*1024*1024);
          if(!index.weight_map||typeof index.weight_map!=='object'||Array.isArray(index.weight_map)||!Object.keys(index.weight_map).length)throw new Error('Invalid native Safetensors index');
          for(const file of Object.values(index.weight_map)){validFilePath(file);if(!weights.has(file))throw new Error('Native Safetensors index references an unselected file');}
        }
        proxy = await createSafetensorsProxy({ upstream: 'http://127.0.0.1:1', key: operation.key, alias: operation.alias, signal: operation.controller.signal, fetchImpl:transport.fetch });
        const env = { ...process.env, HF_HUB_OFFLINE: '1', HF_HOME: path.join(dataDir, 'local-models', 'offline-cache') };
        for (const name of Object.keys(env)) if (/^(?:HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HUGGINGFACE_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|MISTRALRS_.*|MCP_CONFIG_PATH|RAYON_NUM_THREADS)$/i.test(name)) delete env[name];
        if (configuration.threads) env.RAYON_NUM_THREADS = String(configuration.threads);
        return { executable: candidate, env, args: [stage], baseUrl: proxy.baseUrl, attach:transport.attach, close };
      } catch (error) { await close(); if (error.code === 'EPERM' || error.code === 'ENOTSUP') throw new Error('This model drive cannot create safe native package hardlinks. Move the package to NTFS or use a compatible external runtime.'); throw error; }
    },
  };
}
