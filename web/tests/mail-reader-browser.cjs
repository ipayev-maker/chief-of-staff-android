// Run with NODE_PATH pointing to an installed Playwright package; Chromium required.
const {chromium}=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],network=[];
 page.on('pageerror',e=>errors.push(e.message));
 const fixture=`
 window.addEventListener('load',()=>{
 const links={project_id:null,participant_ids:[],revision:0};
 const c1='11111111-1111-4111-8111-111111111111',c2='22222222-2222-4222-8222-222222222222';
 const messages=[{id:'m0',from:'Антон <anton@example.com>',to:'owner@example.com',date:'2026-10-20T10:00:00Z',subject:'Образец стойки · согласование'},{id:'m1',from:'Антон <anton@example.com>',to:'owner@example.com',date:'2026-10-21T10:00:00Z',subject:'Образец стойки · согласование'}];
 const change=(id,text)=>({id,kind:'task_create',text,evidence:text,project_id:null,participant_id:null,participant_name:'Антон',status:'open',direction:'from_me',deadline:null,deadline_time:null,next_check_on:null,planned_on:null,planned_time:null,source_message_id:'m1',trigger_message_id:'m1',selected:true});
 const records=[{id:'parent',status:'applied',source_meta:{delivery:'tasks',messages},proposal:{summary:'Поставщик прислал параметры образца. До запуска нужно подтвердить размеры и выбрать цвет металла.'}},...[[c1,'Подтвердить размеры образца'],[c2,'Согласовать цвет металла']].map(([id,text])=>({id,revision:1,status:'ready',source_meta:{delivery:'review',review_parent_id:'parent',messages},proposal:{changes:[change(id,text)]}}))];
 window.readerRecords=records;window.readerCalls=[];window.applyUncertain=true;
 const rows=[{id:'t1',from:messages[1].from,subject:messages[1].subject,date:messages[1].date,summary:'Параметры образца и два решения перед запуском.',needs_review:2},{id:'t2',from:'Мария <maria@example.com>',subject:'Доставка оборудования на площадку',date:'2026-10-21T08:00:00Z',summary:'Детали доставки и пропуска на разгрузку.'},{id:'t3',from:'Андрей <andrey@example.com>',subject:'Re: Чертежи для производства',date:'2026-10-20T15:00:00Z',summary:'Обновлённые чертежи во вложении.'}];
 window.CoSGmail.request=async (action,body)=>{window.readerCalls.push(action);const u=new URL('https://test/'+action);if(u.pathname==='/links'){Object.assign(links,body,{revision:links.revision+1});return {ok:true,links:structuredClone(links)};}if(u.pathname==='/letters')return {items:rows,nextOffset:null};if(u.pathname==='/thread')return {id:u.searchParams.get('id'),subject:messages[1].subject,messages,links:structuredClone(links),owner_email:'owner@example.com',records:structuredClone(records)};if(u.pathname==='/message')return {id:u.searchParams.get('id'),html:'<p>Добрый день!</p><p>Подготовили параметры первого образца. Просьба подтвердить размеры и выбрать цвет металла, чтобы передать комплект в производство.</p><table style="border-collapse:collapse;width:100%;font:15px Arial"><tr style="background:#f1f4f8"><th style="text-align:left;padding:14px">Параметр</th><th style="text-align:left;padding:14px">Значение</th></tr><tr><td style="padding:14px;border-bottom:1px solid #e4e9ef">Габариты</td><td style="padding:14px;border-bottom:1px solid #e4e9ef">600 × 400 × 1800 мм</td></tr><tr><td style="padding:14px">Материал</td><td style="padding:14px">Металл, порошковая окраска</td></tr></table><p>После согласования сообщим дату готовности.</p><p>С уважением,<br>Антон</p><script>parent.xss=true<'+'/script><img src="https://tracker.invalid/pixel" onerror="parent.xss=true"><iframe src="https://tracker.invalid/frame"></iframe><form action="https://tracker.invalid"><input value="bad"></form><a href="javascript:parent.xss=true">unsafe</a>',inline:[],attachments:[{name:'Чертёж стойки.pdf'}]};throw Error(action);};
 quickNotesRequest=async(url,init)=>{window.readerCalls.push({url,body:structuredClone(init.body)});if(window.applyUncertain&&url.endsWith('/apply')){window.applyUncertain=false;throw Error('Ответ не получен. Повторите.');}const r=records.find(r=>url.includes(r.id));r.status=url.endsWith('/defer')?'deferred':url.endsWith('/resume')?'ready':'applied';r.revision++;return {item:structuredClone(r),result:{tasks:[]}};};
 S.projects=[{id:'project1',title:'Интершарм',status:'active'},{id:'old',title:'Архивный',status:'completed'}];S.participants=[{id:'p1',name:'Антон'},{id:'p2',name:'Мария'}];
 persistNewProject=async(id,body)=>{const row={id,...body};S.projects.push(row);return row};S.section='mail';initDashboardNavigation();render();
 });`;
 const original=await fs.readFile(path.join(root,'index.html'),'utf8');
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.hostname!=='mail.test'){network.push(u.href);return route.abort();}try{const file=u.pathname==='/'?original.replace(/\bboot\(\);(?=\s*<\/script>)/,()=>fixture):await fs.readFile(path.join(root,u.pathname));return route.fulfill({body:file,contentType:u.pathname.endsWith('.css')?'text/css':u.pathname.endsWith('.js')?'text/javascript':'text/html'});}catch{return route.fulfill({status:404,body:''});}});
 await page.goto('https://mail.test/#/mail');await page.locator('.mr-email-frame').waitFor();await page.frameLocator('.mr-email-frame').getByText('600 × 400 × 1800 мм').waitFor();
 assert.equal(await page.locator('.mr-proposal').count(),1);assert.deepEqual(network,[]);assert.equal(await page.evaluate(()=>window.xss),undefined);
 assert.equal(await page.frameLocator('.mr-email-frame').locator('script,iframe,form,[onerror]').count(),0);
 assert.ok(await page.locator('.mr-mail-scroll').evaluate(e=>e.scrollHeight>e.clientHeight));
 await page.screenshot({path:process.env.MAIL_READER_SCREENSHOT||'/tmp/mail-reader-desktop.png'});
 await page.getByRole('button',{name:'Изменить связи'}).click();await page.getByLabel('Проект переписки',{exact:true}).selectOption('project1');await page.getByLabel('Добавить человека',{exact:true}).selectOption('p1');await page.getByRole('button',{name:'Сохранить связи'}).click();
 await page.getByRole('button',{name:'Обновить',exact:true}).click();assert.ok(await page.locator('.mr-links').getByText('Интершарм',{exact:true}).isVisible());
 await page.locator('.mr-proposal').first().getByRole('button',{name:'Исправить',exact:true}).click();
 assert.equal(await page.locator('[data-edit="project_id"] option').filter({hasText:'Архивный'}).count(),0);
 await page.locator('[data-edit="text"]').fill('Подтвердить габариты образца');
 await page.getByRole('button',{name:'Сохранить и принять'}).click();await page.getByText('Ответ не получен. Повторите.').waitFor();
 await page.getByRole('button',{name:'Сохранить и принять'}).click();
 await page.locator('.mr-proposal').filter({hasText:'Согласовать цвет металла'}).getByRole('button',{name:'Отклонить',exact:true}).click();
 const calls=await page.evaluate(()=>window.readerCalls.filter(x=>typeof x==='object'));assert.equal(calls[0].body.request_id,calls[1].body.request_id);assert.equal(calls[1].body.proposal.changes.length,1);assert.equal(calls[1].body.proposal.changes[0].text,'Подтвердить габариты образца');
 await page.getByRole('button',{name:'Вернуть',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'← Письма',exact:true}).click();assert.ok(await page.locator('.mr-list-pane').isVisible());assert.equal(await page.locator('.mr-reader').isVisible(),false);
 await page.locator('[data-letter="t1"]').click();await page.locator('.mr-email-frame').waitFor();assert.equal(await page.locator('.mr-list-pane').isVisible(),false);assert.ok(await page.locator('.mr-reader').isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:'/tmp/mail-reader-mobile.png'});
 assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile reading, HTML isolation, zero tracking requests, one-action acceptance, stable retry ID, edit, reject, restore, active-project filtering.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
