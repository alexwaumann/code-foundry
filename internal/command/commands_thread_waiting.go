package command

import (
	"strconv"
	"strings"
)

// waitingWord is thread.list's status for a thread waiting on its child threads (status
// idle, reason "waiting on 2 child threads"; docs/notes/orch-waiting-status.md):
// "waiting (on 2 children)", "waiting (on 1 child)", or "waiting" while only a wake
// to it is queued. False for any other reason.
func waitingWord(reason string) (string, bool) {
	if reason == "waiting" {
		return "waiting", true
	}
	rest, ok := strings.CutPrefix(reason, "waiting on ")
	if !ok {
		return "", false
	}
	num, _, _ := strings.Cut(rest, " ")
	n, err := strconv.Atoi(num)
	switch {
	case err != nil:
		return "waiting", true
	case n == 1:
		return "waiting (on 1 child)", true
	}
	return "waiting (on " + num + " children)", true
}
