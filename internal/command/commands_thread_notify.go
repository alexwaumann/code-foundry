package command

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// notifyLine is what thread.new says of its --notify subscription: who is woken, and
// until when (docs/notes/notify-ends-on-finish.md).
func notifyLine(req *v1.CreateThreadRequest) string {
	by := req.GetCreatedBy()
	if req.GetNotifyRepeat() {
		return by + " is woken each time it settles"
	}
	return by + " is woken when it settles, until the wake that says it finished; " + by + "'s next thread send to it subscribes again"
}
