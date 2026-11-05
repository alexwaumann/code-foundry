# Pull request tabs and slug case

Opening a pull request that is already open must switch to its tab. `Alex/Repo` and
`alex/repo` gave two tabs: the tab id came from the slug as given, `selectionBranch`
lower-cases it, and other paths do not. GitHub slugs are case-insensitive.

## Decisions

- `pullRequestTabId` (`stores/panel.ts`) lower-cases the slug in the id only. `params.slug`
  keeps its spelling, for what the tab shows and for its URLs. It lives in the panel store
  because the migration needs it and `surfaces/pullrequestTarget.ts` already imports that store.
- `groupOpen` refreshes a tab's params, so a lower-case opener would have overwritten the
  spelling on screen. `panelPullRequestTab` hands back the tab the panel holds instead:
  `openPullRequestInPanel` and the surface's `openDefault` use it. The first spelling stays.
- `prLinks.ts`'s `inPanel` is gone. The id answers whether the pull request is showing.
- Revert goes through `openPullRequestInPanel` like every other entry point.

## Migration

Panel store version 5. `migratePanelV4` re-ids pull request tabs; two tabs that end up with
one id become the first, across groups too. A group's active tab and `pickFrom` follow the id
when the tab that stayed is in that group, else it shows its first tab. A group left empty
collapses the split.

The rewriting moved out of `migratePanelV3` into `rewriteTabs`. Two behaviours differ from
before, for version 3 stores too: tabs that become one id are deduplicated, and only a group
the rewrite emptied collapses, so a split already picking in an empty group stays split.

An older build reading a version 5 store leaves it alone and saves version 4, so its
mixed-case tabs go through the migration again on the way back.

## Other ways to a duplicate, looked for

- Two groups of a split panel: not a separate bug. `openTab` and `openTabBehind` look in both
  groups by id, so the fixed id covers them.
- `moveTabToGroup`, `split` and `unsplit` move tabs and never copy them.
- Number spellings: `007` and `7` give one id, as every path goes through `Number`.
- One pull request in two panels (a thread's and a project's) is two tabs by design: panels
  belong to a selection.
- Not covered: a renamed or transferred repository. The old and new slugs are different
  strings and nothing on the client says they are one repository.
