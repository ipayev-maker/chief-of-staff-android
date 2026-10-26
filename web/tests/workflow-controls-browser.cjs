// Release browser regression: native links, one-layer Escape and project note scope.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'../dist'),config=require('../vercel.json'),security=config.headers.find(h=>h.source==='/(.*)').headers;
 const project='00000000-0000-4000-8000-000000000010',activeId='00000000-0000-4000-8000-000000000011',archiveId='00000000-0000-4000-8000-000000000012';
 const taskId='00000000-0000-4000-8000-000000000013';
 const savedTask={id:taskId,description:'Проверить образец',details:'Первая строка\r\nВторая строка',project_id:project,status:'open',direction:null,estimate_minutes:0,deadline:'2026-10-27',cos_version:1};
 const note=(archived=false)=>({id:archived?archiveId:activeId,project_id:project,title:archived?'Архивная заметка':'Активная заметка',plain_text:archived?'Старая запись':'Текущая запись',source:'web',revision:1,created_at:'2026-10-26T12:00:00Z',updated_at:'2026-10-26T12:00:00Z',archived_at:archived?'2026-10-26T13:00:00Z':null});
 const noteQueries=[];const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=url.pathname;res.setHeader('Cache-Control','no-store');
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))};
  if(p==='/api/session')return json({authenticated:true});
  if(p==='/api/notes'){noteQueries.push(url.searchParams.get('archived'));return json({notes:[note(url.searchParams.get('archived')==='true')],nextOffset:null})}
  if(p.match(/^\/api\/notes\/[^/]+\/assets$/))return json({assets:[]});
  if(p==='/api/notes/'+activeId||p==='/api/notes/'+archiveId)return json({note:note(p.endsWith(archiveId))});
  if(p.startsWith('/rest/v1/'))return json(p.endsWith('/projects')?[{id:project,title:'Проект проверки',status:'active',created_at:'2026-10-26T12:00:00Z'}]:p.endsWith('/commitments')?[savedTask]:p.endsWith('/project_notes')?[note(true)]:[]);
  if(p.startsWith('/api/'))return json({authenticated:true,items:[],nextOffset:null,settings:{enabled:false},status:'connected'});
  const file=path.resolve(root,p==='/'?'index.html':'.'+p);if(!file.startsWith(root+'/')||!fs.existsSync(file)){res.statusCode=404;return res.end()}
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');
  for(const h of security)res.setHeader(h.key,h.value.replace('; upgrade-insecure-requests',''));res.end(fs.readFileSync(file));
 }).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const {chromium}=require(process.env.COS_PLAYWRIGHT||'playwright'),c=process.env.COS_CHROMIUM_PACKAGE?(await import(process.env.COS_CHROMIUM_PACKAGE)).default:{args:[]};
 const browser=await chromium.launch({headless:true,args:c.args,...(process.env.COS_CHROMIUM_PATH?{executablePath:process.env.COS_CHROMIUM_PATH}:{})});
 try{
  const context=await browser.newContext(),page=await context.newPage(),base='http://127.0.0.1:'+server.address().port,errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('.today-page').waitFor();
  assert.equal(await page.locator('#nav a[data-sec]').count(),8);
  const original=page.url();const [tab]=await Promise.all([context.waitForEvent('page'),page.locator('#nav [data-sec="tasks"]').click({button:'middle'})]);
  await tab.waitForLoadState();assert.equal(new URL(tab.url()).hash,'#/tasks');assert.equal(page.url(),original);await tab.close();
  await page.locator('#nav [data-sec="tasks"]').click();
  const unexpectedDialogs=[],dismissUnexpected=async d=>{unexpectedDialogs.push(d.message());await d.dismiss()};page.on('dialog',dismissUnexpected);
  const openSaved=async()=>{await page.locator(`[data-global-task="${taskId}"]`).click();await page.locator('#tdDesc').waitFor()};
  await openSaved();await page.keyboard.press('Escape');assert.deepEqual(unexpectedDialogs,[],'Untouched saved task must close without confirmation');assert.equal(await page.locator('.task-drawer').count(),0);
  await openSaved();await page.locator('#tdDesc').fill('Изменённая задача');await page.locator('#tdDesc').fill(savedTask.description);await page.keyboard.press('Escape');assert.deepEqual(unexpectedDialogs,[],'Reverted edits must not require confirmation');assert.equal(await page.locator('.task-drawer').count(),0);
  await openSaved();await page.locator('#nav [data-sec="people"]').click();await page.waitForURL('**/#/people');assert.deepEqual(unexpectedDialogs,[],'Navigation from an untouched task must not require confirmation');page.off('dialog',dismissUnexpected);
  await page.locator('#nav [data-sec="tasks"]').click();await openSaved();await page.locator('#tdDesc').fill('Настоящее изменение');page.once('dialog',d=>d.dismiss());await page.keyboard.press('Escape');assert.equal(await page.locator('#tdDesc').inputValue(),'Настоящее изменение');page.once('dialog',d=>d.accept());await page.keyboard.press('Escape');assert.equal(await page.locator('.task-drawer').count(),0);
  await page.locator('#globalTaskNew').click();await page.locator('.task-drawer').waitFor();
  await page.locator('#tdDesc').fill('Несохранённая задача');page.once('dialog',d=>d.dismiss());await page.keyboard.press('Escape');assert.equal(await page.locator('.task-drawer').count(),1);
  page.once('dialog',d=>d.accept());await page.keyboard.press('Escape');assert.equal(await page.locator('.task-drawer').count(),0);
  await page.locator('#globalTaskNew').click();await page.locator('#calendarSettings').click();await page.locator('dialog[open]').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('.task-drawer').count(),1);
  await page.keyboard.press('Escape');assert.equal(await page.locator('.task-drawer').count(),0);
  await page.locator('#nikBtn').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#nikPanel.open').count(),0);
  await page.goto(base+'/#/projects/'+project+'/notes');await page.locator('#quickNoteTitle').waitFor();assert.equal(await page.locator('#quickNoteTitle').inputValue(),'Активная заметка');
  await page.locator('#projectNotesArchive').click();await page.waitForFunction(()=>document.querySelector('#quickNoteTitle')?.value==='Архивная заметка');assert.equal(await page.locator('#quickNoteTitle').inputValue(),'Архивная заметка');
  await page.locator('[data-tab="tasks"]').click();await page.locator('[data-tab="notes"]').click();await page.waitForFunction(()=>document.querySelector('#quickNoteTitle')?.value==='Активная заметка'&&!document.querySelector('#quickNoteTitle')?.disabled);assert.equal(await page.locator('#quickNoteTitle').inputValue(),'Активная заметка');assert.equal(noteQueries.at(-1),'false');
  assert.deepEqual(errors,[]);console.log('PASS: untouched and reverted tasks close without confirmation; real changes are protected; middle-click and project notes work.');
 }finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
