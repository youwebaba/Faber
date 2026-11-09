import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunActivity} from '../renderer/run-activity.mjs';

class Node{
  constructor(tag,document,cls='',text=''){Object.assign(this,{tag,ownerDocument:document,className:cls,textContent:text,children:[],dataset:{},open:false});this.classList={toggle(){}};}
  append(...nodes){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parent=undefined;this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=undefined;}
  replaceWith(node){const parent=this.parent,index=parent.children.indexOf(this);node.remove();parent.children[index]=node;node.parent=parent;this.parent=undefined;}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  get isConnected(){return this===this.ownerDocument.body||this.parent?.isConnected===true;}
  get firstChild(){return this.children[0];}get lastChild(){return this.children.at(-1);}
  querySelector(selector){return this.children.find(node=>selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tag===selector)||this.children.map(node=>node.querySelector(selector)).find(Boolean);}
  setAttribute(){}addEventListener(){}focus(){this.ownerDocument.activeElement=this;}
}
test('activity owner prunes retired card/tool/usage indexes while retaining visible identity, disclosure and focus',t=>{
  const previous=globalThis.document,document={activeElement:null};document.body=new Node('body',document);globalThis.document=document;t.after(()=>{globalThis.document=previous;});const el=(tag,cls,text)=>new Node(tag,document,cls,text),parent=el('section');document.body.append(parent);
  const owner=createRunActivity({el,button:label=>el('button','',label),appendResult:(node,value)=>node.append(el('pre','',String(value))),selectChat(){},resolveApproval(){}}),run={id:'run',chatId:'chat',status:'running'},event={id:'event',name:'files_read',status:'completed',result:'known'},row={id:'card',run,events:[event],childRuns:[],active:true,last:true,approvals:[]},state={chats:[]};
  const card=owner.get(state,row),usage=owner.promptUsage('usage',{});parent.append(card,usage);owner.prune(parent);const tool=card.querySelector('.run-activity-tool'),focus=tool.querySelector('summary');card.open=tool.open=true;focus.focus();const updated=owner.get(state,row,new Map([[run.id,{text:'New live text'}]]));owner.prune(parent);assert.equal(updated,card);assert.equal(card.querySelector('.run-activity-tool'),tool);assert.equal(card.open,true);assert.equal(tool.open,true);assert.equal(document.activeElement,focus);assert.equal(owner.promptUsage('usage',{}),usage);
  parent.replaceChildren();owner.prune(parent);const replacement=owner.get(state,row);assert.notEqual(replacement,card);assert.notEqual(replacement.querySelector('.run-activity-tool'),tool);assert.notEqual(owner.promptUsage('usage',{}),usage);
  parent.append(replacement);owner.reset();assert.notEqual(owner.get(state,row),replacement,'scope reset clears all node indexes');
});
