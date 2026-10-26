package command

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/durationpb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ThreadWaitConditions are thread.wait's until values; settled, the default, first.
var ThreadWaitConditions = []string{"settled", "idle", "attention", "error", "disconnected"}

// threadWaitGoals finish thread.wait's timeout message: "waiting for thread s-1 to ...".
var threadWaitGoals = map[string]string{
	"settled": "settle", "idle": "be idle", "attention": "need attention", "error": "have an error", "disconnected": "be disconnected",
}

var threadWaitConditions = map[string]v1.ThreadWaitCondition{
	"settled":      v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_SETTLED,
	"idle":         v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_IDLE,
	"attention":    v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ATTENTION,
	"error":        v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ERROR,
	"disconnected": v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_DISCONNECTED,
}

// maxThreadWait bounds thread.wait's for.
const maxThreadWait = 24 * time.Hour

// threadWait is thread.wait: block until a thread settles (its turn ended, or it asks
// for a permission or an answer; or with until: is idle, needs attention, fails, or is
// disconnected), for an agent that drives other threads from the CLI. It waits in
// the daemon (ThreadService.Wait, which follows the thread list on the bus), like
// action.wait. A timeout is an error (DEADLINE_EXCEEDED, the CLI exits 1; with --json
// it prints {"timedOut": true, "error": ...}) naming the thread's status then. See
// docs/notes/agents-1-wait-events.md and docs/notes/thread-wait-settled.md.
func threadWait(b ThreadBackend, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:      "thread.wait",
		NoPalette: true,
		ReadOnly:  true,
		Title:     "Wait for Thread",
		Description: "Wait until a thread settles: its turn ended, or it asks for a permission or an answer " +
			"(or with --until: idle, attention, error, disconnected); returns at once when it already has. " +
			"Prints the thread's status and any pending request with the thread respond line that answers it " +
			"(--json: the thread). Exits 1 on timeout or removal.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			idArg,
			{Name: "until", Type: Enum, Enum: ThreadWaitConditions, Default: "settled",
				Description: "The condition: settled is idle or attention; idle excludes a pending prompt or question; " +
					"attention covers a prompt, a question and a finished turn"},
			waitForArg,
			{Name: "after", Type: String, Description: "An item id or ordinal (#N in thread read): count the condition only once Claude reacted after it " +
				"(a turn end, error, permission request or question follows it); default: the thread's latest message (yours or a wake), " +
				"so a wait after a send waits for its answer"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			limit, err := waitLimit(a)
			if err != nil {
				return Result{}, err
			}
			return waitThread(ctx, b, a.String("id"), a.String("until"), a.String("after"), limit, "")
		},
	}
}

// waitForArg is thread.wait's and thread.send's for.
var waitForArg = ArgSpec{Name: "for", Type: String, Default: "10m", Description: "How long to wait at most: a Go duration such as 30s, 10m or 2h (at most 24h)"}

// waitLimit reads the for arg.
func waitLimit(a Args) (time.Duration, error) {
	limit, err := time.ParseDuration(strings.TrimSpace(a.String("for")))
	switch {
	case err != nil:
		return 0, InvalidArg("for", "%q is not a duration (30s, 10m, 2h)", a.String("for"))
	case limit <= 0 || limit > maxThreadWait:
		return 0, InvalidArg("for", "%s is out of range: give more than 0 and at most 24h", limit)
	}
	return limit, nil
}

// waitThread waits (ThreadService.Wait) and answers like thread.wait: the thread's
// status line (then pendingLines) and the thread, DEADLINE_EXCEEDED naming its status, or, for a thread
// removed before or during the wait, removedWaitResult (exit 1). what, when set,
// starts the timeout and removed messages ("sent to thread s-1; ").
func waitThread(ctx context.Context, b ThreadBackend, id, until, after string, limit time.Duration, what string) (Result, error) {
	res, err := b.Wait(ctx, connect.NewRequest(&v1.WaitThreadRequest{
		Id: id, Until: threadWaitConditions[until], Timeout: durationpb.New(limit), After: after,
	}))
	if r, ok := removedFrom(err); ok {
		return removedWaitResult(r, what), nil
	}
	if err != nil {
		return Result{}, err
	}
	if r := res.Msg.GetRemoved(); r != nil {
		return removedWaitResult(r, what), nil
	}
	s := res.Msg.GetThread()
	if res.Msg.GetTimedOut() {
		return Result{}, connect.NewError(connect.CodeDeadlineExceeded,
			fmt.Errorf("%stimed out after %s waiting for thread %s to %s; it is %s", what, limit, id, threadWaitGoals[until], waitStatus(s)))
	}
	msg := waitLine(s)
	if lines := pendingLines(ctx, b, s); len(lines) > 0 {
		msg += "\n" + strings.Join(lines, "\n")
	}
	return Result{Message: msg, JSON: s}, nil
}

// maxPendingInput bounds a tool input in pendingLines (bytes).
const maxPendingInput = 600

// pendingLines name the requests a thread a wait returned at asks for, oldest first,
// each with the thread.respond line that answers it:
//
//	pending permission r1: Bash {"command":"ls"}; answer with: code-foundry thread respond --id s1 allow (or deny --message "why")
//	pending question r2: Which color? (options: Red | Blue); answer with: code-foundry thread respond --id s1 --answer "<label>"
//
// None unless s is connected and needs attention for a permission or a question; none
// when the items cannot be read (the status line names the request anyway).
func pendingLines(ctx context.Context, b ThreadBackend, s *v1.Thread) []string {
	r := s.GetStatusReason()
	if s.GetState() != v1.ThreadState_THREAD_STATE_CONNECTED || s.GetStatus() != v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION ||
		!(strings.HasPrefix(r, "permission:") || strings.HasPrefix(r, "question:")) {
		return nil
	}
	res, err := b.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{ThreadId: s.GetId()}))
	if err != nil {
		return nil
	}
	snap := res.Msg.GetSnapshot()
	pending := snap.GetPending()
	respond := "code-foundry thread respond --id " + s.GetId()
	var out []string
	for _, p := range pending {
		cmd := respond
		if len(pending) > 1 {
			cmd += " --request " + p.GetRequestId()
		}
		req := requestOf(snap, p.GetItemId())
		if p.GetQuestion() {
			out = append(out, fmt.Sprintf("pending question %s: %s; answer with: %s --answer %s",
				p.GetRequestId(), describeQuestions(req.GetInputJson(), p.GetSummary()), cmd, answerHint(req.GetInputJson())))
			continue
		}
		what := strings.TrimSpace(p.GetToolName() + " " + compactInput(req.GetInputJson()))
		if what == "" {
			what = p.GetSummary()
		}
		out = append(out, fmt.Sprintf("pending permission %s: %s; answer with: %s allow (or deny --message \"why\")",
			p.GetRequestId(), what, cmd))
	}
	return out
}

// requestOf is the request of the permission or question item itemID; nil when absent.
func requestOf(snap *v1.ThreadItemsSnapshot, itemID string) *v1.ThreadRequestItem {
	for _, it := range snap.GetItems() {
		if it.GetId() != itemID {
			continue
		}
		if r := it.GetPermission(); r != nil {
			return r
		}
		return it.GetQuestion()
	}
	return nil
}

// compactInput is a tool input on one line: compacted JSON, its head past
// maxPendingInput bytes with a marker.
func compactInput(in string) string {
	var buf bytes.Buffer
	if json.Compact(&buf, []byte(in)) == nil {
		in = buf.String()
	}
	in = strings.Join(strings.Fields(in), " ") // no newlines in a raw input
	if len(in) <= maxPendingInput {
		return in
	}
	cut := maxPendingInput
	for cut > 0 && !utf8.RuneStart(in[cut]) {
		cut--
	}
	return in[:cut] + fmt.Sprintf("… [%d more bytes; thread read --full has it all]", len(in)-cut)
}

// pendingQuestion is one question of an AskUserQuestion input.
type pendingQuestion struct {
	Question string `json:"question"`
	Options  []struct {
		Label string `json:"label"`
	} `json:"options"`
}

// questionsIn are the questions of an AskUserQuestion input.
func questionsIn(inputJSON string) []pendingQuestion {
	var in struct {
		Questions []pendingQuestion `json:"questions"`
	}
	_ = json.Unmarshal([]byte(inputJSON), &in)
	return in.Questions
}

// describeQuestions is a question request's questions with their option labels,
// "Which color? (options: Red | Blue)", several joined with " / "; summary when the
// input has none.
func describeQuestions(inputJSON, summary string) string {
	var parts []string
	for _, q := range questionsIn(inputJSON) {
		part := q.Question
		if len(q.Options) > 0 {
			labels := make([]string, 0, len(q.Options))
			for _, o := range q.Options {
				labels = append(labels, o.Label)
			}
			part += " (options: " + strings.Join(labels, " | ") + ")"
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return summary
	}
	return strings.Join(parts, " / ")
}

// answerHint is thread.respond's answer for a question request: "<label>" for one
// question, '{"<question>": "<label>", ...}' for several (parseAnswers).
func answerHint(inputJSON string) string {
	qs := questionsIn(inputJSON)
	if len(qs) <= 1 {
		return `"<label>"`
	}
	m := make(map[string]string, len(qs))
	for _, q := range qs {
		m[q.Question] = "<label>"
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // <label>, not \u003clabel\u003e
	_ = enc.Encode(m)
	return "'" + strings.ReplaceAll(strings.TrimSpace(buf.String()), "'", `'\''`) + "'"
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
		if st = noStatusWord(s); st == "not started" {
			return st
		}
	}
	if r := s.GetStatusReason(); r != "" {
		st += " (" + r + ")"
	}
	if s.GetState() == v1.ThreadState_THREAD_STATE_DISCONNECTED {
		st += ", disconnected"
	}
	return st
}
