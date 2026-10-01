import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..');
const extension=resolve(root,'extension');
const out=resolve(root,'dist/chrome-web-store-kit');
await mkdir(resolve(out,'graphics'),{recursive:true});
const profile=await mkdtemp(resolve(tmpdir(),'canvas-store-assets-'));
const records=[];
let context;
async function saveRGB(page,file,width,height){
  const buffer=await page.screenshot({fullPage:false,omitBackground:false});
  const png=PNG.sync.read(buffer);
  assert.equal(png.width,width);assert.equal(png.height,height);
  for(let i=3;i<png.data.length;i+=4)assert.equal(png.data[i],255);
  const rgb=PNG.sync.write(png,{colorType:2,bitDepth:8});
  assert.equal(rgb[24],8);assert.equal(rgb[25],2);
  await writeFile(resolve(out,'graphics',file),rgb);
  records.push({file,width,height,format:'24-bit RGB PNG, no alpha'});
}
try{
  context=await chromium.launchPersistentContext(profile,{
    channel:'chromium',headless:true,viewport:{width:1280,height:800},deviceScaleFactor:1,
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
  });
  await context.route('**/*',route=>['GET','HEAD','OPTIONS'].includes(route.request().method())?route.continue():route.abort('blockedbyclient'));
  let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
  await worker.evaluate(async()=>{
    for(let i=0;i<100;i++){
      if((await chrome.scripting.getRegisteredContentScripts()).some(s=>s.id==='canvas-dark'))return;
      await new Promise(r=>setTimeout(r,50));
    }
    throw Error('Extension registration missing');
  });
  const page=await context.newPage();
  for(const [file,url] of [
    ['screenshot-1-course-home-1280x800.png','https://canvas.instructure.com/courses/22121'],
    ['screenshot-2-modules-1280x800.png','https://canvas.instructure.com/courses/22121/modules'],
    ['screenshot-3-assignments-1280x800.png','https://canvas.instructure.com/courses/22121/assignments'],
  ]){
    const response=await page.goto(url,{waitUntil:'networkidle',timeout:45000});
    assert.ok(response.ok());assert.equal(page.url(),url);
    await page.waitForFunction(()=>getComputedStyle(document.documentElement).filter.includes('invert(1)'));
    await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(1200);
    await saveRGB(page,file,1280,800);
    records.at(-1).source=url;
    records.at(-1).capture='Unmodified viewport of a public Canvas course, anonymous browser, extension enabled';
    console.log('Captured',file);
  }
  const icon=(await readFile(resolve(extension,'icons/128.png'))).toString('base64');
  const design=await context.newPage();
  for(const [file,width,height] of [['small-promo-440x280.png',440,280],['marquee-promo-1400x560.png',1400,560]]){
    const small=width===440;
    await design.setViewportSize({width,height});
    await design.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
      body{font-family:Arial,Helvetica,sans-serif;background:#101923;color:#f1f5fa;position:relative}
      .wash{position:absolute;inset:0;background:radial-gradient(ellipse at 100% 40%,#244a68 0%,#142435 40%,#101923 75%)}
      .ring{position:absolute;border:1px solid #789cbe30;border-radius:50%;width:${small?340:680}px;height:${small?340:680}px;right:${small?-155:-50}px;top:${small?-55:-70}px}
      .ring.inner{transform:scale(.78)}.ring.outer{transform:scale(1.2)}
      .moon{position:absolute;width:${small?133:310}px;height:${small?133:310}px;right:${small?17:126}px;top:${small?31:110}px}
      main{position:relative;padding:${small?'31px 30px':'66px 80px'};height:100%;display:flex;flex-direction:column;align-items:flex-start}
      .brand{display:flex;align-items:center;gap:12px;font-size:13px;letter-spacing:2.5px;font-weight:600;color:#b9d9f5}
      .brand img{width:${small?28:38}px;height:${small?28:38}px;border-radius:8px}
      h1{font-size:${small?40:86}px;line-height:1.02;letter-spacing:${small?'-1.6px':'-3.8px'};margin:${small?'44px 0 0':'57px 0 0'};font-weight:700}
      h1 span{color:#b8d9ff}p{font-size:${small?14:23}px;line-height:1.4;color:#bbcbd9;margin:${small?'17px 0 0':'27px 0 0'}}
      .bottom{position:absolute;bottom:0;left:0;width:100%;height:4px;background:linear-gradient(90deg,#b8d9ff,#3a709f,#101923)}
    </style><div class="wash"></div><div class="ring"></div><div class="ring inner"></div><div class="ring outer"></div>
    <svg class="moon" viewBox="0 0 128 128" aria-hidden="true"><defs><mask id="cut"><rect width="128" height="128" fill="white"/><circle cx="91" cy="43" r="44" fill="black"/></mask></defs><circle cx="63" cy="66" r="48" fill="#b8d9ff" mask="url(#cut)"/></svg>
    <main><div class="brand"><img src="data:image/png;base64,${icon}" alt="">${small?'':'CANVAS DARK MODE'}</div><h1>Canvas<br><span>Dark Mode</span></h1><p>Your courses. A darker view.</p></main><div class="bottom"></div></html>`);
    await design.evaluate(()=>document.fonts.ready);
    await saveRGB(design,file,width,height);
    console.log('Rendered',file);
  }
}finally{
  if(context)await context.close();
  await rm(profile,{recursive:true,force:true});
}
await copyFile(resolve(extension,'icons/128.png'),resolve(out,'graphics/store-icon-128x128.png'));
const iconPNG=PNG.sync.read(await readFile(resolve(out,'graphics/store-icon-128x128.png')));
assert.equal(iconPNG.width,128);assert.equal(iconPNG.height,128);
records.push({file:'store-icon-128x128.png',width:128,height:128,source:'Exact extension icon'});
await writeFile(resolve(out,'asset-checks.json'),JSON.stringify({created:new Date().toISOString(),headless:true,anonymous:true,assets:records},null,2)+'\n');
console.log('Graphics complete:',out);
