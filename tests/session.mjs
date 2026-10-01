import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { readFile,chmod } from 'node:fs/promises';
import { parse } from 'graphql';
const extension=resolve(import.meta.dirname,'../extension');
const login=process.argv.includes('--login');
let config={};try{config=JSON.parse(await readFile(resolve(import.meta.dirname,'pages.json'),'utf8'));}catch{}
const baseURL=new URL(config.baseURL||'https://canvas.instructure.com').origin;
const context=await chromium.launchPersistentContext(resolve(import.meta.dirname,'.profile'),{
 channel:'chromium',headless:!login,viewport:{width:1280,height:900},deviceScaleFactor:1,
 args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--remote-debugging-port=9333'],
});
if (!login) await context.route('**/*',route=>{
 const request=route.request();
 if (['GET','HEAD','OPTIONS'].includes(request.method())) return route.continue();
 if (request.method()==='POST'&&new URL(request.url()).pathname.includes('graphql')) try {
  const operations=parse(request.postDataJSON().query).definitions.filter(d=>d.kind==='OperationDefinition');
  if(operations.length&&operations.every(op=>op.operation==='query'))return route.continue();
 } catch {}
 return route.abort('blockedbyclient');
});
const auth=resolve(import.meta.dirname,'.profile/auth.json');
try{await context.addCookies(JSON.parse(await readFile(auth,'utf8')).cookies);}catch{}
// Chrome may discard session cookies after a clean restart. Preserve the
// explicitly provided test login in the ignored profile, never in the repo.
const watch=p=>p.on('framenavigated',async frame=>{
 if(frame!==p.mainFrame()||!frame.url().startsWith(`${baseURL}/`))return;
 try{
  const signedIn=await p.evaluate(async()=>{const r=await fetch('/api/v1/users/self');return r.ok&&Boolean((await r.json()).id);});
  if(signedIn){await context.storageState({path:auth});await chmod(auth,0o600);}
 }catch{}
});
context.on('page',watch);for(const p of context.pages())watch(p);
const page=context.pages()[0]||await context.newPage();
await page.goto(config.loginURL||`${baseURL}/login/canvas`);
console.log(`${login?'Canvas login window':'Headless Canvas session'} ready. Profile: tests/.profile/; CDP: http://127.0.0.1:9333`);
await context.waitForEvent('close',{timeout:0});
