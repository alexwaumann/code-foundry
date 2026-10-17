package command

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/durationpb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ThreadWaitConditions are thread.wait's until values.
var ThreadWaitConditions = []string{"idle", "attention", "error", "disconnected"}

// threadWaitGoals finish thread.wait's timeout message: "waiting for thread s-1 to ...".
var threadWaitGoals = map[string]string{
	"idle": "be idle", "attention": "need attention", "error": "have an error", "disconnected": "be disconnected",
}

var threadWaitConditions = map[string]v1.ThreadWaitCondition{
	"idle":         v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_IDLE,
	"attention":    v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ATTENTION,
	"error":        v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ERROR,
	"disconnected": v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_DISCONNECTED,
}

// maxThreadWait bounds thread.wait's for.
const maxThreadWait = 24 * time.Hour

// threadWait is thread.wait: block until a thread is idle (or needs attention, fails,
// or is disconnected), for an agent that drives other threads from the CLI. It waits in
// the daemon (ThreadService.Wait, which follows the thread list on the bus), like
// action.wait. A timeout is an error (DEADLINE_EXCEEDED, the CLI exits 1, nothing on
// stdout with --json) naming the thread's status then. See
// docs/notes/agents-1-wait-events.md.
func threadWait(b ThreadBackend, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:  "thread.wait",
		Title: "Wait for Thread",
		Description: "Wait until a thread is idle (Claude not working and no question or permission prompt pending), " +
			"needs attention, has an error, or is disconnected; returns at once when it already is. " +
			"Prints the thread's status (--json: the thread). Exits 1 when the time runs out.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			idArg,
			{Name: "until", Type: Enum, Enum: ThreadWaitConditions, Default: "idle",
				Description: "idle, attention (needs attention: a prompt, a question or a finished turn), error, or disconnected"},
			{Name: "for", Type: String, Default: "10m", Description: "How long to wait at most: a Go duration such as 30s, 10m or 2h (at most 24h)"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id, until := a.String("id"), a.String("until")
			limit, err := time.ParseDuration(strings.TrimSpace(a.String("for")))
			switch {
			case err != nil:
				return Result{}, InvalidArg("for", "%q is not a duration (30s, 10m, 2h)", a.String("for"))
			case limit <= 0 || limit > maxThreadWait:
				return Result{}, InvalidArg("for", "%s is out of range: give more than 0 and at most 24h", limit)
			}
			res, err := b.Wait(ctx, connect.NewRequest(&v1.WaitThreadRequest{
				Id: id, Until: threadWaitConditions[until], Timeout: durationpb.New(limit),
			}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			if res.Msg.GetTimedOut() {
				return Result{}, connect.NewError(connect.CodeDeadlineExceeded,
					fmt.Errorf("timed out after %s waiting for thread %s to %s; it is %s", limit, id, threadWaitGoals[until], waitStatus(s)))
			}
			return Result{Message: waitLine(s), JSON: s}, nil
		},
	}
}

// waitLine is thread.wait's answer: "thread s-1 fix: idle (at prompt)".
func waitLine(s *v1.Thread) string {
	line := "thread " + s.GetId()
	if s.GetName() != "" {
		line += " " + s.GetName()
	}
	return line + ": " + waitStatus(s)
}

// waitStatus is a thread's status and reason, "needs attention (finished)", followed by
// ", disconnected" when no Claude process runs.
func waitStatus(s *v1.Thread) string {
	st := strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(s.GetStatus().String(), "THREAD_STATUS_")), "_", " ")
	if s.GetStatus() == v1.ThreadStatus_THREAD_STATUS_UNSPECIFIED {
		st = "unknown"
	}
	if r := s.GetStatusReason(); r != "" {
		st += " (" + r + ")"
	}
	if s.GetState() == v1.ThreadState_THREAD_STATE_DISCONNECTED {
		st += ", disconnected"
	}
	return st
}
