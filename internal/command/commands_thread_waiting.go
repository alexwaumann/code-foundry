package command

import (
	"strconv"
	"strings"
)

// waitingWord is thread.list's status for a waiting thread (status idle, reason "waiting
// on 2 child threads and 1 shell"; docs/notes/orch-waiting-status.md and
// waiting-background-tasks.md): "waiting (on 2 children)", "waiting (on 1 child)",
// "waiting (on 1 subagent)", "waiting (on 2 children and 1 shell)", or "waiting" while
// only a wake to it is queued. The reason's parts are "N child thread(s)", "N
// subagent(s)", "N shell(s)" joined by " and "; child threads read "children" here. False
// for any other reason.
func waitingWord(reason string) (string, bool) {
	if reason == "waiting" {
		return "waiting", true
	}
	rest, ok := strings.CutPrefix(reason, "waiting on ")
	if !ok {
		return "", false
	}
	var parts []string
	for _, part := range strings.Split(rest, " and ") {
		num, noun, _ := strings.Cut(part, " ")
		n, err := strconv.Atoi(num)
		if err != nil {
			continue
		}
		switch noun {
		case "child thread", "child threads":
			noun = "children"
			if n == 1 {
				noun = "child"
			}
		}
		parts = append(parts, num+" "+noun)
	}
	if len(parts) == 0 {
		return "waiting", true
	}
	return "waiting (on " + strings.Join(parts, " and ") + ")", true
}
