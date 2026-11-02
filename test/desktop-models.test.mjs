import test from 'node:test';
import assert from 'node:assert/strict';
import {huggingFacePage} from '../desktop/huggingface-page.mjs';

test('external model links allow only canonical Hugging Face repository pages',()=>{
  assert.equal(huggingFacePage('https://huggingface.co/owner/model-name.v2'),'https://huggingface.co/owner/model-name.v2');
  for(const url of ['http://huggingface.co/owner/model','https://huggingface.co.evil.test/owner/model','https://user@huggingface.co/owner/model','https://huggingface.co/owner/model?redirect=evil','https://huggingface.co/owner/model#x','https://huggingface.co/owner/model/resolve/main/a','https://huggingface.co/owner/%2E%2E','file:///C:/Windows','javascript:alert(1)'])assert.throws(()=>huggingFacePage(url));
});
