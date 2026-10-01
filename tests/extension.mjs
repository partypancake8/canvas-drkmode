import { chromium } from 'playwright';
import { access,mkdtemp,rm,writeFile,readdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { auditPixels } from './audit.mjs';
const root=resolve(import.meta.dirname,'..'),extension=resolve(root,'extension');
const profile=await mkdtemp(resolve(tmpdir(),'canvas-extension-test-'));
const options={channel:'chromium',headless:true,viewport:{width:1280,height:900},deviceScaleFactor:1,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]};
let context,worker,page,id;const checks=[];
async function start(){
 context=await chromium.launchPersistentContext(profile,options);
 [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
 id=worker.url().split('/')[2];
 await worker.evaluate(async()=>{for(let i=0;i<50;i++){if((await chrome.scripting.getRegisteredContentScripts()).length)return;await new Promise(r=>setTimeout(r,50));}throw Error('No CSS registration');});
 page=await context.newPage();
 await page.addInitScript(()=>{requestAnimationFrame(()=>window.__firstPaintFilter=getComputedStyle(document.documentElement).filter);});
}
async function check(name,fn){try{await fn();checks.push({name,pass:true});console.log('PASS',name);}catch(error){checks.push({name,pass:false,error:error.message});console.log('FAIL',name,error.message);}}
async function popup(){const p=await context.newPage();await page.bringToFront();await p.goto(`chrome-extension://${id}/popup.html`);await p.waitForFunction(()=>!document.querySelector('#status').textContent.startsWith('Checking'));return p;}
try{
 await start();
 await check('Read-only pixel checker detects white panels and dark-on-dark text',async()=>{
  const pixels=new PNG({width:128,height:96});
  for(let i=0;i<pixels.data.length;i+=4)pixels.data.set([10,10,10,255],i);
  for(let y=0;y<64;y++)for(let x=0;x<64;x++)pixels.data.set([255,255,255,255],(y*128+x)*4);
  for(let y=70;y<80;y++)for(let x=70;x<100;x++)pixels.data.set([20,20,20,255],(y*128+x)*4);
  const result=auditPixels(PNG.sync.write(pixels),[{text:'Negative control',x:65,y:65,width:40,height:25,color:[20,20,20]}]);
  assert.ok(result.nearWhiteRegions.length);assert.equal(result.lowContrast.length,1);
  for(let y=70;y<80;y++)for(let x=70;x<100;x++)pixels.data.set([165,165,165,255],(y*128+x)*4);
  assert.equal(auditPixels(PNG.sync.write(pixels),[{text:'Antialiased glyph',x:65,y:65,width:40,height:25,color:[255,255,255]}]).lowContrast.length,0);
 });
 await check('Only extension runtime files; no underscore-prefixed entries',async()=>{
  assert.deepEqual((await readdir(extension)).sort(),['background.js','dark.css','icons','manifest.json','popup.html','popup.js','state.js']);
  const m=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));assert.equal(m.manifest_version,3);
  for(const f of Object.values(m.icons))await access(resolve(extension,f));
  for(const f of await readdir(resolve(extension,'icons')))assert.ok(!f.startsWith('_'));
 });
 await check('Declarative document_start CSS persists and excludes all child frames',async()=>{
  const scripts=await worker.evaluate(()=>chrome.scripting.getRegisteredContentScripts());
  const s=scripts.find(s=>s.id==='canvas-dark');
  assert.deepEqual(s.css,['dark.css']);assert.equal(s.allFrames,false);assert.equal(s.runAt,'document_start');assert.equal(s.persistAcrossSessions,true);
  assert.equal(scripts.find(s=>s.id==='canvas-media').css?.length||0,0);
 });
 await check('Initial dark render; opening popup is passive; explicit off has no dark flash',async()=>{
  await page.goto('https://canvas.instructure.com/login/canvas');await page.waitForFunction(()=>window.__firstPaintFilter);
  assert.match(await page.evaluate(()=>window.__firstPaintFilter),/invert\(1\)/);
  const before=await worker.evaluate(()=>chrome.storage.sync.get(null)),p=await popup();
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.sync.get(null)),before);
  assert.match(await p.locator('#toggle').innerText(),/Turn dark mode off for this site/);
  await p.locator('#toggle').click();await page.waitForFunction(()=>getComputedStyle(document.documentElement).filter==='none');
  await page.reload();await page.waitForFunction(()=>window.__firstPaintFilter);
  assert.equal(await page.evaluate(()=>window.__firstPaintFilter),'none');await p.close();
 });
 await check('Off persists through actual browser restart without a dark first frame',async()=>{
  await context.close();await start();await page.goto('https://canvas.instructure.com/login/canvas');await page.waitForFunction(()=>window.__firstPaintFilter);
  assert.equal(await page.evaluate(()=>window.__firstPaintFilter),'none');
  const p=await popup();assert.match(await p.locator('#toggle').innerText(),/Turn dark mode on for this site/);
  await p.locator('#toggle').click();await page.waitForFunction(()=>getComputedStyle(document.documentElement).filter.includes('invert(1)'));await p.close();
 });
 await check('Custom domain permission, existing-tab application, passive add and persistence',async()=>{
  // A saved real public login page tests hostname registration only. It is NOT
  // used as evidence for any authenticated Canvas page or visual acceptance.
  const html=await page.content(),host='canvas.registration.test';
  await context.route(`https://${host}/**`,r=>r.fulfill({contentType:'text/html',body:html}));
  const custom=await context.newPage();await custom.goto(`https://${host}/`);
  assert.equal(await custom.locator('html').evaluate(e=>getComputedStyle(e).filter),'none');
  const p=await popup(),before=await worker.evaluate(()=>chrome.storage.sync.get('sites'));
  const denied=await p.evaluate(host=>chrome.runtime.sendMessage({type:'add',host}),host);assert.match(denied.error,/not granted/);
  const manager=await context.newPage();await manager.goto('chrome://extensions/');
  await manager.evaluate(({id,host})=>chrome.developerPrivate.addHostPermission(id,`*://${host}/*`),{id,host});await manager.close();await page.bringToFront();
  await p.locator('#domain').fill(host);await p.locator('[type=submit]').click();
  await custom.waitForFunction(()=>getComputedStyle(document.documentElement).filter.includes('invert(1)'));
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.sync.get('sites')),before);
  await custom.reload();await custom.waitForFunction(()=>getComputedStyle(document.documentElement).filter.includes('invert(1)'));
  assert.ok((await worker.evaluate(()=>chrome.storage.sync.get('domains'))).domains.includes(host));
  await worker.evaluate(host=>chrome.permissions.remove({origins:[`*://${host}/*`]}),host);await custom.reload();
  assert.equal(await custom.locator('html').evaluate(e=>getComputedStyle(e).filter),'none');
  await custom.close();await p.close();
 });
 await check('Chrome reports no extension load or runtime warnings',async()=>{
  const p=await context.newPage();await p.goto('chrome://extensions/');
  const info=await p.evaluate(async id=>(await chrome.developerPrivate.getExtensionsInfo()).find(e=>e.id===id),id);
  assert.equal(info.state,'ENABLED');assert.deepEqual(info.manifestErrors,[]);assert.deepEqual(info.runtimeErrors,[]);await p.close();
 });
 await check('Nested U-M login logo retains its original colors on the preserved dark background',async()=>{
  await page.goto('https://umich.instructure.com/login/canvas');await page.waitForLoadState('networkidle');
  const filters=await page.locator('.ic-Login-header__logo img').evaluate(e=>{
   const filters=[];for(let a=e;a;a=a.parentElement)filters.push(getComputedStyle(a).filter);return filters;
  });
  assert.equal(filters[0],'none');assert.equal(filters.filter(f=>f.includes('invert(1)')).length%2,0);
 });
}finally{
 await writeFile(resolve(root,'test-results/extension-checks.json'),JSON.stringify({created:new Date().toISOString(),headless:true,checks},null,2)+'\n');
 await context?.close();await rm(profile,{recursive:true,force:true});
}
if(checks.some(c=>!c.pass))process.exitCode=1;
