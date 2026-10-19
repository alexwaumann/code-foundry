package thread

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Firing and delivering wakes (subscriptions.go, docs/notes/agents-4-wake.md,
// docs/notes/wake-detail.md).
//
// A wake is a user message (Origin OriginWake) whose text is one header line, then a
// fenced JSON block:
//
//	[code-foundry wake] Thread "Write retry backoff tests" (s-…) needs attention: finished. Report: done — 6 table tests.
//	```json
//	{ "kind": "thread", "subscription_id": "sub-…", "condition": "settled", "fired_at": "…", "thread": { … } }
//	```
//
// A thread wake says what its target's row does not: a turn that ended with no report,
// or one filed before the thread's last message, is "finished without a report" or
// "(report is from before its last message)", with "report_stale" and the turn's
// "last_message" in the JSON; a pending permission prompt or question comes whole in
// "pending" (request id, tool, input, a question's option labels); a thread that
// created threads has "children" counts and "; 2 of its 3 child threads still working"
// in the header:
//
//	[code-foundry wake] Thread "Add LICENSE" (s-…) needs attention: finished without a report.
//	[code-foundry wake] Thread "Docs lead" (s-…) needs attention: finished; 2 of its 3 child threads still working.
//
// The item keeps the header without its prefix (WakeTitle) and the JSON (WakeJSON), so
// the GUI can draw it as a "Woken by …" row. The rate limit: a subscriber gets at most
// Options.WakeLimit (WakeLimit, 60) wakes per rolling WakeWindow (in memory; a daemon
// restart starts over).
// Beyond it a wake is dropped and logged, and once per window the subscriber needs
// attention ("wake limit") with a note saying so; its subscriptions stay.

// wakePrefix starts every wake message's header.
const wakePrefix = "[code-foundry wake] "

// wakeLimitNote is the note of a subscriber whose wakes are being dropped: "Wake limit
// reached (60/hour); wakes are being dropped."
func wakeLimitNote(limit int) string {
	return "Wake limit reached (" + strconv.Itoa(limit) + "/hour); wakes are being dropped."
}

// maxOutputTail bounds a run wake's output_tail.
const maxOutputTail = 4 << 10

// Header bounds (runes): the thread's name, its status reason (a question's text) and
// its report's summary, each cut to one line; the JSON has them whole. The header
// stays near 300 characters.
const (
	maxHeaderName    = 80
	maxHeaderReason  = 120
	maxHeaderSummary = 120
)

// wakeQueue is a subscriber's waiting deliveries; running while its drain goroutine runs.
type wakeQueue struct {
	items   []delivery
	running bool
}

// delivery is a wake to send, or (limit) the wake limit to tell. msg makes the message
// when it is sent, off the locks (a thread wake reads its target's items then).
type delivery struct {
	sub   string // the subscription, for the log
	msg   func(context.Context) Message
	limit bool
}

// fireLocked fires r: unless the subscriber is over the wake limit, it counts the fire
// on r (FiredCount, LastFiredAt) and queues the message build makes. It reports
// whether the wake was queued; a dropped one (over the limit, or the Manager shutting
// down) leaves r as it was. Callers hold m.mu and
// m.subs.mu, and keep or remove r themselves (firedLocked).
func (m *Manager) fireLocked(r *subRec, build func(Subscription, time.Time) Message) bool {
	return m.fireLaterLocked(r, func(s Subscription, at time.Time) func(context.Context) Message {
		msg := build(s, at)
		return func(context.Context) Message { return msg }
	})
}

// fireThreadLocked fires r about thread t, as published: the wake is t as of now, its
// children counted now, and the detail its items hold (wakeDetailOf) read when the wake
// is sent (the items are not read under m.mu). Callers hold m.mu and m.subs.mu.
func (m *Manager) fireThreadLocked(r *subRec, t Thread) bool {
	kids := m.childrenLocked(t.ID)
	return m.fireLaterLocked(r, func(s Subscription, at time.Time) func(context.Context) Message {
		return func(ctx context.Context) Message {
			d := wakeDetail{children: kids}
			if items, err := m.Items(ctx, t.ID); err != nil {
				m.log.Warn("wake detail: read the thread's items", "thread", t.ID, "err", err)
			} else {
				d = wakeDetailOf(t, items.Items, kids)
			}
			return threadWake(s, t, at, d)
		}
	})
}

// childrenLocked counts the threads thread id created that are not archived. Callers
// hold m.mu.
func (m *Manager) childrenLocked(id string) wakeChildren {
	var c wakeChildren
	for _, rec := range m.recs {
		k := rec.s
		if k.CreatedBy != id || !k.ArchivedAt.IsZero() {
			continue
		}
		c.Total++
		if !Meets(CondSettled, k) {
			c.Working++
		}
		if k.Report.Status != ReportNone {
			c.Reported++
		}
	}
	return c
}

// fireLaterLocked is fireLocked with a message made when it is sent.
func (m *Manager) fireLaterLocked(r *subRec, build func(Subscription, time.Time) func(context.Context) Message) bool {
	s := m.subs
	now := m.opts.Now().Round(0).Truncate(time.Millisecond)
	subscriber := r.s.SubscriberID
	if m.closed {
		// The daemon is stopping (its runners' ends commit as they go): not a fire, so a
		// one-shot subscription is kept for the next transition after a restart.
		m.log.Info("wake not fired: the daemon is stopping", "thread", subscriber, "subscription", r.s.ID)
		return false
	}
	if !s.allowLocked(subscriber, now, m.opts.WakeLimit) {
		m.log.Warn("wake dropped: the subscriber reached the wake limit", "thread", subscriber, "subscription", r.s.ID,
			"target", r.s.TargetID, "limit", m.opts.WakeLimit, "window", WakeWindow.String())
		if last, ok := s.noted[subscriber]; !ok || now.Sub(last) >= WakeWindow {
			s.noted[subscriber] = now
			m.enqueueLocked(subscriber, delivery{sub: r.s.ID, limit: true})
		}
		return false
	}
	r.s.FiredCount++
	r.s.LastFiredAt = now
	m.enqueueLocked(subscriber, delivery{sub: r.s.ID, msg: build(r.s, now)})
	m.log.Info("wake subscription fired", "subscription", r.s.ID, "subscriber", subscriber, "target", r.s.TargetID,
		"condition", r.s.Condition, "fired_count", r.s.FiredCount)
	return true
}

// allowLocked counts a wake to subscriber at now when it is under the limit.
func (s *subscriptions) allowLocked(subscriber string, now time.Time, limit int) bool {
	kept := s.sent[subscriber][:0]
	for _, t := range s.sent[subscriber] {
		if now.Sub(t) < WakeWindow {
			kept = append(kept, t)
		}
	}
	if len(kept) >= limit {
		s.sent[subscriber] = kept
		return false
	}
	s.sent[subscriber] = append(kept, now)
	return true
}

// enqueueLocked queues d for subscriber and starts its drain goroutine when none runs.
// Nothing is queued once the Manager is shutting down. Callers hold m.mu and m.subs.mu.
func (m *Manager) enqueueLocked(subscriber string, d delivery) {
	if m.closed {
		return // fireLocked does not fire then; a wake limit note can wait
	}
	s := m.subs
	q := s.queues[subscriber]
	if q == nil {
		q = &wakeQueue{}
		s.queues[subscriber] = q
	}
	q.items = append(q.items, d)
	if q.running {
		return
	}
	q.running = true
	m.wg.Add(1)
	go m.drain(subscriber)
}

// next pops subscriber's next delivery; false (and the queue gone) when it is empty.
func (s *subscriptions) next(subscriber string) (delivery, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.queues[subscriber]
	if q == nil || len(q.items) == 0 {
		delete(s.queues, subscriber)
		return delivery{}, false
	}
	d := q.items[0]
	q.items = q.items[1:]
	return d, true
}

// drain delivers subscriber's wakes in order through Send (a busy thread's Claude picks
// the message up mid-turn, a stopped one starts with it, a snoozed one is unsnoozed),
// until its queue is empty.
func (m *Manager) drain(subscriber string) {
	defer m.wg.Done()
	for {
		d, ok := m.subs.next(subscriber)
		if !ok {
			return
		}
		if d.limit {
			m.wakeLimitReached(subscriber)
			continue
		}
		msg := d.msg(m.ctx)
		if _, err := m.Send(m.ctx, subscriber, msg); err != nil {
			m.log.Warn("wake not delivered", "thread", subscriber, "subscription", d.sub, "err", err)
			continue
		}
		m.log.Info("woke thread", "thread", subscriber, "subscription", d.sub, "wake", msg.WakeTitle)
	}
}

// wakeLimitReached tells subscriber that its wakes are being dropped: NeedsAttention
// ReasonWakeLimit and a note, on its runner when it is running (streamStatus), else on
// its row.
func (m *Manager) wakeLimitReached(id string) {
	ctx := m.ctx
	for {
		live, closing, reserved, _, err := m.lifecycle(id)
		switch {
		case err != nil:
			return
		case live != nil:
			if _, err := live.call(ctx, threadCmd{wakeLimit: true}); errors.Is(err, errProcessGone) {
				continue
			} else if err != nil {
				m.log.Warn("tell the wake limit", "thread", id, "err", err)
			}
			return
		case closing != nil:
			if waitDone(ctx, closing) != nil {
				return
			}
			continue
		case reserved != nil:
			select {
			case <-reserved:
			case <-ctx.Done():
				return
			}
			continue
		}
		log, err := m.thread(ctx, id)
		if err != nil {
			return
		}
		now := m.opts.Now()
		_, ok, err := m.updateStopped(id, func(s *Thread) { s.setStatus(StatusNeedsAttention, ReasonWakeLimit, now) })
		if err != nil {
			return
		}
		if !ok {
			continue // started meanwhile
		}
		w := itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}
		w.add(Item{ID: "note-" + itemSuffix(), Kind: KindNote, Text: wakeLimitNote(m.opts.WakeLimit)})
		return
	}
}

// onWakeLimit is wakeLimitReached on the runner's goroutine.
func (r *runner) onWakeLimit() Item {
	st := r.st
	st.sd.wakeLimit = true
	it := st.proj.w.add(Item{ID: st.proj.nextID("note"), Kind: KindNote, Text: wakeLimitNote(r.m.opts.WakeLimit)})
	r.log().info("wake limit reached; wakes are being dropped", "limit", r.m.opts.WakeLimit)
	r.acknowledgeIfViewed()
	r.checkStatus()
	return it
}

// The JSON payloads. Field order is the output's.

type wakeThreadPayload struct {
	Kind           string     `json:"kind"`
	SubscriptionID string     `json:"subscription_id"`
	Condition      Condition  `json:"condition"`
	FiredAt        string     `json:"fired_at"`
	Thread         wakeThread `json:"thread"`
}

type wakeThread struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	State        string      `json:"state"`
	Status       string      `json:"status"`
	StatusReason string      `json:"status_reason"`
	ProjectID    string      `json:"project_id"`
	WorktreePath string      `json:"worktree_path"`
	CreatedBy    string      `json:"created_by"`
	Labels       []string    `json:"labels"`
	Report       *wakeReport `json:"report"`
	// ReportStale: the turn ended and the report does not describe it (none, or filed
	// before the thread's last message); LastMessage is then the turn's last assistant
	// text, one line, cut at maxLastMessage runes (a question asked in prose).
	ReportStale bool   `json:"report_stale,omitempty"`
	LastMessage string `json:"last_message,omitempty"`
	// Pending is the request a "permission: …" or "question: …" reason describes.
	Pending *wakePending `json:"pending,omitempty"`
	// Children counts the threads it created that are not archived; nil for none.
	Children *wakeChildren `json:"children,omitempty"`
}

// wakePending is a pending permission prompt or question: what `thread respond` needs.
type wakePending struct {
	Kind      string `json:"kind"` // "permission" or "question"
	RequestID string `json:"request_id"`
	Tool      string `json:"tool"`
	// Input is the tool's input: its JSON, or a string cut at maxPendingInput bytes
	// when longer (`thread read --full` has it whole).
	Input any `json:"input"`
	// Question and Options (the labels `--answer` takes) are a question's first;
	// Questions all of them when it asks more than one.
	Question  string         `json:"question,omitempty"`
	Options   []string       `json:"options,omitempty"`
	Questions []wakeQuestion `json:"questions,omitempty"`
}

type wakeQuestion struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

// wakeChildren counts a thread's children (created_by it, not archived): Working are
// not settled, Reported have a report.
type wakeChildren struct {
	Working  int `json:"working"`
	Reported int `json:"reported"`
	Total    int `json:"total"`
}

type wakeReport struct {
	Status  string          `json:"status"`
	Summary string          `json:"summary"`
	Data    json.RawMessage `json:"data"`
	At      string          `json:"at"`
}

type wakeRunPayload struct {
	Kind           string    `json:"kind"`
	SubscriptionID string    `json:"subscription_id"`
	Condition      Condition `json:"condition"`
	FiredAt        string    `json:"fired_at"`
	Run            wakeRun   `json:"run"`
}

type wakeRun struct {
	ID         string `json:"id"`
	ActionID   string `json:"action_id"`
	ActionName string `json:"action_name"`
	ProjectID  string `json:"project_id"`
	ExitCode   int    `json:"exit_code"`
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at"`
	OutputTail string `json:"output_tail"`
}

// wakeTime is a time in a wake's JSON: RFC 3339 in UTC with milliseconds, "" for none.
func wakeTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// statusName is a status in a wake's JSON.
var statusNames = map[Status]string{
	StatusUnknown: "unknown", StatusBusy: "busy", StatusIdle: "idle", StatusNeedsAttention: "needs_attention", StatusError: "error",
}

// wakeDetail is what a thread wake says beyond the thread row: its children, and what
// its items hold (wakeDetailOf).
type wakeDetail struct {
	children wakeChildren
	// noReport: the turn ended and the thread has no report; staleReport: its report was
	// filed before its last message (a follow-up, a wake), so it describes an older turn.
	noReport, staleReport bool
	// lastMessage is the ended turn's last assistant text, when its report does not
	// describe it (noReport, or staleReport).
	lastMessage string
	pending     *wakePending
}

// Wake detail bounds: the last assistant message (runes, one line) and a pending
// request's tool input (bytes).
const (
	maxLastMessage  = 500
	maxPendingInput = 4 << 10
)

// wakeDetailOf reads a thread wake's detail from t's items: whether the report is
// missing or older than the last user message (any origin: a follow-up or a wake), the
// ended turn's last assistant text when so, and the request a "permission: …" or
// "question: …" reason describes. Subagents' items are skipped.
func wakeDetailOf(t Thread, items []Item, kids wakeChildren) wakeDetail {
	d := wakeDetail{children: kids}
	var lastUser time.Time
	var last string
	for _, it := range items {
		if it.ParentToolUseID != "" {
			continue
		}
		switch it.Kind {
		case KindUserMessage:
			lastUser, last = it.CreatedAt, ""
		case KindAssistantText:
			if s := strings.TrimSpace(it.Text); s != "" {
				last = s
			}
		}
	}
	hasReport := t.Report.Status != ReportNone
	d.staleReport = hasReport && t.Report.At.Before(lastUser.Truncate(time.Millisecond))
	if Meets(CondIdle, t) {
		// The turn ended: say when the report does not describe it, and what it said.
		d.noReport = !hasReport
		if d.noReport || d.staleReport {
			d.lastMessage = oneLine(last, maxLastMessage)
		}
	}
	if t.Status == StatusNeedsAttention && isRequestReason(t.StatusReason) {
		d.pending = pendingRequestOf(t, items)
	}
	return d
}

// pendingRequestOf is the request t's reason describes: the item of its
// PendingRequestID, else the oldest pending one that reads as the reason; nil when
// none is found.
func pendingRequestOf(t Thread, items []Item) *wakePending {
	for _, it := range items {
		switch {
		case it.Request == nil:
			continue
		case t.PendingRequestID != "" && it.Request.RequestID != t.PendingRequestID:
			continue
		case t.PendingRequestID == "" && (it.Request.State != RequestPending || requestReason(it) != t.StatusReason):
			continue
		}
		return wakePendingOf(it)
	}
	return nil
}

// wakePendingOf is a request item in a wake.
func wakePendingOf(it Item) *wakePending {
	r := it.Request
	p := &wakePending{Kind: "permission", RequestID: r.RequestID, Tool: r.ToolName, Input: pendingInput(r.InputJSON)}
	if it.Kind != KindQuestion {
		return p
	}
	p.Kind = "question"
	qs := questionsOf(r.InputJSON)
	for i, q := range qs {
		labels := make([]string, 0, len(q.Options))
		for _, o := range q.Options {
			labels = append(labels, o.Label)
		}
		if i == 0 {
			p.Question, p.Options = q.Question, labels
		}
		if len(qs) > 1 {
			p.Questions = append(p.Questions, wakeQuestion{Question: q.Question, Options: labels})
		}
	}
	return p
}

// pendingInput is a tool input in a wake: the JSON itself up to maxPendingInput bytes,
// else its head as a string with a marker.
func pendingInput(in string) any {
	switch {
	case in == "":
		return nil
	case len(in) <= maxPendingInput && json.Valid([]byte(in)):
		return json.RawMessage(in)
	case len(in) <= maxPendingInput:
		return in
	}
	cut := maxPendingInput
	for cut > 0 && !utf8.RuneStart(in[cut]) {
		cut--
	}
	return in[:cut] + "… [" + strconv.Itoa(len(in)-cut) + " more bytes; thread read --full has it all]"
}

// threadWake is the wake message of sub about thread t, fired at, with detail d.
func threadWake(sub Subscription, t Thread, at time.Time, d wakeDetail) Message {
	p := wakeThreadPayload{Kind: "thread", SubscriptionID: sub.ID, Condition: sub.Condition, FiredAt: wakeTime(at), Thread: wakeThread{
		ID: t.ID, Name: t.Name, State: t.State.String(), Status: statusNames[t.Status], StatusReason: t.StatusReason,
		ProjectID: t.ProjectID, WorktreePath: t.WorktreePath, CreatedBy: t.CreatedBy, Labels: t.Labels,
		ReportStale: d.noReport || d.staleReport, LastMessage: d.lastMessage, Pending: d.pending,
	}}
	if p.Thread.Labels == nil {
		p.Thread.Labels = []string{}
	}
	p.Thread.Report = wakeReportOf(t.Report)
	if d.children.Total > 0 {
		kids := d.children
		p.Thread.Children = &kids
	}
	return wakeMessage(threadWakeTitle(sub.Condition, t, d), p)
}

// wakeReportOf is a report in a wake's JSON; nil for none.
func wakeReportOf(rep Report) *wakeReport {
	if rep.Status == ReportNone {
		return nil
	}
	r := &wakeReport{Status: rep.Status.String(), Summary: rep.Summary, At: wakeTime(rep.At), Data: json.RawMessage("null")}
	if rep.Data != "" && json.Valid([]byte(rep.Data)) {
		r.Data = json.RawMessage(rep.Data)
	}
	return r
}

// threadWakeTitle is a thread wake's header without its prefix, for example
// `Thread "Fix the login" (s-1) needs attention: finished. Report: done — all good.`,
// `Thread "Ask" (s-2) needs attention: finished without a report.` or
// `Thread "Lead" (s-3) is idle: at prompt (report is from before its last message); 2 of
// its 3 child threads still working.` The verb is the condition's, or for settled and
// idle the status's. A report is quoted only while it is current (not staleReport).
func threadWakeTitle(c Condition, t Thread, d wakeDetail) string {
	who := "Thread " + t.ID
	if t.Name != "" {
		who = "Thread " + strconv.Quote(oneLine(t.Name, maxHeaderName)) + " (" + t.ID + ")"
	}
	var what string
	switch c {
	case CondAttention:
		what = "needs attention"
	case CondError:
		what = "has an error"
	case CondDisconnected:
		what = "is disconnected"
	default: // settled, idle: what the status says
		switch t.Status {
		case StatusNeedsAttention:
			what = "needs attention"
		case StatusError:
			what = "has an error"
		default:
			what = "is idle"
		}
	}
	line := who + " " + what
	if t.StatusReason != "" {
		line += ": " + oneLine(t.StatusReason, maxHeaderReason)
	}
	switch {
	case d.noReport && t.StatusReason == "finished":
		line += " without a report"
	case d.noReport:
		line += " (no report)"
	case d.staleReport && Meets(CondIdle, t):
		line += " (report is from before its last message)"
	}
	if k := d.children; k.Working > 0 {
		if k.Total == 1 {
			line += "; its child thread is still working"
		} else {
			line += "; " + strconv.Itoa(k.Working) + " of its " + strconv.Itoa(k.Total) + " child threads still working"
		}
	}
	line = endSentence(line)
	if t.Report.Status != ReportNone && !d.staleReport {
		line += " Report: " + t.Report.Status.String()
		if sum := oneLine(t.Report.Summary, maxHeaderSummary); sum != "" {
			line += " — " + sum
		}
		line = endSentence(line)
	}
	return line
}

// endSentence ends s with a period unless it ends in one, "!", "?" or "…".
func endSentence(s string) string {
	if strings.HasSuffix(s, ".") || strings.HasSuffix(s, "!") || strings.HasSuffix(s, "?") || strings.HasSuffix(s, "…") {
		return s
	}
	return s + "."
}

// runWake is the wake message of sub about run, fired at.
func runWake(sub Subscription, run ActionRun, at time.Time) Message {
	p := wakeRunPayload{Kind: "action_run", SubscriptionID: sub.ID, Condition: CondFinished, FiredAt: wakeTime(at), Run: wakeRun{
		ID: run.ID, ActionID: run.ActionID, ActionName: run.ActionName, ProjectID: run.ProjectID, ExitCode: run.ExitCode,
		StartedAt: wakeTime(run.StartedAt), FinishedAt: wakeTime(run.FinishedAt), OutputTail: outputTail(run.Output, maxOutputTail),
	}}
	name := run.ActionName
	if name == "" {
		name = run.ActionID
	}
	title := "Action " + strconv.Quote(name) + " run " + run.ID + " finished with exit " + strconv.Itoa(run.ExitCode) + "."
	return wakeMessage(title, p)
}

// wakeMessage is the message of a wake with header title and payload p.
func wakeMessage(title string, p any) Message {
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		data = []byte("{}") // the payloads are plain structs: never happens
	}
	j := string(data)
	return Message{
		Text:   wakePrefix + title + "\n```json\n" + j + "\n```",
		Origin: OriginWake, WakeTitle: title, WakeJSON: j,
	}
}

// oneLine collapses s's whitespace to single spaces and cuts it to max runes with "…".
func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:max-1])) + "…"
}

// outputTail is the last max bytes of s, starting on a rune boundary.
func outputTail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := len(s) - max
	for cut < len(s) && !utf8.RuneStart(s[cut]) {
		cut++
	}
	return s[cut:]
}
