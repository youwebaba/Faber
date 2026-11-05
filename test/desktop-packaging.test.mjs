import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareWorkbench, packagedRuntime, refreshAlphaPrivacy } from '../desktop/packaged-paths.mjs';
import {getProfileDirectory} from '../desktop/profile-path.cjs';
import {validUpgradePath} from '../desktop/recovery.mjs';

test('fresh profile uses Faber while an existing profile stays at its original path',()=>{
  const base=path.resolve('fixture-appdata');let existing;
  assert.equal(getProfileDirectory(base,{exists:filename=>{existing=filename;return false;}}),path.join(base,'Faber'));
  assert.equal(getProfileDirectory(base,{exists:()=>true}),existing);
  assert.equal(validUpgradePath('desktop/profile-path.cjs'),false);
});

test('packaged workbench is seeded once, preserves edits, and keeps prior installer versions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-package-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundledSource = path.join(root, 'bundle'), workbenchRoot = path.join(root, 'workbench'); await fs.mkdir(path.join(bundledSource, 'desktop'), { recursive: true });
  await fs.writeFile(path.join(bundledSource, 'desktop', 'main.mjs'), 'original'); await fs.writeFile(path.join(bundledSource, 'README.md'), 'instructions'); await fs.writeFile(path.join(bundledSource, 'package.json'), '{}');
  const first = await prepareWorkbench({ bundledSource, workbenchRoot, version: '1.0.0-beta.1' });
  assert.equal(await fs.readFile(path.join(first, 'desktop', 'main.mjs'), 'utf8'), 'original');
  await fs.writeFile(path.join(first, 'desktop', 'main.mjs'), 'approved self-upgrade');
  assert.equal(await prepareWorkbench({ bundledSource, workbenchRoot, version: '1.0.0-beta.1' }), first);
  assert.equal(await fs.readFile(path.join(first, 'desktop', 'main.mjs'), 'utf8'), 'approved self-upgrade');
  const second = await prepareWorkbench({ bundledSource, workbenchRoot, version: '1.0.0-beta.2' }); assert.notEqual(second, first);
  assert.equal(await fs.readFile(path.join(second, 'desktop', 'main.mjs'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(first, 'desktop', 'main.mjs'), 'utf8'), 'approved self-upgrade');
  await assert.rejects(prepareWorkbench({ bundledSource, workbenchRoot, version: '../escape' }), /Invalid/);
  await fs.mkdir(path.join(workbenchRoot, '1.0.0-beta.3')); await assert.rejects(prepareWorkbench({ bundledSource, workbenchRoot, version: '1.0.0-beta.3' }), /Incomplete/);
});
test('packaged runner resolves entirely within bundled real resources', () => {
  const root = path.resolve('fixture-resources'), result = packagedRuntime(root);
  assert.equal(result.executable, path.join(root, 'local-runtime', 'llama-server.exe'));
  assert.deepEqual(result.backendDirectories, ['cuda_v13', 'vulkan'].map(name => path.join(root, 'local-runtime', name)));
});

async function brandingFixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-branding-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bundledSource=path.join(root,'bundle'),workbenchRoot=path.join(root,'workbench'),version='1.1.0-beta.1';
  await fs.mkdir(path.join(bundledSource,'renderer/assets'),{recursive:true});await fs.mkdir(path.join(bundledSource,'core'));
  const original=await fs.readFile(new URL('./fixtures/b1.1-original-branding.css',import.meta.url));
  await fs.writeFile(path.join(bundledSource,'renderer/faber.css'),original);await fs.writeFile(path.join(bundledSource,'renderer/app.mjs'),'custom active renderer code');await fs.writeFile(path.join(bundledSource,'core/runtime.mjs'),'custom core code');
  const options={bundledSource,workbenchRoot,version},sourceDir=await prepareWorkbench(options);
  await fs.writeFile(path.join(bundledSource,'renderer/faber.css'),'/* transparent branding */');await fs.writeFile(path.join(bundledSource,'renderer/app.mjs'),'incoming renderer code');
  for(const name of ['faber-symbol.svg','faber-wordmark.svg'])await fs.writeFile(path.join(bundledSource,'renderer/assets',name),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  return {root,sourceDir,options,original,refresh:()=>prepareWorkbench(options),report:async()=>JSON.parse(await fs.readFile(path.join(sourceDir,'.faber-branding-refresh.json'),'utf8'))};
}

test('same b1.1 branding refresh backs up only known originals, preserves custom code and is idempotent',async t=>{
  const f=await brandingFixture(t);assert.equal(await f.refresh(),f.sourceDir);
  assert.equal(await fs.readFile(path.join(f.sourceDir,'renderer/faber.css'),'utf8'),'/* transparent branding */');
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'.faber-branding-backup/renderer/faber.css')),f.original);
  assert.equal(await fs.readFile(path.join(f.sourceDir,'renderer/app.mjs'),'utf8'),'custom active renderer code');assert.equal(await fs.readFile(path.join(f.sourceDir,'core/runtime.mjs'),'utf8'),'custom core code');
  assert.match(await fs.readFile(path.join(f.sourceDir,'renderer/assets/faber-symbol.svg'),'utf8'),/^<svg/);
  assert.equal((await f.report()).files.find(file=>file.path==='renderer/app.mjs').status,'preserved');
  const writes=[];t.mock.method(fs,'writeFile',async(...args)=>{writes.push(args[0]);throw Error('Unexpected second-start write');});await f.refresh();assert.deepEqual(writes,[]);
});

test('branding refresh never overwrites a custom asset or a conflicting existing backup',async t=>{
  const f=await brandingFixture(t),backup=path.join(f.sourceDir,'.faber-branding-backup/renderer/faber.css');
  await fs.mkdir(path.dirname(backup),{recursive:true});await fs.writeFile(backup,'preexisting backup');await fs.writeFile(path.join(f.sourceDir,'renderer/assets/faber-symbol.svg'),'<svg>custom</svg>');
  await f.refresh();assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'renderer/faber.css')),f.original);assert.equal(await fs.readFile(backup,'utf8'),'preexisting backup');
  assert.equal(await fs.readFile(path.join(f.sourceDir,'renderer/assets/faber-symbol.svg'),'utf8'),'<svg>custom</svg>');assert.match((await f.report()).files.find(file=>file.path==='renderer/faber.css').reason,/backup differs/);
});

test('branding refresh checks the current file again after backup and preserves a concurrent edit',async t=>{
  const f=await brandingFixture(t),originalWrite=fs.writeFile.bind(fs),target=path.join(f.sourceDir,'renderer/faber.css');
  t.mock.method(fs,'writeFile',async(filename,...args)=>{await originalWrite(filename,...args);if(String(filename).includes('.faber-branding-backup')&&String(filename).endsWith('faber.css'))await originalWrite(target,'concurrent custom edit');});
  await f.refresh();assert.equal(await fs.readFile(target,'utf8'),'concurrent custom edit');assert.match((await f.report()).files.find(file=>file.path==='renderer/faber.css').reason,/changed during/);
});

test('branding refresh rejects linked asset and backup parents without writes outside the workbench',async t=>{
  const f=await brandingFixture(t),outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'sentinel'),'untouched');
  await fs.rmdir(path.join(f.sourceDir,'renderer/assets'));await fs.symlink(outside,path.join(f.sourceDir,'renderer/assets'),process.platform==='win32'?'junction':'dir');await fs.symlink(outside,path.join(f.sourceDir,'.faber-branding-backup'),process.platform==='win32'?'junction':'dir');
  await f.refresh();assert.deepEqual(await fs.readdir(outside),['sentinel']);assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'renderer/faber.css')),f.original);
  assert.match((await f.report()).files.find(file=>file.path==='renderer/assets/faber-symbol.svg').reason,/link or junction/);
});

test('fresh copies and other application versions do not run the same-version branding repair',async t=>{
  const f=await brandingFixture(t);const fresh=await prepareWorkbench({...f.options,workbenchRoot:path.join(f.root,'fresh')});
  await assert.rejects(fs.stat(path.join(fresh,'.faber-branding-refresh.json')),/ENOENT/);
  const otherOptions={...f.options,version:'1.1.0-beta.2'},other=await prepareWorkbench(otherOptions);await fs.writeFile(path.join(other,'renderer/faber.css'),f.original);await prepareWorkbench(otherOptions);assert.deepEqual(await fs.readFile(path.join(other,'renderer/faber.css')),f.original);
});

test('runtime packaging rejects unlocked binaries and changed reviewed bytes',async t=>{
  const {createHash}=await import('node:crypto'),{verifyRuntime}=await import('../desktop/runtime-integrity.cjs').then(module=>module.default);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-runtime-lock-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'.runtime','local-runtime');await fs.mkdir(directory,{recursive:true});await fs.mkdir(path.join(root,'build'));
  const bytes=Buffer.from('fixture'),manifest={files:[{path:'runner.exe',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
  await fs.writeFile(path.join(root,'build','runtime-lock.json'),JSON.stringify(manifest));await fs.writeFile(path.join(directory,'runtime-manifest.json'),JSON.stringify(manifest));await fs.writeFile(path.join(directory,'runner.exe'),bytes);
  await verifyRuntime(root);await fs.writeFile(path.join(directory,'unreviewed.dll'),'x');await assert.rejects(verifyRuntime(root),/Unreviewed/);await fs.unlink(path.join(directory,'unreviewed.dll'));
  await fs.writeFile(path.join(directory,'runner.exe'),'changed');await assert.rejects(verifyRuntime(root),/integrity mismatch/);
});

test('Lightpanda packaging rejects added payloads and altered pinned source/binary bytes',async t=>{
  const {createHash}=await import('node:crypto'),{verifyLightpanda}=await import('../desktop/lightpanda-integrity.cjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-browser-lock-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'.runtime/lightpanda');await fs.mkdir(directory,{recursive:true});await fs.mkdir(path.join(root,'build'));await fs.mkdir(path.join(root,'bundled-addons'));
  const bytes=Buffer.from('pinned browser fixture'),lock={files:[{name:'lightpanda',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
  await fs.writeFile(path.join(root,'build/lightpanda-lock.json'),JSON.stringify(lock));await fs.writeFile(path.join(directory,'runtime-lock.json'),JSON.stringify(lock));await fs.writeFile(path.join(directory,'lightpanda'),bytes);await fs.writeFile(path.join(root,'bundled-addons/catalog.json'),JSON.stringify({addons:[]}));
  await verifyLightpanda(root);await fs.writeFile(path.join(directory,'extra'),'unapproved');await assert.rejects(verifyLightpanda(root),/Unreviewed/);await fs.unlink(path.join(directory,'extra'));
  await fs.writeFile(path.join(directory,'lightpanda'),'changed');await assert.rejects(verifyLightpanda(root),/integrity mismatch/);
});



test('Alpha privacy refresh updates exact stock, preserves edits and links, and resumes safely', async t => {
  const {createHash} = await import('node:crypto');
  const {nativeSourceHash, nativeExecutableSuffix} = await import('../native/integrity.mjs');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Faber-privacy-refresh-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const bundledSource = path.join(root, 'bundle'), workbenchRoot = path.join(root, 'workbench');
  const write = async (base, relative, bytes) => {const filename=path.join(base,relative);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes);};
  for (const relative of ['native/Cargo.toml','native/Cargo.lock','native/rust-toolchain.toml','native/.cargo/config.toml','native/src/main.rs']) await write(bundledSource,relative,'fixture source');
  const sourceHash = await nativeSourceHash(bundledSource), oldBytes = Buffer.from('original fixture worker'), newBytes = Buffer.from('private-path-free fixture worker');
  const worker = hash(oldBytes), newWorker = hash(newBytes);
  const manifest = sha256 => Buffer.from(JSON.stringify({schemaVersion:1,protocol:1,sourceHash,sha256,binary:`bin/${sha256}${nativeExecutableSuffix}`}));
  const oldManifest = manifest(worker), newManifest = manifest(newWorker);
  await write(bundledSource,'native/runtime.json',oldManifest);await write(bundledSource,`native/bin/${worker}${nativeExecutableSuffix}`,oldBytes);
  for (const relative of ['README.md','REQUIREMENTS.md','build/fixture.md','core/runtime.mjs']) await write(bundledSource,relative,'original fixture instructions');
  const options = {bundledSource,workbenchRoot,version:'2.0.2-alpha.1'}, sourceDir = await prepareWorkbench(options);
  await write(sourceDir,'REQUIREMENTS.md','custom instructions');
  const outside = path.join(root,'outside');await fs.mkdir(outside);await write(outside,'fixture.md','outside instructions');
  await fs.unlink(path.join(sourceDir,'build/fixture.md'));await fs.rmdir(path.join(sourceDir,'build'));await fs.symlink(outside,path.join(sourceDir,'build'),process.platform==='win32'?'junction':'dir');
  for (const relative of ['README.md','REQUIREMENTS.md','build/fixture.md','core/runtime.mjs','scripts/privacy-check.mjs']) await write(bundledSource,relative,'clean fixture instructions');
  await write(bundledSource,'native/runtime.json',newManifest);await write(bundledSource,`native/bin/${newWorker}${nativeExecutableSuffix}`,newBytes);
  const stock = {files:Object.fromEntries(['README.md','REQUIREMENTS.md','build/fixture.md'].map(name=>[name,[hash('original fixture instructions')]])),runtimeHashes:[hash(oldManifest)],worker,sourceHash};
  stock.files['scripts/privacy-check.mjs']=[];
  // An independently edited native source blocks only the worker replacement.
  await write(sourceDir,'native/src/main.rs','custom native source');
  await refreshAlphaPrivacy(bundledSource,sourceDir,stock);
  assert.equal(await fs.readFile(path.join(sourceDir,'README.md'),'utf8'),'clean fixture instructions');
  assert.equal(await fs.readFile(path.join(sourceDir,'REQUIREMENTS.md'),'utf8'),'custom instructions');
  assert.equal(await fs.readFile(path.join(outside,'fixture.md'),'utf8'),'outside instructions');
  assert.equal(await fs.readFile(path.join(sourceDir,'core/runtime.mjs'),'utf8'),'original fixture instructions');
  assert.equal(await fs.readFile(path.join(sourceDir,'scripts/privacy-check.mjs'),'utf8'),'clean fixture instructions');
  assert.deepEqual(await fs.readFile(path.join(sourceDir,'native/runtime.json')),oldManifest);
  await write(sourceDir,'native/src/main.rs','fixture source');
  await write(sourceDir,'native/bin/unrelated-worker','custom worker');
  const rename=fs.rename.bind(fs);
  t.mock.method(fs,'rename',async(from,to)=>{
    if(to===path.join(sourceDir,'native/runtime.json'))assert.deepEqual(await fs.readFile(path.join(sourceDir,`native/bin/${newWorker}${nativeExecutableSuffix}`)),newBytes);
    return rename(from,to);
  });
  await refreshAlphaPrivacy(bundledSource,sourceDir,stock);
  assert.deepEqual(await fs.readFile(path.join(sourceDir,'native/runtime.json')),newManifest);
  await assert.rejects(fs.stat(path.join(sourceDir,`native/bin/${worker}${nativeExecutableSuffix}`)),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(sourceDir,'native/bin/unrelated-worker'),'utf8'),'custom worker');
  // Resume a partial attempt with the replacement worker already published.
  await write(sourceDir,'native/runtime.json',oldManifest);await write(sourceDir,`native/bin/${worker}${nativeExecutableSuffix}`,oldBytes);
  await refreshAlphaPrivacy(bundledSource,sourceDir,stock);
  assert.deepEqual(await fs.readFile(path.join(sourceDir,'native/runtime.json')),newManifest);
  await assert.rejects(fs.stat(path.join(sourceDir,`native/bin/${worker}${nativeExecutableSuffix}`)),{code:'ENOENT'});
  await fs.rmdir(path.join(sourceDir,'build'));await write(sourceDir,'build/fixture.md','custom instructions');
  const writes=[];t.mock.method(fs,'writeFile',async(...args)=>{writes.push(args[0]);throw Error('Unexpected repeat write');});
  await refreshAlphaPrivacy(bundledSource,sourceDir,stock);assert.deepEqual(writes,[]);
});

test('a2.1 seeds the repaired parser separately and preserves edits in both versions', async t => {
  const {pathToFileURL} = await import('node:url');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-a21-workbench-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bundledSource=path.join(root,'bundle'),workbenchRoot=path.join(root,'workbench');
  await fs.mkdir(path.join(bundledSource,'core'),{recursive:true});
  await fs.writeFile(path.join(bundledSource,'core/responses.mjs'),'approved Alpha 2.0 custom parser');
  await fs.writeFile(path.join(bundledSource,'core/custom-feature.mjs'),'approved Alpha 2.0 feature');
  const previous=await prepareWorkbench({bundledSource,workbenchRoot,version:'2.0.2-alpha.1'});
  const previousMarker=await fs.readFile(path.join(previous,'.faber-workbench.json'));
  for(const file of ['responses.mjs','images.mjs','usage.mjs'])await fs.copyFile(new URL('../core/'+file,import.meta.url),path.join(bundledSource,'core',file));
  await fs.unlink(path.join(bundledSource,'core/custom-feature.mjs'));
  const options={bundledSource,workbenchRoot,version:'2.1.0'},current=await prepareWorkbench(options);
  assert.notEqual(current,previous);
  assert.deepEqual(await fs.readFile(path.join(current,'core/responses.mjs')),await fs.readFile(path.join(bundledSource,'core/responses.mjs')));
  await assert.rejects(fs.stat(path.join(current,'core/custom-feature.mjs')),{code:'ENOENT'});
  const {responseEvents}=await import(pathToFileURL(path.join(current,'core/responses.mjs')).href);
  const answer={type:'message',id:'fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'repaired answer'}]};
  const frames=[{type:'response.output_item.done',output_index:0,item:answer},{type:'response.completed',response:{status:'completed',output:[]}}];
  const events=[];for await(const event of responseEvents(frames,{id:'fixture',kind:'openai-responses',baseUrl:'https://example.invalid/v1',model:'fixture'}))events.push(event);
  assert.equal(events.filter(event=>event.type==='delta').map(event=>event.text).join(''),'repaired answer');
  await fs.writeFile(path.join(current,'core/responses.mjs'),'approved a2.1 custom parser');
  assert.equal(await prepareWorkbench(options),current);
  assert.equal(await fs.readFile(path.join(current,'core/responses.mjs'),'utf8'),'approved a2.1 custom parser');
  assert.equal(await fs.readFile(path.join(previous,'core/responses.mjs'),'utf8'),'approved Alpha 2.0 custom parser');
  assert.equal(await fs.readFile(path.join(previous,'core/custom-feature.mjs'),'utf8'),'approved Alpha 2.0 feature');
  assert.deepEqual(await fs.readFile(path.join(previous,'.faber-workbench.json')),previousMarker);
});


test('a2.2 seeds its own editable workbench and preserves a2.1 customizations',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-a22-package-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bundledSource=path.join(root,'bundle'),workbenchRoot=path.join(root,'workbench');
  await fs.mkdir(path.join(bundledSource,'desktop'),{recursive:true});
  await fs.writeFile(path.join(bundledSource,'desktop/main.mjs'),'previous stock');
  const previous=await prepareWorkbench({bundledSource,workbenchRoot,version:'2.1.0'});
  await fs.writeFile(path.join(previous,'desktop/main.mjs'),'approved a2.1 customization');
  await fs.writeFile(path.join(bundledSource,'desktop/main.mjs'),'a2.2 stock');
  const options={bundledSource,workbenchRoot,version:'2.2.0'},current=await prepareWorkbench(options);
  assert.notEqual(current,previous);assert.equal(await fs.readFile(path.join(current,'desktop/main.mjs'),'utf8'),'a2.2 stock');
  await fs.writeFile(path.join(current,'desktop/main.mjs'),'approved a2.2 customization');
  assert.equal(await prepareWorkbench(options),current);
  assert.equal(await fs.readFile(path.join(current,'desktop/main.mjs'),'utf8'),'approved a2.2 customization');
  assert.equal(await fs.readFile(path.join(previous,'desktop/main.mjs'),'utf8'),'approved a2.1 customization');
});
