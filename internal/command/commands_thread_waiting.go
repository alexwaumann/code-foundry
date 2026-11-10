package command

import (
	"strconv"
	"strings"

	threadstore "github.com/alexwaumann/code-foundry/internal/store/thread"
)

// waitingWord is thread.list's status for a waiting thread (status idle, reason "waiting
// on 2 child threads and 1 shell"; docs/notes/orch-waiting-status.md and
// waiting-background-tasks.md): "waiting (on 2 children)", "waiting (on 1 child)",
// "waiting (on 1 subagent)", "waiting (on 2 children and 1 shell)", or "waiting" while
// only a wake to it is queued. The reason is read by threadstore.ParseWaiting; child
// threads read "children" here. False for any other reason.
func waitingWord(reason string) (string, bool) {
	w, ok := threadstore.ParseWaiting(reason)
	if !ok {
		return "", false
	}
	var parts []string
	for _, p := range []struct {
		n         int
		one, many string
	}{{w.Children, "child", "children"}, {w.Subagents, "subagent", "subagents"}, {w.Shells, "shell", "shells"}} {
		switch {
		case p.n == 1:
			parts = append(parts, "1 "+p.one)
		case p.n > 1:
			parts = append(parts, strconv.Itoa(p.n)+" "+p.many)
		}
	}
	if len(parts) == 0 {
		return "waiting", true
	}
	return "waiting (on " + strings.Join(parts, " and ") + ")", true
}
