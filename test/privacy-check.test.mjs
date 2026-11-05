import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {checkPrivacy,localIdentity,scanText,scanNativeBinary} from '../scripts/privacy-check.mjs';

const require=createRequire(import.meta.url);
let archiveReader;
try{archiveReader=require.resolve('@electron/asar');}catch(error){if(error.code!=='MODULE_NOT_FOUND') throw error;}

test('privacy gate detects home paths including escaped and encoded paths',()=>{
  const windows=['C:','Users','private-person','OneDrive','project'].join('\\');
  for(const value of [windows,JSON.stringify(windows),encodeURIComponent(windows),['D:','OneDrive','project'].join('\\'),['','Users','private-person','project'].join('/'),['','home','private-person','project'].join('/')]){
    assert.ok(scanText(`first\n${value}`).some(item=>item.category==='user-path'&&item.line===2));
  }
});

test('privacy gate detects local identity terms without storing identity values',()=>{
  assert.deepEqual(scanText('Author: Synthetic Person',{terms:['Synthetic Person']}),[{line:1,category:'personal-name'}]);
  assert.deepEqual(scanText('Synthetic Personality',{terms:['Synthetic Person']}),[]);
  assert.deepEqual(scanText('Synthetic Person',{file:'build/licenses/NOTICE.txt',terms:['Synthetic Person']}),[]);
  assert.throws(()=>localIdentity({FABER_PRIVACY_TERMS:'[] invalid'}));
  assert.equal(localIdentity({FABER_PRIVACY_TERMS:'["Synthetic Person"]'}).configured,true);
});

test('privacy gate detects credential and private-key formats even in licenses',()=>{
  const key='sk-'+'Q3wE9rT4'.repeat(5);
  const pem=['-----BEGIN','RSA PRIVATE KEY-----'].join(' ');
  assert.ok(scanText(key,{file:'build/licenses/NOTICE.txt'}).some(item=>item.category==='credential'));
  assert.ok(scanText(pem).some(item=>item.category==='private-key'));
  assert.ok(scanText(['apiKey',': ',JSON.stringify('m9Qz4Vr7S2wX6tP1')].join('')).some(item=>item.category==='credential'));
});

test('privacy gate preserves placeholders, fake credentials and public keys',()=>{
  for(const user of ['<username>','[user]','username','test-user','example-user','%USERNAME%']){
    assert.deepEqual(scanText(['C:','Users',user,'OneDrive','project'].join('\\')),[]);
  }
  assert.deepEqual(scanText('apiKey: "fake-'+'Q3wE9rT4'.repeat(5)+'"'),[]);
  assert.deepEqual(scanText('sk-test-'+'Q3wE9rT4'.repeat(5)),[]);
  assert.deepEqual(scanText(['-----BEGIN','PUBLIC KEY-----'].join(' ')),[]);
  const service=['','home','lightpanda'].join('/');
  assert.deepEqual(scanText(JSON.stringify(service),{file:'bundled-addons/lightpanda/runtime.mjs'}),[]);
  assert.ok(scanText(JSON.stringify(service+'/private'),{file:'bundled-addons/lightpanda/runtime.mjs'}).length);
  assert.ok(scanText(JSON.stringify(service),{file:'other.mjs'}).length);
});

test('owned binary scanning detects ASCII and either UTF-16 alignment with safe categories',()=>{
  const home=['C:','Users','private-person','OneDrive','source'].join('\\');
  for(const buffer of [Buffer.from(home),Buffer.from(home,'utf16le'),Buffer.concat([Buffer.from([0]),Buffer.from(home,'utf16le')])]){
    assert.ok(scanNativeBinary(buffer).some(item=>item.category==='binary-user-path'));
  }
  assert.ok(scanNativeBinary(Buffer.from('Synthetic Person'),{terms:['Synthetic Person']}).some(item=>item.category==='binary-personal-name'));
  assert.deepEqual(scanNativeBinary(Buffer.from([0,1,2,3])),[]);
});

test('release check fails closed and extracted source scan needs neither Git nor dev dependencies',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'faber-privacy-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'app'));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({build:{files:['app/**','package.json'],extraResources:[]}}));
  fs.writeFileSync(path.join(root,'.gitignore'),'app/ignored.txt\n');
  fs.writeFileSync(path.join(root,'tracked.txt'),'safe');
  const identity={terms:['Synthetic Person'],configured:true};
  assert.throws(()=>checkPrivacy({root,strict:true,identity:{terms:[],configured:false}}),/requires local identity/);
  fs.writeFileSync(path.join(root,'app','ignored.txt'),'Synthetic Person');
  const reports=[];
  assert.throws(()=>checkPrivacy({root,strict:true,identity,report:value=>reports.push(value)}),/Privacy check failed/);
  assert.deepEqual(reports,['app/ignored.txt:1: personal-name']);
  assert.ok(reports.every(value=>!value.includes('Synthetic Person')&&!value.includes(root)));
  fs.writeFileSync(path.join(root,'app','ignored.txt'),'safe');
  assert.ok(checkPrivacy({root,strict:true,identity}).checked>=2);
  fs.writeFileSync(path.join(root,'app','Synthetic Person.bin'),Buffer.from([0,1,2]));
  const filenames=[];
  assert.throws(()=>checkPrivacy({root,identity,report:value=>filenames.push(value)}));
  assert.deepEqual(filenames,['[redacted-path]:1: personal-name']);
  fs.mkdirSync(path.join(root,'.git'));
  assert.throws(()=>checkPrivacy({root,identity}),/could not complete/);
});

test('packaged archive scan checks actual text entries and suppresses filesystem errors',{skip:!archiveReader&&'archive reader is a build-time dev dependency'},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'faber-privacy-archive-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const input=path.join(root,'input');
  const archive=path.join(root,'app.asar');
  fs.mkdirSync(input);
  fs.writeFileSync(path.join(input,'app.txt'),'Synthetic Person');
  const asar=require(archiveReader);
  await asar.createPackage(input,archive);
  const reports=[];
  const identity={terms:['Synthetic Person'],configured:true};
  assert.throws(()=>checkPrivacy({archive,strict:true,identity,report:value=>reports.push(value)}),/Privacy check failed/);
  assert.deepEqual(reports,['app.txt:1: personal-name']);
  fs.writeFileSync(path.join(input,'app.txt'),'safe');
  await asar.createPackage(input,archive);
  asar.uncache(archive);
  assert.equal(checkPrivacy({archive,strict:true,identity}).checked,1);
  fs.mkdirSync(path.join(input,'native','bin'),{recursive:true});
  const name='a'.repeat(64)+'.exe';
  fs.writeFileSync(path.join(input,'native','runtime.json'),JSON.stringify({binary:`bin/${name}`}));
  fs.writeFileSync(path.join(input,'native','bin',name),Buffer.concat([Buffer.from([0]),Buffer.from('Synthetic Person','utf16le')]));
  await asar.createPackageWithOptions(input,archive,{unpack:'native/bin/**'});
  asar.uncache(archive);
  const binaryReports=[];
  assert.throws(()=>checkPrivacy({archive,identity,report:value=>binaryReports.push(value)}));
  assert.deepEqual(binaryReports,[`native/bin/${name}:1: binary-personal-name`]);
  fs.writeFileSync(path.join(input,'native','bin',name),Buffer.from([0,1,2,3]));
  fs.writeFileSync(path.join(input,'native','bin','stale.exe'),Buffer.from([0,1,2,3]));
  await asar.createPackageWithOptions(input,archive,{unpack:'native/bin/**'});
  asar.uncache(archive);
  const staleReports=[];
  assert.throws(()=>checkPrivacy({archive,identity,report:value=>staleReports.push(value)}));
  assert.deepEqual(staleReports,['native/bin/stale.exe:1: unexpected-native-binary']);
  assert.throws(()=>checkPrivacy({archive:path.join(root,'missing.asar'),identity}),error=>!error.message.includes(root)&&/could not complete/.test(error.message));
});
