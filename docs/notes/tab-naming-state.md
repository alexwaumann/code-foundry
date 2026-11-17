# A thread's tab shows a name being regenerated

While a thread's name was being regenerated (`thread.regenerate-name`, `Thread.naming`), or was
still provisional (`Thread.name_provisional`), its sidebar row drew the name muted and italic,
but its tab in the pane's strip looked as always. A user saw the two disagree.

## What changed

- **One rule, one hook.** `useNameProvisional(threadId)` (`shell/useThreadName.ts`) is `naming ||
  nameProvisional`, selecting only that boolean. The sidebar's three copies of the rule (the
  shell row's title, the classic row, the single-line archived/snoozed row) use it, and so does
  everything below, so no two places can disagree.
- **The tab.** A surface may give `useNameProvisional(tab)` (`ShellSurface`, `shell/surfaces/types.ts`):
  true while the tab's title is a thread's name that is not final. Only the thread surface has
  it. The strip (`TabContent` in `PaneTabStrip.tsx`) adds `text-cf-text-muted italic` and
  `data-provisional` to the title. Nothing else changes: same icon, no spinner, no motion (the
  agreed variant A). The muted colour wins over the active tab's and the hover's colour, as the
  sidebar's muted name wins over its selected row's.
- **Linked tabs** keep their own titles ("Diff", "code-foundry · feat/sidebar vs main", a
  terminal's name): none of them is the thread's name, so they are unchanged. The thread's name
  around a linked tab is in the row under its strip (`LinkedRow`, "Diff of ● thread"); that name
  is the lead's, and it is muted and italic while the lead's name is not final.
- **The header** (`ThreadHeader`) names the thread only while its tab is cut short or icon-only,
  standing in for the tab: it follows the tab.

## Places not changed

- The pane rail (a collapsed pane) shows icons only; the name is in its tooltip and an sr-only
  label. Nothing to mute.
- There is no space overview that prints thread names.
- The floating composer's pill over a full-screened tab ("Message ▸ thread") and the "+" menu's
  thread item print the name small, as a target or a menu item; left as they are.

## Tests

vitest only: the strip (naming on and off, provisional, the name landing, a linked tab and other
tabs unchanged), the linked row (its thread's naming; the lead's provisional name, not the
child's) and the header. The mock has `POST /__mock/thread/naming?id=…[&on=false]` to hold a
thread in naming; `e2e/shell-tab-naming.spec.ts` uses it only for the PR's screenshots (SHOTS).
