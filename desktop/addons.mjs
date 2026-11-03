import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateExtension} from './extensions.mjs';
import {atomicWrite} from './recovery.mjs';
import {containedPath} from '../tools/files.mjs';
import {validate,checkTool} from '../core/registry.mjs';

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const permissions = ['read', 'files', 'shell', 'computer', 'network', 'upgrade'];
const MAX_BYTES = 32 * 1024 * 1024, MAX_FILES = 512;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const object = (properties, required = []) => ({type:'object', properties, required, additionalProperties:false});
const idSchema = {type:'string', pattern:'^[a-z][a-z0-9-]{0,63}$'};
const requests = {
  'addons.list': object({}), 'addons.import': object({kind:{type:'string',enum:['file','folder']}}, ['kind']),
  'addons.enable': object({id:idSchema}, ['id']), 'addons.disable': object({id:idSchema}, ['id']),
  'addons.uninstall': object({id:idSchema}, ['id']), 'addons.reset': object({id:idSchema}, ['id']),
  'addons.rollback': object({id:idSchema}, ['id']), 'addons.openDirectory': object({id:idSchema}),
};

function untilAborted(result, signal) {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(result).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

export function addonPath(value) {
  if (typeof value !== 'string' || value.length > 240 || !value || /[\\\x00-\x1f<>:"|?*]/.test(value)) throw new Error('Invalid addon file path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ['.git','node_modules'].includes(part.toLowerCase()))) throw new Error('Invalid addon file path');
  return value;
}

export function addonManifest(value) {
  if (!plain(value) || Object.keys(value).some(key => !['schemaVersion','id','name','version','description','entry','hostApi','permissions'].includes(key))) throw new Error('Invalid addon manifest fields');
  if (value.schemaVersion !== 1 || !idPattern.test(value.id || '') || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || !/^\d+\.\d+\.\d+$/.test(value.version || '')) throw new Error('Invalid addon identity or version');
  if (value.hostApi !== 1) throw new Error('Incompatible addon: this Faber version supports hostApi 1');
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2000)) throw new Error('Invalid addon description');
  if (!Array.isArray(value.permissions) || value.permissions.some(permission => !permissions.includes(permission)) || new Set(value.permissions).size !== value.permissions.length) throw new Error('Invalid addon permission declaration');
  addonPath(value.entry);
  if (!/\.mjs$/.test(value.entry)) throw new Error('Addon entry must be an ES module (.mjs)');
  return structuredClone(value);
}

function packageFromFiles(files, expectedId) {
  if (!(files instanceof Map) || !files.size || files.size > MAX_FILES) throw new Error('Addon must contain 1–512 files');
  let bytes = 0; const names = new Set();
  for (const [name, content] of files) {
    addonPath(name); const folded = name.toLowerCase();
    if (names.has(folded)) throw new Error('Duplicate addon file path'); names.add(folded);
    if (!Buffer.isBuffer(content)) throw new Error('Invalid addon file contents');
    bytes += content.length; if (bytes > MAX_BYTES) throw new Error('Addon exceeds the 32 MiB package limit');
  }
  if (!files.has('addon.json')) throw new Error('Addon folder requires addon.json');
  let raw; try {raw = JSON.parse(files.get('addon.json').toString('utf8'));} catch {throw new Error('Invalid addon.json');}
  const manifest = addonManifest(raw);
  if (expectedId && manifest.id !== expectedId) throw new Error('Addon folder and manifest IDs differ');
  if (!files.has(manifest.entry)) throw new Error('Addon entry file is missing');
  const digest = crypto.createHash('sha256');
  for (const name of [...files.keys()].sort()) { const content = files.get(name); digest.update(JSON.stringify([name,content.length])); digest.update(content); }
  return {manifest, files, digest:digest.digest('hex'), bytes};
}

async function readFolder(directory, expectedId) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Addon folder must be a real directory, not a link');
  const root = await fs.realpath(directory), files = new Map(); let bytes = 0, entries = 0;
  async function visit(relative = '') {
    const folder = await containedPath(root, relative || '.');
    for (const entry of await fs.readdir(folder, {withFileTypes:true})) {
      if (++entries > MAX_FILES * 2) throw new Error('Addon contains too many entries');
      const name = addonPath(relative ? `${relative}/${entry.name}` : entry.name);
      if (entry.isSymbolicLink()) throw new Error('Addon links are not allowed');
      const filename = await containedPath(root, name), info = await fs.lstat(filename);
      if (info.isSymbolicLink()) throw new Error('Addon changed during inspection');
      if (info.isDirectory()) await visit(name);
      else if (info.isFile()) {
        if (files.size >= MAX_FILES || info.size + bytes > MAX_BYTES) throw new Error('Addon exceeds package limits');
        const content = await fs.readFile(filename); bytes += content.length;
        if (bytes > MAX_BYTES) throw new Error('Addon exceeds package limits'); files.set(name, content);
      } else throw new Error('Only ordinary addon files are supported');
    }
  }
  await visit(); return packageFromFiles(files, expectedId);
}

export async function readAddonPackage(filename) {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) throw new Error('Addon imports cannot be links');
  if (stat.isDirectory()) return readFolder(filename);
  if (!stat.isFile() || stat.size > MAX_BYTES * 2) throw new Error('Expected an addon folder or package up to 64 MiB');
  let packageFile; try {packageFile = JSON.parse(await fs.readFile(filename, 'utf8'));} catch {throw new Error('Expected a .faber-addon.json package');}
  if (!plain(packageFile) || packageFile.schemaVersion !== 1 || !Array.isArray(packageFile.files) || packageFile.files.length >= MAX_FILES || Object.keys(packageFile).some(key => !['schemaVersion','manifest','files'].includes(key))) throw new Error('Invalid addon package');
  const manifest = addonManifest(packageFile.manifest);
  const files = new Map([['addon.json', Buffer.from(JSON.stringify(manifest,null,2))]]);
  for (const file of packageFile.files) {
    if (!plain(file) || Object.keys(file).some(key => !['path','content','encoding'].includes(key)) || typeof file.content !== 'string') throw new Error('Invalid addon package file');
    addonPath(file.path);
    if (files.has(file.path) || file.path.toLowerCase() === 'addon.json') throw new Error('Duplicate addon file path');
    const encoding = file.encoding ?? 'utf8';
    if (!['utf8','base64'].includes(encoding) || (encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))) throw new Error('Invalid addon file encoding');
    files.set(file.path, Buffer.from(file.content, encoding));
  }
  return packageFromFiles(files);
}

export function createAddons({dataDir,runtime,confirm,chooseAddon,openPath,emit = () => {},loadTimeoutMs=10000,bundledSource,bundledResources={}}) {
  const directory = path.join(dataDir,'addons'), storage = path.join(dataDir,'addon-manager'), dataRoot = path.join(dataDir,'addon-data');
  const stateFile = path.join(storage,'state.json'), active = new Map(), records = new Map(), bundledSeen = new Set(), factoryDigests = new Map();
  const automaticNames = new Set(['lightpanda_status','lightpanda_setup','lightpanda_connect','lightpanda_navigate','lightpanda_read','lightpanda_click','lightpanda_type','lightpanda_evaluate','lightpanda_close','lightpanda_stop']);
  const unsubscribeRuns=runtime.subscribe?.(event=>{
    if(event.type!=='state')return;
    const ongoing=new Set(event.state.runs.filter(run=>['running','waiting_approval'].includes(run.status)).map(run=>run.id));
    for(const entry of active.values())for(const runId of entry.runs.keys())if(!ongoing.has(runId)){
      entry.runs.delete(runId);
      if(entry.automatic&&typeof entry.module.releaseRun==='function')Promise.resolve(entry.module.releaseRun(runId)).catch(error=>{warnings.push(`Lightpanda release: ${error.message}`);});
    }
  });
  let rows = [], warnings = [], initialized = false, legacyMigrated = false, registryInitialized = false, queue = Promise.resolve(), restartRequired = false, publishedSnapshot, savedState, automaticPaused=false;
  const snapshot = () => ({directory,addons:structuredClone(rows),warnings:[...warnings],restartRequired});
  const publish = () => {const state=snapshot(),serialized=JSON.stringify(state);if(serialized===publishedSnapshot)return;publishedSnapshot=serialized;try {emit({type:'addons',state});} catch { /* UI lifetime is independent of host state. */ }};
  const persist = async() => {const text=JSON.stringify({schemaVersion:1,legacyMigrated,records:Object.fromEntries(records),bundledSeen:[...bundledSeen]},null,2);if(text===savedState)return;await atomicWrite(stateFile,text);savedState=text;};
  async function setup() {
    for (const root of [directory,storage,dataRoot]) {
      try {if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Addon storage cannot be a filesystem link');} catch(error) {if(error.code !== 'ENOENT') throw error;}
      await fs.mkdir(root,{recursive:true});
    }
  }
  async function removeOwned(root, relative) {
    const target = await containedPath(root,relative,{missing:true});
    const base = await fs.realpath(root), resolved = path.relative(base,target);
    if (!resolved || resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new Error('Refusing removal outside addon storage');
    await fs.rm(target,{recursive:true,force:true});
  }
  async function writeFiles(root, files) {
    await fs.mkdir(root,{recursive:true});
    for (const [name,content] of files) {
      const target = await containedPath(root,name,{missing:true}); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,content,{flag:'wx'});
    }
  }
  async function cache(pkg) {
    const relative = `versions/${pkg.manifest.id}/${pkg.digest}`, folder = await containedPath(storage,relative,{missing:true});
    try {const saved = await readFolder(folder,pkg.manifest.id); if(saved.digest !== pkg.digest) throw new Error('Addon version cache changed on disk');}
    catch(error) {if(error.code !== 'ENOENT') throw error; await writeFiles(folder,pkg.files);}
    return folder;
  }
  async function release(entry) {
    if (!entry) return;
    entry.controller.abort(new Error('Addon disabled')); restartRequired = true;
    entry.runs.clear();
    let timer;
    const cleanup = Promise.allSettled([...entry.pending, ...(typeof entry.module.deactivate === 'function' ? [Promise.resolve().then(() => entry.module.deactivate(entry.context))] : [])]);
    try {await Promise.race([cleanup,new Promise(resolve => {timer=setTimeout(resolve,entry.context?.resources?120000:1000);})]);} finally {clearTimeout(timer);}
  }
  async function replace(entries) {await runtime.replaceExtensionTools([...entries.values()].flatMap(entry => entry.tools),[...entries.values()].map(entry => entry.metadata));registryInitialized=true;}
  async function importModule(filename,signal) {
    const timeout=new AbortController();let timer;
    try {
      timer=setTimeout(()=>timeout.abort(new Error('Addon initialization timed out; restart to finish stopping its code')),loadTimeoutMs);
      const combined=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
      combined.throwIfAborted();
      return await untilAborted(import(pathToFileURL(filename).href),combined);
    }catch(error){restartRequired=true;throw error;}
    finally{clearTimeout(timer);}
  }
  async function load(pkg, imported, signal) {
    const folder = await cache(pkg), module = imported || await importModule(await containedPath(folder,pkg.manifest.entry),signal);
    const candidate = validateExtension(module);
    candidate.tools.forEach(checkTool);
    if (candidate.metadata.id !== pkg.manifest.id || candidate.metadata.version !== pkg.manifest.version) throw new Error('Addon module identity differs from addon.json');
    if (candidate.tools.some(tool => !pkg.manifest.permissions.includes(tool.permission))) throw new Error('Addon tools request undeclared permissions');
    const privateData = await containedPath(dataRoot,pkg.manifest.id,{missing:true});
    const context={id:pkg.manifest.id,dataDir:privateData,resources:bundledResources[pkg.manifest.id]};
    const entry = {module,context,metadata:{...candidate.metadata,name:pkg.manifest.name,description:pkg.manifest.description || ''},digest:pkg.digest,controller:new AbortController(),pending:new Set(),runs:new Map(),automatic:pkg.manifest.id==='lightpanda'&&factoryDigests.get('lightpanda')===pkg.digest};
    entry.tools = candidate.tools.map(tool => ({...tool,execute:async(args,ctx) => {
      const signal = ctx.signal ? AbortSignal.any([ctx.signal,entry.controller.signal]) : entry.controller.signal; signal.throwIfAborted();
      if(entry.automatic&&ctx.runId)entry.runs.set(ctx.runId,ctx.chat?.id);
      const result = Promise.resolve().then(async() => {signal.throwIfAborted(); await fs.mkdir(privateData,{recursive:true}); return tool.execute(args,{...ctx,signal,addon:context});});
      entry.pending.add(result);result.then(()=>entry.pending.delete(result),()=>entry.pending.delete(result));
      return untilAborted(result,signal);
    }}));
    return entry;
  }
  async function refresh(signal) {
    await setup(); const next = new Map(), found = new Set(), updated = [];
    const currentNames = new Set([...active.values()].flatMap(entry=>entry.tools.map(tool=>tool.name)));
    const reserved = new Set(((await runtime.request?.('state.get'))?.tools || []).map(tool=>tool.name).filter(name=>!currentNames.has(name)));
    for (const folder of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (!idPattern.test(folder.name)) continue;
      const id = folder.name; found.add(id); const record = records.get(id);
      let row = {id,name:id,version:'Unknown',description:'',enabled:false,status:'error',permissions:[],hasData:false,canRollback:!!record?.previous};
      try {
        const data = await containedPath(dataRoot,id,{missing:true}); row.hasData = (await fs.readdir(data).catch(error => {if(error.code === 'ENOENT')return [];throw error;})).length > 0;
        if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('Addon folder is not an ordinary directory');
        const pkg = await readFolder(path.join(directory,id),id);
        row = {...row,...pkg.manifest,status:record?.digest === pkg.digest ? 'disabled' : 'untrusted'};
        if (record?.enabled && record.digest === pkg.digest) {
          const entry = active.get(id)?.digest === pkg.digest ? active.get(id) : await load(pkg,undefined,signal);
          if(entry.tools.some(tool=>reserved.has(tool.name))) {if(entry!==active.get(id))await release(entry);throw new Error('Addon tool name conflicts with another installed tool');}
          entry.tools.forEach(tool=>reserved.add(tool.name));next.set(id,entry);row.enabled=true;row.status='enabled';
        } else if (record?.digest && record.digest !== pkg.digest) row.error='Files changed since approval. Enable to review and trust this version.';
      } catch(error) {row.status=/Incompatible/.test(error.message)?'incompatible':'error';row.error=error.message;}
      updated.push(row);
    }
    if(!registryInitialized || next.size!==active.size || [...next].some(([id,entry])=>active.get(id)!==entry))await replace(next);
    for(const [id,entry] of active) if(next.get(id)!==entry) await release(entry);
    active.clear(); for(const [id,entry] of next) active.set(id,entry);
    for(const id of records.keys()) if(!found.has(id)) records.delete(id);
    rows=updated; await persist(); automaticPaused=false; publish(); return snapshot();
  }
  async function trust(pkg,signal) {
    signal?.throwIfAborted();
    if (!await confirm(`Enable addon “${pkg.manifest.name}” ${pkg.manifest.version}?\n\nDeclared tool access: ${pkg.manifest.permissions.join(', ') || 'none'}.\n${pkg.files.size} files, ${pkg.bytes} bytes.\n\nExecutable addons are trusted JavaScript with full access to your Windows account. They are not sandboxed. Only enable code you trust.\n\nSHA-256: ${pkg.digest}`)) throw new Error('Addon activation declined');
    signal?.throwIfAborted();
  }
  async function installPackage(pkg,signal,{approved=false,imported,enabled=true}={}) {
    await setup(); if(!approved) await trust(pkg,signal); signal?.throwIfAborted();
    const id=pkg.manifest.id, oldRecord=records.get(id), oldEntry=active.get(id), candidate=await load(pkg,imported,signal);
    const next=new Map(active); if(enabled)next.set(id,candidate);else next.delete(id);
    const token=crypto.randomUUID(), staging=`staging/${token}`, backup=`replaced/${id}-${token}`;
    const stage=await containedPath(storage,staging,{missing:true}), saved=await containedPath(storage,backup,{missing:true}), target=await containedPath(directory,id,{missing:true});
    let moved=false,installed=false;
    try {
      signal?.throwIfAborted(); await writeFiles(stage,pkg.files); await replace(next); signal?.throwIfAborted();
      try {await fs.lstat(target); await fs.mkdir(path.dirname(saved),{recursive:true}); await fs.rename(target,saved); moved=true;} catch(error) {if(error.code!=='ENOENT')throw error;}
      await fs.rename(stage,target); installed=true;
      records.set(id,{enabled,digest:pkg.digest,...(oldRecord?.digest && oldRecord.digest!==pkg.digest ? {previous:oldRecord.digest} : oldRecord?.previous ? {previous:oldRecord.previous} : {})});
      await persist(); if(enabled)active.set(id,candidate);else active.delete(id); await release(oldEntry);
    } catch(error) {
      if(installed)await removeOwned(directory,id);
      if(moved)await fs.rename(saved,target);
      if(oldRecord)records.set(id,oldRecord);else records.delete(id);
      await replace(active); await release(candidate); throw error;
    } finally {await removeOwned(storage,staging);}
    if(moved)await removeOwned(storage,backup);
    const retained=new Set([pkg.digest,records.get(id)?.previous]);
    const versions=await containedPath(storage,`versions/${id}`);
    for(const version of await fs.readdir(versions))if(/^[a-f0-9]{64}$/.test(version)&&!retained.has(version))await removeOwned(storage,`versions/${id}/${version}`);
    return refresh();
  }
  async function legacyInstall({source,id},signal,approved=false) {
    if(!idPattern.test(id||'') || typeof source!=='string' || Buffer.byteLength(source)>1024*1024)throw new Error('Invalid extension ID or source');
    signal?.throwIfAborted();
    if(!approved && !await confirm(`Enable executable addon “${id}”?\n\nThis is trusted JavaScript with full access to your Windows account. It is not sandboxed.\nSHA-256: ${sha(source)}`))throw new Error('Addon activation declined');
    signal?.throwIfAborted();await setup();
    const file=await containedPath(storage,`legacy/${id}-${sha(source)}.mjs`,{missing:true}); await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,source,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    if(sha(await fs.readFile(file))!==sha(source))throw new Error('Legacy addon cache changed on disk');
    const module=await importModule(file,signal), candidate=validateExtension(module);
    if(candidate.metadata.id!==id)throw new Error('Extension ID differs from manifest');
    const manifest={schemaVersion:1,id,name:candidate.metadata.name,version:candidate.metadata.version,description:candidate.metadata.description||'',entry:'index.mjs',hostApi:1,permissions:[...new Set(candidate.tools.map(tool=>tool.permission))]};
    const pkg=packageFromFiles(new Map([['addon.json',Buffer.from(JSON.stringify(manifest,null,2))],['index.mjs',Buffer.from(source)]]));
    return installPackage(pkg,signal,{approved:true,imported:module});
  }
  async function initialize() {
    if(initialized)return refresh();await setup();
    try {
      const saved=JSON.parse(await fs.readFile(stateFile,'utf8'));
      if(saved.schemaVersion!==1 || !plain(saved.records))throw new Error('Invalid addon manager state');
      legacyMigrated=saved.legacyMigrated===true;
      if(saved.bundledSeen!==undefined&&(!Array.isArray(saved.bundledSeen)||saved.bundledSeen.some(id=>!idPattern.test(id))))throw new Error('Invalid bundled addon state');
      for(const id of saved.bundledSeen||[])bundledSeen.add(id);
      for(const [id,record] of Object.entries(saved.records)) {
        if(!idPattern.test(id)||!plain(record)||typeof record.enabled!=='boolean'||!/^[a-f0-9]{64}$/.test(record.digest)||record.previous!==undefined&&!/^[a-f0-9]{64}$/.test(record.previous))throw new Error('Invalid addon approval record');
        records.set(id,record);
      }
    }catch(error){if(error.code!=='ENOENT'){records.clear();bundledSeen.add('lightpanda');warnings.push('Saved addon approvals could not be read. Addons require approval again.');}}
    if(bundledSource) try {
      const catalog=JSON.parse(await fs.readFile(path.join(bundledSource,'catalog.json'),'utf8'));
      if(catalog.schemaVersion!==1||!Array.isArray(catalog.addons))throw new Error('Invalid bundled addon catalog');
      for(const item of catalog.addons) {
        if(!idPattern.test(item.id)||!/^[a-f0-9]{64}$/.test(item.digest))throw new Error('Invalid bundled addon identity');
        if(item.replaces!==undefined&&(!Array.isArray(item.replaces)||item.replaces.some(value=>!/^[a-f0-9]{64}$/.test(value))))throw new Error('Invalid bundled replacement hashes');
        if(item.id==='lightpanda') {
          const factory=await readFolder(path.join(bundledSource,item.id),item.id);
          if(factory.digest!==item.digest)throw new Error('Installer-owned addon hash differs');
          factoryDigests.set(item.id,item.digest);
          const previous=records.get(item.id);
          if(previous&&previous.digest!==item.digest&&item.replaces?.includes(previous.digest))try{
            const installed=await readFolder(path.join(directory,item.id),item.id);
            if(installed.digest===previous.digest)await installPackage(factory,undefined,{approved:true,enabled:previous.enabled});
          }catch(error){warnings.push(`Bundled Lightpanda update preserved existing files: ${error.message}`);}
        }
        if(bundledSeen.has(item.id))continue;
        bundledSeen.add(item.id);await persist();
        if(records.has(item.id)||await fs.lstat(path.join(directory,item.id)).then(()=>true,()=>false))continue;
        try{const pkg=await readFolder(path.join(bundledSource,item.id),item.id);if(pkg.digest!==item.digest)throw new Error('Installer-owned addon hash differs');await installPackage(pkg,undefined,{approved:true});}
        catch(error){warnings.push('Bundled addon '+item.id+': '+error.message);}
      }
    }catch(error){warnings.push(`Bundled addon catalog unavailable; factory seeding skipped: ${error.message}`);}
    if(!legacyMigrated) {
      let legacy=[];
      try {legacy=JSON.parse(await fs.readFile(path.join(dataDir,'extensions','approved.json'),'utf8'));if(!Array.isArray(legacy))throw new Error('Invalid legacy extension approvals');}
      catch(error){legacy=[];if(error.code!=='ENOENT')warnings.push(error.message);}
      for(const record of legacy)try {
        if(!idPattern.test(record.id||'')||!/^[a-f0-9]{64}$/.test(record.digest||'')||record.filename!==`${record.id}-${record.digest}.mjs`)throw new Error('Invalid legacy extension approval');
        if(records.has(record.id)||await fs.lstat(path.join(directory,record.id)).then(()=>true,()=>false))continue;
        const filename=await containedPath(path.join(dataDir,'extensions'),record.filename);
        if((await fs.lstat(filename)).isSymbolicLink())throw new Error('Legacy extension links are unsupported');
        const source=await fs.readFile(filename,'utf8');if(sha(source)!==record.digest)throw new Error('Legacy extension changed since approval');
        await legacyInstall({id:record.id,source},undefined,true);
      }catch(error){warnings.push(`Legacy addon ${record?.id||'unknown'}: ${error.message}`);}
      legacyMigrated=true;
    }
    initialized=true;return refresh();
  }
  async function enable(id,signal) {
    const pkg=await readFolder(await containedPath(directory,id),id);await trust(pkg,signal);
    const previous=records.get(id);records.set(id,{...previous,enabled:true,digest:pkg.digest});
    const result=await refresh(signal);const row=result.addons.find(item=>item.id===id);
    if(!row?.enabled){if(previous)records.set(id,previous);else records.delete(id);await persist();throw new Error(row?.error||'Addon could not be enabled');}
    return result;
  }
  async function disable(id,signal) {
    signal?.throwIfAborted();const record=records.get(id);
    if(record)records.set(id,{...record,enabled:false});await persist();return refresh();
  }
  async function uninstall(id,signal) {
    signal?.throwIfAborted();
    active.get(id)?.controller.abort(new Error('Addon uninstalling'));
    const record=records.get(id);let module=active.get(id)?.module;
    if(!module&&record?.digest)try{const pkg=await readFolder(await containedPath(storage,`versions/${id}/${record.digest}`),id);if(pkg.digest!==record.digest)throw new Error('Approved uninstall hook changed on disk');module=await importModule(await containedPath(storage,`versions/${id}/${record.digest}/${pkg.manifest.entry}`),signal);}catch(error){warnings.push(`Addon ${id}: cleanup hook skipped because approved cache was unavailable or invalid (${error.message}). Only addon files will be removed; check any external runtime manually.`);}
    await disable(id,signal);signal?.throwIfAborted();
    if(typeof module?.uninstall==='function'){const timeout=AbortSignal.timeout(120000);await untilAborted(module.uninstall({id,dataDir:await containedPath(dataRoot,id,{missing:true}),resources:bundledResources[id],signal}),signal?AbortSignal.any([signal,timeout]):timeout);}
    signal?.throwIfAborted();
    await removeOwned(directory,id);records.delete(id);await persist();
    await removeOwned(storage,`versions/${id}`);
    const legacy=await containedPath(storage,'legacy',{missing:true});
    for(const name of await fs.readdir(legacy).catch(error=>{if(error.code==='ENOENT')return [];throw error;}))if(new RegExp(`^${id}-[a-f0-9]{64}\\.mjs$`).test(name))await removeOwned(storage,`legacy/${name}`);
    return refresh();
  }
  async function reset(id,signal) {
    signal?.throwIfAborted(); if(active.has(id))throw new Error('Disable this addon before resetting its data');
    // Runtime ownership records must outlive cleanup; never orphan a bundled service by erasing them first.
    const record=records.get(id);
    if(bundledResources[id]&&record?.digest){
      const pkg=await readFolder(await containedPath(storage,`versions/${id}/${record.digest}`),id);
      if(pkg.digest!==record.digest)throw new Error('Approved reset cleanup hook changed on disk; private data was preserved');
      const module=await importModule(await containedPath(storage,`versions/${id}/${record.digest}/${pkg.manifest.entry}`),signal);
      if(typeof module.uninstall==='function'){const timeout=AbortSignal.timeout(120000),cleanupSignal=signal?AbortSignal.any([signal,timeout]):timeout;await untilAborted(module.uninstall({id,dataDir:await containedPath(dataRoot,id,{missing:true}),resources:bundledResources[id],signal:cleanupSignal}),cleanupSignal);}
    }
    signal?.throwIfAborted();
    await removeOwned(dataRoot,id);return refresh();
  }
  async function rollback(id,signal) {
    const previous=records.get(id)?.previous;if(!previous)throw new Error('No previous addon version is available');
    const pkg=await readFolder(await containedPath(storage,`versions/${id}/${previous}`),id);
    if(pkg.digest!==previous)throw new Error('Previous addon version has changed');return installPackage(pkg,signal);
  }
  async function request(method,args={},signal) {
    if(!requests[method])throw new Error('Unknown addon request');validate(args,requests[method]);signal?.throwIfAborted();
    if(!initialized)await initialize();
    if(method==='addons.list')return refresh();
    if(method==='addons.import') {
      if(!chooseAddon)throw new Error('Addon file chooser unavailable');const selected=await chooseAddon(args.kind);signal?.throwIfAborted();
      if(!selected)return {...snapshot(),canceled:true};return installPackage(await readAddonPackage(selected),signal);
    }
    if(method==='addons.openDirectory') {
      if(!openPath)throw new Error('File explorer unavailable');const folder=args.id?await containedPath(directory,args.id):directory;await openPath(folder);return {opened:true};
    }
    return ({'addons.enable':enable,'addons.disable':disable,'addons.uninstall':uninstall,'addons.reset':reset,'addons.rollback':rollback})[method](args.id,signal);
  }
  const serial = fn => (...args) => {const result=queue.catch(()=>{}).then(()=>fn(...args));queue=result;return result;};
  let automaticFences=0;
  const fenced=fn=>(...args)=>{automaticFences++;return serial(fn)(...args).finally(()=>{automaticFences--;});};
  const queuedRequest=serial(request);
  return {
    isAutomaticTool(tool,permission){const entry=active.get('lightpanda'),record=records.get('lightpanda');return !automaticFences&&!automaticPaused&&!!entry&&record?.enabled&&record.digest===entry.digest&&entry.automatic&&!entry.controller.signal.aborted&&['computer','network'].includes(permission)&&automaticNames.has(tool.name)&&entry.tools.some(item=>item.name===tool.name&&item.execute===tool.execute&&item.permission===tool.permission);},
    initialize:serial(initialize), request:(method,args,signal)=>args?.id==='lightpanda'&&['addons.disable','addons.uninstall','addons.reset','addons.rollback'].includes(method)?fenced(request)(method,args,signal):queuedRequest(method,args,signal), install:serial(legacyInstall),
    installPath:serial(async(filename,signal)=>{if(!initialized)await initialize();return installPackage(await readAddonPackage(filename),signal);}),
    reload:fenced(async()=>{automaticPaused=true;return refresh();}), disable:fenced(disable),
    close:serial(async()=>{automaticPaused=true;unsubscribeRuns?.();await replace(new Map());for(const entry of active.values())await release(entry);active.clear();}),
  };
}

export function addonTools(manager) {
  const action=(name,method,description,permission='upgrade',properties={id:idSchema},required=['id'])=>({name,description,permission,parameters:object(properties,required),execute:(args,ctx)=>manager.request(method,args,ctx.signal)});
  return [
    action('addons_list','addons.list','List local addons, exact trust status, versions, and private-data presence. No online catalog.','read',{},[]),
    {name:'addon_install',description:'Install a local addon folder or .faber-addon.json package after native trust review. Does not publish or share files.',permission:'upgrade',parameters:object({path:{type:'string',minLength:1,maxLength:1000}},['path']),execute:(args,ctx)=>manager.installPath(args.path,ctx.signal)},
    action('addon_enable','addons.enable','Review and enable an installed local addon. Changed code needs a new exact-package approval.'),
    action('addon_disable','addons.disable','Disable a local addon and remove its tools and UI actions; keep its files/data. Restart completes cleanup of arbitrary trusted code.'),
    action('addon_uninstall','addons.uninstall','Remove an addon and its UI/tools, preserving its separate private data. Restart completes cleanup.'),
    action('addon_reset_data','addons.reset','Erase only a disabled addon’s private data. This is permanent; it does not delete chats or models.'),
    action('addon_rollback','addons.rollback','Review and restore the previous saved addon code version. Private data is not rolled back.'),
  ];
}
