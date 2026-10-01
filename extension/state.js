// CSS arrives before paint; classify media and pre-existing dark surfaces.
(() => {
  if (globalThis.canvasDarkStateInstalled) return;
  globalThis.canvasDarkStateInstalled = true;
  const child = window !== window.top;
  const frameRoot = () => {
    document.documentElement.setAttribute('data-canvas-dark-frame','');
    document.documentElement.setAttribute('data-canvas-dark-disabled','');
  };
  if (child) {
    if (document.documentElement) frameRoot();
    else new MutationObserver((_,observer) => {
      if (document.documentElement) { frameRoot(); observer.disconnect(); }
    }).observe(document,{childList:true});
  }
  const apply = (settings = {}) => {
    const set = () => document.documentElement.toggleAttribute(
      'data-canvas-dark-disabled', settings[location.hostname] === false);
    if (document.documentElement) set();
    else {
      const observer = new MutationObserver(() => {
        if (document.documentElement) { set(); observer.disconnect(); }
      });
      observer.observe(document, { childList: true });
    }
  };
  const updateFrame = async () => {
    if (!document.documentElement) {
      await new Promise(resolve => new MutationObserver((_,observer) => {
        if (document.documentElement) { observer.disconnect(); resolve(); }
      }).observe(document,{childList:true}));
    }
    const result = await chrome.runtime.sendMessage({type:'frame'});
    document.documentElement.toggleAttribute('data-canvas-dark-disabled',!result?.enabled);
  };
  if (child) updateFrame().catch(() => {});
  else chrome.storage.sync.get('sites').then(({ sites }) => apply(sites));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.sites) {
      if (child) updateFrame().catch(() => {});
      else apply(changes.sites.newValue);
    }
  });
  // Small image glyphs must follow UI inversion; larger SVG illustrations are
  // real media. ResizeObserver runs before paint and handles responsive images.
  const sizes = new ResizeObserver(entries => {
    for (const { target, contentRect } of entries) target.toggleAttribute(
      'data-canvas-dark-glyph', contentRect.height > 0 && contentRect.height <= 48);
    schedule();
  });
  const track = (node, method) => {
    const images = node.matches?.('img') ? [node] : node.querySelectorAll?.('img') || [];
    for (const img of images) sizes[method](img);
  };
  track(document, 'observe');
  const media = 'img:not([data-canvas-dark-glyph]),picture:not(:has(img[data-canvas-dark-glyph])),video,[style*="background-image" i],.avatar,.ic-avatar,iframe[src*="youtube.com/embed/"],iframe[src*="youtube-nocookie.com/embed/"],iframe[src*="player.vimeo.com/"],iframe[src*="kaltura.com/"],iframe[src*="panopto.com/"],iframe[src*="instructuremedia.com/"],iframe[src*="/media_attachments_iframe/"]';
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const regions = new Map();
      for (const e of document.querySelectorAll('body,body *')) {
        const inherited = e.matches(':modal,:popover-open') ? false : regions.get(e.parentElement) || false;
        const preserved = e.matches(`${media},#header,[class*="contentLayout__background__"]`);
        const activeNav = e.matches('#header .ic-app-header__menu-list-item--active .ic-app-header__menu-list-link');
        let region = preserved || inherited;
        if (activeNav) region = false;
        else if (!preserved) {
          const color = getComputedStyle(e).backgroundColor.match(/[\d.]+/g)?.map(Number);
          if (color && (color.length === 3 || color[3] >= .95)) {
            const linear = color.slice(0,3).map(v => v/255 <= .04045 ? v/3294.6 : ((v/255+.055)/1.055)**2.4);
            region = linear.reduce((n,v,i) => n + v*[.2126,.7152,.0722][i],0) < .18;
          }
        }
        const value = !preserved && !activeNav && region !== inherited ? (region ? 'dark' : 'light') : null;
        if (value) {
          if (e.getAttribute('data-canvas-dark-surface') !== value) e.setAttribute('data-canvas-dark-surface',value);
        } else if (e.hasAttribute('data-canvas-dark-surface')) e.removeAttribute('data-canvas-dark-surface');
        regions.set(e,region);
      }
    });
  }
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) track(node, 'observe');
      for (const node of record.removedNodes) if (!node.isConnected) track(node, 'unobserve');
    }
    schedule();
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','style'] });
  for (const event of ['pointerover','pointerout','focusin','focusout']) document.addEventListener(event,schedule,true);
  schedule();
})();
