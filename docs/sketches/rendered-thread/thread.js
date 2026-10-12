// Rendered thread sketch. ?variant=a|b|c  ?theme=dark|light  ?state=permission|question|streaming
const q = new URLSearchParams(location.search);
const V = (q.get('variant') || 'a').toLowerCase();
const THEME = q.get('theme') || 'dark';
const STATE = q.get('state') || 'permission';
document.documentElement.classList.toggle('dark', THEME !== 'light');
document.body.dataset.variant = V;
document.body.dataset.state = STATE;

const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;
const claude = (cls = '') => `<svg class="ic claude ${cls}" viewBox="0 0 24 24" style="stroke-width:2.6;color:var(--claude)"><path d="M12.0 9.4L12.0 2.0"/><path d="M13.3 9.7L15.8 5.5"/><path d="M14.3 10.7L19.8 7.5"/><path d="M14.6 12.0L20.0 12.0"/><path d="M14.3 13.3L20.7 17.0"/><path d="M13.3 14.3L15.5 18.1"/><path d="M12.0 14.6L12.0 21.5"/><path d="M10.7 14.3L8.0 18.9"/><path d="M9.7 13.3L3.3 17.0"/><path d="M9.4 12.0L4.5 12.0"/><path d="M9.7 10.7L4.2 7.5"/><path d="M10.7 9.7L8.0 5.1"/></svg>`;

// ---------------------------------------------------------------- sidebar + header chrome
const status = STATE === 'streaming'
  ? { side: '<span class="t-sky">Working</span> · code-foundry · <span class="mono">cf/pr-badge-stale</span>', badge: 'busy', icon: ic('loader-circle', 'spin t-sky') }
  : { side: `<span class="t-amber">Needs input · ${STATE === 'question' ? 'Claude asked a question' : 'Bash'}</span>`, badge: 'needs attention', icon: '<span class="attn"></span>' };

function sidebar() {
  return `<aside class="sidebar">
    <div class="band"><span class="lights"><i></i><i></i><i></i></span><b>Code Foundry</b></div>
    <div class="toolbar"><span class="tb">${ic('layout-dashboard')}</span><span class="tb bell">${ic('bell')}<span class="badge">1</span></span><span style="flex:1"></span><span class="tb">${ic('folder-plus')}</span><span class="tb">${ic('square-pen')}</span></div>
    <div class="nav">${ic('git-pull-request')}Pull Requests</div>
    <div class="nav" style="margin-bottom:6px">${ic('folder-git-2')}Projects</div>
    <div class="trow"><span class="n"><span>Pinned: fleet checklist</span><span style="margin-left:auto" class="muted">${ic('pin', '').replace('class="ic ', 'style="width:12px;height:12px" class="ic ')}</span></span><span class="s">code-foundry · <span class="mono">main</span></span></div>
    <div class="trow sel"><span class="n"><span>Fix stale PR badge</span></span><span class="s">${status.side}</span></div>
    <div class="trow"><span class="n"><span>Rendered threads daemon</span></span><span class="s"><span class="t-emerald">Finished 3 min ago</span></span></div>
    <div class="trow"><span class="n"><span>Release notes draft</span></span><span class="s">code-foundry · <span class="mono">main</span></span></div>
    <div class="sect"><span>WORKING&nbsp; 2</span>${ic('chevron-down').replace('class="ic ', 'style="width:14px;height:14px" class="ic ')}</div>
    <div class="trow"><span class="n"><span>Usage page polish</span></span><span class="s"><span class="t-sky">Working</span> · code-foundry · <span class="mono">cf/usage-polish</span></span></div>
    <div class="trow"><span class="n"><span>Bottom panel tabs</span></span><span class="s"><span class="t-sky">Working</span> · code-foundry · <span class="mono">cf/bottom-tabs</span></span></div>
    <div class="statusbar"><span class="d"></span>daemon<span>pid 52169</span><span style="flex:1"></span>${ic('command')}${ic('chart-column')}${ic('circle-question-mark')}${ic('settings')}</div>
  </aside>`;
}

function header() {
  return `<header class="phdr">
    ${status.icon}<span class="title">Fix stale PR badge</span><span class="m">${status.badge}</span><span class="m">opus · high</span><span class="m" style="overflow:hidden;text-overflow:ellipsis">~/.code-foundry/worktrees/code-foundry/pr-badge-stale</span>
    <span class="acts"><span class="tb">${ic('pencil')}</span><span class="tb">${ic('git-fork')}</span><span class="tb">${ic('power')}</span><span class="tb" style="width:auto;padding:0 6px">${ic('git-pull-request')}<span class="cnt">1</span></span><span class="tb">${ic('panel-bottom')}</span><span class="tb">${ic('panel-right')}</span></span>
  </header>`;
}

// ---------------------------------------------------------------- content pieces
const THUMB = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#1f3b2c"/><rect x="3" y="4" width="16" height="3" rx="1" fill="#9be3b8"/><rect x="3" y="10" width="22" height="2" rx="1" fill="#4fae7b"/><rect x="3" y="15" width="12" height="3" rx="1" fill="#9be3b8"/><rect x="3" y="21" width="19" height="2" rx="1" fill="#4fae7b"/><circle cx="26" cy="6" r="3" fill="#36d27f"/></svg>`);
const tagImg = `<span class="tag image"><img src="${THUMB}" alt="">pr-badge-stale.png<span class="sz">184 KB</span></span>`;
const tagFile = `<span class="tag file">poller.go</span>`;
const tagSkill = `<span class="tag skill">/tdd</span>`;

const USER1 = `The PR badge in the sidebar stays green after a force-push, see ${tagImg} Look at ${tagFile} and fix it with ${tagSkill}. Keep the fingerprint check-count based.`;
const USER2 = `Looks good. Run the full suite, then push the branch.`;

const row = (icon, label, meta = '', { open = false, chev = true, cls = '', iconHtml = '' } = {}) =>
  `<div class="row click ${open ? 'open' : ''} ${cls}" data-toggle><span class="ico">${iconHtml || ic(icon)}</span><span class="lbl">${label}</span><span class="meta">${meta}</span>${chev ? ic('chevron-right', 'chev') : '<span style="width:14px"></span>'}</div>`;

const P = {
  thinking: () => row('lightbulb', 'Thought for 9s'),
  text1: () => `<p>I'll read the poller and the fingerprint first, then write a failing test.</p>`,
  groupClosed: () => row('file-text', 'Read 3 files, searched code 2 times', '<span>poller.go, poller_test.go, gh/client.go</span>'),
  groupOpen: () => `${row('search', 'Read 2 files, searched code once', '', { open: true })}
    <div class="members">
      ${row('file-text', 'Read <b>fingerprint.go</b> <span class="muted mono">internal/store/pr</span>', '84 lines')}
      ${row('search', 'Searched for <b class="mono">HeadRefOid</b> <span class="muted">in</span> <span class="mono">internal/</span>', '5 matches', { open: true })}
      <div class="detail matches">
        <div><span class="p">internal/store/pr/gh/query.graphql</span><span class="ln">:23</span>&nbsp;&nbsp;      <mark>headRefOid</mark></div>
        <div><span class="p">internal/store/pr/model.go</span><span class="ln">:31</span>&nbsp;&nbsp;	<mark>HeadRefOid</mark>     string</div>
        <div><span class="p">internal/store/pr/decode.go</span><span class="ln">:58</span>&nbsp;&nbsp;	pr.<mark>HeadRefOid</mark> = n.<mark>HeadRefOid</mark></div>
        <div><span class="p">internal/store/pr/decode_test.go</span><span class="ln">:72</span>&nbsp;&nbsp;	<mark>HeadRefOid</mark>: "9f3c2e1",</div>
        <div><span class="p">internal/store/linkedpr/sync.go</span><span class="ln">:104</span>&nbsp;&nbsp;	if old.<mark>HeadRefOid</mark> != pr.<mark>HeadRefOid</mark> {</div>
      </div>
      ${row('file-text', 'Read <b>query.graphql</b> <span class="muted mono">internal/store/pr/gh</span>', '61 lines')}
    </div>`,
  text2: () => `<p>The fingerprint is <code>CheckCount</code> + <code>ReviewState</code> only, so a force-push that keeps the same checks looks unchanged and the poller never refreshes the badge. The head SHA is already in the batched query.</p>`,
  asked: () => row('message-circle-question-mark', 'Asked <span class="q-hdr">Fix approach</span> <b>Head SHA in the fingerprint</b>', 'answered'),
  testEdit: () => row('file-plus', 'Edited <b>fingerprint_test.go</b>', '<span class="add">+18</span>'),
  bashFail: () => `${row('square-terminal', 'Ran <span class="mono" style="color:color-mix(in oklab,var(--fg) 82%,transparent)">go test ./internal/store/pr/ -run TestFingerprint</span>', '<span class="chip fail">exit 1</span><span>0.9s</span>', { open: true })}
    <div class="detail"><div class="term">
      <div class="cmd"><span class="pr">$ </span><span class="sh-c">go</span> test ./internal/store/pr/ <span class="sh-f">-run</span> TestFingerprint</div>
      <div class="out"><span class="fl">--- FAIL: TestFingerprintChangesOnForcePush (0.00s)</span>
    fingerprint_test.go:41: fingerprint unchanged after the head moved
        got:  {CheckCount:3 ReviewState:APPROVED}
        want: a different fingerprint
<span class="fl">FAIL</span>
<span class="fl">FAIL</span>	github.com/alexwaumann/code-foundry/internal/store/pr	0.412s</div>
    </div></div>`,
  edit: () => `<div data-shot="diff">${row('file-pen', 'Edited <b>fingerprint.go</b>', '<span class="add">+6</span><span class="del">−1</span>', { open: true })}
    <div class="detail"><div class="diff">
      <div class="dh"><span class="path"><span class="dir">internal/store/pr/</span>fingerprint.go</span><span class="sp"></span><span class="tb" style="width:22px;height:22px">${ic('copy').replace('class="ic ', 'style="width:12px;height:12px" class="ic ')}</span><span class="tb" style="width:22px;height:22px">${ic('external-link').replace('class="ic ', 'style="width:12px;height:12px" class="ic ')}</span></div>
      <div class="hunk">@@ -18,9 +18,14 @@ package pr</div>
      <div class="l"><span class="o">18</span><span class="n">18</span><span class="g"> </span><span><span class="c">// Fingerprint is what the poller compares between two polls of a pull request.</span></span></div>
      <div class="l"><span class="o">19</span><span class="n">19</span><span class="g"> </span><span><span class="k">type</span> <span class="t">Fingerprint</span> <span class="k">struct</span> {</span></div>
      <div class="l"><span class="o">20</span><span class="n">20</span><span class="g"> </span><span>	CheckCount  <span class="t">int</span></span></div>
      <div class="l"><span class="o">21</span><span class="n">21</span><span class="g"> </span><span>	ReviewState <span class="t">string</span></span></div>
      <div class="l la"><span class="o"></span><span class="n">22</span><span class="g">+</span><span>	HeadOid     <span class="t">string</span> <span class="c">// moves on every push, force-pushes included</span></span></div>
      <div class="l"><span class="o">22</span><span class="n">23</span><span class="g"> </span><span>}</span></div>
      <div class="l"><span class="o">23</span><span class="n">24</span><span class="g"> </span><span></span></div>
      <div class="l"><span class="o">24</span><span class="n">25</span><span class="g"> </span><span><span class="k">func</span> <span class="f">fingerprintOf</span>(pr <span class="t">PullRequest</span>) <span class="t">Fingerprint</span> {</span></div>
      <div class="l lr"><span class="o">25</span><span class="n"></span><span class="g">−</span><span>	<span class="k">return</span> <span class="t">Fingerprint</span>{CheckCount: <span class="f">len</span>(pr.Checks), ReviewState: pr.ReviewDecision}</span></div>
      <div class="l la"><span class="o"></span><span class="n">26</span><span class="g">+</span><span>	<span class="k">return</span> <span class="t">Fingerprint</span>{</span></div>
      <div class="l la"><span class="o"></span><span class="n">27</span><span class="g">+</span><span>		CheckCount:  <span class="f">len</span>(pr.Checks),</span></div>
      <div class="l la"><span class="o"></span><span class="n">28</span><span class="g">+</span><span>		ReviewState: pr.ReviewDecision,</span></div>
      <div class="l la"><span class="o"></span><span class="n">29</span><span class="g">+</span><span>		<ins>HeadOid:     pr.HeadRefOid,</ins></span></div>
      <div class="l la"><span class="o"></span><span class="n">30</span><span class="g">+</span><span>	}</span></div>
      <div class="l"><span class="o">26</span><span class="n">31</span><span class="g"> </span><span>}</span></div>
    </div></div></div>`,
  bashOk: () => row('square-terminal', 'Ran <span class="mono" style="color:color-mix(in oklab,var(--fg) 82%,transparent)">go test ./internal/store/pr/</span>', '<span class="chip ok">ok</span><span>1.3s</span>'),
  agent: () => `${row('bot', 'Agent <b>Review the fingerprint change</b> <span class="muted">code-reviewer</span>', '4 tools · 41s', { open: true })}
    <div class="children">
      ${row('file-text', 'Read <b>fingerprint.go</b>', '91 lines', { chev: true })}
      ${row('file-text', 'Read <b>poller.go</b>', '212 lines')}
      ${row('search', 'Searched for <b class="mono">fingerprintOf(</b> <span class="muted">in</span> <span class="mono">internal/</span>', '3 matches')}
      ${row('square-terminal', 'Ran <span class="mono" style="color:color-mix(in oklab,var(--fg) 82%,transparent)">go vet ./internal/store/pr/...</span>', '<span class="chip ok">ok</span>')}
      <div class="subresult">Looks right. <code>HeadRefOid</code> is already selected in <code>query.graphql:23</code>, so no query change. Nit: the test name could say <em>ForcePush</em> rather than <em>HeadMoved</em>.</div>
    </div>`,
  answer: (streaming) => streaming ? ANSWER_STREAM : ANSWER,
  footer1: () => `<div class="tfoot"><span>Worked for 4m 08s</span><span class="sep">·</span><span>$1.12</span><span class="sep">·</span><span>Opus</span><span style="flex:1"></span><span class="tb">${ic('copy')}</span></div>`,
  bashSuite: () => row('square-terminal', 'Ran <span class="mono" style="color:color-mix(in oklab,var(--fg) 82%,transparent)">go test ./...</span>', '<span class="chip ok">412 passed</span><span>38s</span>'),
  text3: () => `<p>All 412 tests pass. The branch was rebased onto <code>main</code> earlier, so this needs a force-push.</p>`,
  text3q: () => `<p>All 412 tests pass. Two things to settle before I push.</p>`,
  pendingRow: () => row('square-terminal', 'Run <span class="mono" style="color:color-mix(in oklab,var(--fg) 82%,transparent)">git push --force-with-lease origin cf/pr-badge-stale</span>', '<span class="t-amber">waiting for you</span>', { chev: false }),
  pendingRowQ: () => row('message-circle-question-mark', 'Asking <b>2 questions</b>', '<span class="t-amber">waiting for you</span>', { chev: false }),
  working: () => `<div class="working">${ic('loader-circle', 'spin')}<span class="shimmer">Working</span><span class="num">3m 52s</span></div>`,
};

const GO_BLOCK = `<pre><code><span class="k">func</span> <span class="f">fingerprintOf</span>(pr <span class="t">PullRequest</span>) <span class="t">Fingerprint</span> {
	<span class="k">return</span> <span class="t">Fingerprint</span>{
		CheckCount:  <span class="f">len</span>(pr.Checks),
		ReviewState: pr.ReviewDecision,
		HeadOid:     pr.HeadRefOid, <span class="c">// moves on every push</span>
	}
}</code></pre>`;
const ANSWER_HEAD = `<h2>Fixed: stale badge after a force-push</h2>
<p>The poller compared only <code>CheckCount</code> and <code>ReviewState</code>, so a force-push that kept the same checks looked unchanged and the badge never refreshed. The fingerprint now includes the head SHA, which the batched GraphQL query already returns, so <strong>no extra API calls</strong>.</p>
<h3>What changed</h3>
<ul>
<li><code>Fingerprint</code> carries <code>HeadOid</code> (<a>internal/store/pr/fingerprint.go</a>).</li>
<li><code>fingerprintOf</code> fills it from <code>pr.HeadRefOid</code>.</li>
<li>New test <code>TestFingerprintChangesOnForcePush</code>; the reviewer subagent found nothing else.</li>
</ul>
<table><thead><tr><th>Case</th><th>Before</th><th>After</th></tr></thead><tbody>
<tr><td>New commit, same checks</td><td>skipped</td><td>refreshed</td></tr>
<tr><td>Force-push, same checks</td><td>skipped</td><td>refreshed</td></tr>
<tr><td>Nothing changed</td><td>skipped</td><td>skipped</td></tr>
</tbody></table>`;
const ANSWER = ANSWER_HEAD + GO_BLOCK + `<p>Tests: <code>go test ./internal/store/pr/</code> passes. I have not pushed.</p>`;
const ANSWER_STREAM = ANSWER_HEAD + `<pre><code><span class="k">func</span> <span class="f">fingerprintOf</span>(pr <span class="t">PullRequest</span>) <span class="t">Fingerprint</span> {
	<span class="k">return</span> <span class="t">Fingerprint</span>{
		CheckCount:  <span class="f">len</span>(pr.Checks),
		ReviewState: pr.Revi<span class="caret"></span></code></pre>`;

// ---------------------------------------------------------------- pending panels
const kbd = (k) => `<kbd>${k}</kbd>`;
function permission(inline) {
  return `<div class="pend perm ${inline ? 'inline' : ''}" data-shot="permission">
    <div class="pend-h">${ic('shield-alert')}<span>Allow Claude to run this command?</span><span class="chip tool">Bash</span><span class="why">Accept edits asks before commands</span></div>
    <div class="cmdbox"><span class="pr">$ </span><span class="sh-c">git</span> push <span class="sh-f">--force-with-lease</span> origin cf/pr-badge-stale</div>
    <div class="desc">Force-push the rebased branch so PR #63 picks up the fix. <span style="opacity:.8">Allow for session adds <code>Bash(git push:*)</code>.</span></div>
    <div class="acts">
      <span class="btn primary">${ic('check')}Allow ${kbd('1')}</span>
      <span class="btn outline">Allow for session ${kbd('2')}</span>
      <span class="btn outline">Deny ${kbd('3')}</span>
      <span class="btn ghost push"><i style="width:8px;height:8px;border-radius:2px;background:currentColor;display:block"></i>Interrupt</span>
    </div>
  </div>`;
}
function question(inline) {
  return `<div class="pend ask ${inline ? 'inline' : ''}" data-shot="question">
    <div class="pend-h">${ic('message-circle-question-mark')}<span>Claude has 2 questions</span><span class="pager"><i class="on"></i><i></i><span style="margin-left:4px">1 of 2</span></span></div>
    <div class="q-text"><span class="q-hdr">Push</span> The branch was rebased onto <code class="mono" style="font-size:12px">main</code>, so a plain push will be rejected. How should I push?</div>
    <div class="opts">
      <div class="opt sel"><span class="on"></span><span><b>Force with lease</b> <span class="muted" style="font-size:12px">(Recommended)</span><small>Overwrites the remote branch only if nobody else pushed to it</small></span><span class="kn">1</span></div>
      <div class="opt"><span class="on"></span><span><b>Push to a new branch</b><small>cf/pr-badge-stale-2, then retarget PR #63</small></span><span class="kn">2</span></div>
      <div class="opt"><span class="on"></span><span><b>Don't push</b><small>Leave the commits local</small></span><span class="kn">3</span></div>
      <div class="opt"><span class="on"></span><span style="flex:1"><b>Other</b><input placeholder="Type your own answer"></span><span class="kn">4</span></div>
    </div>
    <div class="acts">
      <span class="btn primary">Next ${ic('arrow-up').replace('viewBox', 'style="transform:rotate(90deg)" viewBox')}</span>
      <span class="btn outline">Skip questions</span>
      <span class="btn ghost push"><i style="width:8px;height:8px;border-radius:2px;background:currentColor;display:block"></i>Interrupt</span>
    </div>
  </div>`;
}

function composer(pendingHtml = '') {
  return `<div class="composer"><div class="ccard">
    ${pendingHtml}
    <div class="prompt">Send a follow-up… Claude picks it up mid-turn</div>
    <div class="ctools">
      <span class="pick">${ic('brain')}Opus${ic('chevron-down', 'cv')}</span>
      <span class="pick">${ic('gauge')}High${ic('chevron-down', 'cv')}</span>
      <span class="pick">${ic('shield-check')}Accept edits${ic('chevron-down', 'cv')}</span>
      <span class="attach">${ic('paperclip')}</span>
    </div>
    <div class="csend"><span class="intr" data-shot="interrupt"><i></i>Interrupt</span><span class="send">${ic('arrow-up')}</span></div>
  </div></div>`;
}

const divider = () => `<div class="divider">${ic('square-terminal')}<span>Earlier turns ran in the terminal</span><a>Open transcript</a></div>`;

// ---------------------------------------------------------------- variants
const streaming = STATE === 'streaming';
const pendingInline = () => STATE === 'question' ? question(true) : permission(true);
const pendingDocked = () => STATE === 'question' ? question(false) : permission(false);

// A: T3-like dense work log, user bubbles on the right, composer card floating with pending prompts docked into it.
function variantA() {
  const umsg = (t, when) => `<div class="u"><div class="bubble umsg">${t}</div><div class="when">${when}</div></div>`;
  let h = divider();
  h += umsg(USER1, '14:02');
  h += `<div class="a">
    ${P.thinking()}<div class="md">${P.text1()}</div>
    ${P.groupClosed()}${P.groupOpen()}
    <div class="md">${P.text2()}</div>
    ${P.asked()}${P.testEdit()}${P.bashFail()}${P.edit()}${P.bashOk()}${P.agent()}
    <div class="md answer">${P.answer(streaming)}</div>
    ${streaming ? P.working() : P.footer1()}
  </div>`;
  if (!streaming) {
    h += umsg(USER2, '14:07');
    h += `<div class="a">${P.bashSuite()}<div class="md">${STATE === 'question' ? P.text3q() : P.text3()}</div>${STATE === 'question' ? P.pendingRowQ() : P.pendingRow()}</div>`;
  }
  return `<div class="scroller"><div class="col">${h}</div></div>
    <div class="dock">${composer(streaming ? '' : pendingDocked())}</div>`;
}

// B: chat-like. Role headers, each assistant turn folds its process into an indented work log, the answer sits under it at full width; prompts inline; composer docked.
function variantB() {
  const umsg = (t, when) => `<div class="u"><div class="bubble umsg">${t}</div><div class="when">${when}</div></div>`;
  const who = (meta) => `<div class="who"><span class="av">${claude()}</span><b>Claude</b><span class="muted">${meta}</span></div>`;
  let h = divider();
  h += umsg(USER1, '14:02');
  const log1 = `<div class="log">
      ${streaming
        ? `<div class="loghead">${ic('loader-circle', 'spin t-sky')}<span class="shimmer-ish">Working</span><span class="muted num">3m 52s · 14 steps</span>${ic('chevron-down', 'chev')}</div>`
        : `<div class="loghead click">${ic('chevron-down', 'chev')}<span>Worked for 4m 08s</span><span class="muted num">14 steps · 9 files read · 1 edited</span></div>`}
      <div class="logbody">
        ${P.thinking()}<div class="md mutedtext">${P.text1()}</div>
        ${P.groupClosed()}${P.groupOpen()}
        <div class="md mutedtext">${P.text2()}</div>
        ${P.asked()}${P.testEdit()}${P.bashFail()}${P.edit()}${P.bashOk()}${P.agent()}
      </div>
    </div>`;
  h += `<div class="a">${who('Opus · high · 14:02')}<div class="abody">${log1}<div class="md answer">${P.answer(streaming)}</div>
      ${streaming ? P.working() : `<div class="tfoot"><span>$1.12</span><span class="sep">·</span><span>48.2K tokens</span><span style="flex:1"></span><span class="tb">${ic('copy')}</span></div>`}</div></div>`;
  if (!streaming) {
    h += umsg(USER2, '14:07');
    h += `<div class="a">${who('Opus · high · 14:07')}<div class="abody"><div class="log">
        <div class="loghead"><span class="attn" style="margin:0 2px"></span><span>Waiting for you</span><span class="muted num">1m 02s · 2 steps</span>${ic('chevron-down', 'chev')}</div>
        <div class="logbody">${P.bashSuite()}<div class="md mutedtext">${STATE === 'question' ? P.text3q() : P.text3()}</div>${pendingInline()}</div>
      </div></div></div>`;
  }
  return `<div class="scroller"><div class="col">${h}</div></div>
    <div class="dock">${composer('')}</div>`;
}

// C: rail. The PR surface timeline language (PrTimeline): every item is a node on a vertical rail; prompts inline on the rail; composer floating.
function variantC() {
  const e = (node, body, cls = '') => `<div class="e ${cls}"><span class="node">${node}</span><div class="eb">${body}</div></div>`;
  const u = (t, when) => e(ic('user'), `<div class="uhead"><b>You</b><span class="when">${when}</span></div><div class="umsg">${t}</div>`, 'user');
  const ctext = (t) => e(claude(), `<div class="md">${t}</div>`, 'text');
  const tool = (html) => e('', html, 'tool');
  let h = divider();
  h += `<div class="rail">`;
  h += u(USER1, '14:02');
  h += tool(P.thinking());
  h += ctext(P.text1());
  h += tool(P.groupClosed());
  h += tool(P.groupOpen());
  h += ctext(P.text2());
  h += tool(P.asked()) + tool(P.testEdit()) + tool(P.bashFail()) + tool(P.edit()) + tool(P.bashOk()) + tool(P.agent());
  h += e(claude(), `<div class="md answer">${P.answer(streaming)}</div>`, 'text');
  if (streaming) {
    h += e(ic('loader-circle', 'spin t-sky'), `<div class="working" style="padding-left:0"><span class="shimmer">Working</span><span class="num">3m 52s</span></div>`, 'end');
  } else {
    h += e(ic('circle-check', 't-emerald'), `<div class="tfoot"><span style="color:var(--fg)">Turn finished</span><span class="sep">·</span><span>4m 08s</span><span class="sep">·</span><span>$1.12</span><span style="flex:1"></span><span class="tb">${ic('copy')}</span></div>`, 'end');
    h += u(USER2, '14:07');
    h += tool(P.bashSuite());
    h += ctext(STATE === 'question' ? P.text3q() : P.text3());
    h += e('<span class="attn"></span>', pendingInline(), 'pending');
  }
  h += `</div>`;
  return `<div class="scroller"><div class="col">${h}</div></div>
    <div class="dock">${composer('')}</div>`;
}

const main = { a: variantA, b: variantB, c: variantC }[V] || variantA;
document.getElementById('app').innerHTML = sidebar() + `<section class="pane">${header()}${main()}</section>`;

// expand/collapse rows (sketch only)
document.querySelectorAll('[data-toggle]').forEach((r) => r.addEventListener('click', () => {
  r.classList.toggle('open');
  const next = r.nextElementSibling;
  if (next && (next.classList.contains('detail') || next.classList.contains('members') || next.classList.contains('children'))) next.hidden = !r.classList.contains('open');
}));
// collapsed rows hide nothing yet; start scrolled to the bottom like a live thread
const dock = document.querySelector('.dock');
if (getComputedStyle(dock).position === 'absolute') document.querySelector('.col').style.paddingBottom = (dock.offsetHeight + 8) + 'px';
const sc = document.querySelector('.scroller');
sc.scrollTop = sc.scrollHeight;
