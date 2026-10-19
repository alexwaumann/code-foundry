package thread

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

// What a thread wake says beyond the row (docs/notes/wake-detail.md): a missing or
// stale report with the turn's last message, the pending request, the children.
func TestWakeDetailOf(t *testing.T) {
	t0 := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	user := func(at time.Time) Item { return Item{Kind: KindUserMessage, Text: "do it", CreatedAt: at} }
	said := func(text string) Item { return Item{Kind: KindAssistantText, Text: text} }
	perm := func(id, desc, input string, state RequestState) Item {
		return Item{ID: "perm-" + id, Kind: KindPermission, Request: &Request{RequestID: id, ToolName: "Bash", Description: desc, InputJSON: input, State: state}}
	}
	question := Item{ID: "q-q1", Kind: KindQuestion, Request: &Request{RequestID: "q1", ToolName: "AskUserQuestion", State: RequestPending,
		InputJSON: `{"questions":[{"question":"Which license?","options":[{"label":"MIT (Recommended)"},{"label":"Apache-2.0"}]},` +
			`{"question":"Year?","options":[{"label":"2026"}]}]}`}}
	finished := Thread{State: StateConnected, Status: StatusNeedsAttention, StatusReason: "finished"}
	reported := func(th Thread, at time.Time) Thread {
		th.Report = Report{Status: ReportDone, Summary: "did it", At: at}
		return th
	}
	asking := func(reason, id string) Thread {
		return Thread{State: StateConnected, Status: StatusNeedsAttention, StatusReason: reason, PendingRequestID: id}
	}
	long := strings.Repeat("word ", 200)
	tests := []struct {
		name               string
		t                  Thread
		items              []Item
		noReport, stale    bool
		last               string
		pendingID          string
		pendingQ           string
		pendingOptions     []string
		pendingQuestions   int
		pendingInputString bool
	}{
		{name: "a prose question, no report", t: finished,
			items:    []Item{user(t0), said("Looking."), said("Which formats should I accept:\nJSON, text or CSV?")},
			noReport: true, last: "Which formats should I accept: JSON, text or CSV?"},
		{name: "a current report", t: reported(finished, t0.Add(time.Minute)), items: []Item{user(t0), said("Done.")}},
		{name: "a report from before the last message", t: reported(finished, t0.Add(time.Minute)),
			items: []Item{user(t0), said("Done."), user(t0.Add(2 * time.Minute)), said("Rebased.")}, stale: true, last: "Rebased."},
		{name: "a turn with no text says nothing", t: finished, items: []Item{said("Old."), user(t0)}, noReport: true},
		{name: "a subagent's text is not the thread's",
			t: finished, items: []Item{user(t0), said("Mine."), {Kind: KindAssistantText, Text: "Agent's.", ParentToolUseID: "tu1"}},
			noReport: true, last: "Mine."},
		{name: "the last message is cut", t: finished, items: []Item{user(t0), said(long)}, noReport: true,
			last: oneLine(long, maxLastMessage)},
		{name: "a prompt by id", t: asking("permission: Bash Commit", "r2"),
			items:     []Item{user(t0), perm("r1", "Commit", `{"command":"git commit"}`, RequestAllowed), perm("r2", "Commit", `{"command":"git push"}`, RequestPending)},
			pendingID: "r2"},
		{name: "a prompt by reason", t: asking("permission: Bash Commit", ""),
			items:     []Item{user(t0), perm("r1", "Commit", `{}`, RequestAllowed), perm("r2", "Push", `{}`, RequestPending), perm("r3", "Commit", `{}`, RequestPending)},
			pendingID: "r3"},
		{name: "a prompt answered meanwhile", t: asking("permission: Bash Commit", ""),
			items: []Item{perm("r1", "Commit", `{}`, RequestAllowed)}},
		{name: "a long input is cut", t: asking("permission: Bash Big", "r1"),
			items:     []Item{perm("r1", "Big", `{"command":"`+strings.Repeat("é", maxPendingInput)+`"}`, RequestPending)},
			pendingID: "r1", pendingInputString: true},
		{name: "a question with its labels", t: asking("question: Which license?", "q1"), items: []Item{user(t0), question},
			pendingID: "q1", pendingQ: "Which license?", pendingOptions: []string{"MIT (Recommended)", "Apache-2.0"}, pendingQuestions: 2},
		{name: "a stale report under a prompt is flagged, no last message",
			t:     reported(asking("permission: Bash Commit", "r1"), t0),
			items: []Item{user(t0.Add(time.Minute)), perm("r1", "Commit", `{}`, RequestPending)}, stale: true, pendingID: "r1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := wakeDetailOf(tt.t, tt.items, wakeChildren{})
			if d.noReport != tt.noReport || d.staleReport != tt.stale || d.lastMessage != tt.last {
				t.Errorf("noReport %v stale %v last %q, want %v %v %q", d.noReport, d.staleReport, d.lastMessage, tt.noReport, tt.stale, tt.last)
			}
			var id string
			if d.pending != nil {
				id = d.pending.RequestID
			}
			if id != tt.pendingID {
				t.Fatalf("pending = %+v, want %q", d.pending, tt.pendingID)
			}
			if d.pending == nil {
				return
			}
			p := d.pending
			if p.Question != tt.pendingQ || !slices.Equal(p.Options, tt.pendingOptions) || len(p.Questions) != tt.pendingQuestions {
				t.Errorf("question = %q %q %d", p.Question, p.Options, len(p.Questions))
			}
			if s, isString := p.Input.(string); isString != tt.pendingInputString ||
				(isString && (len(s) > maxPendingInput+80 || !strings.Contains(s, "more bytes; thread read --full"))) {
				t.Errorf("input = %T %.80v", p.Input, p.Input)
			}
			if tt.pendingQ != "" && p.Kind != "question" || tt.pendingQ == "" && p.Kind != "permission" {
				t.Errorf("kind = %q", p.Kind)
			}
		})
	}
}

func TestThreadWakeTitleDetail(t *testing.T) {
	at := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	named := func(status Status, reason string) Thread {
		return Thread{ID: "s-1", Name: "Add LICENSE", State: StateConnected, Status: status, StatusReason: reason}
	}
	withReport := func(th Thread) Thread {
		th.Report = Report{Status: ReportProgress, Summary: "2 workers started", At: at}
		return th
	}
	tests := []struct {
		name string
		c    Condition
		t    Thread
		d    wakeDetail
		want string
	}{
		{"finished, no report", CondSettled, named(StatusNeedsAttention, "finished"), wakeDetail{noReport: true},
			`Thread "Add LICENSE" (s-1) needs attention: finished without a report.`},
		{"idle at prompt, no report", CondIdle, named(StatusIdle, "at prompt"), wakeDetail{noReport: true},
			`Thread "Add LICENSE" (s-1) is idle: at prompt (no report).`},
		{"an interrupted turn", CondSettled, named(StatusError, ReasonInterrupted), wakeDetail{noReport: true},
			`Thread "Add LICENSE" (s-1) has an error: interrupted (no report).`},
		{"a stale report is not quoted", CondSettled, withReport(named(StatusNeedsAttention, "finished")), wakeDetail{staleReport: true},
			`Thread "Add LICENSE" (s-1) needs attention: finished (report is from before its last message).`},
		{"a current report", CondSettled, withReport(named(StatusNeedsAttention, "finished")), wakeDetail{},
			`Thread "Add LICENSE" (s-1) needs attention: finished. Report: progress — 2 workers started.`},
		{"children working", CondSettled, withReport(named(StatusNeedsAttention, "finished")),
			wakeDetail{children: wakeChildren{Working: 2, Reported: 1, Total: 3}},
			`Thread "Add LICENSE" (s-1) needs attention: finished; 2 of its 3 child threads still working. Report: progress — 2 workers started.`},
		{"its one child working", CondSettled, named(StatusNeedsAttention, "finished"),
			wakeDetail{noReport: true, children: wakeChildren{Working: 1, Total: 1}},
			`Thread "Add LICENSE" (s-1) needs attention: finished without a report; its child thread is still working.`},
		{"children all settled say nothing", CondSettled, named(StatusNeedsAttention, "finished"),
			wakeDetail{noReport: true, children: wakeChildren{Reported: 3, Total: 3}},
			`Thread "Add LICENSE" (s-1) needs attention: finished without a report.`},
		{"a prompt keeps its reason; a stale report is not quoted", CondSettled,
			withReport(named(StatusNeedsAttention, "permission: Bash Stage, commit, and push.")), wakeDetail{staleReport: true},
			`Thread "Add LICENSE" (s-1) needs attention: permission: Bash Stage, commit, and push.`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := threadWakeTitle(tt.c, tt.t, tt.d); got != tt.want {
				t.Errorf("title =\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
	// Long parts are cut; the header stays near 300 characters.
	huge := Thread{ID: "s-123456789abc", Name: strings.Repeat("n", 200), State: StateConnected, Status: StatusNeedsAttention,
		StatusReason: "question: " + strings.Repeat("q", 400)}
	if got := threadWakeTitle(CondSettled, huge, wakeDetail{children: wakeChildren{Working: 12, Total: 30}}); len([]rune(got)) > 300 {
		t.Errorf("title is %d runes: %s", len([]rune(got)), got)
	}
}

func TestThreadWakeDetailJSON(t *testing.T) {
	at := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	th := Thread{ID: "s-1", State: StateConnected, Status: StatusNeedsAttention, StatusReason: "permission: Bash Push", CreatedBy: "s-p"}
	d := wakeDetail{noReport: true, lastMessage: "Shall I push?", children: wakeChildren{Working: 1, Reported: 2, Total: 3},
		pending: wakePendingOf(Item{Kind: KindPermission, Request: &Request{RequestID: "r1", ToolName: "Bash", InputJSON: `{"command":"git push"}`}})}
	var p struct {
		Thread struct {
			ReportStale bool   `json:"report_stale"`
			LastMessage string `json:"last_message"`
			Pending     struct {
				Kind      string          `json:"kind"`
				RequestID string          `json:"request_id"`
				Tool      string          `json:"tool"`
				Input     json.RawMessage `json:"input"`
			} `json:"pending"`
			Children wakeChildren `json:"children"`
		} `json:"thread"`
	}
	msg := threadWake(Subscription{ID: "sub-1", Condition: CondSettled}, th, at, d)
	if err := json.Unmarshal([]byte(msg.WakeJSON), &p); err != nil {
		t.Fatal(err)
	}
	got := p.Thread
	if !got.ReportStale || got.LastMessage != "Shall I push?" || got.Pending.Kind != "permission" || got.Pending.RequestID != "r1" ||
		got.Pending.Tool != "Bash" || !strings.Contains(string(got.Pending.Input), `"command": "git push"`) || got.Children != (wakeChildren{1, 2, 3}) {
		t.Errorf("payload:\n%s", msg.WakeJSON)
	}
	// None of it when there is nothing to say.
	plain := threadWake(Subscription{ID: "sub-1", Condition: CondSettled}, th, at, wakeDetail{})
	for _, key := range []string{"report_stale", "last_message", "pending", "children"} {
		if strings.Contains(plain.WakeJSON, `"`+key+`"`) {
			t.Errorf("plain JSON has %s:\n%s", key, plain.WakeJSON)
		}
	}
}

// End to end in the store: the wake reads the target's items when it is sent and counts
// its children when it fires.
func TestThreadWakeDetailDelivered(t *testing.T) {
	e := newEnv(t)
	top, lead := e.stopped("top"), e.stopped("lead")
	var kids []Thread
	for _, name := range []string{"w1", "w2", "w3"} {
		k := e.stopped(name)
		if _, ok := e.m.update(k.ID, false, func(rec *record) { rec.s.CreatedBy = lead.ID }); !ok {
			t.Fatal("no child")
		}
		kids = append(kids, k)
	}
	e.setStep(kids[0].ID, busy)
	e.setStep(kids[1].ID, busy)
	if _, err := e.m.Report(e.ctx(), kids[2].ID, Report{Status: ReportDone, Summary: "ok"}); err != nil {
		t.Fatal(err)
	}
	e.putItems(lead.ID, Item{ID: "u1", Kind: KindUserMessage, Text: "lead it"}, Item{ID: "a1", Kind: KindAssistantText, Text: "Started w1-w3; waiting."})
	e.setStep(lead.ID, busy)
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: top.ID, TargetThreadID: lead.ID, Repeat: true}); err != nil {
		t.Fatal(err)
	}
	e.setStep(lead.ID, finished)
	items := e.waitItems(top.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	want := `Thread "lead" (` + lead.ID + `) needs attention: finished without a report; 2 of its 3 child threads still working.`
	if w.WakeTitle != want || !strings.Contains(w.WakeJSON, `"last_message": "Started w1-w3; waiting."`) ||
		!strings.Contains(w.WakeJSON, `"report_stale": true`) || !strings.Contains(w.WakeJSON, `"working": 2`) {
		t.Errorf("wake:\n%s\n%s", w.WakeTitle, w.WakeJSON)
	}
	// An archived child is not counted.
	if _, err := e.m.Archive(e.ctx(), kids[2].ID, true); err != nil {
		t.Fatal(err)
	}
	e.setStep(lead.ID, busy)
	e.setStep(lead.ID, finished)
	items = e.waitItems(top.ID, "the second wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	if w := wakes(items)[1]; !strings.Contains(w.WakeTitle, "; 2 of its 2 child threads still working.") {
		t.Errorf("second wake: %s", w.WakeTitle)
	}
}
