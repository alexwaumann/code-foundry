package thread

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// passUpItems are the passed-up question items in items.
func passUpItems(items []Item) []Item {
	var out []Item
	for _, it := range items {
		if it.Kind == KindQuestion && it.Request != nil && it.Request.PassedUp != nil {
			out = append(out, it)
		}
	}
	return out
}

// worker makes a stopped thread created by lead.
func (e *env) worker(name, lead string) Thread {
	e.t.Helper()
	w := e.stopped(name)
	e.m.update(w.ID, false, func(rec *record) { rec.s.CreatedBy = lead })
	return w
}

// asked sets w's latest thread ask, as Ask does, without its wake.
func (e *env) asked(w, question, assuming string) {
	e.t.Helper()
	e.m.update(w, false, func(rec *record) {
		rec.s.Asked = &ThreadAsked{Question: question, Assuming: assuming, At: e.m.opts.Now().Round(0).Truncate(time.Millisecond)}
	})
}

func TestPassUpRefusals(t *testing.T) {
	tests := []struct {
		name  string
		setup func(e *env, lead, w, other Thread) (by, worker, req string)
		want  error
		says  string
	}{
		{"no lead", func(e *env, _, w, _ Thread) (string, string, string) {
			e.asked(w.ID, "q?", "a")
			return "", w.ID, ""
		}, ErrInvalidArgument, "only a lead"},
		{"not its worker", func(e *env, _, w, other Thread) (string, string, string) {
			e.asked(w.ID, "q?", "a")
			return other.ID, w.ID, ""
		}, ErrFailedPrecondition, "did not create"},
		{"the worker passing up its lead's", func(e *env, lead, w, _ Thread) (string, string, string) {
			e.asked(lead.ID, "q?", "a")
			return w.ID, lead.ID, ""
		}, ErrFailedPrecondition, "did not create"},
		{"nothing open", func(_ *env, lead, w, _ Thread) (string, string, string) {
			return lead.ID, w.ID, ""
		}, ErrFailedPrecondition, "no open question"},
		{"an ask the lead answered", func(e *env, lead, w, _ Thread) (string, string, string) {
			e.asked(w.ID, "q?", "a")
			time.Sleep(2 * time.Millisecond)
			if _, err := e.m.Send(e.ctx(), w.ID, Message{Text: "use b", ByThreadID: lead.ID, Reply: ReplyNone}); err != nil {
				e.t.Fatal(err)
			}
			return lead.ID, w.ID, ""
		}, ErrFailedPrecondition, "was answered"},
		{"an unknown request", func(e *env, lead, w, _ Thread) (string, string, string) {
			e.asked(w.ID, "q?", "a")
			return lead.ID, w.ID, "nope"
		}, ErrFailedPrecondition, "no pending request nope"},
		{"an archived worker", func(e *env, lead, w, _ Thread) (string, string, string) {
			e.asked(w.ID, "q?", "a")
			e.m.update(w.ID, false, func(rec *record) { rec.s.ArchivedAt = time.Now() })
			return lead.ID, w.ID, ""
		}, ErrFailedPrecondition, "archived"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			lead, other := e.stopped("lead"), e.stopped("other")
			w := e.worker("worker", lead.ID)
			by, worker, req := tt.setup(e, lead, w, other)
			_, err := e.m.PassUp(e.ctx(), by, worker, req)
			if !errors.Is(err, tt.want) || !strings.Contains(err.Error(), tt.says) {
				t.Errorf("err = %v", err)
			}
			for _, id := range []string{lead.ID, other.ID, w.ID} {
				if n := len(passUpItems(e.items(id).Items)); n != 0 {
					t.Errorf("%s has %d passed-up items", id, n)
				}
			}
		})
	}
}

// A thread ask passed up: the lead shows the worker's question as its own, the user's
// answer reaches the worker as the lead's message, and the lead is told.
func TestPassUpAsk(t *testing.T) {
	e := newEnv(t)
	lead := e.stopped("lead")
	w := e.worker("Resize", lead.ID)
	e.asked(w.ID, "Should the body drag too?", "only the gutters")
	res, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != PassUpAsk || res.Question != "Should the body drag too?" || res.Worker.ID != w.ID {
		t.Errorf("result = %+v", res)
	}
	snap := e.items(lead.ID)
	if len(snap.Pending) != 1 || snap.Pending[0].From != w.ID || snap.Pending[0].Summary != "From Resize: Should the body drag too?" {
		t.Fatalf("pending = %+v", snap.Pending)
	}
	it := passUpItems(snap.Items)[0]
	if p := it.Request.PassedUp; p.Kind != PassUpAsk || p.Assuming != "only the gutters" || p.FromName != "Resize" || it.Request.State != RequestPending {
		t.Errorf("item = %+v %+v", it.Request, p)
	}
	l := e.waitFor(lead.ID, "the overlay", func(s Thread) bool {
		return s.Status == StatusNeedsAttention && s.StatusReason == "question: From Resize: Should the body drag too?"
	})
	if l.PassedUp != 1 {
		t.Errorf("PassedUp = %d", l.PassedUp)
	}
	if _, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, ""); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "already passed up") {
		t.Errorf("twice: %v", err)
	}
	if _, err := e.m.Respond(e.ctx(), lead.ID, snap.Pending[0].RequestID, Decision{Allow: true}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("no answer: %v", err)
	}
	got, err := e.m.Respond(e.ctx(), lead.ID, snap.Pending[0].RequestID,
		Decision{Allow: true, Answers: map[string]string{"Should the body drag too?": "The body too"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Request.State != RequestAllowed || got.Request.Answers["Should the body drag too?"] != "The body too" {
		t.Errorf("answered = %+v", got.Request)
	}
	items := e.waitItems(w.ID, "the answer", func(items []Item) bool {
		for _, it := range items {
			if it.Kind == KindUserMessage && it.SentBy == lead.ID && strings.Contains(it.Text, "> The body too") {
				return true
			}
		}
		return false
	})
	for _, it := range items {
		if it.Kind == KindUserMessage && it.SentBy == lead.ID && (it.SenderRelation != RelationLead || it.Reply != ReplyNone) {
			t.Errorf("the answer's mark = %q %q", it.SenderRelation, it.Reply)
		}
	}
	li := e.waitItems(lead.ID, "the lead told", func(items []Item) bool { return len(wakes(items)) == 1 })
	wk := wakes(li)[0]
	for _, want := range []string{"The user answered the question you passed up from thread \"Resize\"", "> The body too",
		"as a message from you", "do not pass it on", WakeReplyNote} {
		if !strings.Contains(wk.Text, want) {
			t.Errorf("wake lacks %q:\n%s", want, wk.Text)
		}
	}
	if !strings.Contains(wk.WakeJSON, `"kind": "answer"`) || !strings.Contains(wk.WakeJSON, `"thread": "`+w.ID+`"`) {
		t.Errorf("wake json %s", wk.WakeJSON)
	}
	e.waitFor(lead.ID, "the overlay gone", func(s Thread) bool { return !strings.HasPrefix(s.StatusReason, "question: From") && s.PassedUp == 0 })
	if p := e.items(lead.ID).Pending; len(p) != 0 {
		t.Errorf("still pending %+v", p)
	}
	if _, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, ""); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("after the answer: %v", err)
	}
}

// Skipping a passed-up ask sends the worker nothing and tells the lead it was skipped.
func TestPassUpAskSkipped(t *testing.T) {
	e := newEnv(t)
	lead := e.stopped("lead")
	w := e.worker("Resize", lead.ID)
	e.asked(w.ID, "Which?", "a")
	if _, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, ""); err != nil {
		t.Fatal(err)
	}
	p := e.items(lead.ID).Pending[0]
	got, err := e.m.Respond(e.ctx(), lead.ID, p.RequestID, Decision{})
	if err != nil || got.Request.State != RequestDenied {
		t.Fatalf("skip = %+v %v", got.Request, err)
	}
	wk := wakes(e.waitItems(lead.ID, "told", func(items []Item) bool { return len(wakes(items)) == 1 }))[0]
	if !strings.Contains(wk.Text, "The user skipped the question you passed up") || !strings.Contains(wk.Text, "goes on with its assumption") ||
		!strings.Contains(wk.WakeJSON, `"skipped": true`) {
		t.Errorf("wake:\n%s\n%s", wk.Text, wk.WakeJSON)
	}
	for _, it := range e.items(w.ID).Items {
		if it.Kind == KindUserMessage && it.SentBy == lead.ID {
			t.Errorf("the worker got %q", it.Text)
		}
	}
}

// A pending question-tool prompt passed up: the user's answer answers the worker's prompt
// exactly as in its own thread.
func TestPassUpQuestionTool(t *testing.T) {
	e := newFixtureEnv(t, "ask")
	lead := e.stopped("lead")
	w := e.create(CreateOptions{Name: "Colour", InitialPrompt: "ask me", CreatedBy: lead.ID})
	e.waitFor(w.ID, "its question", func(s Thread) bool { return s.StatusReason == "question: Which color do you prefer?" })
	wp := e.items(w.ID).Pending[0]
	res, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, "")
	if err != nil || res.Kind != PassUpQuestion {
		t.Fatalf("pass up = %+v %v", res, err)
	}
	snap := e.items(lead.ID)
	it := passUpItems(snap.Items)[0]
	wi, _ := lastKind(e.items(w.ID).Items, KindQuestion)
	if it.Request.InputJSON != wi.Request.InputJSON || it.Request.PassedUp.WorkerRequest != wp.RequestID {
		t.Errorf("item %+v vs %+v", it.Request, wi.Request)
	}
	if _, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, wp.RequestID); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "already") {
		t.Errorf("twice: %v", err)
	}
	if _, err := e.m.Respond(e.ctx(), lead.ID, snap.Pending[0].RequestID,
		Decision{Allow: true, Answers: map[string]string{"Which color do you prefer?": "Blue"}}); err != nil {
		t.Fatal(err)
	}
	ans := e.waitSent("the worker's answer", func(m map[string]any) bool { return m["type"] == "control_response" })
	up := ans["response"].(map[string]any)["response"].(map[string]any)["updatedInput"].(map[string]any)
	if up["answers"].(map[string]any)["Which color do you prefer?"] != "Blue" {
		t.Errorf("updatedInput %v", up)
	}
	wq, _ := lastKind(e.waitItems(w.ID, "answered", func(items []Item) bool {
		q, _ := lastKind(items, KindQuestion)
		return q.Request.State == RequestAllowed
	}), KindQuestion)
	if wq.Request.Answers["Which color do you prefer?"] != "Blue" {
		t.Errorf("worker's item %+v", wq.Request)
	}
	wk := wakes(e.waitItems(lead.ID, "told", func(items []Item) bool { return len(wakes(items)) == 1 }))[0]
	if !strings.Contains(wk.Text, "> Blue") || !strings.Contains(wk.Text, "went straight to the worker") || strings.Contains(wk.Text, "as a message from you") {
		t.Errorf("wake:\n%s", wk.Text)
	}
	li, _ := e.m.Items(e.ctx(), lead.ID)
	if q := passUpItems(li.Items)[0]; q.Request.State != RequestAllowed {
		t.Errorf("lead's item %+v", q.Request)
	}
}

// A permission prompt is never passed up.
func TestPassUpRefusesAPermission(t *testing.T) {
	e := newFixtureEnv(t, "write-allow")
	lead := e.stopped("lead")
	w := e.create(CreateOptions{Name: "Writer", InitialPrompt: "write", CreatedBy: lead.ID})
	e.waitFor(w.ID, "its permission", func(s Thread) bool { return strings.HasPrefix(s.StatusReason, "permission:") })
	p := e.items(w.ID).Pending[0]
	for _, req := range []string{"", p.RequestID} {
		_, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, req)
		if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "permission prompt: never pass one up") ||
			!strings.Contains(err.Error(), "thread respond --id "+w.ID) {
			t.Errorf("request %q: %v", req, err)
		}
	}
	if n := len(passUpItems(e.items(lead.ID).Items)); n != 0 {
		t.Errorf("%d items on the lead", n)
	}
}

// What withdraws an open passed-up question, and that the lead's own process ending does not.
func TestPassUpWithdrawn(t *testing.T) {
	tests := []struct {
		name string
		act  func(e *env, lead, w Thread, workerReq string)
		why  string
	}{
		{"answered in the worker's thread", func(e *env, _, w Thread, req string) {
			if _, err := e.m.Respond(e.ctx(), w.ID, req, Decision{Allow: true, Answers: map[string]string{"Which color do you prefer?": "Red"}}); err != nil {
				e.t.Fatal(err)
			}
		}, "answered or withdrawn"},
		{"the worker's process closed", func(e *env, _, w Thread, _ string) {
			if err := e.m.Close(e.ctx(), w.ID); err != nil {
				e.t.Fatal(err)
			}
		}, "answered or withdrawn"},
		{"the worker archived", func(e *env, _, w Thread, _ string) {
			if _, err := e.m.Archive(e.ctx(), w.ID, true); err != nil {
				e.t.Fatal(err)
			}
		}, "withdrawn"},
		{"the worker removed", func(e *env, _, w Thread, _ string) {
			if err := e.m.Remove(e.ctx(), w.ID); err != nil {
				e.t.Fatal(err)
			}
		}, "withdrawn"},
		{"the lead archived", func(e *env, lead, _ Thread, _ string) {
			if _, err := e.m.Archive(e.ctx(), lead.ID, true); err != nil && !errors.As(err, new(*CascadeError)) {
				e.t.Fatal(err)
			}
		}, "withdrawn"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newFixtureEnv(t, "ask")
			lead := e.stopped("lead")
			w := e.create(CreateOptions{Name: "Colour", InitialPrompt: "ask me", CreatedBy: lead.ID})
			e.waitFor(w.ID, "its question", func(s Thread) bool { return s.StatusReason == "question: Which color do you prefer?" })
			req := e.items(w.ID).Pending[0].RequestID
			if _, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, ""); err != nil {
				t.Fatal(err)
			}
			e.waitFor(lead.ID, "the overlay", func(s Thread) bool { return s.PassedUp == 1 })
			tt.act(e, lead, w, req)
			items := e.waitItems(lead.ID, "withdrawn", func(items []Item) bool {
				q := passUpItems(items)
				return len(q) == 1 && q[0].Request.State == RequestCancelled
			})
			if q := passUpItems(items)[0]; !strings.Contains(q.Request.Message, tt.why) {
				t.Errorf("message %q", q.Request.Message)
			}
			l := e.waitFor(lead.ID, "the overlay gone", func(s Thread) bool { return s.PassedUp == 0 })
			if strings.HasPrefix(l.StatusReason, "question: From") {
				t.Errorf("status %q", l.StatusReason)
			}
			time.Sleep(50 * time.Millisecond)
			if n := len(wakes(e.items(lead.ID).Items)); n != 0 {
				t.Errorf("%d wakes to the lead", n)
			}
		})
	}
}

// The lead's own process ending keeps the question; a daemon restart withdraws it, and the
// row never saved the overlay.
func TestPassUpOutlivesTheLeadsProcessNotARestart(t *testing.T) {
	e := newEnv(t)
	lead := e.connected(CreateOptions{Name: "lead"})
	w := e.worker("Resize", lead.ID)
	e.asked(w.ID, "Which?", "a")
	if _, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Close(e.ctx(), lead.ID); err != nil {
		t.Fatal(err)
	}
	l := e.waitFor(lead.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
	if l.PassedUp != 1 || l.StatusReason != "question: From Resize: Which?" {
		t.Errorf("stopped lead = %d %q", l.PassedUp, l.StatusReason)
	}
	if p := e.items(lead.ID).Pending; len(p) != 1 {
		t.Errorf("pending after the close = %+v", p)
	}
	e.restart()
	l = e.waitFor(lead.ID, "loaded", func(Thread) bool { return true })
	if l.PassedUp != 0 || strings.HasPrefix(l.StatusReason, "question: From") {
		t.Errorf("after a restart = %d %q", l.PassedUp, l.StatusReason)
	}
	q := passUpItems(e.items(lead.ID).Items)
	if len(q) != 1 || q[0].Request.State != RequestCancelled || !strings.Contains(q[0].Request.Message, "restarted") {
		t.Errorf("item after a restart = %+v", q)
	}
}

// A snoozed lead shows its passed-up question like any thread that needs the user, and
// stays snoozed with the same time through the answer and the wake that tells it.
func TestPassUpSnoozedLead(t *testing.T) {
	e := newEnv(t)
	lead := e.stopped("lead")
	w := e.worker("Resize", lead.ID)
	until := time.Now().Add(time.Hour).Round(time.Millisecond)
	if _, err := e.m.Snooze(e.ctx(), lead.ID, until); err != nil {
		t.Fatal(err)
	}
	e.asked(w.ID, "Which?", "a")
	if _, err := e.m.PassUp(e.ctx(), lead.ID, w.ID, ""); err != nil {
		t.Fatal(err)
	}
	l := e.waitFor(lead.ID, "asking", func(s Thread) bool { return s.StatusReason == "question: From Resize: Which?" })
	if !l.SnoozedUntil.Equal(until) {
		t.Errorf("snoozed until %v", l.SnoozedUntil)
	}
	p := e.items(lead.ID).Pending[0]
	if _, err := e.m.Respond(e.ctx(), lead.ID, p.RequestID, Decision{Allow: true, Answers: map[string]string{"Which?": "b"}}); err != nil {
		t.Fatal(err)
	}
	e.waitItems(lead.ID, "told", func(items []Item) bool { return len(wakes(items)) == 1 && hasTurnEnd(items) })
	l = e.waitFor(lead.ID, "back", func(s Thread) bool { return s.PassedUp == 0 && !strings.HasPrefix(s.StatusReason, "question:") })
	if !l.SnoozedUntil.Equal(until) {
		t.Errorf("after: snoozed until %v", l.SnoozedUntil)
	}
}

// A thread above the worker's lead may pass up its question too (the creator chain).
func TestPassUpByAGrandLead(t *testing.T) {
	e := newEnv(t)
	top := e.stopped("top")
	lead := e.worker("lead", top.ID)
	w := e.worker("w", lead.ID)
	e.asked(w.ID, "Which?", "a")
	if _, err := e.m.PassUp(e.ctx(), top.ID, w.ID, ""); err != nil {
		t.Fatal(err)
	}
	if n := len(passUpItems(e.items(top.ID).Items)); n != 1 {
		t.Errorf("%d items on the top thread", n)
	}
}

func TestPassUpLines(t *testing.T) {
	q := &wakePending{Kind: "question", RequestID: "r", Question: "Which?"}
	perm := &wakePending{Kind: "permission", RequestID: "r", Tool: "Bash"}
	for _, tt := range []struct {
		name string
		got  string
		want bool
	}{
		{"a question to its lead", pendingText("s-1", q, true), true},
		{"a question to another", pendingText("s-1", q, false), false},
		{"a permission to its lead", pendingText("s-1", perm, true), false},
		{"an ask", askWake(Thread{ID: "s-1"}, "Which?", "a", time.Now()).Text, true},
	} {
		if has := strings.Contains(tt.got, PassUpLine("s-1")); has != tt.want {
			t.Errorf("%s: pass-up line %v in:\n%s", tt.name, has, tt.got)
		}
	}
	if !strings.Contains(PassUpLine("s-1"), "code-foundry thread pass-up s-1") {
		t.Error(PassUpLine("s-1"))
	}
}
