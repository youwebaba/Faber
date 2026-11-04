import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createUpgrades} from '../desktop/upgrades.mjs';
import {readRecoveryRecord,restoreUpgrade,validUpgradePath} from '../desktop/recovery.mjs';
import {nativeSourceHash,nativeExecutableSuffix,verifyNativeRuntime} from '../native/integrity.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const successfulTests=async()=>({code:0,stdout:'synthetic Node verifier',stderr:''});
async function artifact(sourceDir,outputDir,bytes){
  const sha256=hash(bytes),manifest={schemaVersion:1,protocol:1,sourceHash:await nativeSourceHash(sourceDir),binary:`bin/${sha256}${nativeExecutableSuffix}`,sha256};
  await fs.mkdir(path.join(outputDir,'bin'),{recursive:true});
  await fs.writeFile(path.join(outputDir,manifest.binary),bytes);
  await fs.writeFile(path.join(outputDir,'runtime.json'),JSON.stringify(manifest));
  return {manifest,code:0,stdout:'synthetic compiler; executable is not launched',stderr:''};
}
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-native-upgrade-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sourceDir=path.join(root,'source'),dataDir=path.join(root,'data');
  for(const directory of ['native/src','native/.cargo','native/vendor/fixture','test','renderer'])await fs.mkdir(path.join(sourceDir,directory),{recursive:true});
  for(const [relative,content] of Object.entries({
    'native/Cargo.toml':'[package]\nname="fixture"\nversion="1.0.0"',
    'native/Cargo.lock':'# protected fixture lock',
    'native/rust-toolchain.toml':'[toolchain]\nchannel="1.99.1"',
    'native/.cargo/config.toml':'# protected fixture configuration',
    'native/vendor/fixture/lib.rs':'// protected fixture dependency',
    'native/src/main.rs':'fn main() { /* original */ }',
    'native/worker.mjs':'// original bridge',
    'renderer/app.mjs':'// original UI',
    'test/value.test.mjs':'// synthetic test entry point',
  }))await fs.writeFile(path.join(sourceDir,relative),content);
  await fs.mkdir(dataDir);await fs.writeFile(path.join(dataDir,'state.json'),'user data retained');
  const original=await artifact(sourceDir,path.join(sourceDir,'native'),Buffer.from('original worker fixture'));
  const builds=[];
  const nativeBuilder=async args=>{builds.push(args);return artifact(args.sourceDir,args.outputDir,Buffer.from('replacement worker fixture'));};
  const manager=createUpgrades({sourceDir,dataDir,confirm:async()=>true,runner:successfulTests,nativeBuilder,...options});
  return {root,sourceDir,dataDir,manager,original,builds,nativeBuilder};
}
const rustChange={path:'native/src/main.rs',content:'fn main() { /* updated */ }'};

test('compiled upgrade switches a verified pointer and independent recovery restores source plus prior binary',async t=>{
  const f=await fixture(t),originalSource=await fs.readFile(path.join(f.sourceDir,rustChange.path));
  const originalManifest=await fs.readFile(path.join(f.sourceDir,'native/runtime.json'));
  const stage=await f.manager.stage([rustChange]);
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,rustChange.path)),originalSource);
  assert.equal((await f.manager.verify(stage.id)).verified,true);assert.equal(f.builds.length,1);
  assert.equal((await f.manager.verify(stage.id)).verified,true);assert.equal(f.builds.length,1);
  const applied=await f.manager.apply(stage.id);assert.equal(applied.activation,'restart');assert.equal(applied.uiRefreshRequested,false);
  const active=await verifyNativeRuntime(f.sourceDir);assert.notEqual(active.manifest.sha256,f.original.manifest.sha256);
  const record=await readRecoveryRecord(f.dataDir,f.sourceDir);assert.equal(record.version,2);
  assert.deepEqual(record.files.map(file=>file.path),[rustChange.path,'native/runtime.json']);
  assert.equal((await restoreUpgrade({sourceDir:f.sourceDir,dataDir:f.dataDir,record})).rolledBack,true);
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,rustChange.path)),originalSource);
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'native/runtime.json')),originalManifest);
  assert.equal((await verifyNativeRuntime(f.sourceDir)).manifest.sha256,f.original.manifest.sha256);
  assert.equal(await fs.readFile(active.binaryPath,'utf8'),'replacement worker fixture');
  assert.deepEqual(await f.manager.activationStatus(),{restartRequired:false,changedFiles:[]});
  assert.equal(await fs.readFile(path.join(f.dataDir,'state.json'),'utf8'),'user data retained');
});

test('UI and JS upgrades reuse the validated compiled worker without requiring a compiler',async t=>{
  const f=await fixture(t,{nativeBuilder:async()=>{throw new Error('Compiler must not run');}});
  const stage=await f.manager.stage([{path:'renderer/app.mjs',content:'// updated UI'}]);
  const staged=path.join(f.dataDir,'upgrades',stage.id,'stage');
  assert.equal((await verifyNativeRuntime(staged)).manifest.sha256,f.original.manifest.sha256);
  assert.equal((await f.manager.verify(stage.id)).verified,true);
  assert.equal((await f.manager.apply(stage.id)).activation,'ui-refresh');
  assert.equal((await readRecoveryRecord(f.dataDir,f.sourceDir)).version,1);
  assert.equal((await f.manager.rollback()).rolledBack,true);
  const bridge=await f.manager.stage([{path:'native/worker.mjs',content:'// updated bridge'}]);
  assert.equal((await f.manager.verify(bridge.id)).verified,true);
  assert.equal((await f.manager.apply(bridge.id)).activation,'restart');
});

test('compiled patch paths exclude generated artifacts, dependencies and recovery authority',async t=>{
  const f=await fixture(t);
  assert.equal(validUpgradePath('native/src/metadata/gguf.rs'),true);
  for(const file of ['native/runtime.json','native/Cargo.toml','native/Cargo.lock','native/rust-toolchain.toml','native/.cargo/config.toml','native/vendor/fixture/lib.rs','native/build.mjs','native/integrity.mjs','native/bin/worker.exe','native/src/../build.rs','native/src//main.rs']){
    assert.equal(validUpgradePath(file),false,file);
    await assert.rejects(f.manager.stage([{path:file,content:'tampered'}]),/Invalid/);
  }
  const stage=await f.manager.stage([rustChange]);
  await fs.writeFile(path.join(f.sourceDir,'native/vendor/fixture/lib.rs'),'changed dependency');
  await assert.rejects(f.manager.verify(stage.id),/Source changed/);
});

test('compiler failure, failed Node verification and cancellation cannot activate Rust changes',async t=>{
  const f=await fixture(t,{nativeBuilder:async()=>{throw new Error('Synthetic compile failure');}}),before=await fs.readFile(path.join(f.sourceDir,'native/runtime.json'));
  const stage=await f.manager.stage([rustChange]);await assert.rejects(f.manager.verify(stage.id),/compile failure/);await assert.rejects(f.manager.apply(stage.id),/Verify/);
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'native/runtime.json')),before);
  const second=createUpgrades({sourceDir:f.sourceDir,dataDir:f.dataDir,confirm:async()=>true,nativeBuilder:f.nativeBuilder,runner:async()=>({code:1,stdout:'failed test',stderr:''})});
  const failed=await second.stage([rustChange]);assert.equal((await second.verify(failed.id)).verified,false);await assert.rejects(second.apply(failed.id),/Verify/);
  const controller=new AbortController(),third=createUpgrades({sourceDir:f.sourceDir,dataDir:f.dataDir,runner:successfulTests,nativeBuilder:f.nativeBuilder,confirm:async()=>{controller.abort();return true;}});
  const canceled=await third.stage([rustChange]);await third.verify(canceled.id);await assert.rejects(third.apply(canceled.id,controller.signal),/abort/i);
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'native/runtime.json')),before);
});

test('staged source, generated pointer and executable tampering are rejected before activation',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.sourceDir,'native/runtime.json'));
  const stage=await f.manager.stage([rustChange]);await f.manager.verify(stage.id);
  const staged=path.join(f.dataDir,'upgrades',stage.id,'stage'),native=await verifyNativeRuntime(staged);
  await fs.writeFile(native.binaryPath,'tampered compiled bytes');await assert.rejects(f.manager.apply(stage.id),/integrity mismatch/);
  const rogue=createUpgrades({sourceDir:f.sourceDir,dataDir:f.dataDir,confirm:async()=>true,runner:successfulTests,nativeBuilder:async args=>{
    const result=await f.nativeBuilder(args);await fs.writeFile(path.join(args.sourceDir,'native','extra.mjs'),'unexpected compiler write');return result;
  }});
  const rogueStage=await rogue.stage([rustChange]);await assert.rejects(rogue.verify(rogueStage.id),/unverified files/);
  const mismatch=createUpgrades({sourceDir:f.sourceDir,dataDir:f.dataDir,confirm:async()=>true,runner:successfulTests,nativeBuilder:async args=>{
    const result=await f.nativeBuilder(args);result.manifest.sourceHash='0'.repeat(64);await fs.writeFile(path.join(args.outputDir,'runtime.json'),JSON.stringify(result.manifest));return result;
  }});
  const mismatchStage=await mismatch.stage([rustChange]);await assert.rejects(mismatch.verify(mismatchStage.id),/does not match its source/);
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'native/runtime.json')),before);
});

test('partial compiled activation rolls back and later recovery refuses missing or altered prior binaries',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.sourceDir,'native/runtime.json'));
  const stage=await f.manager.stage([rustChange]);await f.manager.verify(stage.id);
  const rename=fs.rename;let fail=true;
  fs.rename=async(from,to)=>{if(fail&&to===path.join(f.sourceDir,'native/runtime.json')){fail=false;throw new Error('Synthetic pointer write failure');}return rename(from,to);};
  try{await assert.rejects(f.manager.apply(stage.id),/pointer write failure/);}finally{fs.rename=rename;}
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'native/runtime.json')),before);
  assert.match(await fs.readFile(path.join(f.sourceDir,rustChange.path),'utf8'),/original/);
  await f.manager.apply(stage.id);
  const current=await fs.readFile(path.join(f.sourceDir,'native/runtime.json'));
  await fs.writeFile(path.join(f.sourceDir,'native',f.original.manifest.binary),'corrupted old executable');
  await assert.rejects(f.manager.rollback(),/rollback binary integrity mismatch/);
  assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'native/runtime.json')),current);
  assert.equal(await fs.readFile(path.join(f.sourceDir,rustChange.path),'utf8'),rustChange.content);
});

test('native binary directory links fail closed even when the referenced executable bytes are unchanged',async t=>{
  const f=await fixture(t),directory=path.join(f.sourceDir,'native/bin'),moved=path.join(f.root,'moved-binaries');
  await fs.rename(directory,moved);await fs.symlink(moved,directory,process.platform==='win32'?'junction':'dir');
  const status=await f.manager.activationStatus();assert.equal(status.restartRequired,true);assert.match(status.error,/Symlinks/);
  await assert.rejects(f.manager.stage([{path:'renderer/app.mjs',content:'// UI'}]),/symlinks|junctions/i);
});
