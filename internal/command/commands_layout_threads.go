package command

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// writeThreads writes, for layout.show, what the layout stores per thread beside its tabs:
// its space (listed when it is not the default space, or with any of the rest), its quick
// terminal open (or to open again as a fresh shell, after a snooze), its info card shown or
// hidden when the user toggled it (thread.info), and the linked tabs it
// remembers (closed with it, to come back when it opens; a terminal marked fresh comes back
// as a new shell, with the command it ran for "Run again").
func writeThreads(b *strings.Builder, threads map[string]*core.ThreadState, defaultSpace string, names map[string]string) {
	ids := slices.Sorted(maps.Keys(threads))
	ids = slices.DeleteFunc(ids, func(id string) bool {
		ts := threads[id]
		return ts.Space == defaultSpace && (ts.Quick == nil || (!ts.Quick.Open && !ts.Quick.Fresh)) && ts.Remembered == nil && ts.Info == nil
	})
	if len(ids) == 0 {
		return
	}
	b.WriteString("threads\n")
	for _, id := range ids {
		ts := threads[id]
		fmt.Fprintf(b, "  thread %s", id)
		if n := names[id]; n != "" {
			fmt.Fprintf(b, " %q", n)
		}
		fmt.Fprintf(b, " in space %s", ts.Space)
		switch q := ts.Quick; {
		case q != nil && q.Fresh:
			b.WriteString(", quick terminal comes back open as a fresh shell")
		case q != nil && q.Open:
			b.WriteString(", quick terminal open")
		}
		if q := ts.Quick; q != nil && q.Ran != "" {
			fmt.Fprintf(b, " (ran %q)", q.Ran)
		}
		if ts.Info != nil {
			if *ts.Info {
				b.WriteString(", info card shown")
			} else {
				b.WriteString(", info card hidden")
			}
		}
		b.WriteString("\n")
		if ts.Remembered == nil {
			continue
		}
		for _, rt := range ts.Remembered.Tabs {
			fmt.Fprintf(b, "    remembered %s %s", rt.Tab.ID, tabWords(rt.Tab, nil))
			if rt.Pane != "" {
				fmt.Fprintf(b, " in pane %s", rt.Pane)
				if rt.Space != "" && rt.Space != ts.Space {
					fmt.Fprintf(b, " of space %s", rt.Space)
				}
			} else {
				// No pane (the first-load import's records): opening the thread places it fresh.
				b.WriteString(", placed fresh beside the thread")
			}
			if rt.Fresh != nil {
				b.WriteString(" (comes back as a fresh shell")
				if ran := rt.Fresh.Ran; ran != "" {
					fmt.Fprintf(b, "; ran %q", ran)
				}
				b.WriteString(")")
			}
			b.WriteString("\n")
		}
	}
}
