// Actions sketch, on top of the thread-header sketch (layout A, ?s=wt).
// ?v=header | menu | empty | new | edit | delete | running | exited   ?x=a|b   ?code=0 (exited)
const aq = new URLSearchParams(location.search);
const AV = aq.get('v') || 'menu';
const AX = aq.get('x') || 'a';
const CODE = aq.get('code') || '1';
const REPO = 'code-foundry';

// The repo's actions (icon ids are the six of the feature: play, test, lint, configure, build, debug).
const ICON = { play: 'play', test: 'flask-conical', lint: 'list-checks', configure: 'wrench', build: 'hammer', debug: 'bug' };
const ICON_LABEL = { play: 'Play', test: 'Test', lint: 'Lint', configure: 'Configure', build: 'Build', debug: 'Debug' };
const ACTIONS = [
  { name: 'Dev', icon: 'play', cmd: 'make dev' },
  { name: 'Test', icon: 'test', cmd: 'go test ./...' },
  { name: 'Check', icon: 'lint', cmd: 'make check' },
  { name: 'Build', icon: 'build', cmd: 'make build' },
  { name: 'Install deps', icon: 'configure', cmd: 'cd gui/frontend && pnpm install', onCreate: true },
  { name: 'Debug daemon', icon: 'debug', cmd: 'dlv debug ./cmd/code-foundry -- daemon' },
];
const sz = (svg, px) => svg.replace('class="ic ', `style="width:${px}px;height:${px}px" class="ic `);

// ---------------------------------------------------------------- header trigger
const acts = document.querySelector('.phdr .acts');
const tbs = acts.querySelectorAll(':scope > .tb');
const bottomToggle = tbs[tbs.length - 2];
bottomToggle.insertAdjacentHTML('beforebegin', `<span class="tb" id="actions-trigger" title="Run an action">${ic('play')}</span>`);
const trigger = document.getElementById('actions-trigger');

// ---------------------------------------------------------------- content column (+ bottom panel)
const pane = document.querySelector('.pane');
const column = document.createElement('div');
column.className = 'column';
pane.replaceWith(column);
column.append(pane);

// ---------------------------------------------------------------- menu
function menuRow(a, i, hl) {
  let end = '';
  if (AX === 'a' && hl) end = `<span class="end"><span class="edit hov" title="Edit ${a.name}">${ic('pencil')}</span></span>`;
  if (AX === 'b') end = `<span class="end">${ic('chevron-right', 'chev')}</span>`;
  return `<div class="mi ${hl ? 'hl' : ''}" data-i="${i}">${ic(ICON[a.icon])}<span class="lbl">${a.name}</span>${end}</div>`;
}
function menu(empty) {
  const body = empty
    ? `<div class="ml hint">No actions for ${REPO} yet</div>`
    : `<div class="ml">${REPO}</div>${ACTIONS.map((a, i) => menuRow(a, i, i === 1)).join('')}<div class="msep"></div>`;
  return `<div class="menu" id="menu">${body}<div class="mi">${ic('plus')}<span class="lbl">New action…</span></div></div>`;
}
function submenu() {
  return `<div class="menu" id="sub" style="min-width:9.5rem">
    <div class="mi hl">${ic('play')}<span class="lbl">Run</span></div>
    <div class="mi">${ic('pencil')}<span class="lbl">Edit…</span></div>
  </div>`;
}
function placeMenu() {
  const r = trigger.getBoundingClientRect();
  const m = document.getElementById('menu');
  m.style.top = `${r.bottom + 4}px`;
  m.style.right = `${innerWidth - r.right}px`;
  const sub = document.getElementById('sub');
  if (sub) {
    const mr = m.getBoundingClientRect();
    const row = m.querySelector('.mi.hl').getBoundingClientRect();
    sub.style.top = `${row.top - 5}px`;
    sub.style.right = `${innerWidth - mr.left - 2}px`;
  }
}

// ---------------------------------------------------------------- editor dialog
function editor(mode) {
  const isNew = mode === 'new';
  const a = isNew
    ? { name: 'Install deps', icon: 'configure', onCreate: true }
    : ACTIONS[1];
  const command = isNew
    ? `<span class="sh-c">cd</span> gui/frontend\n<span class="sh-c">pnpm</span> install <span class="sh-f">--frozen-lockfile</span><span class="caret"></span>`
    : `<span class="sh-c">go</span> test ./...`;
  const tiles = Object.keys(ICON).map((k) => `<span class="tile ${k === a.icon ? 'sel' : ''}">${ic(ICON[k])}<span>${ICON_LABEL[k]}</span></span>`).join('');
  let foot;
  if (isNew) {
    foot = `<span class="sp"></span><span class="b outline">Cancel</span><span class="b primary">Save</span>`;
  } else if (mode === 'delete') {
    // the confirm takes over the footer; its Delete sits where Save was, away from the first click
    foot = `<span class="confirm">Delete <b>${a.name}</b> for every thread in ${REPO}?</span><span class="sp"></span><span class="b outline">Keep</span><span class="b danger">Delete</span>`;
  } else {
    foot = `<span class="b del">${ic('trash')}Delete</span><span class="sp"></span><span class="b outline">Cancel</span><span class="b primary">Save</span>`;
  }
  return `<div class="overlay"></div><div class="dlg" role="dialog">
    <span class="x">${ic('x')}</span>
    <h2>${isNew ? 'New action' : 'Edit action'}</h2>
    <div class="desc">Saved for every thread in <b style="font-weight:500;color:var(--fg)">${REPO}</b>. Runs in the thread's checkout and opens as a tab in the bottom panel.</div>
    <div class="fields">
      <div class="fld"><label>Name</label><div class="in">${a.name}</div></div>
      <div class="fld"><label>Command</label><div class="in area ${isNew ? 'focus' : ''}">${command}</div><span class="help">Runs from the checkout's root. Each line runs in order.</span></div>
      <div class="fld"><label>Icon</label><div class="tiles">${tiles}</div></div>
      <div class="swrow"><span class="tt">Run automatically when a worktree is created<small>Opens in the new thread's bottom panel</small></span><span class="sw ${a.onCreate ? 'on' : ''}"></span></div>
    </div>
    <div class="foot">${foot}</div>
  </div>`;
}

// ---------------------------------------------------------------- bottom panel
const OUT_CHECK = [
  `<span class="dim">$ make check</span>`,
  `gofmt -l .`,
  `go vet ./...`,
  `staticcheck ./...`,
  `go test ./...`,
  `<span class="ok">ok</span>  	github.com/alexwaumann/code-foundry/internal/api	2.114s`,
  `<span class="ok">ok</span>  	github.com/alexwaumann/code-foundry/internal/command	0.381s`,
  `<span class="ok">ok</span>  	github.com/alexwaumann/code-foundry/internal/model	0.092s`,
  `<span class="ok">ok</span>  	github.com/alexwaumann/code-foundry/internal/store/pr	0.412s`,
  `?   	github.com/alexwaumann/code-foundry/internal/store/prtest	[no test files]`,
  `<span class="cur"></span>`,
];
const OUT_TEST = [
  `<span class="dim">$ go test ./...</span>`,
  `<span class="ok">ok</span>  	github.com/alexwaumann/code-foundry/internal/api	2.114s`,
  `<span class="ok">ok</span>  	github.com/alexwaumann/code-foundry/internal/command	0.381s`,
  `<span class="fl">--- FAIL: TestFingerprintChangesOnForcePush (0.00s)</span>`,
  `    fingerprint_test.go:41: fingerprint unchanged after the head moved`,
  `        got:  {CheckCount:3 ReviewState:APPROVED}`,
  `        want: a different fingerprint`,
  `<span class="fl">FAIL</span>`,
  `<span class="fl">FAIL</span>	github.com/alexwaumann/code-foundry/internal/store/pr	0.412s`,
  `<span class="ok">ok</span>  	github.com/alexwaumann/code-foundry/internal/store/session	1.902s`,
  `<span class="fl">FAIL</span>`,
];
const OUT_BUILD = [
  `<span class="dim">$ make build</span>`,
  `go build -trimpath -o bin/code-foundry ./cmd/code-foundry`,
  `cd gui && wails3 task build`,
  `task: [build:frontend] pnpm run build`,
  `vite v7.1.4 building for production...`,
  `✓ 2214 modules transformed.`,
  `dist/index.html                   0.61 kB`,
  `dist/assets/index-Bq3x8Yc1.css   88.40 kB │ gzip: 14.21 kB`,
  `dist/assets/index-C2fWm0aT.js  1,412.73 kB │ gzip: 401.66 kB`,
  `✓ built in 6.12s`,
  `task: [build:darwin] go build -o bin/code-foundry-gui .`,
];

function tab(icon, title, { on = false, st = '' } = {}) {
  return `<div class="btab ${on ? 'on' : ''}">${ic(icon)}<span>${title}</span>${st}<span class="bx">${ic('x')}</span></div>`;
}
const ST = {
  run: ic('loader-circle', 'st spin'),
  ok: ic('circle-check', 'st t-emerald'),
  fail: ic('circle-x', 'st t-red'),
};
function bottomPanel(state) {
  const running = state === 'running';
  const ok = !running && CODE === '0';
  const shell = tab('square-terminal', 'pr-badge-stale');
  let tabs; let out; let a; let b;
  if (running) {
    tabs = shell + tab(ICON.lint, 'Check', { on: true, st: ST.run });
    out = OUT_CHECK;
    a = `<div class="tstat">${ST.run}<span class="who">Running</span><span class="sep">·</span><span class="num">0:12</span><span class="sep">·</span><span class="bb">${sz(ic('square'), 10)}Stop</span></div>`;
    b = `<span class="run"><span>Running</span><span class="sep">·</span><span class="num">0:12</span></span><span class="bb out">${sz(ic('square'), 10)}Stop</span>`;
  } else if (ok) {
    tabs = shell + tab(ICON.build, 'Build', { on: true, st: ST.ok });
    out = OUT_BUILD;
    a = `<div class="tstat">${ST.ok}<span class="who">Exited with code 0</span><span class="sep">·</span><span class="num">9.8s</span><span class="sep">·</span><span class="bb">${ic('rotate-ccw')}Rerun</span></div>`;
    b = `<span class="run"><span>Exited 0</span><span class="sep">·</span><span class="num">9.8s</span></span><span class="bb out">${ic('rotate-ccw')}Rerun</span>`;
  } else {
    tabs = shell + tab(ICON.build, 'Build', { st: ST.ok }) + tab(ICON.test, 'Test', { on: true, st: ST.fail });
    out = OUT_TEST;
    a = `<div class="tstat fail">${ST.fail}<span class="who">Exited with code 1</span><span class="sep">·</span><span class="num">4.2s</span><span class="sep">·</span><span class="bb hov">${ic('rotate-ccw')}Rerun</span></div>`;
    b = `<span class="run"><span class="t-red">Exited 1</span><span class="sep">·</span><span class="num">4.2s</span></span><span class="bb out hov">${ic('rotate-ccw')}Rerun</span>`;
  }
  return `<aside class="bottom">
    <div class="bhead"><div class="btabs">${tabs}<span class="tb">${ic('plus')}</span></div>${AX === 'b' ? b : ''}<span class="tb">${ic('x')}</span></div>
    <div class="tarea"><div>${out.join('\n')}</div></div>
    ${AX === 'a' ? a : ''}
  </aside>`;
}

// ---------------------------------------------------------------- states
const overlay = document.createElement('div');
document.body.append(overlay);
if (AV === 'menu' || AV === 'empty') {
  trigger.classList.add('on');
  overlay.innerHTML = menu(AV === 'empty') + (AV === 'menu' && AX === 'b' ? submenu() : '');
  placeMenu();
} else if (AV === 'new' || AV === 'edit' || AV === 'delete') {
  overlay.innerHTML = editor(AV);
} else if (AV === 'running' || AV === 'exited') {
  bottomToggle.classList.add('on');
  column.insertAdjacentHTML('beforeend', bottomPanel(AV));
}
// keep the thread scrolled to its end after the column shrank
const sc2 = document.querySelector('.scroller');
sc2.scrollTop = sc2.scrollHeight;
