const builtin = host => host === 'instructure.com' || host.endsWith('.instructure.com');
const pattern = host => `*://${host}/*`;
const defaults = '*://*.instructure.com/*';
let lastConfiguration = '';

async function reconcile() {
  const { domains = [], sites = {} } = await chrome.storage.sync.get(['domains', 'sites']);
  const allowed = [];
  for (const host of domains) {
    if (!builtin(host) && await chrome.permissions.contains({ origins: [pattern(host)] })) allowed.push(host);
  }
  const matches = [defaults, ...allowed.map(pattern)];
  const excludeMatches = Object.keys(sites).filter(host => sites[host] === false).map(pattern);
  // Persistent declarative CSS is excluded on disabled hosts BEFORE document
  // creation. No asynchronous storage lookup or dark flash on an off-site load.
  const script = { id: 'canvas-dark', matches, excludeMatches, css: ['dark.css'], js: ['state.js'],
    runAt: 'document_start', allFrames: false, persistAcrossSessions: true };
  // Frame helpers counter-invert media only. They never invert the frame root.
  const frames = { id: 'canvas-media', matches: [...matches,'https://carousel.tl.it.umich.edu/*'], excludeMatches,
    js: ['state.js'], runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true };
  const configuration = JSON.stringify([script,frames]);
  if (configuration === lastConfiguration) return;
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  for (const item of [script,frames]) {
    if (scripts.some(s => s.id === item.id)) await chrome.scripting.updateContentScripts([item]);
    else await chrome.scripting.registerContentScripts([item]);
  }
  lastConfiguration = configuration;
  for (const tab of await chrome.tabs.query({ url: matches })) {
    const enabled = sites[new URL(tab.url).hostname] !== false;
    const target = { tabId: tab.id, frameIds: [0] };
    try {
      await chrome.scripting.executeScript({ target, func: off => {
        document.documentElement.toggleAttribute('data-canvas-dark-disabled', off);
      }, args: [!enabled] });
      await chrome.scripting.removeCSS({ target, files: ['dark.css'] });
      if (enabled) {
        await chrome.scripting.insertCSS({ target, files: ['dark.css'] });
        await chrome.scripting.executeScript({ target, files: ['state.js'] });
      }
    } catch { /* A tab may close or navigate while the list is being processed. */ }
  }
}

async function current() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) return { supported: false };
  const host = new URL(tab.url).hostname;
  const { domains = [], sites = {} } = await chrome.storage.sync.get(['domains', 'sites']);
  const supported = builtin(host) || (domains.includes(host) && await chrome.permissions.contains({ origins: [pattern(host)] }));
  return { supported, host, enabled: supported && sites[host] !== false };
}
async function handle(message) {
  if (message.type === 'status') return current();
  if (message.type === 'add') {
    const host = message.host;
    if (typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) throw Error('Enter a valid hostname.');
    if (!await chrome.permissions.contains({ origins: [pattern(host)] })) throw Error('Site permission was not granted.');
    const { domains = [] } = await chrome.storage.sync.get('domains');
    await chrome.storage.sync.set({ domains: [...new Set([...domains, host])] });
    await reconcile();
    return current();
  }
  if (message.type === 'toggle') {
    const state = await current();
    if (!state.supported) return state;
    const { sites = {} } = await chrome.storage.sync.get('sites');
    await chrome.storage.sync.set({ sites: { ...sites, [state.host]: !state.enabled } });
    await reconcile();
    return { ...state, enabled: !state.enabled };
  }
  throw Error('Unknown request.');
}
let queue = Promise.resolve();
const enqueue = fn => (queue = queue.catch(() => {}).then(fn));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id === chrome.runtime.id && sender.frameId > 0 && message.type === 'frame') {
    (async () => {
      const host = new URL(sender.tab.url).hostname;
      const { domains = [], sites = {} } = await chrome.storage.sync.get(['domains','sites']);
      if (!builtin(host) && !domains.includes(host)) return { enabled: false };
      // These frames are already counter-inverted as whole video surfaces.
      if (/instructuremedia\.com|\/media_attachments_iframe\//.test(sender.url)) return { enabled: false };
      const target = { tabId: sender.tab.id, frameIds: [sender.frameId] };
      await chrome.scripting.removeCSS({ target, files: ['dark.css'] });
      await chrome.scripting.insertCSS({ target, files: ['dark.css'] });
      return { enabled: sites[host] !== false };
    })().then(reply, () => reply({ enabled: false }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  enqueue(() => handle(message)).then(reply, error => reply({ error: error.message }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => enqueue(reconcile));
chrome.runtime.onStartup.addListener(() => enqueue(reconcile));
chrome.permissions.onRemoved.addListener(() => enqueue(reconcile));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.domains || changes.sites)) enqueue(reconcile);
});
