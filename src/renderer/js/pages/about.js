// About, license and third-party notices.
import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { brandMark } from '../icons.js';
import { card, kv } from '../ui.js';

export async function render(page, _p, { setTitle }) {
  setTitle('About & License');
  const [info, lic] = await Promise.all([api.call('app.info'), api.call('app.license')]);
  mount(page,
    h('div', { class: 'card glow row mb', style: { gap: '20px', padding: '26px' } }, brandMark(), h('div', { class: 'grow' }, h('h1', null, 'Satisfactory Server Manager'), h('p', null, `Version ${info.version} · © 2026 ${lic.holder}`), h('p', { class: 'small muted' }, 'Satisfactory is a trademark of Coffee Stain Studios AB. Steam and SteamCMD are trademarks of Valve Corporation. This application is not affiliated with or endorsed by Coffee Stain Studios or Valve. Mods are provided by their authors through ficsit.app.'))),
    h('div', { class: 'grid g2' },
      card(lic.name, 'file', lic.text ? h('pre', { class: 'pathbox', style: { whiteSpace: 'pre-wrap', maxHeight: '520px', overflow: 'auto', fontFamily: 'var(--font)', fontSize: '12.5px' } }, lic.text) : h('p', null, 'The license file could not be read.')),
      card('Third-party notices', 'layers', lic.thirdParty ? h('pre', { class: 'pathbox', style: { whiteSpace: 'pre-wrap', maxHeight: '520px', overflow: 'auto', fontFamily: 'var(--font)', fontSize: '12.5px' } }, lic.thirdParty) : h('p', null, 'Not available.'))),
    h('div', { class: 'card mt' }, kv([['Electron', info.electron], ['Node.js', info.node], ['Platform', `${info.platform} ${info.arch}`], ['Data folder', info.paths.userData]])));
}
