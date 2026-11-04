import test from 'node:test';
import assert from 'node:assert/strict';
import {redactReport,bugReportDraft,reportIssueUrl,externalWebUrl} from '../core/bug-report.mjs';

test('reports redact credentials, paths, account identifiers and URL query strings before creating a public draft',()=>{
  const secret='sk-examplePrivateCredential12345';
  const draft=bugReportDraft({description:'Failed for person@example.com',steps:'Open C:\\Users\\private\\file.txt',errors:[`Authorization: Bearer ${secret}`,`access_token=secret987 refresh_token="refresh987"`,`https://user:password@example.com/callback?code=secret123&state=abc`,`${secret}`]});
  const text=JSON.stringify(draft);
  for(const value of [secret,'secret987','refresh987','secret123','person@example.com','file.txt','password@'])assert.equal(text.includes(value),false,value);
  const url=new URL(reportIssueUrl(draft));assert.equal(url.origin,'https://github.com');assert.equal(url.pathname,'/youwebaba/Faber/issues/new');assert.match(url.searchParams.get('body'),/Review this report/);
  assert.equal(redactReport('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.signature'), '[token redacted]');
});

test('edited report URLs are fixed to Faber and reject oversized drafts; external links reject executable schemes',()=>{
  const url=new URL(reportIssueUrl({title:'&redirect=https://evil.example',body:'api_key=secret123'}));
  assert.equal(url.hostname,'github.com');assert.equal(url.searchParams.has('redirect'),false);assert.equal(url.href.includes('secret123'),false);
  assert.throws(()=>reportIssueUrl({title:'x',body:'😀'.repeat(9000)}),/too long/);
  for(const value of ['javascript:alert(1)','file:///C:/Users/private','data:text/html,evil','https://user:password@example.com'])assert.throws(()=>externalWebUrl(value));
  assert.equal(externalWebUrl('https://example.com/docs'),'https://example.com/docs');
});
