import { chromium } from 'playwright';
import { mkdir,writeFile,readFile,chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureAudit } from './audit.mjs';
import { parse } from 'graphql';
const root=resolve(import.meta.dirname,'..'),extension=resolve(root,'extension'),out=resolve(root,'test-results');
await mkdir(out,{recursive:true});
const required=['login','dashboard-cards','dashboard-list','course-home','modules','assignments','assignment-submission','grades','discussions','discussion-thread','announcements','inbox','calendar','files','settings','rce-image','modal-dialog','dropdown-menu','youtube-page'];
const report={created:new Date().toISOString(),readOnly:true,pages:[],untested:[],errors:[]};
let config={};try{config=JSON.parse(await readFile(resolve(import.meta.dirname,'pages.json'),'utf8'));}catch{}
const course=process.env.CANVAS_COURSE_URL||config.course;
const courseBase=course?course.replace(/\/$/,''):null;
const baseURL=new URL(config.baseURL||courseBase||'https://canvas.instructure.com').origin;
const urls={
 'dashboard-cards':`${baseURL}/`,
 inbox:`${baseURL}/conversations`,calendar:`${baseURL}/calendar`,settings:`${baseURL}/profile/settings`,
 'modal-dialog':courseBase||`${baseURL}/`,
 ...(courseBase?{'course-home':courseBase,modules:`${courseBase}/modules`,assignments:`${courseBase}/assignments`,grades:`${courseBase}/grades`,discussions:`${courseBase}/discussion_topics`,announcements:`${courseBase}/announcements`,files:`${courseBase}/files`}:{}),
 ...config.pages,
};
let browser,context,ownsContext=false;
try{browser=await chromium.connectOverCDP('http://127.0.0.1:9333');context=browser.contexts()[0];}
catch{
 context=await chromium.launchPersistentContext(resolve(import.meta.dirname,'.profile'),{channel:'chromium',headless:true,viewport:{width:1280,height:900},deviceScaleFactor:1,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});ownsContext=true;
 try{await context.addCookies(JSON.parse(await readFile(resolve(import.meta.dirname,'.profile/auth.json'),'utf8')).cookies);}catch{}
}
if(browser){
 const session=await browser.newBrowserCDPSession();
 if(!(await session.send('Browser.getVersion')).userAgent.includes('HeadlessChrome'))throw Error('Tests require a headless browser. The visible login browser will not be used.');
 await session.detach();
}
const page=await context.newPage();
await page.setViewportSize({width:1280,height:900});
// Only this test tab is routed. Existing user tabs and their sessions are untouched.
// Prevent the verifier from making any account/content mutation requests.
const guard=async route=>{
 const request=route.request();
 if(!['GET','HEAD','OPTIONS'].includes(request.method())){
  // Inbox uses POST for GraphQL reads. Parse the document and allow queries
  // only; mutations and unrecognized POST bodies stay blocked.
  let queryOnly=false;
  if(request.method()==='POST'&&new URL(request.url()).pathname.includes('graphql'))try{
   const {query}=request.postDataJSON(),ops=parse(query).definitions.filter(d=>d.kind==='OperationDefinition');
   queryOnly=ops.length>0&&ops.every(op=>op.operation==='query');
  }catch{}
  if(!queryOnly)return route.abort('blockedbyclient');
 }
 return route.continue();
};
await page.route('**/*',guard);
async function settleScroll(p){
 await p.evaluate(async()=>{
  let last='',stable=0;
  for(let i=0;i<200;i++){
   const next=[scrollX,scrollY,document.documentElement.scrollHeight].join(',');
   stable=next===last?stable+1:0;last=next;
   if(stable>=8)return;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('Canvas is still scrolling or changing document height.');
 });
}
async function capture(name,p){
 // Canvas loads and reorders lists asynchronously. Wait for its reads to
 // finish before pairing DOM text coordinates with screenshot pixels.
 await p.waitForLoadState('networkidle',{timeout:15000});
 await settleScroll(p);
 const before=await p.locator('#header').count()?await p.locator('#header').boundingBox():null;
 for(const [position,fraction]of[['top',0],['halfway',.5]]){
  const scrollers=await p.evaluateHandle(fraction=>{
   const items=[...new Set([document.scrollingElement,...document.querySelectorAll('*')])].filter(e=>e&&e.clientHeight>100&&e.scrollHeight>e.clientHeight+20&&(e===document.scrollingElement||['auto','scroll'].includes(getComputedStyle(e).overflowY)));
   for(const e of items)e.scrollTo({top:Math.round((e.scrollHeight-e.clientHeight)*fraction),behavior:'instant'});
   return items;
  },fraction);
  await settleScroll(p);
  await p.waitForTimeout(150);
  // Wait for real finite UI transitions; do not freeze or rewrite page styles.
  await p.evaluate(()=>Promise.race([
   Promise.allSettled(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished)),
   new Promise(resolve=>setTimeout(resolve,2000)),
  ]));
  if(name==='public-long-course'&&position==='halfway'&&await p.locator('#skip_navigation_link').count())await p.locator('#skip_navigation_link').evaluate(e=>e.focus({preventScroll:true}));
  const scroll=await scrollers.evaluate((items,fraction)=>items.map(e=>({tag:e.tagName,id:e.id,connected:e.isConnected,scrollTop:e.scrollTop,max:e.scrollHeight-e.clientHeight,expected:Math.round((e.scrollHeight-e.clientHeight)*fraction)})),fraction);
  await scrollers.dispose();
  const file=`${name}-${position}.png`,audit=await captureAudit(p,resolve(out,file));
  const after=before?await p.locator('#header').boundingBox():null;
  const positionFailure=[
   before&&after&&Math.abs(before.y-after.y)>1?'Global navigation moved during scrolling':null,
   scroll.some(e=>!e.connected||Math.abs(e.scrollTop-e.expected)>1)?'Canvas changed the requested scroll position before capture':null,
  ].filter(Boolean).join('; ')||null;
  const pass=audit.textRegions>0&&!audit.nearWhiteRegions.length&&!audit.lightRegions.length&&!audit.lowContrast.length&&!positionFailure;
  report.pages.push({name,position,url:p.url(),screenshot:file,pass,scroll,positionFailure,...audit});
  console.log(pass?'PASS':'FAIL',name,position,JSON.stringify({white:audit.nearWhiteRegions.length,light:audit.lightRegions.length,text:audit.lowContrast.length}));
 }
}
try{
 // Isolated unauthenticated login capture never logs the user's session out.
 const loginContext=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  let[w]=loginContext.serviceWorkers();if(!w)w=await loginContext.waitForEvent('serviceworker');
  await w.evaluate(async()=>{for(let i=0;i<50;i++){if((await chrome.scripting.getRegisteredContentScripts()).length)return;await new Promise(r=>setTimeout(r,50));}throw Error('CSS registration missing');});
  const login=await loginContext.newPage();await login.route('**/*',guard);await login.goto(`${baseURL}/login/canvas`);await login.waitForTimeout(1200);await capture('login',login);
 }finally{await loginContext.close();}
 for(const name of required.filter(n=>n!=='login')){
  if(!urls[name]){report.untested.push({name,reason:'No accessible existing page/state supplied. No content will be created or edited.'});continue;}
  try{
   const response=await page.goto(urls[name],{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1500);
   if(response?.status()>=400)throw Error(`Page returned HTTP ${response.status()}`);
   if(page.url().includes('/login')||new URL(page.url()).origin!==baseURL)throw Error('Authentication required');
   if(name==='dashboard-cards'){
    const auth=resolve(import.meta.dirname,'.profile/auth.json');
    await context.storageState({path:auth});await chmod(auth,0o600);
   }
   if(name==='dashboard-cards'&&!await page.locator('.ic-DashboardCard:visible').count()){
    await page.getByRole('button',{name:'Dashboard Options',exact:true}).click();
    await page.getByRole('menuitemradio',{name:'Card View',exact:true}).click();
    await page.locator('.ic-DashboardCard:visible').first().waitFor({timeout:5000});
   }
   if(name==='dashboard-list'&&!await page.locator('#dashboard-planner:visible').count())throw Error('The existing dashboard is not in list view.');
   if(name==='rce-image'&&!await page.locator('iframe.tox-edit-area__iframe').count())throw Error('No existing TinyMCE editor is open.');
   if(name==='assignment-submission'){
    const comments=page.getByRole('button',{name:'Add Comment',exact:true});
    if(await comments.count())await comments.click();
   }
   if(name==='modal-dialog'){
    await page.locator('#global_nav_help_link[role=button]').click();
    await page.locator('[role=dialog][aria-modal=true]').waitFor({state:'visible'});
   }
   if(name==='dropdown-menu'){
    await page.getByRole('button',{name:'Dashboard Options',exact:true}).click();
    await page.locator('[role=menu]:visible').waitFor();
   }
   if(name==='youtube-page'&&!await page.locator('iframe[src*="youtube.com/embed/"],iframe[src*="youtube-nocookie.com/embed/"]').count())throw Error('No existing YouTube embed found.');
   if(name==='rce-image'){
    const frame=await page.locator('iframe.tox-edit-area__iframe').first().contentFrame();
    if(!frame||!await frame.locator('img').count())throw Error('The existing editor has no image. No image will be inserted.');
   }
   await capture(name,page);
  }catch(error){report.untested.push({name,reason:error.message});}
 }
 // Supplemental real public pages improve regression coverage, but never fill
 // missing authenticated course requirements in the acceptance gate.
 for(const[name,url]of[
  ['public-course-home','https://canvas.instructure.com/courses/22121'],
  ['public-modules','https://canvas.instructure.com/courses/22121/modules'],
  ['public-assignments','https://canvas.instructure.com/courses/22121/assignments'],
  ['public-long-course','https://canvas.instructure.com/courses/22173'],
 ]){
  try{await page.goto(url);await page.waitForTimeout(1000);if(page.url().includes('/login'))throw Error('Public page redirected to login');await capture(name,page);}
  catch(error){report.errors.push({name,error:error.message});}
 }
}finally{
 report.pass=report.untested.length===0&&report.errors.length===0&&report.pages.filter(p=>required.includes(p.name)).length===required.length*2&&report.pages.every(p=>p.pass);
 await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 let md=`# Canvas dark mode verification\n\nRun: ${report.created}\n\nResult: **${report.pass?'PASS':'FAIL — incomplete or failing coverage'}**\n\nAll account inspection is read-only. No content, grades, assignments, editor data, or preferences are changed. Scroll positions are local to the test tab.\n\n| Page | Position | Result | Screenshot |\n| --- | --- | --- | --- |\n`;
 for(const r of report.pages)md+=`| ${r.name} | ${r.position} | ${r.pass?'PASS':'FAIL'} | [View](${r.screenshot}) |\n`;
 for(const r of report.untested)md+=`| ${r.name} | Both | FAIL — untested | ${r.reason.replaceAll('|','/')} |\n`;
 for(const r of report.errors)md+=`| ${r.name} | Both | FAIL | ${r.error.replaceAll('|','/')} |\n`;
 for(const r of report.pages.filter(p=>!p.pass)){
  md+=`\n## ${r.name} — ${r.position}\n\n`;
  if(r.positionFailure)md+=`- ${r.positionFailure}\n`;
  for(const[type,items]of[['Near-white',r.nearWhiteRegions],['Light',r.lightRegions],['Low-contrast text',r.lowContrast]])for(const p of items)md+=`- ${type}: x=${Math.round(p.x)}, y=${Math.round(p.y)}, width=${Math.round(p.width)}, height=${Math.round(p.height)}${p.ratio?`, contrast=${p.ratio}: ${p.text.replaceAll('\n',' ')}`:''}\n`;
 }
 await writeFile(resolve(out,'report.md'),md);
 await page.close();
 if(ownsContext)await context.close();
 console.log(`Report: ${out}/report.md`);
}
// Detach this CDP client; leave the headless persistent session running.
process.exit(report.pass?0:1);
