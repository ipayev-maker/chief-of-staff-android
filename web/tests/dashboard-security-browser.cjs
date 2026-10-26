// Node.js 24 + Playwright. Real release assets and CSP; synthetic HTTP responses.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'../dist'),config=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../vercel.json'),'utf8'));
 const csp=config.headers.find(r=>r.source==='/(.*)').headers.find(h=>h.key==='Content-Security-Policy').value;
 const referrerPolicy=config.headers.find(r=>r.source==='/(.*)').headers.find(h=>h.key==='Referrer-Policy').value;
 let authorized=false,unlocked=false,configured=false,reads=0,logout=0,loginOrigin=null,pinCalls=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=url.pathname;res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy',referrerPolicy);
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))};
  if(p==='/api/session')return json({authenticated:authorized,pinRequired:!unlocked,pinSetupRequired:!configured});
  if(p==='/api/session/pin/lock'){unlocked=false;return json({ok:true})}
  if(p==='/api/session/pin/setup'||p==='/api/session/pin/unlock'){pinCalls++;let body='';req.on('data',x=>body+=x);req.on('end',()=>{const v=JSON.parse(body);if(v.pin==='0123'&&(p.endsWith('/unlock')||v.confirmation===v.pin)){configured=true;unlocked=true;return json({ok:true})}res.statusCode=400;json({error:'pin_incorrect'})});return}
  if(p==='/api/session/logout'){authorized=false;logout++;return json({ok:true})}
  if(p==='/api/google-calendar/start'){loginOrigin=req.headers.origin;res.statusCode=303;res.setHeader('Location','/');return res.end()}
  if(p.startsWith('/rest/v1/')){reads++;if(!authorized||!unlocked){res.statusCode=423;return json({error:'pin_required'})}return json([])}
  if(p.startsWith('/api/')){res.statusCode=401;return json({error:'unauthorized'})}
  const file=path.resolve(root,p==='/'?'index.html':'.'+p);if(!file.startsWith(root+'/')||!fs.existsSync(file)){res.statusCode=404;return res.end()}
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');
  res.setHeader('Content-Security-Policy',csp.replace('; upgrade-insecure-requests',''));res.end(fs.readFileSync(file));
 }).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const {chromium}=require(process.env.COS_PLAYWRIGHT||'playwright'),c=process.env.COS_CHROMIUM_PACKAGE?(await import(process.env.COS_CHROMIUM_PACKAGE)).default:{args:[]};
 const browser=await chromium.launch({headless:true,args:c.args,...(process.env.COS_CHROMIUM_PATH?{executablePath:process.env.COS_CHROMIUM_PATH}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],cspErrors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy/.test(m.text()))cspErrors.push(m.text())});
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'Войти через Google',exact:true}).waitFor();
  assert.equal(reads,0,'no business reads before login');assert.equal(await page.locator('.app').isVisible(),false);
  await page.getByRole('button',{name:'Войти через Google',exact:true}).click();await page.waitForLoadState('networkidle');await page.getByRole('button',{name:'Войти через Google',exact:true}).waitFor();assert.equal(loginOrigin,'http://127.0.0.1:'+server.address().port,'login POST retains same-origin identity for CSRF validation');
  await page.screenshot({path:'/tmp/cos-owner-login.png'});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  authorized=true;await page.getByRole('button',{name:'Проверить вход',exact:true}).click();await page.locator('#dashboardPin').waitFor();assert.equal(reads,0);assert.equal(await page.locator('.app').isVisible(),false);assert.equal(await page.locator('#dashboardPin').getAttribute('maxlength'),'4');
  await page.locator('#dashboardPin').fill('0123');await page.locator('#dashboardPinConfirm').fill('0124');await page.locator('#dashboardPinSubmit').click();assert.equal(await page.locator('#dashboardPinError').textContent(),'PIN-коды не совпадают.');assert.equal(pinCalls,0);
  await page.locator('#dashboardPinConfirm').fill('0123');await page.locator('#dashboardPinSubmit').click();await page.locator('.today-page,.today-kpis').first().waitFor();assert.ok(reads>=7);assert.ok(await page.locator('.app').isVisible());assert.equal(pinCalls,1);
  const previousReads=reads;await page.locator('#dashboardLock').click();await page.locator('#dashboardPin').waitFor();assert.equal(await page.locator('#dashboardPinConfirm').count(),0);assert.equal(reads,previousReads);await page.screenshot({path:'/tmp/cos-pin-login.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#dashboardPin').fill('9999');await page.locator('#dashboardPinSubmit').click();await page.getByText('Неверный PIN-код.',{exact:true}).waitFor();assert.equal(reads,previousReads);assert.equal(await page.locator('#dashboardPin').inputValue(),'');
  await page.locator('#dashboardPin').fill('0123');await page.locator('#dashboardPinSubmit').click();await page.locator('.today-page,.today-kpis').first().waitFor();assert.ok(await page.locator('.app').isVisible());
  await page.locator('#dashboardLogout').click();await page.getByRole('button',{name:'Войти через Google',exact:true}).waitFor();assert.equal(logout,1);assert.equal(await page.locator('.app').isVisible(),false);
  assert.deepEqual(errors,[]);assert.deepEqual(cspErrors,[]);console.log('PASS: release CSP, login-only screen, zero reads before Google and PIN, four-digit setup, mismatch, wrong PIN, relock, mobile layout and logout.');
 }finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
