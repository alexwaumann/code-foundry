// Plugin surfaces sketch: the host's generic renderer for the declarative view model,
// one function per primitive, inside the app frame of docs/sketches/mcp-panel.
// ?plugin=jenkins|auth|list  ?state=<name>  ?theme=dark|light  ?w=<panel px>  ?outline (label every node)  ?tall (panel grows to its content)
const q = new URLSearchParams(location.search);
const PLUGIN = q.get('plugin') || 'jenkins';
const THEME = q.get('theme') || 'dark';
const W = Number(q.get('w') || 400);
document.documentElement.classList.toggle('dark', THEME !== 'light');
document.documentElement.classList.toggle('outline', q.has('outline'));
document.documentElement.classList.toggle('tall', q.has('tall'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;

// ---------------------------------------------------------------- shared vocabulary
// One status enum for pills, chips and list leads. Colour stays the host's: emerald for
// ok (the MCP precedent), amber attention, red error, everything else neutral.
const LEAD = {
  ok: '<span class="dot ok"></span>',
  error: '<span class="dot bad"></span>',
  attention: '<span class="dot auth"></span>',
  running: ic('loader-circle', 'spin p-lead'),
  pending: '<span class="dot off"></span>',
  skipped: ic('circle-slash', 'p-lead p-skip'),
  neutral: '<span class="dot wait"></span>',
};
const PILL = { ok: 'ok', error: 'bad', attention: 'auth', running: 'wait', pending: 'wait', skipped: 'off', neutral: 'wait' };

// Every rendered node carries its primitive name (and action id) in the DOM, so the
// sketch shows it is built from the primitives and nothing else (?outline draws them).
const attrs = (n) => `data-node="${n.type}"${n.key ? ` data-key="${esc(n.key)}"` : ''}${n.action ? ` data-action="${esc(n.action)}"` : ''}`;
const el = (n, tag, cls, inner) => `<${tag} class="${cls}" ${attrs(n)}>${inner}</${tag}>`;
const node = (n) => (R[n.type] ? R[n.type](n) : `<div class="p-unknown">unknown node ${esc(n.type)}</div>`);
const nodes = (list = []) => list.map(node).join('');
// Inline content: a plain string or an array of inline nodes (text, time, link, pill).
const inline = (v) => (v == null ? '' : typeof v === 'string' ? esc(v) : Array.isArray(v) ? v.map(node).join('') : node(v));

// ---------------------------------------------------------------- primitives
// Label + control + hint or validation error: the shell every input-like primitive shares.
const field = (n, control) => `<label class="p-field" ${attrs(n)}>${n.label ? `<span class="p-fl">${esc(n.label)}</span>` : ''}${control}${n.error ? `<span class="p-fe">${esc(n.error)}</span>` : n.hint ? `<span class="p-fh">${esc(n.hint)}</span>` : ''}</label>`;

const R = {
  // Pinned surface header, the shape of McpSurface's: icon, title, pill; a sub line of inline nodes.
  header(h) {
    const sub = (h.sub || []).map((s, i) => (s.type === 'link' ? `<span class="p-sp"></span>${node(s)}` : `${i ? '<span class="p-sep">·</span>' : ''}${node(s)}`)).join('');
    return `<header class="p-hdr" data-node="header"><h2>${ic(h.icon)}<span class="p-title">${esc(h.title)}</span>${h.pill ? node({ type: 'pill', ...h.pill }) : ''}</h2>${sub ? `<div class="p-sub">${sub}</div>` : ''}</header>`;
  },
  text(n) {
    return el(n, n.inline ? 'span' : 'p', `p-text ${n.tone ? `t-${n.tone}` : ''} ${n.mono ? 'mono' : ''}`, esc(n.text));
  },
  markdown(n) {
    const md = esc(n.source)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
      .split(/\n\n/).map((p) => `<p>${p}</p>`).join('');
    return el(n, 'div', 'p-md md', md);
  },
  pill(n) {
    return el(n, 'span', `pill ${PILL[n.status] || 'wait'} p-pill`, `${n.status === 'running' ? ic('loader-circle', 'spin') : ''}${esc(n.label)}`);
  },
  // Host-formatted and host-ticked timestamp: elapsed | relative | countdown | duration.
  time(n) {
    return `<time class="p-time num" data-node="time" datetime="${n.at}" data-format="${n.format}">${esc(n.display)}</time>`;
  },
  link(n) {
    return `<a class="p-link" ${attrs(n)} href="${esc(n.href)}">${esc(n.label)}${n.icon ? ic(n.icon) : ''}</a>`;
  },
  spinner(n) {
    return el(n, 'div', 'p-spinner', `${ic('loader-circle', 'spin')}<span>${esc(n.label)}</span>${n.meta ? `<span class="p-sep">·</span>${inline(n.meta)}` : ''}`);
  },
  fields(n) {
    const rows = n.items.map((f) => {
      const val = typeof f.value === 'object' ? inline(f.value) : esc(f.value);
      const copy = f.copy ? `<span class="ib p-ib" title="Copy" data-action="${esc(f.action || 'copy')}">${ic('copy')}</span>` : '';
      return `<dt class="${f.keyMono ? 'mono' : ''}">${esc(f.key)}</dt><dd><span class="${f.mono ? 'mono' : ''} ${f.secret ? 'p-secretval' : ''}">${val}</span>${copy}</dd>`;
    }).join('');
    return el(n, 'dl', 'p-fields', rows);
  },
  // Stage chips: text-only (status dot + name + duration), wraps.
  chips(n) {
    const chips = n.items.map((c) => `<span class="p-chip s-${c.status}" data-key="${esc(c.key)}">${LEAD[c.status] || ''}<span class="p-cl">${esc(c.label)}</span>${c.meta ? `<span class="p-cm num">${esc(c.meta)}</span>` : ''}</span>`).join('');
    return el(n, 'div', 'p-chips', chips);
  },
  // Rows: status lead (or icon), title, meta; trailing buttons always visible.
  list(n) {
    const rows = n.items.map((r) => `<li class="p-row s-${r.status || 'none'} ${r.action ? 'click' : ''}" data-key="${esc(r.key)}"${r.action ? ` data-action="${esc(r.action)}"` : ''}>
      ${r.icon ? ic(r.icon, 'p-lead p-ricon') : LEAD[r.status] || ''}<span class="p-rt">${esc(r.title)}</span>${r.meta ? `<span class="p-rm">${esc(r.meta)}</span>` : ''}${r.trailing ? `<span class="p-rtr">${nodes(r.trailing)}</span>` : ''}</li>`).join('');
    return el(n, 'ul', 'p-list', rows);
  },
  log(n) {
    const lines = n.lines.map((l) => `<div class="${l.tone ? `t-${l.tone}` : ''}">${esc(l.text)}</div>`).join('');
    const head = `<div class="p-loghead"><span class="p-logt">${esc(n.title)}</span>${n.meta ? `<span class="p-logm">${n.follow ? '<span class="p-live"></span>' : ''}${esc(n.meta)}</span>` : ''}<span class="p-sp"></span>${n.copy ? `<span class="ib p-ib" title="Copy log" data-action="${esc(n.action)}">${ic('copy')}</span>` : ''}</div>`;
    return el(n, 'div', 'p-log', `${head}<div class="p-logbody">${lines}</div>`);
  },
  button(n) {
    const icon = n.loading ? ic('loader-circle', 'spin') : n.icon ? ic(n.icon) : '';
    return `<button class="p-btn v-${n.variant || 'default'}" ${attrs(n)}${n.loading || n.disabled ? ' disabled' : ''}${n.confirm ? ` data-confirm="${esc(n.confirm)}"` : ''}>${icon}${esc(n.loading ? `${n.label}…` : n.label)}</button>`;
  },
  actions(n) {
    return el(n, 'div', 'p-actions', nodes(n.items) + (n.end ? `<span class="p-sp"></span>${nodes(n.end)}` : ''));
  },
  // Titled group; collapsible sends its action on toggle. stale: the content is last-known, not live.
  section(n) {
    const chev = n.collapsible ? ic(n.open === false ? 'chevron-right' : 'chevron-down', 'p-chev') : '';
    const head = `<div class="p-sechead ${n.collapsible ? 'click' : ''}"${n.collapsible ? ` data-action="${esc(n.action || 'toggle')}"` : ''}>${chev}<span>${esc(n.title)}</span>${n.count != null ? `<span class="p-cnt num">${n.count}</span>` : ''}</div>`;
    return el(n, 'section', `p-section ${n.stale ? 'stale' : ''}`, head + (n.open === false ? '' : `<div class="p-secbody">${nodes(n.children)}</div>`));
  },
  notice(n) {
    const acts = n.actions ? `<div class="p-actions">${nodes(n.actions)}</div>` : '';
    return el(n, 'div', `p-notice tone-${n.tone}`, `<div class="p-nt">${ic(n.icon || (n.tone === 'info' ? 'info' : 'circle-alert'))}<span>${esc(n.title)}</span></div><div class="p-nb">${inline(n.text)}</div>${acts}`);
  },
  empty(n) {
    return el(n, 'div', 'p-empty', `${ic(n.icon)}<div class="p-et">${esc(n.title)}</div>${n.text ? `<div class="p-ex">${esc(n.text)}</div>` : ''}${n.actions ? `<div class="p-actions">${nodes(n.actions)}</div>` : ''}`);
  },
  divider(n) {
    return el(n, 'hr', 'p-divider', '');
  },
  progress(n) {
    const det = typeof n.value === 'number';
    return el(n, 'div', 'p-progress', `<div class="p-pl"><span>${esc(n.label || '')}</span>${n.meta ? `<span class="p-pm num">${esc(n.meta)}</span>` : ''}</div><div class="p-bar ${det ? '' : 'ind'}"><i style="${det ? `width:${n.value * 100}%` : ''}"></i></div>`);
  },
  // A short value to carry elsewhere by hand: large mono, one copy button.
  code(n) {
    return el(n, 'div', 'p-code', `<span class="mono">${esc(n.value)}</span>${n.copy ? `<button class="p-btn v-muted" data-action="${esc(n.action)}">${ic('copy')}Copy</button>` : ''}`);
  },
  input(n) {
    return field(n, `<span class="p-in ${n.error ? 'bad' : ''}">${n.value ? esc(n.value) : `<span class="p-ph">${esc(n.placeholder || '')}</span>`}</span>`);
  },
  secret(n) {
    const v = n.value ? `<span class="mono p-dots">${'•'.repeat(Math.min(n.value.length, 18))}</span>` : `<span class="p-ph">${esc(n.placeholder || '')}</span>`;
    return field(n, `<span class="p-in ${n.error ? 'bad' : ''}">${v}<span class="p-sp"></span><span class="p-inbtn" title="Show">${ic('eye')}</span></span>`);
  },
  select(n) {
    return field(n, `<span class="p-in p-select">${esc(n.value)}<span class="p-sp"></span>${ic('chevron-down')}</span>`);
  },
  checkbox(n) {
    return `<label class="p-check" ${attrs(n)}><span class="p-box ${n.checked ? 'on' : ''}">${n.checked ? ic('check') : ''}</span><span>${esc(n.label)}</span></label>`;
  },
  // Groups inputs; submit sends {action, payload: values by key}. Validation comes back as `error` on a field.
  form(n) {
    const acts = `<div class="p-actions">${node(n.submit)}${n.cancel ? node(n.cancel) : ''}</div>`;
    return el(n, 'form', 'p-form', nodes(n.children) + acts);
  },
};

// ---------------------------------------------------------------- app frame (from docs/sketches/mcp-panel)
function sidebar(attention) {
  const sel = attention
    ? `<div class="trow sel"><span class="n"><span>Fix stale PR badge</span></span><span class="s"><span class="t-amber">${esc(attention)}</span></span></div>`
    : `<div class="trow sel"><span class="n"><span>${PLUGIN === 'auth' ? 'Churn by plan' : 'Fix stale PR badge'}</span></span><span class="s">${PLUGIN === 'auth' ? 'data-pipelines · <span class="mono">cf/churn-by-plan</span>' : 'code-foundry · <span class="mono">cf/pr-badge-stale</span>'}</span></div>`;
  return `<aside class="sidebar">
    <div class="band"><span class="lights"><i></i><i></i><i></i></span><b>Code Foundry</b></div>
    <div class="toolbar"><span class="tb">${ic('layout-dashboard')}</span><span class="tb ${attention ? 'bell' : ''}">${ic('bell')}${attention ? '<span class="badge">1</span>' : ''}</span><span style="flex:1"></span><span class="tb">${ic('folder-plus')}</span><span class="tb">${ic('square-pen')}</span></div>
    <div class="nav">${ic('git-pull-request')}Pull Requests</div>
    <div class="nav" style="margin-bottom:6px">${ic('folder-git-2')}Projects</div>
    ${sel}
    <div class="trow"><span class="n"><span>Rendered threads daemon</span></span><span class="s"><span class="t-emerald">Finished 3 min ago</span></span></div>
    <div class="trow"><span class="n"><span>Release notes draft</span></span><span class="s">code-foundry · <span class="mono">main</span></span></div>
    <div class="sect"><span>WORKING&nbsp; 1</span>${ic('chevron-down')}</div>
    <div class="trow"><span class="n"><span>Usage page polish</span></span><span class="s"><span class="t-sky">Working</span> · code-foundry · <span class="mono">cf/usage-polish</span></span></div>
    <div class="statusbar"><span class="d"></span>daemon<span>pid 52169</span><span style="flex:1"></span>${ic('command')}${ic('chart-column')}${ic('circle-question-mark')}${ic('settings')}</div>
  </aside>`;
}

function mainPane(t, attention) {
  const title = PLUGIN === 'auth' ? 'Churn by plan' : 'Fix stale PR badge';
  return `<section class="pane main">
    <header class="phdr">${attention ? '<span class="attn"></span>' : '<span class="dot ok"></span>'}<span class="title">${title}</span><span class="m">idle</span><span class="m">opus · high</span><span class="m" style="overflow:hidden;text-overflow:ellipsis">~/.code-foundry/worktrees/…</span>
      <span class="acts"><span class="tb">${ic('pencil')}</span><span class="tb">${ic('git-fork')}</span><span class="tb">${ic('power')}</span><span class="tb">${ic('panel-bottom')}</span><span class="tb on">${ic('panel-right')}</span></span></header>
    <div class="thread">
      <div class="bubble">${esc(t.ask)}</div>
      ${t.tools.map(([i, l]) => `<div class="row"><span class="ico">${ic(i)}</span><span class="lbl">${l}</span><span class="meta"><span class="chip ok">ok</span></span></div>`).join('')}
      <p>${t.answer}</p>
      <div class="footer">${ic('chevron-down')} Worked for 41s · 3 steps · $0.04 · Opus 4.8</div>
    </div>
    <div class="dock"><div class="ccard"><div class="ph">Send a follow-up…</div><div class="bar"><span class="pick">${ic('brain')}Opus ${ic('chevron-down')}</span><span class="pick">${ic('gauge')}High ${ic('chevron-down')}</span><span class="pick">${ic('shield-check')}Accept edits ${ic('chevron-down')}</span><span class="send">${ic('arrow-up')}</span></div></div></div>
  </section>`;
}

const tab = (t, on) => `<span class="tab ${on ? 'on' : ''}">${ic(t.icon)}${esc(t.title)}${on ? `<span class="x">${ic('x')}</span>` : ''}</span>`;
function panel(tabs, body, picking = false) {
  return `<section class="panel p-panel" style="width:${W}px">
    <div class="strip">${tabs}<span class="tb ${picking ? 'on' : ''}">${ic('plus')}</span><span class="sp"></span><span class="tb">${ic('maximize-2')}</span><span class="tb">${ic('panel-right')}</span></div>
    <div class="body p-body">${body}</div>
  </section>`;
}

// ---------------------------------------------------------------- the surface list (+ picking), with plugin surfaces after the built-ins
function surfaceList() {
  const builtins = [
    ['file-text', 'Files', 'f'], ['file-diff', 'Diff', 'd'], ['git-pull-request', 'Pull request', 'p'], ['git-pull-request-arrow', 'Linked PRs', 'l'],
    ['chart-column', 'Usage', 'u'], ['plug', 'MCP', 'm'], ['layers', 'Workspace', 'w'], ['git-branch', 'Worktree', 't', true],
  ];
  const plug = [PLUGINS.jenkins.surface, PLUGINS.auth.surface];
  const row = ([icon, title, key, off]) => `<li class="p-srow ${off ? 'off' : ''}">${ic(icon)}<span class="p-st">${title}</span><kbd>${key.toUpperCase()}</kbd></li>`;
  const prow = (s) => `<li class="p-srow" data-plugin="${s.plugin}">${ic(s.icon)}<span class="p-st">${esc(s.title)}</span><span class="p-from" title="From the ${esc(s.plugin)} plugin">${ic('puzzle')}</span></li>`;
  return `<div class="p-surfaces"><div class="w"><h2>Open a surface</h2><ul>${builtins.map(row).join('')}<li class="p-sdiv"></li>${plug.map(prow).join('')}</ul></div></div>`;
}

// ---------------------------------------------------------------- page
let html;
if (PLUGIN === 'list') {
  const j = PLUGINS.jenkins;
  html = sidebar() + mainPane(j.thread) + panel(tab({ title: 'Usage', icon: 'chart-column' }) + tab(j.surface, false), surfaceList(), true);
} else {
  const p = PLUGINS[PLUGIN];
  const name = q.get('state') || Object.keys(p.states)[0];
  const st = p.states[name];
  const view = `<div class="p-view" data-surface="${p.surface.id}">${R.header(st.header)}<div class="p-content">${nodes(st.body)}</div></div>`;
  html = sidebar(st.attention) + mainPane(p.thread, st.attention) + panel(p.tabsBefore.map((t) => tab(t)).join('') + tab(p.surface, true), view);
}
document.getElementById('app').innerHTML = html;
// A log block shows its tail (follow: keeps showing it as lines arrive).
for (const b of document.querySelectorAll('.p-logbody')) b.scrollTop = b.scrollHeight;
