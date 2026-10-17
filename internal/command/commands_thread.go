package command

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/model"
)

// Threads (docs/notes/rendered-threads-1-daemon.md): the thread.* commands drive a
// thread's Claude, which runs headless, and read the conversation the daemon records as
// items.

// ThreadBackend is the slice of ThreadService the thread.* commands need, in generated
// Connect signatures. The API handler, any ThreadServiceHandler, and a
// ThreadServiceClient satisfy it.
type ThreadBackend interface {
	// The lifecycle (commands_thread_lifecycle.go and the thread.pin, thread.archive,
	// thread.snooze and thread.run-in files).
	Create(context.Context, *connect.Request[v1.CreateThreadRequest]) (*connect.Response[v1.CreateThreadResponse], error)
	Fork(context.Context, *connect.Request[v1.ForkThreadRequest]) (*connect.Response[v1.ForkThreadResponse], error)
	List(context.Context, *connect.Request[v1.ListThreadsRequest]) (*connect.Response[v1.ListThreadsResponse], error)
	Get(context.Context, *connect.Request[v1.GetThreadRequest]) (*connect.Response[v1.GetThreadResponse], error)
	Rename(context.Context, *connect.Request[v1.RenameThreadRequest]) (*connect.Response[v1.RenameThreadResponse], error)
	Remove(context.Context, *connect.Request[v1.RemoveThreadRequest]) (*connect.Response[v1.RemoveThreadResponse], error)
	RunIn(context.Context, *connect.Request[v1.RunInThreadRequest]) (*connect.Response[v1.RunInThreadResponse], error)
	Pin(context.Context, *connect.Request[v1.PinThreadRequest]) (*connect.Response[v1.PinThreadResponse], error)
	Archive(context.Context, *connect.Request[v1.ArchiveThreadRequest]) (*connect.Response[v1.ArchiveThreadResponse], error)
	Snooze(context.Context, *connect.Request[v1.SnoozeThreadRequest]) (*connect.Response[v1.SnoozeThreadResponse], error)
	// The conversation.
	ListItems(context.Context, *connect.Request[v1.ListThreadItemsRequest]) (*connect.Response[v1.ListThreadItemsResponse], error)
	Send(context.Context, *connect.Request[v1.SendThreadMessageRequest]) (*connect.Response[v1.SendThreadMessageResponse], error)
	Respond(context.Context, *connect.Request[v1.RespondThreadRequest]) (*connect.Response[v1.RespondThreadResponse], error)
	Interrupt(context.Context, *connect.Request[v1.InterruptThreadRequest]) (*connect.Response[v1.InterruptThreadResponse], error)
	SetModel(context.Context, *connect.Request[v1.SetThreadModelRequest]) (*connect.Response[v1.SetThreadModelResponse], error)
	SetPermissionMode(context.Context, *connect.Request[v1.SetThreadPermissionModeRequest]) (*connect.Response[v1.SetThreadPermissionModeResponse], error)
	SetEffort(context.Context, *connect.Request[v1.SetThreadEffortRequest]) (*connect.Response[v1.SetThreadEffortResponse], error)
	// Wait backs thread.wait (commands_thread_wait.go).
	Wait(context.Context, *connect.Request[v1.WaitThreadRequest]) (*connect.Response[v1.WaitThreadResponse], error)
	// McpBackend backs thread.mcp and thread.mcp-reconnect (commands_mcp.go).
	McpBackend
	// SlashBackend backs thread.commands (commands_slash.go).
	SlashBackend
	// MetadataBackend backs thread.label, thread.report and thread.budget
	// (commands_thread_metadata.go).
	MetadataBackend
	// SubscriptionBackend backs thread.subscribe, thread.unsubscribe and
	// thread.subscriptions (commands_thread_subscribe.go).
	SubscriptionBackend
}

var (
	_ ThreadBackend = codefoundryv1connect.ThreadServiceHandler(nil)
	_ ThreadBackend = codefoundryv1connect.ThreadServiceClient(nil)
)

// ThreadDecisions are thread.respond's decision values.
var ThreadDecisions = []string{"allow", "allow-session", "deny"}

var threadDecisions = map[string]v1.ThreadDecision{
	"allow":         v1.ThreadDecision_THREAD_DECISION_ALLOW,
	"allow-session": v1.ThreadDecision_THREAD_DECISION_ALLOW_FOR_SESSION,
	"deny":          v1.ThreadDecision_THREAD_DECISION_DENY,
}

// RegisterThread registers thread.send, thread.respond, thread.interrupt,
// thread.items, thread.read, thread.set-model, thread.set-mode, thread.set-effort, thread.wait,
// thread.subscribe, thread.unsubscribe and thread.subscriptions.
func RegisterThread(r *Registry, b ThreadBackend) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID, Description: "Thread id" + IDHelp}
	r.SetIDLister(ThreadID, threadIDs(b))
	r.SetIDLister(SubscriptionID, subscriptionIDs(b))
	return r.RegisterAll(
		Command{
			Name:  "thread.send",
			Title: "Send to Thread",
			Description: "Send a message to a thread, also while it works: Claude picks it up mid-turn. " +
				"A thread whose Claude is not running starts with it.",
			Category: "Thread",
			Args: []ArgSpec{
				idArg,
				{Name: "text", Type: String, Required: true, Positional: true, Description: "The message"},
				{Name: "attachments", Type: String, Description: "Comma-separated image or PDF paths from StageAttachment"},
				{Name: "composer-text", Type: String, Description: "The GUI composer's text with its tag tokens, kept on the message for display (the GUI sets it)"},
				{Name: "wait", Type: Bool, Description: "Then wait until Claude has answered the message and the thread is idle, and print the thread " +
					"like thread.wait (--json: the thread instead of the message item; exits 1 when the time runs out)"},
				withDefault(ArgSpec{Name: "for", Type: String, Description: "With wait: how long to wait at most, a Go duration such as 30s, 10m or 2h (at most 24h)"},
					waitForArg.Default),
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				var limit time.Duration
				if a.Bool("wait") {
					var err error
					if limit, err = waitLimit(a); err != nil {
						return Result{}, err
					}
				}
				res, err := b.Send(ctx, connect.NewRequest(&v1.SendThreadMessageRequest{
					ThreadId: a.String("id"), Text: a.String("text"), Attachments: splitList(a.String("attachments")),
					ComposerText: a.String("composer-text"),
				}))
				if err != nil {
					return Result{}, err
				}
				sent := "sent to thread " + a.String("id")
				if !a.Bool("wait") {
					return Result{Message: sent, JSON: res.Msg.GetItem()}, nil
				}
				// Past the message's own item: the status of the turn before it (still
				// "finished" until the new turn's busy is published) does not count.
				return waitThread(ctx, b, a.String("id"), "idle", res.Msg.GetItem().GetId(), limit, sent+"; ")
			},
		},
		Command{
			Name:  "thread.respond",
			Title: "Answer Thread Request",
			Description: "Answer a thread's pending permission request or question (default: the oldest pending one). " +
				"A question takes answer: the chosen option's label, or a JSON object of question to label.",
			Category:     "Thread",
			NoKeybinding: true,
			Args: []ArgSpec{
				idArg,
				{Name: "decision", Type: Enum, Enum: ThreadDecisions, Default: "allow", Positional: true,
					Description: "allow, allow-session (allow and keep Claude's suggested rule for the session), or deny"},
				{Name: "request", Type: String, Description: "Request id (default: the oldest pending request)"},
				{Name: "answer", Type: String, Description: `A question's answer: an option label (one question) or {"question": "label", ...}`},
				{Name: "message", Type: String, Description: "With deny: the reason Claude sees"},
				{Name: "interrupt", Type: Bool, Description: "With deny: also stop the turn"},
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				items, err := b.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{ThreadId: id}))
				if err != nil {
					return Result{}, err
				}
				snap := items.Msg.GetSnapshot()
				req := a.String("request")
				var pending *v1.ThreadPendingRequest
				for _, p := range snap.GetPending() {
					if req == "" || p.GetRequestId() == req {
						pending = p
						break
					}
				}
				if pending == nil {
					if req != "" {
						return Result{}, InvalidArg("request", "thread %s has no pending request %s", id, req)
					}
					return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("thread %s has no pending request", id))
				}
				msg := &v1.RespondThreadRequest{
					ThreadId: id, RequestId: pending.GetRequestId(), Decision: threadDecisions[a.String("decision")],
					Message: a.String("message"), Interrupt: a.Bool("interrupt"),
				}
				if pending.GetQuestion() && msg.Decision != v1.ThreadDecision_THREAD_DECISION_DENY {
					questions := questionTexts(snap, pending.GetItemId())
					if msg.Answers, err = parseAnswers(a.String("answer"), questions); err != nil {
						return Result{}, err
					}
				}
				res, err := b.Respond(ctx, connect.NewRequest(msg))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: fmt.Sprintf("%s: %s", pending.GetSummary(), describeRequest(res.Msg.GetItem())), JSON: res.Msg.GetItem()}, nil
			},
		},
		Command{
			Name:        "thread.interrupt",
			Title:       "Interrupt Thread",
			Description: "Stop a thread's running turn. Pending requests are withdrawn.",
			Category:    "Thread",
			// No keybinding: Escape (Claude Code's key) stopped turns by accident. The GUI
			// interrupts from the composer's Interrupt button only.
			Args: []ArgSpec{idArg},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if _, err := b.Interrupt(ctx, connect.NewRequest(&v1.InterruptThreadRequest{ThreadId: a.String("id")})); err != nil {
					return Result{}, err
				}
				return Result{Message: "interrupted thread " + a.String("id")}, nil
			},
		},
		Command{
			Name:         "thread.items",
			Title:        "Show Thread Conversation",
			Description:  "Print a thread's conversation as a readable log.",
			Category:     "Thread",
			NoKeybinding: true,
			Args: []ArgSpec{
				idArg,
				{Name: "full", Type: Bool, Description: "Print whole texts, tool inputs and outputs instead of one line each"},
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{ThreadId: a.String("id")}))
				if err != nil {
					return Result{}, err
				}
				snap := res.Msg.GetSnapshot()
				return Result{Message: FormatThreadItems(snap, a.Bool("full")), JSON: snap}, nil
			},
		},
		Command{
			Name:        "thread.set-model",
			Title:       "Set Thread Model",
			Description: "Switch a thread's model from its next request.",
			Category:    "Thread",
			Args: []ArgSpec{
				idArg,
				{Name: "model", Type: Enum, Enum: ThreadModels, Required: true, Positional: true, Description: threadModelHelp},
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.SetModel(ctx, connect.NewRequest(&v1.SetThreadModelRequest{ThreadId: a.String("id"), Model: a.String("model")}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetThread()
				return Result{Message: "thread " + threadLabel(s) + " uses " + model.Label(s.GetModel()), JSON: s}, nil
			},
		},
		Command{
			Name:        "thread.set-mode",
			Title:       "Set Thread Permissions",
			Description: "Switch a thread's permission mode: supervised (confirm every tool call), accept-edits, or auto.",
			Category:    "Thread",
			Args: []ArgSpec{
				idArg,
				{Name: "permission", Type: Enum, Enum: ThreadPermissions, Required: true, Positional: true, Description: "supervised, accept-edits, or auto"},
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.SetPermissionMode(ctx, connect.NewRequest(&v1.SetThreadPermissionModeRequest{
					ThreadId: a.String("id"), PermissionMode: threadPermissionModes[a.String("permission")],
				}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetThread()
				return Result{Message: "thread " + threadLabel(s) + " runs " + a.String("permission"), JSON: s}, nil
			},
		},
		Command{
			Name:  "thread.set-effort",
			Title: "Set Thread Effort",
			Description: "Change a thread's effort level. A running Claude restarts with it (resuming the " +
				"conversation) at once when idle, else when the running turn ends; otherwise the next message starts it with it.",
			Category: "Thread",
			Args: []ArgSpec{
				idArg,
				{Name: "effort", Type: Enum, Enum: ThreadEfforts, Required: true, Positional: true, Description: "low, medium, high, xhigh, or max"},
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.SetEffort(ctx, connect.NewRequest(&v1.SetThreadEffortRequest{ThreadId: a.String("id"), Effort: a.String("effort")}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetThread()
				msg := "thread " + threadLabel(s) + " restarts with effort " + s.GetEffort()
				switch {
				case s.GetEffortPending() && onTurn(s):
					msg = "thread " + threadLabel(s) + " switches to effort " + s.GetEffort() + " after this turn"
				case notRunning(s):
					msg = "thread " + threadLabel(s) + " uses effort " + s.GetEffort() + " from its next message"
				}
				return Result{Message: msg, JSON: s}, nil
			},
		},
		threadWait(b, idArg),
		threadRead(b, idArg),
		threadSubscribe(b),
		threadUnsubscribe(b),
		threadSubscriptions(b),
	)
}

// notRunning: s has no Claude process up (stopped, or on its way down); a setting
// applies when the next message starts it.
func notRunning(s *v1.Thread) bool {
	st := s.GetState()
	return st == v1.ThreadState_THREAD_STATE_DISCONNECTED || st == v1.ThreadState_THREAD_STATE_CLOSING
}

// questionTexts are the questions of the question item itemID.
func questionTexts(snap *v1.ThreadItemsSnapshot, itemID string) []string {
	for _, it := range snap.GetItems() {
		if it.GetId() != itemID || it.GetQuestion() == nil {
			continue
		}
		var in struct {
			Questions []struct {
				Question string `json:"question"`
			} `json:"questions"`
		}
		_ = json.Unmarshal([]byte(it.GetQuestion().GetInputJson()), &in)
		var out []string
		for _, q := range in.Questions {
			out = append(out, q.Question)
		}
		return out
	}
	return nil
}

// parseAnswers reads thread.respond's answer: a JSON object of question to label, or
// a bare label when there is exactly one question.
func parseAnswers(answer string, questions []string) (map[string]string, error) {
	answer = strings.TrimSpace(answer)
	if answer == "" {
		return nil, InvalidArg("answer", "this request is a question; give answer (questions: %s)", strings.Join(questions, " | "))
	}
	if strings.HasPrefix(answer, "{") {
		var m map[string]string
		if err := json.Unmarshal([]byte(answer), &m); err != nil {
			return nil, InvalidArg("answer", "answer is not a JSON object of question to label: %v", err)
		}
		return m, nil
	}
	if len(questions) != 1 {
		return nil, InvalidArg("answer", "there are %d questions; answer with a JSON object of question to label", len(questions))
	}
	return map[string]string{questions[0]: answer}, nil
}

// describeRequest is a resolved request's outcome, e.g. "allowed (allow_session)".
func describeRequest(it *v1.ThreadItem) string {
	r := it.GetPermission()
	if r == nil {
		r = it.GetQuestion()
	}
	if r == nil {
		return "answered"
	}
	out := strings.ToLower(strings.TrimPrefix(r.GetState().String(), "THREAD_REQUEST_STATE_"))
	if r.GetDecision() != "" {
		out += " (" + r.GetDecision() + ")"
	}
	if len(r.GetAnswers()) > 0 {
		keys := make([]string, 0, len(r.GetAnswers()))
		for k := range r.GetAnswers() {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		var parts []string
		for _, k := range keys {
			parts = append(parts, k+" = "+r.GetAnswers()[k])
		}
		out += ": " + strings.Join(parts, "; ")
	}
	if r.GetMessage() != "" {
		out += ": " + r.GetMessage()
	}
	return out
}

// FormatThreadItems renders a thread's items as a readable log, one entry per item
// (indented under the Agent call for a subagent's). full prints whole texts, tool
// inputs and outputs; otherwise each is cut to one line.
func FormatThreadItems(snap *v1.ThreadItemsSnapshot, full bool) string {
	var sb strings.Builder
	line := func(s string) string {
		s = strings.TrimSpace(s)
		if full {
			return s
		}
		first, rest, more := strings.Cut(s, "\n")
		if len([]rune(first)) > 160 {
			first = string([]rune(first)[:160]) + "…"
		} else if more && strings.TrimSpace(rest) != "" {
			first += " …"
		}
		return first
	}
	for _, it := range snap.GetItems() {
		indent := ""
		if it.GetParentToolUseId() != "" {
			indent = "    "
		}
		prefix := fmt.Sprintf("%s#%d ", indent, it.GetOrdinal())
		var body string
		switch {
		case it.GetUserMessage() != nil:
			u := it.GetUserMessage()
			body = "you: " + line(u.GetText())
			if u.GetOrigin() == v1.MessageOrigin_MESSAGE_ORIGIN_WAKE {
				// The daemon's, for a wake subscription (commands_thread_subscribe.go).
				body = "wake: " + line(u.GetWakeTitle())
			}
			for _, a := range u.GetAttachments() {
				kind := "image"
				if strings.EqualFold(filepath.Ext(a), ".pdf") {
					kind = "pdf"
				}
				body += "\n" + indent + "    [" + kind + " " + a + "]"
			}
		case it.GetAssistantText() != nil:
			body = "claude: " + line(it.GetAssistantText().GetText())
		case it.GetThinking() != nil:
			body = "thinking"
			if t := it.GetThinking().GetText(); t != "" {
				body += ": " + line(t)
			}
		case it.GetToolCall() != nil:
			t := it.GetToolCall()
			st := strings.ToLower(strings.TrimPrefix(t.GetStatus().String(), "TOOL_CALL_STATUS_"))
			body = fmt.Sprintf("tool %s [%s] %s", t.GetName(), st, line(t.GetInputJson()))
			if out := t.GetOutput(); out != "" {
				body += "\n" + indent + "    → " + line(out)
			}
		case it.GetPermission() != nil:
			r := it.GetPermission()
			body = fmt.Sprintf("permission %s %s: %s", r.GetToolName(), r.GetDescription(), describeRequest(it))
			if r.GetState() == v1.ThreadRequestState_THREAD_REQUEST_STATE_PENDING {
				body += " (request " + r.GetRequestId() + ")"
			}
		case it.GetQuestion() != nil:
			body = "question: " + describeRequest(it)
			for _, q := range questionTexts(snap, it.GetId()) {
				body += "\n" + indent + "    ? " + q
			}
			if it.GetQuestion().GetState() == v1.ThreadRequestState_THREAD_REQUEST_STATE_PENDING {
				body += "\n" + indent + "    (request " + it.GetQuestion().GetRequestId() + ")"
			}
		case it.GetTurnEnd() != nil:
			t := it.GetTurnEnd()
			body = fmt.Sprintf("turn end: %s, %.1fs, %d in / %d out tokens", t.GetSubtype(),
				float64(t.GetDurationMs())/1000, t.GetInputTokens()+t.GetCacheReadTokens()+t.GetCacheWriteTokens(), t.GetOutputTokens())
			if t.TurnCostUsd != nil {
				body += fmt.Sprintf(", $%.4f", t.GetTurnCostUsd())
			}
			if t.GetCostUsd() > 0 {
				// None on a turn end the daemon wrote for a process that ended first.
				body += fmt.Sprintf(", $%.4f so far", t.GetCostUsd())
			}
			if t.GetModel() != "" {
				body += ", " + t.GetModel()
			}
			if t.GetInterrupted() {
				body += " (interrupted)"
			}
		case it.GetError() != nil:
			body = "error: " + line(it.GetError().GetText())
		case it.GetCompaction() != nil:
			c := it.GetCompaction()
			body = fmt.Sprintf("compaction (%s, %d → %d tokens)", c.GetTrigger(), c.GetPreTokens(), c.GetPostTokens())
			if full && c.GetSummary() != "" {
				body += "\n" + c.GetSummary()
			}
		case it.GetCommandOutput() != nil:
			body = "output: " + line(it.GetCommandOutput().GetText())
		case it.GetNote() != nil:
			body = "note: " + line(it.GetNote().GetText())
		default:
			body = "(unknown item " + it.GetId() + ")"
		}
		if it.GetStreaming() {
			body += " …"
		}
		sb.WriteString(prefix + body + "\n")
	}
	if len(snap.GetItems()) == 0 {
		sb.WriteString("(no items yet)\n")
	}
	return strings.TrimRight(sb.String(), "\n")
}

// onTurn: the thread is on a turn (working, or waiting on a permission or a question
// mid-turn), so an effort change waits for its end. "finished" or a turn's error waits
// for nobody: the restart is immediate.
func onTurn(s *v1.Thread) bool {
	switch s.GetStatus() {
	case v1.ThreadStatus_THREAD_STATUS_BUSY:
		return true
	case v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION:
		r := s.GetStatusReason()
		return strings.HasPrefix(r, "permission") || strings.HasPrefix(r, "question")
	}
	return false
}
