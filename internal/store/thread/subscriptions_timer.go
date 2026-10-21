package thread

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Timer wake subscriptions (docs/notes/ember-1-primitives.md). A thread asks to be woken
// at a time (SubscribeOptions.TargetAt, once) or every interval (TargetEvery, at least
// MinTimerEvery, repeating until unsubscribed): TargetTimer, CondFired. The target id is
// the schedule itself, "at:<RFC 3339 UTC>" or "every:<duration>", so the same timer
// twice is the same subscription (Subscribe's existed). A timer never fires at subscribe
// time.
//
// Like a snooze (snooze.go) the schedule is wall clock: fireTimers compares
// Options.Now with each timer's next fire every Options.TimerCheckInterval, so a Mac
// that slept fires an overdue timer at the first check after it wakes, and so does a
// daemon that was stopped: a one-shot whose time passed fires once at the first check
// after the start, an interval fires once for every slot it missed together and then
// keeps its schedule. An interval's slots are counted from its creation (CreatedAt +
// k·every), so a late fire does not shift the next ones. The wake is a normal wake
// message through the subscriber's queue (subscriptions_fire.go), counted by the wake
// limit; one the limit drops is tried again a minute later.

// TargetTimer is a timer ("at:<RFC 3339>" or "every:<duration>").
const TargetTimer TargetKind = "timer"

// MinTimerEvery is the shortest interval of a repeating timer.
const MinTimerEvery = time.Minute

// TimerCheckInterval is how often a running Manager fires the timers that are due
// (Options.TimerCheckInterval's default).
const TimerCheckInterval = 10 * time.Second

// timerRetry is how long a timer fire the wake limit dropped waits before it is tried
// again.
const timerRetry = time.Minute

// Timer target id prefixes.
const (
	timerAtPrefix    = "at:"
	timerEveryPrefix = "every:"
)

// timerTarget is the target id of a timer: at (once) when every is zero.
func timerTarget(at time.Time, every time.Duration) string {
	if every > 0 {
		return timerEveryPrefix + FormatEvery(every)
	}
	return timerAtPrefix + at.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// parseTimerTarget reads a timer target id: its time (once) or its interval.
func parseTimerTarget(id string) (at time.Time, every time.Duration, ok bool) {
	if v, found := strings.CutPrefix(id, timerEveryPrefix); found {
		d, err := time.ParseDuration(v)
		return time.Time{}, d, err == nil && d > 0
	}
	if v, found := strings.CutPrefix(id, timerAtPrefix); found {
		t, err := time.Parse(time.RFC3339Nano, v)
		return t, 0, err == nil
	}
	return time.Time{}, 0, false
}

// FormatEvery is an interval as people write it: "30m", "2h", "1h30m", "90s" stays
// "1m30s".
func FormatEvery(d time.Duration) string {
	s := d.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}

// TimerTarget validates a timer target of Subscribe (exactly one of at and every,
// every at least MinTimerEvery, and the condition: fired, or settled meaning it) and
// returns its target id and condition. It does not check that at is in the future.
func TimerTarget(at time.Time, every time.Duration, c Condition) (string, Condition, error) {
	switch {
	case !at.IsZero() && every != 0:
		return "", "", fmt.Errorf("%w: a timer is at a time or every interval, not both", ErrInvalidArgument)
	case every < 0 || (every > 0 && every < MinTimerEvery):
		return "", "", fmt.Errorf("%w: a timer's interval is at least %s, not %s", ErrInvalidArgument, FormatEvery(MinTimerEvery), every)
	}
	switch c {
	case "", CondFired, CondSettled:
	default:
		return "", "", fmt.Errorf("%w: a timer's only condition is fired, not %s", ErrInvalidArgument, c)
	}
	return timerTarget(at.Round(0).Truncate(time.Millisecond), every), CondFired, nil
}

// timerNext is when timer subscription s fires next: its time, or the first slot of its
// interval (CreatedAt + k·every) after its last fire. Zero for a malformed target.
func timerNext(s Subscription) time.Time {
	at, every, ok := parseTimerTarget(s.TargetID)
	switch {
	case !ok:
		return time.Time{}
	case every == 0:
		return at
	case s.LastFiredAt.IsZero() || s.LastFiredAt.Before(s.CreatedAt):
		return s.CreatedAt.Add(every)
	}
	k := s.LastFiredAt.Sub(s.CreatedAt)/every + 1
	return s.CreatedAt.Add(k * every)
}

// fireTimers fires every timer subscription that is due at Options.Now: a one-shot goes
// once it fired, an interval saves its fire (its next slot follows from it). New starts
// a loop that runs it every Options.TimerCheckInterval.
func (m *Manager) fireTimers() {
	now := m.opts.Now().Round(0)
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	type due struct {
		r  *subRec
		at time.Time
	}
	var hit []due
	for _, r := range s.byID {
		if r.s.TargetKind != TargetTimer || now.Before(r.retryAt) {
			continue
		}
		if next := timerNext(r.s); !next.IsZero() && !next.After(now) {
			hit = append(hit, due{r, next})
		}
	}
	slices.SortFunc(hit, func(a, b due) int {
		return cmp.Or(a.at.Compare(b.at), a.r.s.CreatedAt.Compare(b.r.s.CreatedAt), strings.Compare(a.r.s.ID, b.r.s.ID))
	})
	for _, d := range hit {
		at := d.at
		if m.fireLocked(d.r, func(sub Subscription, fired time.Time) Message { return timerWake(sub, at, fired) }) {
			d.r.retryAt = time.Time{}
			s.firedLocked(d.r)
			continue
		}
		d.r.retryAt = now.Add(timerRetry) // dropped (the wake limit) or the daemon stops
	}
}

// fireTimersLoop runs fireTimers on every tick until Shutdown cancels m.ctx.
func (m *Manager) fireTimersLoop(tick <-chan time.Time) {
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-tick:
			m.fireTimers()
		}
	}
}

type wakeTimerPayload struct {
	Kind           string    `json:"kind"`
	SubscriptionID string    `json:"subscription_id"`
	Condition      Condition `json:"condition"`
	FiredAt        string    `json:"fired_at"`
	// DueAt is when it was due: its time, or its interval's slot.
	DueAt string `json:"due_at"`
	// Every is a repeating timer's interval ("30m"); At a one-shot's time.
	Every string `json:"every,omitempty"`
	At    string `json:"at,omitempty"`
	// Note is the subscription's note (thread subscribe --note).
	Note string `json:"note,omitempty"`
}

// timerWake is the wake message of timer sub, due at due, fired at: "Timer sub-… fired
// at 09:30 CDT (every 30m)." or "(set for 09:00 CDT)", then ": <note>" when the
// subscription has one.
func timerWake(sub Subscription, due, at time.Time) Message {
	p := wakeTimerPayload{Kind: "timer", SubscriptionID: sub.ID, Condition: CondFired, FiredAt: wakeTime(at), DueAt: wakeTime(due), Note: sub.Note}
	t, every, _ := parseTimerTarget(sub.TargetID)
	what := "set for " + ClockTime(t, at)
	if every > 0 {
		p.Every, what = FormatEvery(every), "every "+FormatEvery(every)
	} else {
		p.At = wakeTime(t)
	}
	title := "Timer " + sub.ID + " fired at " + ClockTime(at, at) + " (" + what + ")"
	if sub.Note != "" {
		title += ": " + sub.Note
	}
	return wakeMessage(endSentence(title), p)
}

// ClockTime is t in local time for a header or a listing: "09:30 CDT" on now's day,
// else "Oct 21 09:30 CDT".
func ClockTime(t, now time.Time) string {
	t, now = t.Local(), now.Local()
	if t.Year() == now.Year() && t.YearDay() == now.YearDay() {
		return t.Format("15:04 MST")
	}
	return t.Format("Jan 2 15:04 MST")
}

// DescribeTimer fills a timer subscription's TargetName ("every 30m", "at 09:00 CDT"),
// TargetStatus ("next 09:30 CDT", "due"), NextAt and Every for a listing at now.
func DescribeTimer(sub *Subscription, now time.Time) {
	at, every, ok := parseTimerTarget(sub.TargetID)
	if !ok {
		sub.TargetName, sub.TargetStatus = sub.TargetID, "malformed"
		return
	}
	sub.TargetName = "at " + ClockTime(at, now)
	if every > 0 {
		sub.TargetName = "every " + FormatEvery(every)
	}
	next := timerNext(*sub)
	sub.NextAt, sub.Every = next, every
	sub.TargetStatus = "next " + ClockTime(next, now)
	if !next.After(now) {
		sub.TargetStatus = "due"
	}
}
