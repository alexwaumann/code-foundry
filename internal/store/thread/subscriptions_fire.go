package thread

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Firing and delivering wakes (subscriptions.go, docs/notes/agents-4-wake.md).
//
// A wake is a user message (Origin OriginWake) whose text is one header line, then a
// fenced JSON block:
//
//	[code-foundry wake] Thread "Write retry backoff tests" (s-…) is idle: finished. Report: done — 6 table tests.
//	```json
//	{ "kind": "thread", "subscription_id": "sub-…", "condition": "settled", "fired_at": "…", "thread": { … } }
//	```
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

// maxHeaderSummary bounds the report summary in a header line (runes); the JSON has it all.
const maxHeaderSummary = 200

// wakeQueue is a subscriber's waiting deliveries; running while its drain goroutine runs.
type wakeQueue struct {
	items   []delivery
	running bool
}

// delivery is a wake to send, or (limit) the wake limit to tell.
type delivery struct {
	sub   string // the subscription, for the log
	msg   Message
	limit bool
}

// fireLocked fires r: unless the subscriber is over the wake limit, it counts the fire
// on r (FiredCount, LastFiredAt) and queues the message build makes. It reports
// whether the wake was queued; a dropped one leaves r as it was. Callers hold m.mu and
// m.subs.mu, and keep or remove r themselves (firedLocked).
func (m *Manager) fireLocked(r *subRec, build func(Subscription, time.Time) Message) bool {
	s := m.subs
	now := m.opts.Now().Round(0).Truncate(time.Millisecond)
	subscriber := r.s.SubscriberID
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
		m.log.Info("wake not delivered: the daemon is stopping", "thread", subscriber, "subscription", d.sub)
		return
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

// drain delivers subscriber's wakes in order through Send (a busy thread queues the
// message, a stopped one starts with it, a snoozed one is unsnoozed), until its queue
// is empty.
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
		if _, err := m.Send(m.ctx, subscriber, d.msg); err != nil {
			m.log.Warn("wake not delivered", "thread", subscriber, "subscription", d.sub, "err", err)
			continue
		}
		m.log.Info("woke thread", "thread", subscriber, "subscription", d.sub, "wake", d.msg.WakeTitle)
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
	RepoID       string      `json:"repo_id"`
	WorktreePath string      `json:"worktree_path"`
	CreatedBy    string      `json:"created_by"`
	Labels       []string    `json:"labels"`
	Report       *wakeReport `json:"report"`
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
	RepoID     string `json:"repo_id"`
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

// threadWake is the wake message of sub about thread t, fired at.
func threadWake(sub Subscription, t Thread, at time.Time) Message {
	p := wakeThreadPayload{Kind: "thread", SubscriptionID: sub.ID, Condition: sub.Condition, FiredAt: wakeTime(at), Thread: wakeThread{
		ID: t.ID, Name: t.Name, State: t.State.String(), Status: statusNames[t.Status], StatusReason: t.StatusReason,
		RepoID: t.RepoID, WorktreePath: t.WorktreePath, CreatedBy: t.CreatedBy, Labels: t.Labels,
	}}
	if p.Thread.Labels == nil {
		p.Thread.Labels = []string{}
	}
	if t.Report.Status != ReportNone {
		r := &wakeReport{Status: t.Report.Status.String(), Summary: t.Report.Summary, At: wakeTime(t.Report.At), Data: json.RawMessage("null")}
		if t.Report.Data != "" && json.Valid([]byte(t.Report.Data)) {
			r.Data = json.RawMessage(t.Report.Data)
		}
		p.Thread.Report = r
	}
	return wakeMessage(threadWakeTitle(sub.Condition, t), p)
}

// threadWakeTitle is a thread wake's header without its prefix:
// `Thread "Fix the login" (s-1) is idle: finished. Report: done — all good.`
func threadWakeTitle(c Condition, t Thread) string {
	who := "Thread " + t.ID
	if t.Name != "" {
		who = "Thread " + strconv.Quote(t.Name) + " (" + t.ID + ")"
	}
	var what string
	switch c {
	case CondAttention:
		what = "needs attention"
	case CondError:
		what = "has an error"
	case CondDisconnected:
		what = "is disconnected"
	case CondIdle:
		what = "is idle"
	default: // settled
		what = "is idle"
		if !Meets(CondIdle, t) {
			what = "needs attention"
		}
	}
	line := who + " " + what
	if t.StatusReason != "" {
		line += ": " + t.StatusReason
	}
	line += "."
	if t.Report.Status != ReportNone {
		line += " Report: " + t.Report.Status.String()
		if sum := oneLine(t.Report.Summary, maxHeaderSummary); sum != "" {
			line += " — " + sum
			if !strings.HasSuffix(sum, ".") && !strings.HasSuffix(sum, "!") && !strings.HasSuffix(sum, "?") && !strings.HasSuffix(sum, "…") {
				line += "."
			}
		} else {
			line += "."
		}
	}
	return line
}

// runWake is the wake message of sub about run, fired at.
func runWake(sub Subscription, run ActionRun, at time.Time) Message {
	p := wakeRunPayload{Kind: "action_run", SubscriptionID: sub.ID, Condition: CondFinished, FiredAt: wakeTime(at), Run: wakeRun{
		ID: run.ID, ActionID: run.ActionID, ActionName: run.ActionName, RepoID: run.RepoID, ExitCode: run.ExitCode,
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
