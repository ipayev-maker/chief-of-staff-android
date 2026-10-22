// Run with NODE_PATH pointing to a jsdom installation. No external requests or user data.
const {JSDOM}=require('jsdom'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM('<div id="editor"></div><div id="mail"></div>',{url:'https://test.invalid',pretendToBeVisual:true});const {window}=dom,document=window.document;
 const editorModule=require('../note-editor.js'),host=document.getElementById('editor'),id='00000000-0000-4000-8000-000000000001',asset={id,mime_type:'image/png',original_name:'image.png',url:'https://storage.invalid/signed-image'};let stored;
 const editor=editorModule.mount(host,{text:'До картинки. После картинки.',onFiles:async()=>[asset],onSave:()=>{stored=editor.getDocument()},onError:e=>{throw e}});
 const range=document.createRange();range.setStart(host.firstChild.firstChild,12);range.collapse(true);window.getSelection().removeAllRanges();window.getSelection().addRange(range);host.dispatchEvent(new window.Event('keyup'));
 await editor.addFiles([{type:'image/png',name:'image.png'}]);
 assert.deepEqual(stored.blocks.filter(b=>b.type==='image').map(b=>b.asset_id),[id]);
 const index=stored.blocks.findIndex(b=>b.type==='image');assert.ok(stored.blocks.slice(0,index).some(b=>b.text.includes('До картинки')));assert.ok(stored.blocks.slice(index+1).some(b=>b.text.includes('После картинки')));
 editor.dispose();const reopened=editorModule.mount(host,{document:stored,assets:[asset]});assert.equal(host.querySelectorAll('img').length,1);assert.deepEqual(reopened.getDocument(),stored);
 host.querySelector('figure button').click();assert.equal(reopened.getDocument().blocks.some(b=>b.type==='image'),false);assert.ok(editorModule.plainText(reopened.getDocument()).includes('После картинки'));
 window.matchMedia=()=>({matches:true});window.ResizeObserver=class{observe(){}disconnect(){}};window.confirm=()=>true;
 const mailHost=document.getElementById('mail'),reader=require('../mail-reader.js');const changes=[{id:'c',text:'Проверить размеры',kind:'task_create',selected:true}],records=[{id:'r',revision:1,status:'ready',source_meta:{delivery:'review',messages:[{id:'m1'},{id:'m2'}]},proposal:{changes}}];
 let bodyRequests=0;
 const controller=reader.mount(mailHost,{projects:[],participants:[],mailRequest:async path=>{const url=new URL(path,'https://test.invalid/');if(url.pathname==='/letters')return {items:[{id:'t1',subject:'Thread 1',needs_review:1},{id:'t2',subject:'Thread 2',needs_review:0}],nextOffset:null};if(url.pathname==='/thread')return {id:url.searchParams.get('id'),messages:[{id:'m1',subject:'First'},{id:'m2',subject:'Second'}],records:structuredClone(records)};if(url.pathname==='/message'){bodyRequests++;return {html:'<p>Body</p>'}}throw Error(path)},notesRequest:async()=>{records[0].status='applied';return {item:structuredClone(records[0])}}});
 const settle=()=>new Promise(resolve=>setImmediate(resolve));await settle();await settle();
 const chooser=mailHost.querySelector('[data-message]');chooser.value='m1';chooser.dispatchEvent(new window.Event('change',{bubbles:true}));await settle();
 const scroll=mailHost.querySelector('.mr-mail-scroll');scroll.scrollTop=85;const originalFrame=mailHost.querySelector('iframe');const before=bodyRequests;
 mailHost.querySelector('[data-action="refresh"]').click();await settle();await settle();
 assert.equal(mailHost.querySelector('[data-message]').value,'m1');assert.equal(bodyRequests,before);assert.equal(mailHost.querySelector('.mr-mail-scroll').scrollTop,85);assert.equal(mailHost.querySelector('iframe'),originalFrame);
 mailHost.querySelector('[data-filter="review"]').click();await settle();mailHost.querySelector('.mr-proposal [data-action="apply"]').click();await settle();await settle();assert.equal(mailHost.querySelector('[data-letter="t1"]'),null);assert.ok(mailHost.querySelector('.mr-reader').textContent.includes('First'));
 controller.dispose();dom.window.close();console.log('PASS: cursor image insertion, reopen, removal keeps text; mail refresh keeps selected message, frame and scroll; handled mail leaves review list.');
})().catch(e=>{console.error(e);process.exitCode=1});
