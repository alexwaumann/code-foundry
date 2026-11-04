# Lineage card place: a child thread's hover card says where it works

GUI only. The hover card on the thread info card's Lineage rows gains the child thread's
place, in the sidebar card's words and icons.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/components/thread/ThreadPlaceRows.tsx` (new) | `ThreadPlaceRows` and `TipRow`, moved out of `SidebarRow.tsx`; `freshBranchOnly` keeps the branch to a fresh copy |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | `ThreadTipBody` renders `ThreadPlaceRows`; no behaviour change |
| `gui/frontend/src/components/threadinfo/LineageGroup.tsx` | a child row's card shows the place between two dividers; the child's branch no longer sits on its own line (`LineageRow.type` is "" for a child) |
| `gui/frontend/mock/` | `multi-thread` takes `createdBy`, so a child can sit in a workspace on a fresh copy |
| `gui/frontend/e2e/thread-info.spec.ts` | a SHOTS block for the PR's screenshots |

## Decisions

* Order: workspace, project, branch. Icons are the sidebar card's: Layers, `ProjectKindIcon`
  (House for no project), GitBranch with the branch in mono. The sketch's folder icon was wrong.
* Subagent runs show no place. The first plan was the parent thread's place, but a run can
  really be elsewhere: the Agent tool has a worktree isolation option (the orchestrate skill
  tells agents not to use it), and the daemon records no cwd per run. The owner chose to show
  nothing rather than something possibly wrong. No daemon data was added.
* The branch shows only for place "fresh", as asked. A worktree the user picked (place null)
  and a thread in its workspace's folder show no branch here, though the sidebar card does.
* Several projects with no workspace keep the sidebar's Layers row reading "N projects". It
  is the same logic as the sidebar, and without it the card hides that the thread spans several.
* `ThreadPlaceRows` lives in the card, so its selectors run only while the card is open.
