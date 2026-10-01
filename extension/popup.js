const status = document.querySelector('#status');
const toggle = document.querySelector('#toggle');
const domain = document.querySelector('#domain');
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.error) throw Error(result?.error || 'The extension did not respond. Try reopening the popup.');
  return result;
}
async function refresh(type = 'status') {
  try {
    const result = await send({ type });
    toggle.hidden = !result.supported;
    toggle.textContent = `Turn dark mode ${result.enabled ? 'off' : 'on'} for this site`;
    status.textContent = result.supported ? `Dark mode ${result.enabled ? 'on' : 'off'} for ${result.host}.` : 'Add this Canvas domain to enable dark mode.';
    if (!result.supported && result.host) domain.value = result.host;
  } catch (error) { status.textContent = error.message; }
}
async function list() {
  const { domains = [] } = await chrome.storage.sync.get('domains');
  document.querySelector('#domains').replaceChildren(...domains.map(host => {
    const item = document.createElement('li'); item.textContent = host; return item;
  }));
}
toggle.addEventListener('click', () => refresh('toggle'));
document.querySelector('#domain-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const input = domain.value.trim();
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.') || url.hostname.includes('*')) {
      throw Error('Enter only a hostname, such as canvas.yourschool.edu.');
    }
    const host = url.hostname;
    // Keep the permission request in the actual submit gesture.
    if (!await chrome.permissions.request({ origins: [`*://${host}/*`] })) throw Error('Permission declined. No domain was added.');
    await send({ type: 'add', host });
    status.textContent = `Added ${host}. Dark mode is ready.`;
    await list();
    await refresh();
  } catch (error) { status.textContent = error.message; }
});
refresh();
list();
