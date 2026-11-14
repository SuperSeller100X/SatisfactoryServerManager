// First-launch setup wizard. All state lives in the main process (setup.js) and
// is persisted after every change, so closing the app mid-way resumes here.
import { h, mount, fmt, debounce } from '../dom.js';
import { api } from '../api.js';
import { icon, brandMark } from '../icons.js';
import { ill } from '../illustrations.js';
import { toast, toastError, callout, progress, confirmDialog, badge } from '../ui.js';

const STEP_META = {
  welcome: { title: 'Welcome', sub: 'What this app does' },
  scan: { title: 'Check this PC', sub: 'System & existing installs' },
  location: { title: 'Server folder', sub: 'Where files are installed' },
  dependencies: { title: 'Prerequisites', sub: 'SteamCMD & runtimes' },
  install: { title: 'Install server', sub: 'Dedicated Server 1690800' },
  network: { title: 'Network', sub: 'Ports & firewall' },
  security: { title: 'Security', sub: 'Claim & API access' },
  review: { title: 'Review', sub: 'Summary of setup' },
  finish: { title: 'Finish', sub: 'Start playing' },
};
const ORDER = Object.keys(STEP_META);

export function renderWizard(root, { onDone }) {
  let st = null; let progressInfo = null; let direction = 'fwd';
  const body = h('div', { class: 'wz-body' });
  const foot = h('div', { class: 'wz-foot' });
  const steps = h('div', { class: 'wz-steps' });
  mount(root, h('div', { class: 'wizard' },
    h('aside', { class: 'wz-side' },
      h('div', { class: 'brand', style: { padding: 0 } }, brandMark(), h('div', { class: 'brand-name' }, 'Satisfactory', h('br'), 'Server Manager', h('small', null, 'Setup'))),
      steps,
      h('div', { class: 'muted small', style: { marginTop: 'auto' } }, 'Your progress is saved automatically. You can close the app at any time and continue later.')),
    h('main', { class: 'wz-main' }, body, foot)));

  const off = api.on('operation.progress', (e) => {
    if (!e || e.kind !== 'setup') return;
    if (e.progress !== undefined) { progressInfo = e.progress; updateProgress(); }
  });

  let progressSlot = null;
  function updateProgress() {
    if (!progressSlot || !progressSlot.isConnected) return;
    const p = progressInfo;
    mount(progressSlot, p ? h('div', { class: 'big-progress' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', null, p.phase || 'Working…'), h('div', { class: 'muted small' }, p.total ? `${fmt.bytes(p.done)} of ${fmt.bytes(p.total)}` : 'Preparing — this step does not report a percentage')), h('div', { class: 'pct' }, p.percent != null ? `${p.percent.toFixed(1)}%` : '')),
      progress(p.percent)) : null);
  }

  async function refresh() {
    try { st = await api.call('setup.state'); } catch (err) { toastError(err); return; }
    drawSteps();
    draw();
  }

  function isDone(step) {
    const v = st.verification.verified;
    return step === 'welcome' ? ORDER.indexOf(st.step) > 0 : step === 'review' ? ORDER.indexOf(st.step) > ORDER.indexOf('review') : !!v[step];
  }
  function drawSteps() {
    const cur = ORDER.indexOf(st.step);
    mount(steps, ORDER.map((k, i) => {
      const done = isDone(k) && i !== cur;
      const skipped = st.skipped && st.skipped[k];
      const reachable = i <= cur || ORDER.slice(1, i).every((x) => ['review', 'finish'].includes(x) || isDone(x));
      const el = h('div', { class: ['wz-step', i === cur ? 'current' : '', done ? 'done' : '', skipped ? 'skipped' : '', reachable && i !== cur && !st.running ? 'clickable' : ''] },
        h('div', { class: 'num' }, done && !skipped ? icon('check', { sw: 3 }) : String(i + 1)),
        h('div', null, STEP_META[k].title, h('div', { class: 'small muted', style: { fontWeight: 500 } }, skipped ? 'Skipped' : STEP_META[k].sub)));
      if (reachable && i !== cur && !st.running) el.addEventListener('click', () => go(k));
      return el;
    }));
  }

  async function go(step) {
    direction = ORDER.indexOf(step) < ORDER.indexOf(st.step) ? 'back' : 'fwd';
    try { st = await api.call('setup.goTo', { step }); drawSteps(); draw(); } catch (err) { toastError(err, 'Not yet'); }
  }
  const next = () => go(ORDER[ORDER.indexOf(st.step) + 1]);
  const prev = () => go(ORDER[ORDER.indexOf(st.step) - 1]);

  function footer({ back = true, nextLabel = 'Continue', nextEnabled = true, onNext = next, extra = [] } = {}) {
    const n = h('button', { class: 'btn primary lg', disabled: !nextEnabled || st.running }, nextLabel, icon('chevronRight'));
    n.addEventListener('click', async () => { n.disabled = true; try { await onNext(); } catch (err) { toastError(err); } finally { n.disabled = false; } });
    const idx = ORDER.indexOf(st.step);
    mount(foot,
      h('div', { class: 'progressline' }, h('span', null, `Step ${idx + 1} of ${ORDER.length}`), h('div', { class: 'meter' }, h('div', { style: { width: `${((idx + 1) / ORDER.length) * 100}%` } }))),
      ...extra,
      back && idx > 0 ? h('button', { class: 'btn ghost lg', disabled: st.running, onclick: prev }, icon('chevronLeft'), 'Back') : null,
      n);
  }

  function panel(illustration, kicker, title, text, ...rest) {
    return h('div', { class: `wz-panel ${direction === 'back' ? 'back' : ''}` },
      h('div', { class: 'wz-hero' }, ill[illustration](), h('div', null, h('div', { class: 'wz-kicker' }, kicker), h('h1', null, title), h('p', null, text))),
      ...rest);
  }

  function interruptedBanner() {
    if (!st.interrupted && !st.lastError) return null;
    if (st.interrupted) return callout('warn', 'alert', h('b', null, 'Setup was interrupted. '), `The last operation ("${st.interrupted.kind}") did not finish because the app was closed. Completed work was kept — finished steps are verified and will not run again.`);
    return callout('err', 'alertCircle', h('b', null, 'The last step did not complete. '), st.lastError.message);
  }

  // ------------------------------------------------------------------ steps
  const views = {
    welcome() {
      const resumed = st.serverId || Object.keys(st.completed || {}).length > 1;
      mount(body, panel('welcome', 'Satisfactory Server Manager', resumed ? 'Welcome back' : 'Let’s set up your dedicated server',
        resumed ? 'Your setup progress was saved. Continue where you left off — steps that are already done will be skipped.' : 'This assistant installs and configures a Satisfactory Dedicated Server on this PC. It takes about 10–20 minutes, mostly for downloading the server (about 8 GB). No technical knowledge needed.',
        interruptedBanner(),
        h('div', { class: 'feature-list' }, [
          ['download', 'Automatic installation', 'Downloads SteamCMD and the official dedicated server from Valve.'],
          ['activity', 'Live monitoring', 'CPU, memory, players and health — measured, never guessed.'],
          ['backup', 'Safe backups', 'Restore points before every update, restore or mod change.'],
          ['shieldCheck', 'Secure by default', 'Credentials encrypted by Windows; remote access is off unless you enable it.'],
        ].map(([i, b, t]) => h('div', { class: 'feature' }, h('div', { class: 'fi' }, icon(i)), h('div', null, h('b', null, b), h('span', null, t))))),
        h('p', { class: 'small muted mt' }, 'Satisfactory is a trademark of Coffee Stain Studios. This application is not affiliated with or endorsed by Coffee Stain Studios or Valve.')));
      footer({ back: false, nextLabel: resumed ? 'Continue setup' : 'Start setup', onNext: async () => { if (resumed) await go(firstIncomplete()); else await next(); } });
    },

    scan() {
      const list = h('div', { class: 'check-list' });
      const existingBox = h('div');
      mount(body, panel('scan', 'Step 2', 'Checking this PC', 'We look at your system, free disk space and whether SteamCMD or a server is already installed. Nothing is changed during this check.', list, existingBox));
      const drawScan = (r) => {
        mount(list, r.checks.map((c, i) => h('div', { class: `check-item ${c.state}`, style: { animationDelay: `${i * 60}ms` } },
          h('div', { class: 'ci' }, icon(c.state === 'ok' ? 'check' : c.state === 'error' ? 'x' : c.state === 'warning' ? 'alert' : 'info', { sw: 2.4 })),
          h('div', { class: 'grow' }, h('b', null, c.label), h('div', { class: 'd' }, c.detail), c.help ? h('div', { class: 'h' }, c.help) : null))));
        mount(existingBox, r.existing.length ? h('div', { class: 'mt' }, h('h4', { class: 'mb' }, 'Existing installations found'),
          h('div', { class: 'col' }, r.existing.map((e) => h('div', { class: 'choice' }, h('div', { class: 'ci' }, icon('server')), h('div', { class: 'grow' }, h('b', null, e.dir), h('span', null, `${e.buildId ? `Build ${e.buildId}` : 'Unknown build'} · ${e.branch || 'public'} branch · ${e.fullyInstalled ? 'complete' : 'incomplete'}`)), badge('Can be attached in the next step', 'info'))))) : null);
        const blocking = r.checks.some((c) => c.key === 'os' && c.state === 'error');
        footer({ nextEnabled: !blocking, extra: [h('button', { class: 'btn ghost lg', onclick: run }, icon('restart'), 'Scan again')] });
      };
      const run = async () => {
        mount(list, ['Operating system', 'Memory', 'Processor', 'Disk space', 'SteamCMD', 'Runtimes', 'Existing installations'].map((l) => h('div', { class: 'check-item pending' }, h('div', { class: 'ci' }, icon('clock')), h('div', null, h('b', null, l), h('div', { class: 'd' }, 'Checking…')))));
        footer({ nextEnabled: false });
        try { const r = await api.call('setup.scan'); st.scan = r; drawScan(r); } catch (err) { toastError(err, 'Scan failed'); footer({ nextEnabled: false }); }
      };
      if (st.scan && Date.now() - st.scan.at < 10 * 60000) drawScan(st.scan); else run();
    },

    location() {
      const existing = (st.scan && st.scan.existing) || [];
      const loc = st.location || {};
      let mode = loc.mode || 'new';
      let check = null;
      const nameIn = h('input', { class: 'input', value: loc.name || 'My Satisfactory Server', maxlength: 80 });
      const dirIn = h('input', { class: 'input mono', value: loc.dir || (st.scan ? st.scan.suggested : ''), spellcheck: 'false' });
      const branchSel = h('select', { class: 'input' }, h('option', { value: 'public' }, 'Stable (public) — recommended'), h('option', { value: 'experimental' }, 'Experimental — newest features, may be unstable'));
      branchSel.value = loc.branch || 'public';
      const confirmBox = h('input', { type: 'checkbox' });
      const result = h('div', { class: 'col' });
      const confirmText = h('span');
      const modes = h('div', { class: 'grid g2' });
      const drawModes = () => mount(modes,
        h('div', { class: ['choice', mode === 'new' ? 'selected' : ''], onclick: () => { mode = 'new'; drawModes(); validate(); } }, h('div', { class: 'ci' }, icon('download')), h('div', null, h('b', null, 'Install a new server'), h('span', null, 'Download the dedicated server into a new, empty folder.'))),
        h('div', { class: ['choice', mode === 'attach' ? 'selected' : ''], onclick: () => { mode = 'attach'; if (existing[0] && !loc.dir) dirIn.value = existing[0].dir; drawModes(); validate(); } }, h('div', { class: 'ci' }, icon('link')), h('div', null, h('b', null, 'Use an existing installation'), h('span', null, existing.length ? `${existing.length} found on this PC — or browse to one.` : 'Point to a folder that already contains the server.'))));
      drawModes();
      const validate = debounce(async () => {
        confirmBox.checked = false;
        confirmText.textContent = '';
        mount(result, h('div', { class: 'muted small' }, 'Checking folder…'));
        try {
          check = await api.call('setup.validateLocation', { dir: dirIn.value.trim(), mode });
          dirIn.classList.toggle('invalid', !check.ok);
          confirmText.textContent = check.dir;
          mount(result,
            ...check.errors.map((e) => callout('err', 'alertCircle', e)),
            ...check.warnings.map((w) => callout('warn', 'alert', w)),
            check.ok && check.info ? callout('ok', 'check', h('b', null, 'This folder can be used. '), check.info.free != null ? `${fmt.bytes(check.info.free)} free on this drive.` : '', check.info.hasServer ? ' A server installation was detected.' : '') : null);
        } catch (err) { mount(result, callout('err', 'alertCircle', err.message)); check = null; }
        updateFoot();
      }, 350);
      dirIn.addEventListener('input', validate);
      confirmBox.addEventListener('change', () => updateFoot());
      const browse = h('button', { class: 'btn', onclick: async () => { const d = await api.pickDirectory({ title: 'Choose the folder for the Satisfactory server files', defaultPath: dirIn.value || undefined }).catch(toastError); if (d) { dirIn.value = d; validate(); } } }, icon('folder'), 'Browse…');
      mount(body, panel('location', 'Step 3', 'Where should the server live?', 'Choose a folder for the Satisfactory server files. It must be separate from where this manager program is installed. The server needs about 10 GB plus room for updates.',
        modes,
        h('div', { class: 'card mt col' },
          h('label', { class: 'field' }, 'Server name', nameIn, h('span', { class: 'hint' }, 'Shown in this app and — after claiming — in the in-game server list.')),
          h('label', { class: 'field' }, 'Server folder', h('div', { class: 'input-group' }, dirIn, browse), h('span', { class: 'hint' }, 'Suggested: ', h('a', { onclick: () => { dirIn.value = st.scan ? st.scan.suggested : dirIn.value; validate(); } }, st.scan ? st.scan.suggested : ''))),
          existing.length && mode === 'attach' ? h('div', { class: 'row wrap' }, existing.map((e) => h('button', { class: 'btn sm', onclick: () => { dirIn.value = e.dir; validate(); } }, icon('server'), e.dir))) : null,
          h('label', { class: 'field' }, 'Game branch', branchSel, h('span', { class: 'hint' }, 'The experimental branch is published by Coffee Stain on Steam when available. Players must use the same branch.')),
          result,
          h('label', { class: 'check' }, confirmBox, h('span', null, 'I confirm the server files will be installed in ', h('code', null, confirmText), h('span', { class: 'hint' }, 'Nothing outside this folder will be modified.'))))));
      api.call('setup.branches').then((list) => {
        const names = list.map((b) => b.name);
        for (const opt of [...branchSel.options]) if (!names.includes(opt.value)) opt.disabled = true;
        for (const b of list) if (b.buildId) { const o = [...branchSel.options].find((x) => x.value === b.name); if (o) o.textContent += ` · build ${b.buildId}`; }
      }).catch(() => {});
      const updateFoot = () => footer({
        nextEnabled: !!(check && check.ok && confirmBox.checked && nameIn.value.trim()),
        onNext: async () => {
          st = await api.call('setup.confirmLocation', { dir: check.dir, name: nameIn.value.trim(), branch: branchSel.value, mode, confirmed: true });
          await next();
        },
      });
      validate();
    },

    dependencies() {
      const v = st.verification;
      const vc = st.scan && st.scan.vcRuntime;
      const vcBox = h('input', { type: 'checkbox', checked: !!(vc && vc.applicable && !vc.installed) });
      progressSlot = h('div');
      const items = h('div', { class: 'check-list' },
        h('div', { class: `check-item ${v.steamcmd.installed ? 'ok' : 'pending'}` }, h('div', { class: 'ci' }, icon(v.steamcmd.installed ? 'check' : 'download', { sw: 2.2 })), h('div', { class: 'grow' }, h('b', null, 'SteamCMD (Valve)'), h('div', { class: 'd' }, v.steamcmd.installed ? `Installed in ${v.steamcmd.dir}` : 'Will be downloaded from Valve’s official server (steamcdn-a.akamaihd.net) into the manager’s data folder.'))),
        vc && vc.applicable ? h('div', { class: `check-item ${vc.installed ? 'ok' : 'warning'}` }, h('div', { class: 'ci' }, icon(vc.installed ? 'check' : 'package', { sw: 2.2 })), h('div', { class: 'grow' }, h('b', null, 'Microsoft Visual C++ 2015–2022 runtime (x64)'), h('div', { class: 'd' }, vc.installed ? `Installed (version ${vc.version})` : 'Required by Unreal Engine servers. Downloaded from Microsoft (aka.ms) and verified by its digital signature.'),
          !vc.installed ? h('label', { class: 'check mt' }, vcBox, h('span', null, 'Install it now', h('span', { class: 'hint' }, 'Windows will ask for administrator permission once.'))) : null)) : null);
      const done = v.verified.dependencies;
      mount(body, panel('dependencies', 'Step 4', 'Preparing the tools', 'SteamCMD is Valve’s official tool for downloading dedicated servers. The manager installs and maintains it for you.', interruptedBanner(), items, progressSlot,
        done ? callout('ok', 'check', 'All prerequisites are ready.') : null));
      updateProgress();
      footer({
        nextLabel: done ? 'Continue' : 'Install & continue',
        onNext: async () => {
          if (!done || vcBox.checked) {
            footer({ nextEnabled: false, nextLabel: 'Installing…', extra: [cancelBtn()] });
            try { await api.call('setup.installDependencies', { installVcRedist: vcBox.checked }); toast('Prerequisites installed', '', 'success'); } catch (err) { toastError(err, 'Installation failed'); await refresh(); return; }
          }
          await refresh(); if (st.verification.verified.dependencies) await next();
        },
      });
    },

    install() {
      const v = st.verification;
      const loc = st.location || {};
      progressSlot = h('div');
      const stateBox = v.install.state === 'complete' ? callout('ok', 'check', h('b', null, 'Server installed. '), `Build ${v.install.buildId} (${v.install.branch} branch) was verified. Nothing needs to be downloaded again.`)
        : v.install.state === 'partial' ? callout('warn', 'wrench', h('b', null, 'Partially completed installation found. '), `${v.install.reason}. Choose “Resume installation” — SteamCMD keeps the parts that were already downloaded and repairs the rest.`)
          : callout('info', 'info', 'The dedicated server (Steam App 1690800, about 8 GB) will be downloaded and verified. You can keep using your PC meanwhile.');
      const canCleanup = loc.createdByWizard && v.install.state !== 'complete' && (st.interrupted || st.lastError || v.install.state === 'partial');
      mount(body, panel('install', 'Step 5', 'Installing the dedicated server', `Downloading Satisfactory Dedicated Server into ${loc.dir || 'the chosen folder'} using SteamCMD.`,
        interruptedBanner(), stateBox, h('div', { class: 'mt' }, progressSlot),
        canCleanup ? h('div', { class: 'row mt' }, h('span', { class: 'muted small grow' }, 'Prefer to start over? This removes only the files this setup downloaded into the new folder.'),
          h('button', { class: 'btn danger sm', onclick: async () => { if (await confirmDialog({ title: 'Remove partial installation?', message: `All partially downloaded files in ${loc.dir} will be deleted. The folder was created by this setup, so nothing else is affected.`, confirmLabel: 'Remove files', danger: true })) { try { st = await api.call('setup.cleanup', { confirm: true }); toast('Partial installation removed', '', 'success'); await refresh(); } catch (err) { toastError(err); } } } }, icon('trash'), 'Remove partial files')) : null));
      updateProgress();
      const start = async (repair) => {
        footer({ nextEnabled: false, nextLabel: 'Installing…', extra: [cancelBtn()] });
        try {
          const r = await api.call('setup.installServer', { repair });
          toast(r.skipped ? 'Server already installed' : 'Server installed', r.buildId ? `Build ${r.buildId}` : '', 'success');
          await refresh();
        } catch (err) { if (err.code === 'E_CANCELLED') toast('Installation paused', 'You can resume at any time; downloaded parts are kept.', 'warning'); else toastError(err, 'Installation failed'); await refresh(); }
      };
      if (st.running) { footer({ nextEnabled: false, nextLabel: 'Installing…', extra: [cancelBtn()] }); return; }
      footer(v.install.state === 'complete'
        ? { extra: [h('button', { class: 'btn ghost lg', onclick: () => start(true) }, icon('wrench'), 'Verify files again')] }
        : { nextLabel: v.install.state === 'partial' ? 'Resume installation' : 'Install server', onNext: () => start(false) });
    },

    network() {
      const box = h('div', { class: 'col' }, h('div', { class: 'muted' }, 'Checking ports and firewall…'));
      mount(body, panel('network', 'Step 6', 'Network & firewall', 'Players connect to your server over the network. We check that the required ports are free and that Windows Firewall lets players in.', box));
      footer({ nextEnabled: false });
      const load = async () => {
        let n;
        try { n = await api.call('setup.network'); } catch (err) { mount(box, callout('err', 'alertCircle', err.message)); return; }
        const fw = n.firewall;
        mount(box,
          h('div', { class: 'card flush' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Port'), h('th', null, 'Protocol'), h('th', null, 'Used for'), h('th', null, 'Status'), h('th', null, 'Firewall rule'))),
            h('tbody', null, n.ports.map((p) => {
              const rule = fw.rules ? fw.rules.find((r) => r.protocol === p.protocol && r.port === p.port) : null;
              return h('tr', null, h('td', { class: 'mono' }, String(p.port)), h('td', null, p.protocol), h('td', null, p.purpose),
                h('td', null, p.free === null ? badge(p.note || 'n/a', 'info') : p.free ? badge('Free', 'ok', 'check') : badge('In use by another program', 'err', 'x')),
                h('td', null, !fw.supported ? badge('Windows only', '') : rule && rule.present ? badge('Allowed', 'ok', 'check') : rule && rule.present === false ? badge('Missing', 'warn', 'alert') : badge('Unknown', '')));
            })))),
          n.conflicts.length ? callout('err', 'alertCircle', h('b', null, 'A port is already used by another program. '), `Use the free ports ${n.suggestion.port} / ${n.suggestion.reliablePort} instead.`, h('div', { class: 'mt' }, h('button', { class: 'btn sm primary', onclick: async () => { try { await api.call('setup.changePorts', n.suggestion); load(); } catch (err) { toastError(err); } } }, 'Use suggested ports'))) : null,
          fw.supported && fw.error ? callout('warn', 'alert', fw.error) : null,
          fw.supported && !fw.error && !fw.allPresent ? callout('warn', 'firewall', h('b', null, 'Firewall rules are missing. '), fw.firewallEnabled ? 'Windows Firewall is on and may block players from other computers. The manager can add inbound rules for exactly these ports — Windows will ask for administrator permission.' : 'Windows Firewall appears to be off; rules are still recommended in case it is switched on.',
            h('div', { class: 'mt' }, h('button', { class: 'btn sm primary', onclick: async () => {
              if (!(await confirmDialog({ title: 'Create firewall rules?', message: 'Windows will show an administrator prompt. Inbound “allow” rules will be created only for the ports listed above, named “Satisfactory Server Manager”. You can remove them later in Diagnostics.', confirmLabel: 'Continue to Windows prompt' }))) return;
              try { await api.call('setup.configureFirewall', { confirm: true }); toast('Firewall rules created and verified', '', 'success'); } catch (err) { toastError(err, 'Firewall rules not created'); }
              load();
            } }, icon('shield'), 'Create firewall rules'))) : null,
          fw.supported && fw.allPresent ? callout('ok', 'shieldCheck', 'Windows Firewall rules for this server are in place.') : null,
          callout('info', 'globe', h('b', null, 'Playing over the internet? '), `Friends outside your home network also need port forwarding on your router (UDP ${n.ports[0].port}, TCP ${n.ports[1].port}, TCP ${n.ports[2].port}) — this is set in your router’s web page and cannot be done by this app. `, h('a', { onclick: () => api.openExternal('https://satisfactory.wiki.gg/wiki/Dedicated_servers') }, 'Official dedicated server guide')),
          n.lan.length ? h('p', { class: 'small muted' }, `Players on your home network can connect to ${n.lan.map((a) => a.address).join(' or ')} port ${n.ports[0].port}.`) : null);
        footer({ nextEnabled: !n.conflicts.length, onNext: async () => { st = await api.call('setup.completeNetwork', {}); await next(); }, extra: !fw.allPresent && fw.supported ? [h('button', { class: 'btn ghost lg', onclick: async () => { st = await api.call('setup.completeNetwork', { skipReason: 'Firewall rules not created' }); await next(); } }, 'Skip firewall')] : [] });
      };
      load();
    },

    security() {
      const box = h('div', { class: 'col' });
      progressSlot = h('div');
      mount(body, panel('security', 'Step 7', 'Secure your server', 'A new server must be “claimed”: you give it a name and an administrator password. The manager then receives an access token so it can save before stopping, read the player count and change settings live.', interruptedBanner(), progressSlot, box));
      updateProgress();
      const done = st.verification.hasToken;
      const skipBtn = h('button', { class: 'btn ghost lg', onclick: async () => {
        if (!(await confirmDialog({ title: 'Skip security setup?', message: 'Without API access the manager cannot stop the server gracefully on Windows, show player counts or apply live settings. You can claim the server later on its Access tab.', confirmLabel: 'Skip for now' }))) return;
        st = await api.call('setup.skipSecurity', { reason: 'Skipped during setup' }); await next();
      } }, 'Skip for now');
      if (done) { mount(box, callout('ok', 'shieldCheck', h('b', null, 'API access is configured. '), 'The access token is stored encrypted with Windows Data Protection. Passwords are never stored.')); footer(); return; }
      const showForms = async () => {
        let a;
        try { a = await api.call('setup.accessStatus'); } catch (err) { mount(box, callout('err', 'alertCircle', err.message)); return; }
        if (!a || !a.running) {
          mount(box, callout('info', 'play', 'The server needs to run once for this step. It will start in the background — this can take a few minutes the first time.'));
          footer({ nextLabel: 'Start server', onNext: async () => {
            footer({ nextEnabled: false, nextLabel: 'Starting…', extra: [cancelBtn()] });
            try { await api.call('setup.startForSecurity'); } catch (err) { toastError(err, 'Server did not start'); }
            await refresh();
          }, extra: [skipBtn] });
          return;
        }
        if (a.error && a.claimed === null) { mount(box, callout('warn', 'alert', `The server API is not reachable yet: ${a.error}`, h('div', { class: 'mt' }, h('button', { class: 'btn sm', onclick: showForms }, 'Try again')))); footer({ nextEnabled: false, extra: [skipBtn] }); return; }
        const err = h('div');
        if (a.claimed === false) {
          const name = h('input', { class: 'input', value: (st.location && st.location.name) || '' });
          const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
          const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
          const cpw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Leave empty for no password' });
          mount(box, h('div', { class: 'card col' }, h('h3', null, 'Claim your server'),
            h('label', { class: 'field' }, 'Server name (shown in the game)', name),
            h('div', { class: 'grid g2' }, h('label', { class: 'field' }, 'Administrator password', pw, h('span', { class: 'hint' }, 'At least 8 characters. Needed to manage the server in-game.')), h('label', { class: 'field' }, 'Repeat password', pw2)),
            h('label', { class: 'field' }, 'Player password (optional)', cpw, h('span', { class: 'hint' }, 'Players must enter this to join. You can change it later.')),
            callout('info', 'lock', 'Write the administrator password down — it is not stored by this app and Coffee Stain cannot recover it.'), err));
          footer({ nextLabel: 'Claim server', extra: [skipBtn], onNext: async () => {
            mount(err);
            if (pw.value.length < 8) { mount(err, callout('err', 'alertCircle', 'The administrator password must be at least 8 characters.')); return; }
            if (pw.value !== pw2.value) { mount(err, callout('err', 'alertCircle', 'The passwords do not match.')); return; }
            try { st = await api.call('setup.claim', { serverName: name.value.trim() || 'Satisfactory Server', adminPassword: pw.value, clientPassword: cpw.value || undefined }); toast('Server claimed', 'API access stored securely.', 'success'); await refresh(); } catch (e) { mount(err, callout('err', 'alertCircle', e.message)); }
          } });
        } else {
          const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
          mount(box, h('div', { class: 'card col' }, h('h3', null, 'This server is already claimed'), h('p', null, 'Sign in with its administrator password so the manager can obtain an access token.'), h('label', { class: 'field' }, 'Administrator password', pw), err));
          footer({ nextLabel: 'Sign in', extra: [skipBtn], onNext: async () => {
            try { st = await api.call('setup.login', { adminPassword: pw.value }); toast('Signed in', 'API access stored securely.', 'success'); await refresh(); } catch (e) { mount(err, callout('err', 'alertCircle', e.message)); }
          } });
        }
      };
      if (st.running) { footer({ nextEnabled: false, extra: [cancelBtn()] }); return; }
      showForms();
    },

    async review() {
      mount(body, panel('review', 'Step 8', 'Review your setup', 'Here is everything that was configured. You can go back to any step to change it.', h('div', { class: 'muted' }, 'Loading summary…')));
      footer({ nextEnabled: false });
      let r;
      try { r = await api.call('setup.review'); } catch (err) { toastError(err); return; }
      const rows = [
        ['Server name', r.server ? r.server.name : '—'],
        ['Server folder', h('span', { class: 'pathbox' }, r.server ? r.server.dir : '—')],
        ['Game branch', r.server ? r.server.branch : '—'],
        ['Installed build', r.install.state === 'complete' ? `${r.install.buildId}` : r.install.state],
        ['Ports', r.server ? `UDP/TCP ${r.server.port}, TCP ${r.server.reliablePort}` : '—'],
        ['SteamCMD', r.steamcmd.installed ? r.steamcmd.dir : 'not installed'],
        ['API access', r.apiAccess ? 'Configured (token encrypted)' : r.skipped.security ? 'Skipped — configure later' : 'Not configured'],
        ['Firewall', r.skipped.network ? 'Skipped' : 'Checked'],
        ['Manager program folder', h('span', { class: 'pathbox' }, r.appInstallDir)],
        ['Manager data folder', h('span', { class: 'pathbox' }, r.appDataDir)],
      ];
      mount(body, panel('review', 'Step 8', 'Review your setup', 'Here is everything that was configured. You can go back to any step to change it.',
        h('div', { class: 'card' }, h('div', { class: 'summary-grid' }, rows.flatMap(([k, v]) => [h('div', null, k), h('div', null, v)]))),
        h('div', { class: 'card mt' }, h('h3', { class: 'mb' }, 'Completed operations'),
          h('div', { class: 'timeline' }, r.operations.slice(-12).reverse().map((o) => h('div', { class: `tl-item ${o.ok ? 'ok' : 'failed'}` }, h('div', { class: 't' }, fmt.date(o.ts)), h('div', { class: 'h' }, o.message)))))));
      footer();
    },

    finish() {
      const startBox = h('input', { type: 'checkbox', checked: true });
      const autoBox = h('input', { type: 'checkbox' });
      const loginBox = h('input', { type: 'checkbox' });
      mount(body, panel('finish', 'All done', 'Your server is ready', 'Setup is complete. The dashboard shows live status, the console, backups, mods and more.',
        h('div', { class: 'card col' },
          h('label', { class: 'check' }, startBox, h('span', null, 'Start the server now', h('span', { class: 'hint' }, 'You can start and stop it any time from the dashboard.'))),
          h('label', { class: 'check' }, autoBox, h('span', null, 'Start this server automatically when the manager opens', h('span', { class: 'hint' }, 'Useful together with the option below.'))),
          api.desktop ? h('label', { class: 'check' }, loginBox, h('span', null, 'Open Satisfactory Server Manager when I sign in to Windows', h('span', { class: 'hint' }, 'Adds a per-user startup entry. You can turn this off in Settings → Startup.'))) : null),
        callout('info', 'info', 'Tip: create a backup schedule under Scheduler so your saves are protected automatically.')));
      footer({ nextLabel: 'Open dashboard', onNext: async () => {
        if (loginBox.checked) await api.call('settings.update', { section: 'startup', patch: { launchAtLogin: true } });
        await api.call('setup.finish', { startServer: startBox.checked, autoStart: autoBox.checked });
        off();
        onDone();
      } });
    },
  };

  function firstIncomplete() {
    const v = st.verification.verified;
    for (const k of ['scan', 'location', 'dependencies', 'install', 'network', 'security']) if (!v[k]) return k;
    return 'review';
  }

  function cancelBtn() {
    return h('button', { class: 'btn danger lg', onclick: async () => { try { await api.call('setup.cancel'); toast('Cancelling…', 'The current operation is being stopped safely.', 'warning'); } catch (err) { toastError(err); } } }, icon('x'), 'Cancel');
  }

  function draw() {
    progressSlot = null;
    const view = views[st.step] || views.welcome;
    view();
    body.scrollTop = 0;
  }

  refresh();
  return { dispose: off };
}
