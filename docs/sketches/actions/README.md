# Actions sketch

Per-repo actions (name, command, icon, run on worktree create), run from the thread header
into a bottom-panel tab that stays open after the command exits. Static HTML on top of the
thread-header sketch (layout A), which builds on `../rendered-thread/` (style, lucide
icons, fake thread). Open `index.html?v=<state>&x=a|b&theme=dark|light`.

| State | URL | Shot name |
|---|---|---|
| Header trigger (Play left of the bottom toggle) | `?v=header` | `header` |
| Menu, edit = pencil on hover (chosen) | `?v=menu&x=a` | `menu-a` |
| Menu, edit = submenu (Run / Edit…) | `?v=menu&x=b` | `menu-b` |
| Menu, no actions | `?v=empty` | `menu-empty` |
| New action | `?v=new` | `dialog-new` |
| Edit action | `?v=edit` | `dialog-edit` |
| Edit, after Delete was clicked | `?v=delete` | `dialog-delete` |
| Action running, status line | `?v=running&x=a` | `panel-running-a` |
| Action running, status in the strip | `?v=running&x=b` | `panel-running-b` |
| Exited 1, status line (chosen) | `?v=exited&x=a` | `panel-exited-a` |
| Exited 1, status + Rerun in the strip | `?v=exited&x=b` | `panel-exited-b` |
| Exited 0, status line | `?v=exited&x=a&code=0` | `panel-exited-ok-a` |

Committed shots: three, the chosen variants `menu-a-dark.png` and `panel-exited-a-light.png`,
and the delete confirm `dialog-delete-dark.png`. The others (each state in `-dark.png` and `-light.png`) are
not kept in the repo; regenerate them with `shoot.mjs` below. The shipped GUI's live
screenshots are in `docs/notes/actions-2-gui/`.

Shots: `node shoot.mjs [name,...]` (WebKit, 1180 wide at 2x like the thread-header shots;
header 1180x150, menus 1180x400, the rest the full 1180x760 window). Playwright comes from
`gui/frontend/node_modules`, or set `CF_FRONTEND` to a frontend dir that has it.

## Recommendations

* **Menu edit affordance: a (pencil on hover).** One click runs, and the pencil is visible on
  the highlighted row, so it shows for keyboard highlight too. This is what T3 Code does (a
  settings glyph). With b, a row opens a submenu instead of running, so running takes two
  steps, and running is the common case. Gotcha for a: the pencil is a button inside a
  Radix item. It needs `stopPropagation`/`preventDefault` on pointer down, and a keyboard
  path (for example an "Edit action…" palette command with the action as an argument).
* **Exited status placement: a (status line under the output).** It reads like the
  command's last line: "Exited with code 1 · 4.2s · Rerun", tinted red for a non-zero code.
  Show it from the start ("Running · 0:12 · Stop"), so the terminal does not refit when the
  command exits. With b the status and Rerun move to the strip's right end. That saves
  28px, but the status sits far from the tab and the output it describes, and the strip
  changes with the active tab.
* **Tab**: the action's icon and name, then a status glyph: sky spinner while running,
  emerald `CircleCheck` for 0, red `CircleX` otherwise. The output starts with the command,
  dimmed (`$ go test ./...`).
* **Delete confirm**: the confirm takes over the footer ("Delete Test for every thread in
  code-foundry?" · Keep · Delete). The armed Delete sits on the right, where Save was, so a
  double click on the left-hand Delete cannot confirm it.
* **Dialog**: a stacked form in the app's dialog (`max-w-lg p-4`). It has Publish's input
  look, a mono command textarea, T3's icon tiles (six in a row instead of T3's popover
  grid), and the settings switch in a T3-style row. The description says the action is
  saved for the repo, since the editor is opened from a thread.
