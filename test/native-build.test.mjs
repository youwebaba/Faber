import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildNative} from '../native/build.mjs';
import {nativeExecutableSuffix,verifyNativeRuntime} from '../native/integrity.mjs';

test('native builds remap private compiler paths while retaining pinned Cargo flags',async t=>{
  const sourceDir=await fs.mkdtemp(path.join(os.tmpdir(),'Faber-native-build-test-'));
  t.after(()=>fs.rm(sourceDir,{recursive:true,force:true}));
  await fs.mkdir(path.join(sourceDir,'native/src'),{recursive:true});
  await fs.mkdir(path.join(sourceDir,'native/.cargo'));
  for(const name of ['Cargo.toml','Cargo.lock','rust-toolchain.toml','.cargo/config.toml','src/main.rs'])await fs.writeFile(path.join(sourceDir,'native',name),'fixture');
  const calls=[];
  const runner=async(_command,args,options)=>{
    calls.push(args[0]);
    assert.equal(options.cwd,path.join(sourceDir,'native'));
    const config=args[args.indexOf('--config')+1],prefix=process.platform==='win32'?'target.x86_64-pc-windows-msvc':'build';
    assert.ok(config.startsWith(prefix+'.rustflags='));
    const remaps=JSON.parse(config.slice(config.indexOf('=')+1));
    if(process.platform==='win32')assert.deepEqual(remaps.splice(-2),['-C','link-arg=/Brepro']);
    const target=args[args.indexOf('--target-dir')+1];
    assert.deepEqual(remaps,[[os.homedir(),'/faber-build-home'],[sourceDir,'/faber'],[target,'/faber-target']].map(([from,to])=>'--remap-path-prefix='+path.resolve(from)+'='+to));
    for(const name of ['RUSTUP_TOOLCHAIN','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS'])assert.equal(options.env[name],undefined);
    if(args[0]==='build'){
      await fs.mkdir(path.join(target,'release'));
      await fs.writeFile(path.join(target,'release','faber-native'+nativeExecutableSuffix),'synthetic worker');
    }
    return {code:0,stdout:'',stderr:''};
  };
  const result=await buildNative({sourceDir,runner});
  assert.deepEqual(calls,['test','build']);
  assert.equal((await verifyNativeRuntime(sourceDir)).manifest.sha256,result.manifest.sha256);
});
