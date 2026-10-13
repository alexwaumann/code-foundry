// MCP panel sketch. ?variant=a|b|c  ?theme=dark|light  ?hover=<server name>
const q = new URLSearchParams(location.search);
const V = (q.get('variant') || 'a').toLowerCase();
const THEME = q.get('theme') || 'dark';
const HOVER = q.get('hover') || 'github';
document.documentElement.classList.toggle('dark', THEME !== 'light');
document.body.dataset.variant = V;

const ic = (n, cls = '', size = 0) => `<svg class="ic ${cls}" viewBox="0 0 24 24"${size ? ` style="width:${size}px;height:${size}px"` : ''}>${ICONS[n] || ''}</svg>`;

// ---------------------------------------------------------------- data (mcp_status, plus system/init's source)
const SERVERS = [
  { name: 't3-code', status: 'connected', scope: 'project', transport: 'http', version: '0.4.2', tools: [
    ['link_pull_request', 'Link a pull request to this thread', ['rw']],
    ['list_thread_pull_requests', 'List the pull requests linked to this thread', ['ro']],
    ['preview_open', 'Open a URL in the preview browser', ['ow']],
    ['preview_click', 'Click an element in the preview', ['rw']],
    ['device_screenshot', 'Screenshot a connected device', ['ro']],
  ], toolCount: 24 },
  { name: 'github', status: 'connected', scope: 'user', transport: 'stdio', version: '1.12.0', tools: [
    ['get_pull_request', 'Get details of a pull request', ['ro']],
    ['create_pull_request', 'Create a pull request', ['ow']],
    ['merge_pull_request', 'Merge a pull request', ['d', 'ow']],
    ['search_code', 'Search code across repositories', ['ro', 'ow']],
    ['push_files', 'Push files to a branch in one commit', ['d']],
  ], toolCount: 31 },
  { name: 'linear', status: 'needs-auth', scope: 'user', transport: 'http', version: '', tools: [], toolCount: 0,
    note: 'Needs login · run /mcp in a terminal thread, then reconnect' },
  { name: 'playwright', status: 'failed', scope: 'project', transport: 'stdio', version: '', tools: [], toolCount: 0,
    error: 'spawn npx ENOENT' },
  { name: 'filesystem', status: 'pending', scope: 'local', transport: 'stdio', version: '', tools: [], toolCount: 0 },
  { name: 'sentry', status: 'disabled', scope: 'user', transport: 'http', version: '2.1.0', tools: [], toolCount: 12 },
];
const connected = SERVERS.filter((s) => s.status === 'connected').length;

const DOT = { connected: 'ok', failed: 'bad', 'needs-auth': 'auth', pending: 'wait', disabled: 'off' };
const LABEL = { connected: 'Connected', failed: 'Failed', 'needs-auth': 'Needs login', pending: 'Connecting…', disabled: 'Disabled' };
const ANN = { ro: ['eye', 'read-only', ''], d: ['triangle-alert', 'destructive', 'd'], ow: ['globe', 'reaches the open web', ''], rw: ['pencil', 'writes', ''] };

const toolRows = (s, open) => {
  if (!open || s.tools.length === 0) return '';
  const rows = s.tools.map(([n, d, a]) => `<div class="tool"><span class="tn">${n}</span><span class="td">${d}</span><span class="ann">${a.map((k) => `<span class="${ANN[k][2]}" title="${ANN[k][1]}">${ic(ANN[k][0])}</span>`).join('')}</span></div>`).join('');
  const more = s.toolCount > s.tools.length ? `<div class="more">… ${s.toolCount - s.tools.length} more</div>` : '';
  return `<div class="tools">${rows}${more}</div>`;
};
const countText = (s) => (s.status === 'connected' ? `${s.toolCount} tools` : s.status === 'disabled' && s.toolCount ? `${s.toolCount} tools` : '');
const actions = (s, cls = 'ib') => {
  const a = [];
  if (s.status === 'disabled') a.push(`<span class="${cls}" title="Enable">${ic('power')}</span>`);
  else {
    a.push(`<span class="${cls}" title="Reconnect">${ic('refresh-cw')}</span>`);
    a.push(`<span class="${cls}" title="Disable">${ic('circle-minus')}</span>`);
  }
  return a.join('');
};

// ---------------------------------------------------------------- chrome
function sidebar() {
  return `<aside class="sidebar">
    <div class="band"><span class="lights"><i></i><i></i><i></i></span><b>Code Foundry</b></div>
    <div class="toolbar"><span class="tb">${ic('layout-dashboard')}</span><span class="tb">${ic('bell')}</span><span style="flex:1"></span><span class="tb">${ic('folder-plus')}</span><span class="tb">${ic('square-pen')}</span></div>
    <div class="nav">${ic('git-pull-request')}Pull Requests</div>
    <div class="nav" style="margin-bottom:6px">${ic('folder-git-2')}Projects</div>
    <div class="trow sel"><span class="n"><span>Fix stale PR badge</span></span><span class="s">code-foundry · <span class="mono">cf/pr-badge-stale</span></span></div>
    <div class="trow"><span class="n"><span>Rendered threads daemon</span></span><span class="s"><span class="t-emerald">Finished 3 min ago</span></span></div>
    <div class="trow"><span class="n"><span>Release notes draft</span></span><span class="s">code-foundry · <span class="mono">main</span></span></div>
    <div class="sect"><span>WORKING&nbsp; 1</span>${ic('chevron-down', '', 14)}</div>
    <div class="trow"><span class="n"><span>Usage page polish</span></span><span class="s"><span class="t-sky">Working</span> · code-foundry · <span class="mono">cf/usage-polish</span></span></div>
    <div class="statusbar"><span class="d"></span>daemon<span>pid 52169</span><span style="flex:1"></span>${ic('command')}${ic('chart-column')}${ic('circle-question-mark')}${ic('settings')}</div>
  </aside>`;
}

function mainPane() {
  return `<section class="pane main">
    <header class="phdr"><span class="dot ok"></span><span class="title">Fix stale PR badge</span><span class="m">idle</span><span class="m">opus · high</span><span class="m">rendered</span><span class="m" style="overflow:hidden;text-overflow:ellipsis">~/.code-foundry/worktrees/…/pr-badge-stale</span>
      <span class="acts"><span class="tb">${ic('pencil')}</span><span class="tb">${ic('git-fork')}</span><span class="tb">${ic('power')}</span><span class="tb">${ic('panel-bottom')}</span><span class="tb on">${ic('panel-right')}</span></span></header>
    <div class="thread">
      <div class="bubble">Link PR #63 to this thread and check whether its CI is green.</div>
      <div class="row"><span class="ico">${ic('plug')}</span><span class="lbl">Called <b>t3-code · link_pull_request</b></span><span class="meta"><span class="chip ok">ok</span></span></div>
      <div class="row"><span class="ico">${ic('plug')}</span><span class="lbl">Called <b>github · get_pull_request</b></span><span class="meta"><span class="chip ok">ok</span></span></div>
      <p>Linked <code>#63</code>. CI is green on <code>a3f9c21</code>: 3 of 3 checks passed, one approval, no requested changes.</p>
      <div class="footer">${ic('chevron-down', '', 14)} Worked for 6.2s · 2 steps · &lt;$0.01 · Opus 4.8</div>
    </div>
    <div class="dock"><div class="ccard"><div class="ph">Send a follow-up…</div><div class="bar"><span class="pick">${ic('brain')}Opus ${ic('chevron-down', '', 12)}</span><span class="pick">${ic('gauge')}High ${ic('chevron-down', '', 12)}</span><span class="pick">${ic('shield-check')}Accept edits ${ic('chevron-down', '', 12)}</span><span class="send">${ic('arrow-up')}</span></div></div></div>
  </section>`;
}

function panel(body) {
  return `<section class="panel v${V}">
    <div class="strip"><span class="tab">${ic('chart-column')}Usage</span><span class="tab on">${ic('plug')}MCP<span class="x">${ic('x')}</span></span><span class="tb">${ic('plus')}</span><span class="sp"></span><span class="tb">${ic('maximize-2')}</span><span class="tb">${ic('panel-right')}</span></div>
    <div class="body">${body}</div>
  </section>`;
}

const header = (sub) => `<header class="shdr"><h2>${ic('plug')}<span>MCP servers</span><span class="cnt">${connected} of ${SERVERS.length} connected</span></h2><span class="shsub">${sub}</span></header>`;
const SUB = `${ic('clock')}<span>Checked 12s ago, at the start of the last turn</span><span style="margin-left:auto" class="ib" title="Refresh">${ic('refresh-cw')}</span>`;

// ---------------------------------------------------------------- variant A: flat list, hover actions, expandable tools
function variantA() {
  const rows = SERVERS.map((s) => {
    const open = s.name === 'github';
    const hover = s.name === HOVER;
    const line2 = s.error ? `<div class="err">${LABEL[s.status]} · <span class="mono">${s.error}</span></div>` : s.note ? `<div class="note">${s.note}</div>` : s.status === 'pending' ? `<div class="muted12">Connecting…</div>` : s.status === 'disabled' ? `<div class="muted12">Disabled · not passed to Claude</div>` : '';
    return `<div class="${open ? 'open' : ''}">
      <div class="srow ${hover ? 'hover' : ''}">${s.status === 'pending' ? ic('loader-circle', 'spin', 12) : `<span class="dot ${DOT[s.status]}"></span>`}<span class="name">${s.name}</span><span class="scope">${s.scope}</span>${s.version ? `<span class="muted12 mono">v${s.version}</span>` : ''}<span class="cnt">${countText(s)}</span><span class="acts">${actions(s)}</span>${s.tools.length ? ic('chevron-right', 'chev') : '<span style="width:14px"></span>'}</div>
      ${line2 ? `<div class="sub">${line2}</div>` : ''}${toolRows(s, open)}</div>`;
  }).join('');
  return header(SUB) + `<div class="list">${rows}</div>`;
}

// ---------------------------------------------------------------- variant B: cards with always-visible actions
function variantB() {
  const cards = SERVERS.map((s) => {
    const open = s.name === 'github';
    const cls = s.status === 'failed' ? 'bad' : s.status === 'needs-auth' ? 'needs' : s.status === 'disabled' ? 'off' : '';
    const meta = [s.scope, s.transport, s.status === 'connected' ? `${s.toolCount} tools` : s.status === 'disabled' && s.toolCount ? `${s.toolCount} tools when enabled` : ''].filter(Boolean).join('<span class="sep"> · </span>');
    const detail = s.error ? `<div class="err"><span class="mono">${s.error}</span></div>` : s.note ? `<div class="note">${s.note}</div>` : '';
    // Decision (Alex, 2026-10-12): Reconnect is the only action; no Disable/Enable. A
    // disabled server (Claude's config) just shows as disabled; a pending one has nothing.
    const acts = s.status === 'disabled' || s.status === 'pending' ? ''
      : `<span class="btn ${s.status === 'needs-auth' || s.status === 'failed' ? 'warn' : 'quiet'}">${ic('refresh-cw')}Reconnect</span>`;
    const tools = s.tools.length ? `<span class="btn quiet tools-btn">${ic(open ? 'chevron-down' : 'chevron-right')}${s.toolCount} tools</span>` : '';
    return `<div class="card ${cls}">
      <div class="top">${s.status === 'pending' ? ic('loader-circle', 'spin', 12) : `<span class="dot ${DOT[s.status]}"></span>`}<span class="name">${s.name}</span>${s.version ? `<span class="ver">v${s.version}</span>` : ''}<span class="pill ${DOT[s.status]}">${LABEL[s.status]}</span></div>
      <div class="meta">${meta}</div>
      ${detail}
      <div class="acts">${acts}${tools}</div>
      ${toolRows(s, open)}
    </div>`;
  }).join('');
  return header(SUB) + `<div class="cards">${cards}</div>`;
}

// ---------------------------------------------------------------- variant C: grouped, attention first, inline fix button
function variantC() {
  const attn = SERVERS.filter((s) => s.status === 'failed' || s.status === 'needs-auth');
  const ok = SERVERS.filter((s) => s.status === 'connected' || s.status === 'pending');
  const off = SERVERS.filter((s) => s.status === 'disabled');
  const row = (s) => {
    const open = s.name === 'github';
    const hover = s.name === HOVER;
    const line2 = s.error ? `<span class="line2 err">${s.error}</span>` : s.note ? `<span class="line2 note">${s.note}</span>` : `<span class="line2">${[s.scope, s.transport, s.version ? `v${s.version}` : ''].filter(Boolean).join(' · ')}</span>`;
    const right = s.status === 'failed' ? `<span class="btn warn">${ic('refresh-cw')}Retry</span>`
      : s.status === 'needs-auth' ? `<span class="btn warn">${ic('refresh-cw')}Reconnect</span>`
      : s.status === 'disabled' ? `<span class="btn quiet">${ic('power')}Enable</span>`
      : `<span class="cnt">${s.status === 'pending' ? 'connecting…' : countText(s)}</span>${actions(s)}`;
    return `<div class="${open ? 'open' : ''}"><div class="srow ${hover ? 'hover' : ''} ${s.status === 'disabled' ? 'off' : ''}">${s.status === 'pending' ? ic('loader-circle', 'spin', 12) : `<span class="dot ${DOT[s.status]}"></span>`}<span class="txt"><span class="name">${s.name}${s.scope === 'project' ? '<span class="scope">project</span>' : ''}</span>${line2}</span><span class="right">${right}${s.tools.length ? ic('chevron-right', 'chev') : ''}</span></div>${toolRows(s, open)}</div>`;
  };
  const grp = (title, list, cls = '') => list.length ? `<div class="grp"><div class="gh ${cls}">${title} <span class="n">${list.length}</span></div>${list.map(row).join('')}</div>` : '';
  return header(SUB) + grp('Needs you', attn, 'needs') + grp('Connected', ok) + grp('Disabled', off);
}

const BODY = { a: variantA, b: variantB, c: variantC }[V]();
document.getElementById('app').innerHTML = sidebar() + mainPane() + panel(BODY);
