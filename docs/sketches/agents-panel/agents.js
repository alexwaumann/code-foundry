// Agents panel sketch. ?variant=a|b|c (panel)  ?thread=chip|strip|line (how the thread shows running agents)  ?theme=dark|light
const q = new URLSearchParams(location.search);
const V = (q.get('variant') || 'l1').toLowerCase();
const T = (q.get('thread') || 'strip').toLowerCase();
const THEME = q.get('theme') || 'dark';
document.documentElement.classList.toggle('dark', THEME !== 'light');
document.body.dataset.variant = V;

const ic = (n, cls = '', size = 0) => `<svg class="ic ${cls}" viewBox="0 0 24 24"${size ? ` style="width:${size}px;height:${size}px"` : ''}>${ICONS[n] || ''}</svg>`;
const spin = (size = 14) => ic('loader-circle', 'spin', size);

// ---------------------------------------------------------------- data: one thread's agent runs (task_started/progress/updated/notification + Agent tool input)
// status: running | done | failed. background from run_in_background / is_backgrounded. depth from spawn_depth.
const RUNS = [
  { id: 'a1', name: 'PR 1: daemon task frames', type: 'general-purpose', model: 'opus', effort: 'high', bg: true, depth: 1, status: 'running',
    activity: 'Running go test ./internal/store/...', lastTool: 'Bash', elapsed: '4m 12s', tokens: '48.2k', tools: 23, started: '4 min ago' },
  { id: 'a1b', name: 'Review usage_runs changes', type: 'Explore', model: '', effort: '', bg: false, depth: 2, parent: 'a1', status: 'running',
    activity: 'Reading usage_runs.go', lastTool: 'Read', elapsed: '38s', tokens: '6.1k', tools: 4, started: '38 s ago' },
  { id: 'a2', name: 'PR 2: Agents surface in the panel', type: 'general-purpose', model: 'opus', effort: 'high', bg: true, depth: 1, status: 'running',
    activity: 'Editing AgentsSurface.tsx', lastTool: 'Edit', elapsed: '3m 51s', tokens: '61.7k', tools: 31, started: '4 min ago' },
  { id: 'a0', name: 'Find the header chip pattern', type: 'Explore', model: 'haiku', effort: '', bg: false, depth: 1, status: 'done',
    elapsed: '12s', tokens: '9.4k', tools: 6, started: '5 min ago',
    summary: 'LinkedPrs in HeaderActions.tsx renders a CommandButton with a count when there are 2+ PRs; the single case is SingleLinkedPr. Both open a panel surface.' },
  { id: 'a3', name: 'Screenshot the panel in Wails', type: 'claude', model: '', effort: '', bg: true, depth: 1, status: 'failed',
    elapsed: '1m 03s', tokens: '12.0k', tools: 9, started: '3 min ago', error: 'Stopped: process exited with code 1' },
];
const running = RUNS.filter((r) => r.status === 'running');
const runningTop = running.filter((r) => r.depth === 1);
const bgRunning = runningTop.filter((r) => r.bg).length;

const STATUS = { running: ['run', 'Running'], done: ['ok', 'Done'], failed: ['bad', 'Failed'] };
const kindText = (r) => [r.type, r.model ? r.model + (r.effort ? ' · ' + r.effort : '') : ''].filter(Boolean);
const modeText = (r) => (r.bg ? 'background' : 'foreground');
const stats = (r) => `<span class="stats"><span class="stat">${ic('clock')}${r.elapsed}</span><span class="stat">${ic('wrench')}${r.tools}</span><span class="stat">${ic('zap')}${r.tokens}</span></span>`;
const actline = (r) => r.status === 'running'
  ? `<div class="actline">${ic('loader-circle', 'spin')}<span class="shimmer">${r.activity}</span><span class="tl">${r.lastTool}</span></div>`
  : r.status === 'failed' ? `<div class="err">${r.error}</div>` : r.summary ? `<div class="summ">${r.summary}</div>` : '';

// ---------------------------------------------------------------- chrome
function sidebar() {
  return `<aside class="sidebar">
    <div class="band"><span class="lights"><i></i><i></i><i></i></span><b>Code Foundry</b></div>
    <div class="toolbar"><span class="tb">${ic('layout-dashboard')}</span><span class="tb">${ic('bell')}</span><span style="flex:1"></span><span class="tb">${ic('folder-plus')}</span><span class="tb">${ic('square-pen')}</span></div>
    <div class="nav">${ic('git-pull-request')}Pull Requests</div>
    <div class="nav" style="margin-bottom:6px">${ic('folder-git-2')}Projects</div>
    <div class="trow sel"><span class="n"><span>Agents panel</span></span><span class="s"><span class="t-sky">${ic('bot')}2 agents</span> · code-foundry · <span class="mono">cf/agents-panel</span></span></div>
    <div class="trow"><span class="n"><span>Rendered threads daemon</span></span><span class="s"><span class="t-emerald">Finished 3 min ago</span></span></div>
    <div class="trow"><span class="n"><span>Release notes draft</span></span><span class="s">code-foundry · <span class="mono">main</span></span></div>
    <div class="sect"><span>WORKING&nbsp; 1</span>${ic('chevron-down', '', 14)}</div>
    <div class="trow"><span class="n"><span>Usage page polish</span></span><span class="s"><span class="t-sky">Working</span> · code-foundry · <span class="mono">cf/usage-polish</span></span></div>
    <div class="statusbar"><span class="d"></span>daemon<span>pid 52169</span><span style="flex:1"></span>${ic('command')}${ic('chart-column')}${ic('circle-question-mark')}${ic('settings')}</div>
  </aside>`;
}

const agentRow = (r, open) => {
  const meta = r.status === 'running'
    ? `${r.bg ? '<span class="chip bg">background</span>' : ''}<span class="act">${r.activity}</span><span>${r.elapsed}</span>${spin()}`
    : r.status === 'failed' ? `<span class="chip bg">background</span><span class="chip fail">failed</span><span>${r.elapsed}</span>`
    : `<span>${r.elapsed}</span>`;
  return `<div class="row ${open ? 'open' : ''}"><span class="ico">${ic('bot')}</span><span class="lbl">Agent <b>${r.name}</b> <span class="muted12">${r.type}</span></span><span class="meta">${meta}</span>${ic('chevron-right', 'chev')}</div>`;
};

function mainPane() {
  const chip = T === 'chip' ? `<span class="agents" title="2 agents running (2 in the background)">${ic('bot')}${runningTop.length}${spin(12)}</span>` : '';
  const strip = T === 'strip' ? `<div class="strip-agents">${ic('bot')}<span class="t">${runningTop.length} agents running in the background</span><span class="d">PR 1: daemon task frames · Running go test ./internal/store/… &nbsp; PR 2: Agents surface · Editing AgentsSurface.tsx</span><span class="show">Agents ${ic('chevron-right')}</span></div>` : '';
  const line = T === 'line' ? `<div class="working">${spin()}<span>${runningTop.length} agents working in the background</span><span class="link">${ic('panel-right')}Show agents</span></div>` : '';
  return `<section class="pane main">
    <header class="phdr"><span class="dot ok"></span><span class="title">Agents panel</span><span class="m">idle</span><span class="m">opus · high</span><span class="m" style="overflow:hidden;text-overflow:ellipsis">~/.code-foundry/worktrees/…/agents-panel</span>
      <span class="acts">${chip}<span class="tb">${ic('pencil')}</span><span class="tb">${ic('git-fork')}</span><span class="tb">${ic('power')}</span><span class="tb">${ic('panel-bottom')}</span><span class="tb on">${ic('panel-right')}</span></span></header>
    <div class="thread">
      <div class="bubble">Build the agents panel: PR 1 is the daemon side, PR 2 the GUI surface. Fan both out as background agents and look up how the header chips are done first.</div>
      ${agentRow(RUNS[3], true)}
      <div class="children">
        <div class="row"><span class="ico">${ic('text-search')}</span><span class="lbl">Searched <b>LinkedPrs|CommandButton</b> <span class="muted12">in gui/frontend/src</span></span><span class="meta"><span>3 files</span></span></div>
        <div class="row"><span class="ico">${ic('file-text')}</span><span class="lbl">Read <b>HeaderActions.tsx</b></span><span class="meta"><span>112 lines</span></span></div>
        <div class="subresult">LinkedPrs in <code>HeaderActions.tsx</code> renders a CommandButton with a count when there are 2+ PRs; the single case is SingleLinkedPr. Both open a panel surface.</div>
      </div>
      ${agentRow(RUNS[0])}
      ${agentRow(RUNS[2])}
      ${agentRow(RUNS[4])}
      <p>Both PRs are building in the background. The screenshot agent died when the Wails window failed to start; I will retry it once PR 2 lands.</p>
      <div class="footer">${ic('chevron-down', '', 14)} Worked for 48s · 4 steps · $0.12 · Opus 5.5</div>
      <div class="note">${ic('circle-check')}<span class="nm">Agent finished</span><span class="ghost">·</span><span class="nm">PR 1: daemon task frames</span><span class="sum">Added task frame handling to the session store with 14 table tests; make check is green.</span><span class="ghost" style="margin-left:auto;white-space:nowrap">just now</span></div>
      ${line}
    </div>
    ${strip}
    <div class="dock ${T === 'strip' ? 'tight' : ''}"><div class="ccard"><div class="ph">Send a follow-up…</div><div class="bar"><span class="pick">${ic('brain')}Opus ${ic('chevron-down', '', 12)}</span><span class="pick">${ic('gauge')}High ${ic('chevron-down', '', 12)}</span><span class="pick">${ic('shield-check')}Accept edits ${ic('chevron-down', '', 12)}</span><span class="send">${ic('arrow-up')}</span></div></div></div>
  </section>`;
}

function panel(body) {
  return `<section class="panel v${V}">
    <div class="strip"><span class="tab">${ic('plug')}MCP</span><span class="tab on">${ic('bot')}Agents<span class="x">${ic('x')}</span></span><span class="tb">${ic('plus')}</span><span class="sp"></span><span class="tb">${ic('maximize-2')}</span><span class="tb">${ic('panel-right')}</span></div>
    <div class="body">${body}</div>
  </section>`;
}

const header = () => `<header class="shdr"><h2>${ic('bot')}<span>Agents</span><span class="cnt">${runningTop.length} running · ${RUNS.filter((r) => r.depth === 1).length} this thread</span></h2><span class="shsub">${spin(13)}<span>${bgRunning} in the background keep running after the turn ends</span></span></header>`;

// ---------------------------------------------------------------- variant A: grouped two-line rows (Running / Finished)
function variantA() {
  const row = (r) => {
    const [tone, label] = STATUS[r.status];
    const line2 = [...kindText(r), modeText(r)].join('<span class="sep"> · </span>');
    return `<div class="arow ${r.status} ${r.depth === 2 ? 'depth2' : ''}">${r.status === 'running' ? spin(12) : `<span class="ag-dot ${tone}"></span>`}<span class="txt"><span class="name">${r.name}</span><span class="line2">${line2}</span>${actline(r)}</span><span class="right">${stats(r)}</span></div>`;
  };
  const grp = (title, list, cls = '') => list.length ? `<div class="grp"><div class="gh ${cls}">${title} <span class="n">${list.length}</span></div>${list.map(row).join('')}</div>` : '';
  const done = RUNS.filter((r) => r.status !== 'running');
  return header() + grp('Running', running, 'run') + grp('Finished', done);
}

// ---------------------------------------------------------------- variant B: cards, like the MCP tab
function variantB() {
  const card = (r) => {
    const [tone, label] = STATUS[r.status];
    const cls = r.status === 'running' ? 'run' : r.status === 'failed' ? 'bad' : 'done';
    const meta = [...kindText(r), modeText(r), r.depth === 2 ? `<span class="nested-mark">${ic('git-fork')}spawned by PR 1</span>` : ''].filter(Boolean).join('<span class="sep"> · </span>');
    return `<div class="card ${cls} ${r.depth === 2 ? 'depth2' : ''}">
      <div class="top">${r.status === 'running' ? spin(12) : `<span class="ag-dot ${tone}"></span>`}<span class="name">${r.name}</span><span class="pill ${tone}">${label}</span></div>
      <div class="meta">${meta}</div>
      ${actline(r)}
      <div class="foot">${stats(r)}<span class="btn quiet reveal">${ic('text-search')}Show in thread</span></div>
    </div>`;
  };
  const done = RUNS.filter((r) => r.status !== 'running');
  return header() + `<div class="cards"><div class="sect">Running <span class="n">${running.length}</span></div>${running.map(card).join('')}<div class="sect">Finished <span class="n">${done.length}</span></div>${done.map(card).join('')}</div>`;
}

// ---------------------------------------------------------------- variant C: tree by turn, nested runs, indeterminate bar
function variantC() {
  const run = (r) => {
    const icon = r.status === 'running' ? spin() : r.status === 'done' ? ic('circle-check', 'okc') : ic('circle-x', 'badc');
    const meta = [...kindText(r), modeText(r)].join('<span class="sep"> · </span>');
    return `<div class="trun ${r.depth === 2 ? 'd2' : ''}"><span class="ic">${icon}</span><span class="name">${r.name}${r.bg ? '<span class="pill bgk">bg</span>' : ''}</span><span class="right">${stats(r)}</span>
      <span class="sub"><span class="meta">${meta}</span><span class="meta">${stats(r)}</span>${actline(r)}${r.status === 'running' ? '<span class="bar"><i></i></span>' : ''}</span></div>`;
  };
  const order = ['a0', 'a1', 'a1b', 'a2', 'a3'].map((id) => RUNS.find((r) => r.id === id));
  return header() + `<div class="tree"><div class="turn">Turn 1 · 5 min ago</div>${order.map(run).join('')}</div>`;
}


// ---------------------------------------------------------------- variants L1 / L2: flat list, spawn order, edge-to-edge separators (Alex, 2026-10-14: no cards)
const SPAWN = ['a0', 'a1', 'a1b', 'a2', 'a3'].map((id) => RUNS.find((r) => r.id === id));
const stLabel = (r) => r.status === 'running' ? 'Running' : r.status === 'failed' ? 'Failed' : 'Done';
function variantL(compact) {
  const row = (r) => {
    const [tone] = STATUS[r.status];
    const icon = r.status === 'running' ? spin(12) : `<span class="ag-dot ${tone}"></span>`;
    const meta = [...kindText(r), modeText(r)].join('<span class="sep"> · </span>');
    const st = `<span class="st ${tone}">${stLabel(r)}${r.status !== 'running' ? ' · ' + r.started : ''}</span>`;
    if (compact) {
      return `<div class="lrow ${r.status} ${r.depth === 2 ? 'd2' : ''}"><div class="top">${icon}<span class="name">${r.name}</span>${st}</div><div class="meta"><span>${meta}</span>${stats(r)}</div>${actline(r)}</div>`;
    }
    return `<div class="lrow ${r.status} ${r.depth === 2 ? 'd2' : ''}"><div class="top">${icon}<span class="name">${r.name}</span>${st}</div><div class="meta">${meta}</div>${actline(r)}<div class="meta">${stats(r)}</div></div>`;
  };
  return header() + `<div class="list">${SPAWN.map(row).join('')}</div>`;
}

const BODY = { a: variantA, b: variantB, c: variantC, l1: () => variantL(false), l2: () => variantL(true) }[V]();
document.getElementById('app').innerHTML = sidebar() + mainPane() + panel(BODY);
