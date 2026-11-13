package layout

import "fmt"

// A thread's info card, shown or hidden per thread (docs/notes/shell-model.md, "Thread info is
// per thread"; docs/notes/shell-25a-test-feedback.md). The window draws it; the layout keeps the
// choice with the thread, so it follows the thread across panes, spaces and restarts.

func init() {
	register("set_info", func() Op { return &SetInfo{} })
}

// SetInfo shows or hides a thread's info card (ThreadState.Info). The thread need not have a
// tab open: the choice waits for it.
type SetInfo struct {
	Thread string `json:"thread"`
	Open   bool   `json:"open"`
}

// OpName implements Op.
func (*SetInfo) OpName() string { return "set_info" }

func (o *SetInfo) apply(t *tx) (Result, error) {
	if o.Thread == "" {
		return Result{}, fmt.Errorf("no thread given: %w", ErrInvalidArgument)
	}
	open := o.Open
	threadState(t.st, o.Thread).Info = &open
	return Result{}, nil
}
