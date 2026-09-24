// Node.js 24 built-ins only. Run the real app viewer with synthetic files and DOM/API boundaries.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const file=process.env.COS_TEST_HTML||path.join(__dirname,'../index.html');
const script=fs.readFileSync(file,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/,'');
const pdfBytes=Uint8Array.from(Buffer.from('%PDF-1.7\n% synthetic viewer integration fixture\n')).buffer;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}

function fixture({mime='application/pdf',name='Образец.pdf',render=()=>Promise.resolve()}={}){
  const created=[],dialogs=[],elements=new Map(),calls=[],mounts=[],revoked=[],blobs=new Map();
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.listeners={};this.dataset={};this.style={};this.attributes={};this.className='';this.value='';this.disabled=false;this.open=false;this._html='';this._text='';this.mutations=0;this.classList={add(){},remove(){},toggle(){}};created.push(this)}
    get isConnected(){return this===document.body||!!this.parentElement?.isConnected}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('')}
    set textContent(value){this.clear();this._text=String(value);this.mutations++}
    get innerHTML(){return this._html}
    set innerHTML(value){this.clear();this._html=String(value);this.mutations++;
      if(this.tagName==='DIALOG'&&this._html.includes('media-viewer-body')){
        const close=new Element('button');close.setAttribute('data-close-media','');close.textContent='Закрыть';this.appendChild(close);
        const body=new Element('div');body.className='media-viewer-body';body.textContent='Загружаю файл…';this.appendChild(body);this.appendChild(new Element('footer'));
      }
    }
    clear(){for(const child of this.children)child.parentElement=null;this.children=[];this._text='';this._html=''}
    appendChild(child){if(child.parentElement)child.remove();child.parentElement=this;this.children.push(child);this.mutations++;return child}
    append(...children){children.forEach(child=>this.appendChild(child))}
    replaceChildren(...children){this.clear();this.mutations++;this.append(...children)}
    remove(){if(this.parentElement){const parent=this.parentElement;parent.children=parent.children.filter(child=>child!==this);parent.mutations++;this.parentElement=null}}
    addEventListener(name,handler){(this.listeners[name]??=[]).push(handler)}
    setAttribute(name,value){this.attributes[name]=String(value);if(name==='class')this.className=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value)}
    matches(selector){if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));if(selector.startsWith('['))return Object.hasOwn(this.attributes,selector.slice(1,-1));return this.tagName===selector.toUpperCase()}
    querySelectorAll(selector){const found=[];for(const child of this.children){if(child.matches(selector))found.push(child);found.push(...child.querySelectorAll(selector))}return found}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null}
    showModal(){this.open=true}
    close(){if(!this.open)return;this.open=false;this.onclose?.();for(const handler of this.listeners.close||[])handler()}
    focus(){this.focused=true}
  }
  const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector)},querySelectorAll(){return[]},createElement(tag){const node=new Element(tag);if(tag==='dialog')dialogs.push(node);return node},body:null};
  document.body=new Element('body');
  class TestURL extends URL{}
  TestURL.createObjectURL=blob=>{const url='blob:synthetic-'+(blobs.size+1);blobs.set(url,blob);return url};
  TestURL.revokeObjectURL=url=>revoked.push(url);
  const response=({status=200,type=mime,bytes=pdfBytes}={})=>({ok:status>=200&&status<300,status,headers:{get:name=>name.toLowerCase()==='content-type'?type:null},arrayBuffer:async()=>bytes.slice(0)});
  let network=async()=>response();
  const window={addEventListener(){},CoSPdfPreview:{mount(body,options){
    const footer=body.parentElement.querySelector('footer');
    const call={body,options,downloadsAtMount:footer.querySelectorAll('a').map(anchor=>({href:anchor.href,download:anchor.download})),disposed:0};mounts.push(call);
    const canvas=new Element('canvas');body.appendChild(canvas);
    return{ready:render(mounts.length,call),dispose(){call.disposed++}};
  }}};
  const context=vm.createContext({document,window,Date,Intl,URL:TestURL,Blob,ArrayBuffer,Uint8Array,console,crypto:webcrypto,
    location:new URL('https://chief-of-staff-v3-live.vercel.app/'),setTimeout,clearTimeout,setInterval(){},
    sessionStorage:{getItem(){return null},setItem(){},removeItem(){}}});
  vm.runInContext(script,context,{filename:file});
  context.netStub=async(url,options={})=>{calls.push({url,options});return network(url,options)};
  vm.runInContext('netFetch=netStub;',context);
  const app=vm.runInContext('({S,openAsset})',context);
  const asset={id:'synthetic-asset',original_name:name,mime_type:mime,storage_bucket:'project-media',storage_path:'synthetic/sample',url:'/storage/v1/object/sign/project-media/synthetic/sample?token=initial',signed_at:Date.now()};
  app.S.assets=[asset];
  return{app,asset,window,created,dialogs,calls,mounts,revoked,blobs,response,network(fn){network=fn},get dialog(){return dialogs.at(-1)},get body(){return this.dialog.querySelector('.media-viewer-body')},get footer(){return this.dialog.querySelector('footer')}};
}

test('PDF uses the application renderer and installs the original download before rendering starts',async()=>{
  const f=fixture();await f.app.openAsset(f.asset.id);
  assert.equal(f.mounts.length,1);
  assert.deepEqual(Array.from(new Uint8Array(f.mounts[0].options.bytes)),Array.from(new Uint8Array(pdfBytes)));
  assert.equal(f.mounts[0].options.title,'Образец.pdf');
  assert.deepEqual(f.mounts[0].downloadsAtMount,[{href:'blob:synthetic-1',download:'Образец.pdf'}]);
  assert.equal(f.blobs.get('blob:synthetic-1').type,'application/pdf');
  assert.equal(f.created.some(node=>['IFRAME','OBJECT','EMBED'].includes(node.tagName)),false,'PDF must not depend on a native browser PDF frame');
  assert.equal(f.footer.querySelectorAll('a').length,1);
  assert.equal(f.calls.length,1);assert.match(f.calls[0].url,/^\/storage\/v1\/object\/sign\//);
});

test('renderer rejection, including a password-protected PDF, preserves a working download and retry',async()=>{
  for(const reason of [Error('Cannot load PDF renderer'),Object.assign(Error('Password required'),{name:'PasswordException'})]){
    const f=fixture({render:()=>Promise.reject(reason)});await f.app.openAsset(f.asset.id);
    assert.equal(f.footer.querySelectorAll('a').length,1);
    assert.equal(f.footer.querySelector('a').href,'blob:synthetic-1');
    assert.match(f.footer.querySelector('button').textContent,/Повторить/);
    assert.equal(f.revoked.length,0,'failed preview must not invalidate the downloadable original');
    assert.equal(f.dialog.open,true);assert.notEqual(f.body.textContent,'Загружаю файл…');
  }
});

test('retry replaces the failed renderer and Blob URL without duplicate download controls',async()=>{
  const f=fixture({render:attempt=>attempt===1?Promise.reject(Error('Worker startup failed')):Promise.resolve()});
  await f.app.openAsset(f.asset.id);await f.footer.querySelector('button').onclick();
  assert.equal(f.mounts.length,2);assert.equal(f.mounts[0].disposed,1);
  assert.deepEqual(f.revoked,['blob:synthetic-1']);
  assert.equal(f.footer.querySelectorAll('a').length,1);assert.equal(f.footer.querySelector('a').href,'blob:synthetic-2');
  assert.equal(f.footer.querySelectorAll('button').length,0);
  f.dialog.close();assert.equal(f.mounts[1].disposed,1);assert.deepEqual(f.revoked,['blob:synthetic-1','blob:synthetic-2']);
});

test('closing during PDF rendering disposes resources and a late failure cannot update detached UI',async()=>{
  const pending=deferred(),f=fixture({render:()=>pending.promise}),loading=f.app.openAsset(f.asset.id);
  await tick();assert.equal(f.mounts.length,1);
  const body=f.body,footer=f.footer;f.dialog.close();
  const mutations=[body.mutations,footer.mutations];
  assert.equal(f.dialog.isConnected,false);assert.equal(f.mounts[0].disposed,1);assert.deepEqual(f.revoked,['blob:synthetic-1']);
  pending.reject(Error('Late renderer failure'));await loading;
  assert.deepEqual([body.mutations,footer.mutations],mutations);assert.equal(footer.querySelectorAll('button').length,0);
});

test('closing while the file is downloading creates no Blob or renderer after the response arrives',async()=>{
  const pending=deferred(),f=fixture();f.network(()=>pending.promise);const loading=f.app.openAsset(f.asset.id);
  await tick();const body=f.body,footer=f.footer;f.dialog.close();const mutations=[body.mutations,footer.mutations];
  pending.resolve(f.response());await loading;
  assert.equal(f.blobs.size,0);assert.equal(f.mounts.length,0);assert.equal(f.dialog.isConnected,false);
  assert.deepEqual([body.mutations,footer.mutations],mutations);
});

test('expired signed URL is refreshed once before rendering the downloaded PDF',async()=>{
  const f=fixture();let downloads=0;
  f.network(async(url,options)=>options.method==='POST'?{ok:true,json:async()=>({signedURL:'/object/sign/project-media/synthetic/sample?token=renewed'})}:f.response({status:++downloads===1?403:200}));
  await f.app.openAsset(f.asset.id);
  assert.equal(f.calls.length,3);assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
  assert.match(f.calls[1].url,/^\/storage\/v1\/object\/sign\/project-media\/synthetic\/sample$/);
  assert.equal(JSON.parse(f.calls[1].options.body).expiresIn,3600);
  assert.match(f.calls[2].url,/token=renewed$/);assert.equal(f.mounts.length,1);
});

test('repeated expired-link response stops after one refresh and exposes retry without an unusable download',async()=>{
  const f=fixture();f.network(async(url,options)=>options.method==='POST'?{ok:true,json:async()=>({signedURL:'/object/sign/project-media/synthetic/sample?token=renewed'})}:f.response({status:403}));
  await f.app.openAsset(f.asset.id);
  assert.equal(f.calls.length,3);assert.equal(f.mounts.length,0);assert.equal(f.blobs.size,0);
  assert.equal(f.footer.querySelectorAll('a').length,0);assert.match(f.footer.querySelector('button').textContent,/Повторить/);
});

test('image, audio, and video keep their native preview elements and original download MIME',async()=>{
  for(const [mime,name,tag] of [['image/png','photo.png','IMG'],['audio/mpeg','voice.mp3','AUDIO'],['video/mp4','clip.mp4','VIDEO']]){
    const f=fixture({mime,name});await f.app.openAsset(f.asset.id);
    assert.equal(f.mounts.length,0);const preview=f.body.children.find(node=>node.tagName===tag);assert.ok(preview);
    assert.equal(preview.src,'blob:synthetic-1');assert.equal(f.blobs.get(preview.src).type,mime);
    assert.equal(f.footer.querySelector('a').download,name);if(tag!=='IMG')assert.equal(preview.controls,true);
    f.dialog.close();assert.deepEqual(f.revoked,['blob:synthetic-1']);
  }
});

test('HTML, SVG, and unknown files remain download-only and retain original MIME',async()=>{
  for(const [mime,name] of [['text/html','document.html'],['image/svg+xml','drawing.svg'],['application/x-custom','data.custom']]){
    const f=fixture({mime,name});await f.app.openAsset(f.asset.id);
    assert.equal(f.mounts.length,0);assert.equal(f.body.children.length,0);
    assert.equal(f.created.some(node=>['IFRAME','OBJECT','EMBED','IMG'].includes(node.tagName)),false);
    assert.equal(f.footer.querySelector('a').download,name);assert.equal(f.blobs.get('blob:synthetic-1').type,mime);
  }
});
