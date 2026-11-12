package guide

import (
	"fmt"
	"io"
)

// writeLayoutConventions is `code-foundry guide layout`'s section above its commands: how a
// thread's model reads and arranges the window's spaces, panes and tabs without taking the
// user's focus (docs/notes/shell-model.md, docs/notes/shell-4-commands.md).
func writeLayoutConventions(w io.Writer) {
	p := func(format string, a ...any) { fmt.Fprintf(w, format+"\n", a...) }
	p("")
	p("## Conventions")
	p("")
	p("- The window is spaces (top bar), each a tree of panes, each pane a strip of tabs. A tab shows a thread, or a")
	p("  surface linked to one (its diff, files, pull requests, terminals), or a page. Read it first: `code-foundry layout")
	p("  show` prints every space with split, pane and tab ids (`--json` for the data); `tab list --thread <id>` finds a")
	p("  thread's tabs.")
	p("- Name what you act on: from inside a thread every space, pane and tab verb needs its id (a unique suffix of 4+")
	p("  characters works; a space also takes its name). The user's focused pane or tab is never a default for you.")
	p("- Never move the user's focus: your verbs leave it where it is. A tab you open or move becomes active in its own")
	p("  pane, and waits behind the focused tab in the focused pane. Pass `--focus` only when the user asked to be taken")
	p("  there; `space switch` and `pane focus` do nothing else, so they need it.")
	p("- Prefer letting placement work: `view open file|diff|pr|page|gallery|mcp` opens a thread's surface as a tab linked")
	p("  to it, beside it by the app's rules; opening the same one again (a file's path, a pull request, a checkout's")
	p("  diff) uses the open tab. Arrange by hand (`tab move`, `pane move`, `pane resize`) only when the user asked for")
	p("  an arrangement.")
	p("- `thread close` closes a thread's tab from its space (never archives it); its linked tabs are remembered and")
	p("  come back with `thread open`.")
}
