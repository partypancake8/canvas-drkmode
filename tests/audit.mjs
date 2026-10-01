import { PNG } from 'pngjs';
const luminance = rgb => rgb.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0);
const rgbAt = (p,x,y) => [...p.data.subarray((y*p.width+x)*4,(y*p.width+x)*4+3)];
const contrast = (a,b) => (Math.max(a,b)+.05)/(Math.min(a,b)+.05);

// Read-only audit: no injected styles, hidden text, or changes to Canvas DOM.
export function auditPixels(buffer, regions, media=[]) {
 const p=PNG.sync.read(buffer),white=[],light=[],lowContrast=[];
 const excluded=(x,y)=>media.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
 for(let y=0;y+32<=p.height;y+=16)for(let x=0;x+32<=p.width;x+=16){
  let n=0,w=0,l=0;
  for(let dy=0;dy<32;dy+=2)for(let dx=0;dx<32;dx+=2){
   if(excluded(x+dx,y+dy))continue;
   n++;const v=luminance(rgbAt(p,x+dx,y+dy));if(v>.92)w++;if(v>.45)l++;
  }
  if(n>200&&w/n>.9)white.push({x,y,width:32,height:32});
  else if(n>200&&l/n>.9)light.push({x,y,width:32,height:32});
 }
 for(const r of regions){
  const bins=new Map();const pixels=[];
  for(let y=Math.max(0,Math.ceil(r.y));y<Math.min(p.height,Math.floor(r.y+r.height));y++){
   for(let x=Math.max(0,Math.ceil(r.x));x<Math.min(p.width,Math.floor(r.x+r.width));x++){
    const rgb=rgbAt(p,x,y),key=rgb.map(v=>Math.round(v/8)).join(',');
    const bin=bins.get(key)||{count:0,rgb};bin.count++;bins.set(key,bin);
    pixels.push(rgb);
   }
  }
  if(!bins.size)continue;
  const background=[...bins.values()].sort((a,b)=>b.count-a.count)[0].rgb;
  const bg=luminance(background),delta=r.color.map((v,i)=>v-background[i]);
  const length=delta.reduce((n,v)=>n+v*v,0);
  // Thin glyphs may have no fully opaque pixels. Accept their antialiased
  // blends with the measured background, while rejecting unrelated colors.
  const candidates=pixels.filter(rgb=>{
   if(!length)return false;
   const alpha=rgb.reduce((n,v,i)=>n+(v-background[i])*delta[i],0)/length;
   return alpha>.05&&alpha<=1.05&&Math.hypot(...rgb.map((v,i)=>v-background[i]-alpha*delta[i]))<24;
  }).map(luminance);
  const ratios=candidates.map(fg=>contrast(fg,bg)).sort((a,b)=>b-a);
  const ratio=ratios[Math.min(2,ratios.length-1)]||1;
  if(ratio<3)lowContrast.push({...r,ratio:Number(ratio.toFixed(2))});
 }
 return {nearWhiteRegions:white,lightRegions:light,lowContrast,textRegions:regions.length,mediaRegions:media.length};
}

export async function captureAudit(page,path) {
 await page.evaluate(()=>document.fonts.ready);
 const regions=[],media=[];
 for(const frame of page.frames()){
  let offset={x:0,y:0};
  if(frame!==page.mainFrame()){
   try{const box=await(await frame.frameElement()).boundingBox();if(!box)continue;offset=box;}catch{continue;}
  }
  const data=await frame.evaluate(()=>{
   const regions=[],media=[];
   function visible(e,r){
    if(!r.width||!r.height||r.bottom<3||r.right<3||r.left>=innerWidth-3||r.top>=innerHeight-3)return false;
    if(Math.min(r.bottom,innerHeight)-Math.max(r.top,0)<Math.min(8,r.height/2))return false;
    let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),topEdge=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
    for(let a=e;a;a=a.parentElement){
     const s=getComputedStyle(a),b=a.getBoundingClientRect();
     if(s.visibility!=='visible'||s.display==='none'||Number(s.opacity)===0||s.clipPath!=='none'||s.clip!=='auto')return false;
     if(['hidden','clip','auto','scroll'].includes(s.overflowY)){topEdge=Math.max(topEdge,b.top);bottom=Math.min(bottom,b.bottom);}
     if(['hidden','clip','auto','scroll'].includes(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right);}
    }
    if(bottom-topEdge<Math.min(8,r.height/2)||right-left<1)return false;
    const top=document.elementFromPoint(Math.min(innerWidth-1,Math.max(0,r.x+r.width/2)),Math.min(innerHeight-1,Math.max(0,r.y+r.height/2)));
    return !top||e.contains(top)||top.contains(e);
   }
   function renderedColor(e,pseudo=null){
    const values=(getComputedStyle(e,pseudo).color.match(/[\d.]+/g)||['0','0','0']).map(Number);
    let color=values.slice(0,3);
    if(values.length>3&&values[3]<1){
     let bg=[255,255,255];
     for(let a=e;a;a=a.parentElement){const c=getComputedStyle(a).backgroundColor.match(/[\d.]+/g)?.map(Number);if(c&&(c.length===3||c[3]===1)){bg=c.slice(0,3);break;}}
     color=color.map((v,i)=>v*values[3]+bg[i]*(1-values[3]));
    }
    for(let a=e;a;a=a.parentElement){
     const filter=getComputedStyle(a).filter;
     if(filter.includes('invert(1)'))color=color.map(v=>255-v);
     if(filter.includes('hue-rotate(180deg)')){
      const[r,g,b]=color;color=[-.574*r+1.43*g+.144*b,.426*r+.43*g+.144*b,.426*r+1.43*g-.856*b].map(v=>Math.max(0,Math.min(255,v)));
     }
     if(a.matches(':modal,:popover-open'))break;
    }
    return color;
   }
   const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
   for(let node;node=walk.nextNode();){
    const e=node.parentElement;if(!node.textContent.trim()||e.closest('script,style,noscript,option,svg'))continue;
    const range=document.createRange();range.selectNodeContents(node);
    for(const r of range.getClientRects())if(visible(e,r))regions.push({text:node.textContent.trim().slice(0,100),x:r.x,y:r.y,width:r.width,height:r.height,color:renderedColor(e)});
   }
   for(const e of document.querySelectorAll('img,picture,video,[style*="background-image"],iframe[src*="youtube.com/embed/"]')){
    const r=e.getBoundingClientRect();if(visible(e,r))media.push({x:r.x,y:r.y,width:r.width,height:r.height});
   }
   for(const e of document.querySelectorAll('input:not([type=password]):not([type=checkbox]):not([type=radio]):not([type=hidden]),textarea,select')){
    const r=e.getBoundingClientRect();
    if((e.value||e.placeholder)&&visible(e,r))regions.push({text:`Form control: ${e.tagName.toLowerCase()} ${e.id}`,x:r.x+8,y:r.y+6,width:r.width-16,height:r.height-12,color:renderedColor(e,!e.value&&e.placeholder?'::placeholder':null)});
   }
   return{regions,media};
  });
  // Iframe document colors still pass through the parent's compositing filters.
  if(frame!==page.mainFrame()){
   const filters=await(await frame.frameElement()).evaluate(e=>{
    const result=[];for(let a=e;a;a=a.parentElement){result.push(getComputedStyle(a).filter);if(a.matches(':modal,:popover-open'))break;}return result;
   });
   for(const r of data.regions)for(const filter of filters){
    if(filter.includes('invert(1)'))r.color=r.color.map(v=>255-v);
    if(filter.includes('hue-rotate(180deg)')){const[r0,g,b]=r.color;r.color=[-.574*r0+1.43*g+.144*b,.426*r0+.43*g+.144*b,.426*r0+1.43*g-.856*b].map(v=>Math.max(0,Math.min(255,v)));}
   }
  }
  regions.push(...data.regions.map(r=>({...r,x:r.x+offset.x,y:r.y+offset.y})).filter(r=>r.y<900&&r.y+r.height>0));
  media.push(...data.media.map(r=>({...r,x:r.x+offset.x,y:r.y+offset.y})));
 }
 return auditPixels(await page.screenshot({path,scale:'css'}),regions,media);
}
