// Overrides the rendered-thread sketch's header with the proposed designs.
const hq = new URLSearchParams(location.search);
const HV = hq.get('h') || 'a';       // layout: a | b | c
const SV = hq.get('s') || 'wt';      // state: wt (worktree, 1 open PR) | main | ws (workspace, 3 PRs) | merged | nogit
const HNAME = hq.get('n') || 'Fix the stale PR badge';

function place() {
  const proj = SV === 'nogit' ? `${ic('folder')}<span>scratch notes</span><span class="chip">no git</span>` : `${ic('folder-git-2')}<span>code-foundry</span>`;
  if (SV === 'nogit') return `<span class="place">${proj}</span>`;
  const branch = SV === 'main' ? 'main' : SV === 'ws' ? 'cf/release-channels' : 'cf/pr-badge-stale';
  const chip = (SV === 'main') ? '' : `<span class="chip">worktree</span>`;
  return `<span class="place" title="Show worktree in side panel">${proj}<span class="at">@</span><span class="mono">${branch}</span>${chip}</span>`;
}
function prs() {
  if (SV === 'nogit' || SV === 'main') return '';
  if (SV === 'ws') return `<span class="tb pr" title="Show linked PRs in side panel">${ic('git-pull-request')}<span class="n">3</span></span>`;
  if (SV === 'merged') return `<span class="tb pr t-violet" title="Show #71 in side panel">${ic('git-merge')}<span class="n">#71</span></span>`;
  return `<span class="tb pr t-emerald" title="Show #78 in side panel">${ic('git-pull-request')}<span class="n">#78</span></span>`;
}
function ws() {
  if (SV !== 'ws') return '';
  return `<span class="tb ws" title="Show workspace in side panel">${ic('layers')}<span>release-channels</span></span>`;
}
function hdr() {
  const acts = `<span class="acts">${ws()}${prs()}<span class="tb">${ic('power')}</span><span class="tb">${ic('panel-bottom')}</span><span class="tb">${ic('panel-right')}</span></span>`;
  return `<header class="phdr h${HV}"><span class="title edit" title="Rename">${HNAME}</span>${place()}${acts}</header>`;
}
const old = document.querySelector('.phdr');
old.outerHTML = hdr();
// sidebar line: project @ branch
document.querySelectorAll('.trow .s').forEach((el) => { el.innerHTML = el.innerHTML.replace(/code-foundry · <span class="mono">/g, 'code-foundry <span style="opacity:.6">@</span> <span class="mono">'); });
