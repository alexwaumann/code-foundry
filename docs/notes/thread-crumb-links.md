# Thread crumb links

The thread header's crumb (components/thread/ThreadParts.tsx, lib/threadCrumb.ts) names
where the thread runs. Its project / workspace segment now opens that place's page on the
Projects view.

## Decisions

- **One verb, two optional args.** `view.projects` takes `--project <ref>` or
  `--workspace <ref>` (not both). With neither it is unchanged: the Projects page the
  window showed last. The page goes in the ShowView's params (`project` / `workspace`),
  like `view.settings --page` picks a settings page. `ui.focus.project` was the other
  candidate, but it only covers projects and is about a worktree row. A workspace twin of
  it would have needed a new UiIntent, and the CLI gets `view.projects --workspace platform`
  for free this way.
- **Refs resolve in the daemon.** `--project` is a `ProjectID` arg (id, unique name or a
  path inside it, through the registry's ref resolver). `--workspace` resolves its id or
  name through `WorkspaceService.List` (`findWorkspace`, shared with `workspace.reveal`),
  so the GUI only ever sees ids. Neither arg has a Context, so the palette and cmd+shift+j
  still go to the page the window showed last, not the active project.
- **Which page the crumb opens** (`crumbLink`):
  - a thread in a workspace the store knows → that workspace's page, whatever its primary
    (also when it runs in the workspace's own folder);
  - a set without a workspace (the crumb reads "api +2"), or a removed workspace → the
    primary project's page (the project the label names);
  - one project → its page; an older row with no project id → the project whose checkout
    holds its cwd;
  - no project ("No project", home), or a removed primary → plain text, no button.
- **Hover** matches the parent segment beside it (rounded-sm tint, text to full colour,
  focus ring) rather than the Projects page crumb's text-only hover. Two links in one
  crumb should react the same way.
- No tooltip: the label is on screen and the page it opens is the obvious one.
- The subagent pane's crumb has no place segment (parent › agent name), so it is unchanged.

## Gotchas

- `api/ui.ts` dropped a ShowView's params unless it had a thread id. It now keeps them
  either way. Page ShowViews never sent params before, so nothing else changes.
- The mock's `view.projects` passes the ids through as given; it resolves no names.
