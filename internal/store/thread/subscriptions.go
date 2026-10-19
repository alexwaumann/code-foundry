package thread

import (
	"cmp"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Wake subscriptions (docs/notes/agents-4-wake.md). Claude Code is turn-based: a
// thread's agent only runs when a message arrives. A subscription makes the daemon send
// one: when its target thread meets a condition, or its target action run finishes, the
// subscriber is sent a wake message (subscriptions_fire.go) through Send, so a busy
// subscriber queues it, a stopped one starts with it and a snoozed one is unsnoozed.
//
// Thread targets are edge-triggered: the store's commit hook (observeLocked, called by
// commitLocked under m.mu for every published change) fires a subscription when its
// target goes from not meeting the condition to meeting it, and Subscribe fires once at
// once when the target already meets it, so a late subscriber does not miss a finished
// child. A settled or attention subscription also fires on each new pending request
// while the condition holds (requestKey; docs/notes/wake-detail.md): a supervised child
// going from one permission prompt straight to the next never leaves needs attention,
// and the next prompt must wake its parent all the same. Running in the commit gives a total order with Subscribe (also under m.mu): no
// change is seen twice or missed, whatever the bus buffers. Run targets fire once, when
// the daemon reports the run's end (ActionRunFinished), or at once when it already ended.
//
// The hook only decides and queues: wakes are delivered by one goroutine per subscriber
// (drain), in order, never under m.mu; thread wakes that fire within a second of each
// other go as one message (subscriptions_batch.go). A one-shot subscription goes once it fired; a
// repeat one stays. Subscriptions are persisted (thread_subscriptions, migration 0024)
// and rehydrated by New, armed with the targets as loaded: nothing fires for what
// happened while the daemon was stopped, except what DeliverRestartWakes sends once the
// daemon is up (subscriptions_restart.go): the wakes the stop suppressed, threads the
// stop interrupted, and a restart notice. Action runs live in the action store's memory,
// so run subscriptions are dropped at startup. Archiving or removing the subscriber or
// the target thread deletes its subscriptions.

// Condition is when a subscription fires. The thread conditions are thread.wait's
// (Meets); CondFinished is an action run's only one.
type Condition string

// Conditions.
const (
	// CondSettled: idle or attention; Claude is not working.
	CondSettled Condition = "settled"
	// CondIdle: thread.wait's idle (a finished turn counts, a pending prompt does not).
	CondIdle Condition = "idle"
	// CondAttention: status NeedsAttention, whatever the reason.
	CondAttention Condition = "attention"
	// CondError: status Error.
	CondError Condition = "error"
	// CondDisconnected: state Disconnected.
	CondDisconnected Condition = "disconnected"
	// CondFinished: the action run exited.
	CondFinished Condition = "finished"
)

// ThreadConditions are the conditions a thread target takes.
var ThreadConditions = []Condition{CondSettled, CondIdle, CondAttention, CondError, CondDisconnected}

// TargetKind is what a subscription watches.
type TargetKind string

// Target kinds.
const (
	TargetThread    TargetKind = "thread"
	TargetActionRun TargetKind = "action_run"
)

// Wake limits: a subscriber gets at most WakeLimit wakes per rolling WakeWindow; the
// rest are dropped (subscriptions_fire.go).
const (
	WakeLimit  = 60
	WakeWindow = time.Hour
)

// ReasonWakeLimit is the StatusReason, with StatusNeedsAttention, of a thread whose
// wakes are being dropped. Cleared by the next message, or once seen.
const ReasonWakeLimit = "wake limit"

// Meets reports whether t meets thread condition c. CondIdle is "Claude is not working
// and no answer is pending": not starting, and status idle, error (the process ended
// mid-turn), or needs attention for anything but a pending permission prompt or
// question (a turn that ended unseen, "finished" or "error: <code>", "snooze ended",
// "budget reached", "wake limit"). A thread waiting on its child threads (idle
// "waiting on N child threads", waiting.go) is idle, not attention. The
// ThreadService.Wait conditions are the same
// (docs/notes/agents-1-wait-events.md). A thread being removed (Thread.Removing) meets
// none: its closing snapshot is not a thread that settled.
func Meets(c Condition, t Thread) bool {
	if t.Removing {
		return false
	}
	switch c {
	case CondSettled:
		return Meets(CondIdle, t) || Meets(CondAttention, t)
	case CondIdle:
		return idleNow(t)
	case CondAttention:
		return t.Status == StatusNeedsAttention
	case CondError:
		return t.Status == StatusError
	case CondDisconnected:
		return t.State == StateDisconnected
	}
	return false
}

func idleNow(t Thread) bool {
	if t.State == StateStarting {
		return false
	}
	switch t.Status {
	case StatusIdle, StatusError:
		return true
	case StatusNeedsAttention:
		return !strings.HasPrefix(t.StatusReason, "permission") && !strings.HasPrefix(t.StatusReason, "question")
	case StatusUnknown:
		// A row from before status persistence: only a stopped one is known not to work.
		return t.State == StateDisconnected
	}
	return false
}

// Subscription is one wake subscription. Values; never mutate one returned.
type Subscription struct {
	ID           string // "sub-" + 12 hex digits
	SubscriberID string // the thread that is woken
	TargetKind   TargetKind
	TargetID     string // a thread id, an action run id, or "<plugin>/<source>"
	Condition    Condition
	// Args are a plugin target's (subscriptions_plugin.go); nil for the others.
	Args map[string]string
	// Repeat: fires on every transition into the condition; else it goes once it fired.
	Repeat    bool
	CreatedAt time.Time
	// FiredCount counts the wakes it queued (one dropped by the wake limit does not
	// count); LastFiredAt is the latest, zero before the first.
	FiredCount  int
	LastFiredAt time.Time
	// SuppressedAt is when a thread target met the condition while the daemon was
	// stopping, so the wake could not be sent; the next start delivers it
	// (subscriptions_restart.go). Zero for none.
	SuppressedAt time.Time

	// Filled by Subscriptions at read time, not persisted: the subscriber's and the
	// target's names (a run's: its action's), and the target's state in words.
	SubscriberName, TargetName, TargetStatus string
}

// SubscribeOptions configures Store.Subscribe: exactly one of TargetThreadID,
// TargetRunID, TargetPullRequest ("owner/name#123" or a pull request URL) and
// TargetPlugin ("<plugin>/<source>", with Args). Condition "" is CondSettled for a
// thread, CondFinished for a run, CondChecksDone for a pull request, CondFired for a
// plugin; a run and a plugin also take CondSettled (it means their own). Repeat is
// ignored for a run.
type SubscribeOptions struct {
	SubscriberID      string
	TargetThreadID    string
	TargetRunID       string
	TargetPullRequest string
	TargetPlugin      string
	Args              map[string]string
	Condition         Condition
	Repeat            bool
}

// SubscribeResult is Store.Subscribe's answer.
type SubscribeResult struct {
	Subscription Subscription
	// Fired: the target already met the condition and the wake was queued at once (a
	// one-shot subscription is then not kept).
	Fired bool
	// Existed: the same subscriber, target and condition was subscribed already; it is
	// returned (Repeat updated) and nothing fired.
	Existed bool
}

// UnsubscribeOptions configures Store.Unsubscribe: an ID, or a SubscriberID and exactly
// one target.
type UnsubscribeOptions struct {
	ID                string
	SubscriberID      string
	TargetThreadID    string
	TargetRunID       string
	TargetPullRequest string
	TargetPlugin      string
}

// ActionRun is what a wake about an action run says (Options.ActionRun).
type ActionRun struct {
	ID, ActionID, ActionName, ProjectID string
	Finished                            bool
	ExitCode                            int
	StartedAt, FinishedAt               time.Time
	// Output is a background run's captured output (its tail); "" for a terminal run.
	Output string
}

// subscriptions is the Manager's subscription state. Lock order: m.mu, then mu.
type subscriptions struct {
	db  *sql.DB
	log *slog.Logger

	mu   sync.Mutex
	byID map[string]*subRec
	// sent are each subscriber's wake times within the last WakeWindow; noted is when
	// its last wake limit note was written (subscriptions_fire.go). In memory only.
	sent  map[string][]time.Time
	noted map[string]time.Time
	// queues are the deliveries waiting for each subscriber's drain goroutine.
	queues map[string]*wakeQueue
	// watch is Options.WatchPullRequests; watched the set it was last told.
	watch   func(targets []string)
	watched []string
	// plugins is the plugin store's side of plugin targets (subscriptions_plugin.go);
	// notes are its Changed calls waiting, noting whether a goroutine makes them.
	plugins PluginWakes
	notes   []pluginNote
	noting  bool
	// restarted: DeliverRestartWakes ran (subscriptions_restart.go).
	restarted bool
}

// subRec is a subscription, whether its target met the condition when last seen, and
// the pending request it was then waiting on (requestKey).
type subRec struct {
	s   Subscription
	sat bool
	req string
}

// requestKey names the pending request (permission prompt or question) a running
// thread waits on: its PendingRequestID, else its "permission: …"/"question: …" reason;
// "" when it waits on none or has no process (a stopped thread keeps the reason of a
// request that ended with its process).
func requestKey(t Thread) string {
	if t.Status != StatusNeedsAttention || t.State == StateDisconnected || t.State == StateClosing || !isRequestReason(t.StatusReason) {
		return ""
	}
	return cmp.Or(t.PendingRequestID, t.StatusReason)
}

// isRequestReason reports whether a status reason is a pending request's.
func isRequestReason(reason string) bool {
	return strings.HasPrefix(reason, "permission:") || strings.HasPrefix(reason, "question:")
}

// firesOnRequest reports whether a subscription with condition c, met before and now,
// fires again for a new pending request: settled and attention (the conditions a
// prompt meets).
func firesOnRequest(c Condition) bool { return c == CondSettled || c == CondAttention }

// loadSubscriptionState rehydrates the subscriptions for New, armed with the threads as
// loaded (recs): a subscription whose target meets its condition now waits for the
// next transition into it. Run subscriptions (runs do not outlive the daemon) and those
// of threads that are gone or archived are deleted.
func loadSubscriptionState(ctx context.Context, db *sql.DB, log *slog.Logger, recs map[string]*record, watch func([]string)) (*subscriptions, error) {
	rows, err := loadSubscriptions(ctx, db)
	if err != nil {
		return nil, err
	}
	s := &subscriptions{db: db, log: log, byID: map[string]*subRec{}, sent: map[string][]time.Time{},
		noted: map[string]time.Time{}, queues: map[string]*wakeQueue{}, watch: watch}
	live := func(id string) (Thread, bool) {
		rec, ok := recs[id]
		if !ok || !rec.s.ArchivedAt.IsZero() {
			return Thread{}, false
		}
		return rec.s, true
	}
	var stale []string
	for _, sub := range rows {
		_, okSub := live(sub.SubscriberID)
		if okSub && sub.TargetKind == TargetPlugin {
			// The plugin re-arms when it starts (PluginSubscriptions).
			s.byID[sub.ID] = &subRec{s: sub}
			continue
		}
		switch target, okTarget := live(sub.TargetID); {
		case okSub && sub.TargetKind == TargetThread && okTarget:
			s.byID[sub.ID] = &subRec{s: sub, sat: Meets(sub.Condition, target)}
		case okSub && sub.TargetKind == TargetPullRequest:
			// Edge-triggered on the GitHub poll's changes, which carry their own before.
			s.byID[sub.ID] = &subRec{s: sub}
		default:
			stale = append(stale, sub.ID)
		}
	}
	if len(stale) > 0 {
		if err := deleteSubscriptions(ctx, db, stale); err != nil {
			return nil, err
		}
		log.Info("dropped wake subscriptions at startup (action runs do not outlive the daemon; archived or removed threads)",
			"count", len(stale))
	}
	s.mu.Lock()
	s.syncWatchLocked()
	s.mu.Unlock()
	return s, nil
}

// newSubscriptionID returns "sub-" + 12 hex digits.
func newSubscriptionID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("subscription id: %w", err)
	}
	return "sub-" + hex.EncodeToString(b[:]), nil
}

// subscribeTarget validates o's target and condition: the target's kind and id and the
// condition with its default.
func subscribeTarget(o SubscribeOptions) (TargetKind, string, Condition, error) {
	thread, run, pr, plugin := strings.TrimSpace(o.TargetThreadID), strings.TrimSpace(o.TargetRunID), strings.TrimSpace(o.TargetPullRequest),
		strings.TrimSpace(o.TargetPlugin)
	n := 0
	for _, t := range []string{thread, run, pr, plugin} {
		if t != "" {
			n++
		}
	}
	switch {
	case n != 1:
		return "", "", "", fmt.Errorf("%w: give exactly one target: a thread, an action run, a pull request or a plugin's wake source", ErrInvalidArgument)
	case plugin == "" && len(o.Args) > 0:
		return "", "", "", fmt.Errorf("%w: args are for a plugin's wake source", ErrInvalidArgument)
	case pr != "":
		target, err := ParsePullRequestTarget(pr)
		if err != nil {
			return "", "", "", err
		}
		c := cmp.Or(o.Condition, CondChecksDone)
		if !slices.Contains(PullRequestConditions, c) {
			return "", "", "", fmt.Errorf("%w: condition %q is not a pull request's (want checks_done, checks_failed, checks_passed, review, comment, review_requested, head_pushed, merged, closed or changed)",
				ErrInvalidArgument, c)
		}
		return TargetPullRequest, target, c, nil
	case plugin != "":
		if p, src, ok := strings.Cut(plugin, "/"); !ok || p == "" || src == "" || strings.Contains(src, "/") {
			return "", "", "", fmt.Errorf("%w: %q is not <plugin>/<source> (code-foundry plugin wakes lists them)", ErrInvalidArgument, plugin)
		}
		switch o.Condition {
		case "", CondFired, CondSettled:
			return TargetPlugin, plugin, CondFired, nil
		}
		return "", "", "", fmt.Errorf("%w: a plugin's wake source's only condition is fired, not %s", ErrInvalidArgument, o.Condition)
	case run != "":
		switch o.Condition {
		case "", CondFinished, CondSettled:
			return TargetActionRun, run, CondFinished, nil
		}
		return "", "", "", fmt.Errorf("%w: an action run's only condition is finished, not %s", ErrInvalidArgument, o.Condition)
	}
	c := cmp.Or(o.Condition, CondSettled)
	if !slices.Contains(ThreadConditions, c) {
		return "", "", "", fmt.Errorf("%w: condition %q (want settled, idle, attention, error or disconnected)", ErrInvalidArgument, c)
	}
	return TargetThread, thread, c, nil
}

// Subscribe implements Store.
func (m *Manager) Subscribe(ctx context.Context, o SubscribeOptions) (SubscribeResult, error) {
	kind, target, cond, err := subscribeTarget(o)
	if err != nil {
		return SubscribeResult{}, err
	}
	subscriber := strings.TrimSpace(o.SubscriberID)
	if subscriber == "" {
		return SubscribeResult{}, fmt.Errorf("%w: a subscriber thread is required", ErrInvalidArgument)
	}
	var run ActionRun
	var pr *PullRequestInfo
	var args map[string]string
	switch kind {
	case TargetActionRun:
		if run, err = m.actionRun(ctx, target); err != nil {
			return SubscribeResult{}, err
		}
	case TargetPullRequest:
		if m.opts.PullRequest == nil {
			return SubscribeResult{}, fmt.Errorf("%w: pull requests are not available", ErrFailedPrecondition)
		}
		if p, ok := m.opts.PullRequest(ctx, target); ok {
			if p.State == "merged" && cond != CondMerged {
				return SubscribeResult{}, fmt.Errorf("%w: pull request %s is merged; nothing more will happen to it", ErrFailedPrecondition, target)
			}
			pr = &p
		}
	case TargetPlugin:
		if args, err = m.resolvePluginTarget(ctx, subscriber, target, o.Args); err != nil {
			return SubscribeResult{}, err
		}
	}
	id, err := newSubscriptionID()
	if err != nil {
		return SubscribeResult{}, err
	}
	res, err := m.subscribe(Subscription{
		ID: id, SubscriberID: subscriber, TargetKind: kind, TargetID: target, Condition: cond, Args: args,
		Repeat: o.Repeat && kind != TargetActionRun, CreatedAt: m.opts.Now().Round(0).Truncate(time.Millisecond),
	}, run, pr)
	if err == nil {
		m.rewait(subscriber) // it may wait on the target now (waiting.go)
	}
	if err != nil || kind != TargetActionRun || res.Fired || res.Existed {
		return res, err
	}
	// The run may have ended between the look-up and the registration, before its end
	// could see the subscription: look again (ActionRunFinished fires each once).
	if again, err := m.actionRun(ctx, target); err == nil && again.Finished {
		m.fireRun(again)
	}
	return res, nil
}

// actionRun looks up a run for a subscription.
func (m *Manager) actionRun(ctx context.Context, id string) (ActionRun, error) {
	if m.opts.ActionRun == nil {
		return ActionRun{}, fmt.Errorf("%w: action runs are not available", ErrFailedPrecondition)
	}
	run, ok := m.opts.ActionRun(ctx, id)
	if !ok {
		return ActionRun{}, fmt.Errorf("%w: action run %s (runs are remembered until the daemon stops)", ErrNotFound, id)
	}
	return run, nil
}

// subscribe validates sub against the threads and the other subscriptions and keeps
// it, under m.mu and the subscriptions' lock: it fires at once when its target already
// meets the condition (a run: already finished, given as run; a pull request: as the
// GitHub store's cache has it, pr, nil when unknown there).
func (m *Manager) subscribe(sub Subscription, run ActionRun, pr *PullRequestInfo) (SubscribeResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return SubscribeResult{}, ErrClosed
	}
	srec, ok := m.recs[sub.SubscriberID]
	if !ok {
		return SubscribeResult{}, fmt.Errorf("%w: subscriber %s", ErrNotFound, sub.SubscriberID)
	}
	if !srec.s.ArchivedAt.IsZero() {
		return SubscribeResult{}, fmt.Errorf("%w: thread %s is archived; unarchive it to subscribe it", ErrFailedPrecondition, sub.SubscriberID)
	}
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	var target Thread
	if sub.TargetKind == TargetThread {
		trec, ok := m.recs[sub.TargetID]
		switch {
		case sub.TargetID == sub.SubscriberID:
			return SubscribeResult{}, fmt.Errorf("%w: thread %s cannot subscribe to itself", ErrFailedPrecondition, sub.TargetID)
		case !ok:
			return SubscribeResult{}, fmt.Errorf("target thread: %w", m.notFound(sub.TargetID))
		case !trec.s.ArchivedAt.IsZero():
			return SubscribeResult{}, fmt.Errorf("%w: thread %s is archived", ErrFailedPrecondition, sub.TargetID)
		}
		for _, r := range s.byID {
			if r.s.SubscriberID == sub.TargetID && r.s.TargetKind == TargetThread && r.s.TargetID == sub.SubscriberID {
				return SubscribeResult{}, fmt.Errorf("%w: thread %s already subscribes to thread %s (%s); subscribing back would wake them in a loop",
					ErrFailedPrecondition, sub.TargetID, sub.SubscriberID, r.s.ID)
			}
		}
		target = trec.s
	}
	for _, r := range s.byID {
		if r.s.SubscriberID == sub.SubscriberID && r.s.TargetKind == sub.TargetKind && r.s.TargetID == sub.TargetID && r.s.Condition == sub.Condition &&
			maps.Equal(r.s.Args, sub.Args) {
			if r.s.Repeat != sub.Repeat {
				r.s.Repeat = sub.Repeat
				if err := saveSubscription(context.Background(), s.db, r.s); err != nil {
					return SubscribeResult{}, err
				}
			}
			return SubscribeResult{Subscription: r.s, Existed: true}, nil
		}
	}
	r := &subRec{s: sub}
	fired := false
	switch sub.TargetKind {
	case TargetThread:
		r.sat, r.req = Meets(sub.Condition, target), requestKey(target)
		if r.sat {
			fired = m.fireThreadLocked(r, target)
		}
	case TargetActionRun:
		if run.Finished {
			fired = m.fireLocked(r, func(s Subscription, at time.Time) Message { return runWake(s, run, at) })
		}
	case TargetPullRequest:
		if pr != nil && prAlreadyMet(sub.Condition, *pr) {
			p := *pr
			fired = m.fireLocked(r, func(s Subscription, at time.Time) Message { return prWake(s, p, nil, at) })
		}
	}
	if fired && (!r.s.Repeat || prTerminal(r.s.Condition)) {
		m.log.Info("wake subscription fired at once", "subscription", sub.ID, "subscriber", sub.SubscriberID,
			"target", sub.TargetID, "condition", sub.Condition)
		return SubscribeResult{Subscription: r.s, Fired: true}, nil
	}
	if err := saveSubscription(context.Background(), s.db, r.s); err != nil {
		return SubscribeResult{}, err
	}
	s.byID[sub.ID] = r
	s.syncWatchLocked()
	s.notePluginLocked(r.s, true)
	m.log.Info("wake subscription added", "subscription", sub.ID, "subscriber", sub.SubscriberID, "target_kind", sub.TargetKind,
		"target", sub.TargetID, "condition", sub.Condition, "repeat", sub.Repeat, "fired", fired)
	return SubscribeResult{Subscription: r.s, Fired: fired}, nil
}

// observeLocked is the commit hook: t was just published. An archived thread's
// subscriptions go (forgetLocked); a thread being removed is skipped (its subscribers
// get a removed wake, subscriptions_removed.go); otherwise each subscription to t fires
// when t went into its condition, and a settled or attention one also when t, still
// meeting it, now waits on another pending request than when last seen (requestKey): a
// permission prompt answered and the next one asked within the status debounce publish
// as one change, from "permission: Edit …" to "permission: Bash …". A reason change
// that is not a new request (finished, then finished again) does not fire. Callers hold
// m.mu.
func (m *Manager) observeLocked(t Thread) {
	if m.subs == nil {
		return
	}
	if !t.ArchivedAt.IsZero() {
		m.forgetLocked(t.ID, "archived")
		return
	}
	if t.Removing {
		// Its subscribers get a removed wake (fireRemovedLocked). Should the removal
		// fail, the next change is compared with the state from before it.
		return
	}
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	var hit []*subRec
	for _, r := range s.byID {
		if r.s.TargetKind == TargetThread && r.s.TargetID == t.ID {
			hit = append(hit, r)
		}
	}
	slices.SortFunc(hit, func(a, b *subRec) int {
		return cmp.Or(a.s.CreatedAt.Compare(b.s.CreatedAt), strings.Compare(a.s.ID, b.s.ID))
	})
	req := requestKey(t)
	for _, r := range hit {
		now := Meets(r.s.Condition, t)
		was, wasReq := r.sat, r.req
		r.sat, r.req = now, req
		newRequest := was && firesOnRequest(r.s.Condition) && req != "" && req != wasReq
		if !now || (was && !newRequest) {
			continue
		}
		if m.fireThreadLocked(r, t) {
			s.firedLocked(r)
		}
	}
}

// ActionRunFinished fires the subscriptions to run id, which ended. The daemon calls it
// for every run_finished of the action store.
func (m *Manager) ActionRunFinished(ctx context.Context, id string) {
	if m.opts.ActionRun == nil {
		return
	}
	run, ok := m.opts.ActionRun(ctx, id)
	if !ok {
		run = ActionRun{ID: id, Finished: true}
	}
	run.Finished = true
	m.fireRun(run)
}

// fireRun fires (and removes) every subscription to run.
func (m *Manager) fireRun(run ActionRun) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	var hit []*subRec
	for _, r := range s.byID {
		if r.s.TargetKind == TargetActionRun && r.s.TargetID == run.ID {
			hit = append(hit, r)
		}
	}
	slices.SortFunc(hit, func(a, b *subRec) int { return a.s.CreatedAt.Compare(b.s.CreatedAt) })
	for _, r := range hit {
		m.fireLocked(r, func(s Subscription, at time.Time) Message { return runWake(s, run, at) })
		// Once, whether delivered or dropped by the wake limit: the run will not end again.
		s.removeLocked([]string{r.s.ID})
	}
}

// firedLocked keeps a subscription that fired: a one-shot goes, a repeat one's counts
// are saved. Callers hold s.mu.
func (s *subscriptions) firedLocked(r *subRec) {
	if !r.s.Repeat {
		s.removeLocked([]string{r.s.ID})
		return
	}
	if err := saveSubscription(context.Background(), s.db, r.s); err != nil {
		s.log.Error("persist wake subscription", "subscription", r.s.ID, "err", err)
	}
}

// removeLocked forgets subscriptions, in memory and in the database. Callers hold s.mu.
func (s *subscriptions) removeLocked(ids []string) {
	if len(ids) == 0 {
		return
	}
	for _, id := range ids {
		if r, ok := s.byID[id]; ok {
			s.notePluginLocked(r.s, false)
		}
		delete(s.byID, id)
	}
	if err := deleteSubscriptions(context.Background(), s.db, ids); err != nil {
		s.log.Error("delete wake subscriptions", "subscriptions", ids, "err", err)
	}
	s.syncWatchLocked()
}

// syncWatchLocked tells Options.WatchPullRequests the pull requests the subscriptions
// watch when the set changed. Callers hold s.mu.
func (s *subscriptions) syncWatchLocked() {
	var targets []string
	for _, r := range s.byID {
		if r.s.TargetKind == TargetPullRequest && !slices.Contains(targets, r.s.TargetID) {
			targets = append(targets, r.s.TargetID)
		}
	}
	slices.Sort(targets)
	if slices.Equal(targets, s.watched) {
		return
	}
	s.watched = targets
	if s.watch != nil {
		s.watch(slices.Clone(targets))
	}
}

// forgetLocked deletes the subscriptions of thread id and those to it, and drops the
// wakes still queued for it (a wake must not bring an archived thread back). Callers
// hold m.mu.
func (m *Manager) forgetLocked(id, why string) {
	if m.subs == nil {
		return
	}
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	var ids []string
	for sid, r := range s.byID {
		if r.s.SubscriberID == id || (r.s.TargetKind == TargetThread && r.s.TargetID == id) {
			ids = append(ids, sid)
		}
	}
	if q, ok := s.queues[id]; ok {
		q.items = nil
	}
	if why == "removed" {
		delete(s.sent, id)
		delete(s.noted, id)
	}
	if len(ids) == 0 {
		return
	}
	slices.Sort(ids)
	s.removeLocked(ids)
	m.log.Info("wake subscriptions deleted with their thread", "thread", id, "why", why, "subscriptions", ids)
}

// Unsubscribe implements Store. A subscriber that waited on the target may wait on
// nothing now (waiting.go).
func (m *Manager) Unsubscribe(_ context.Context, o UnsubscribeOptions) ([]Subscription, error) {
	out, err := m.unsubscribe(o)
	if len(out) > 0 {
		m.rewait(out[0].SubscriberID)
	}
	return out, err
}

// unsubscribe removes the subscriptions o names.
func (m *Manager) unsubscribe(o UnsubscribeOptions) ([]Subscription, error) {
	s := m.subs
	if id := strings.TrimSpace(o.ID); id != "" {
		s.mu.Lock()
		defer s.mu.Unlock()
		r, ok := s.byID[id]
		if !ok {
			return nil, fmt.Errorf("%w: subscription %s", ErrNotFound, id)
		}
		s.removeLocked([]string{id})
		m.log.Info("wake subscription removed", "subscription", id)
		return []Subscription{r.s}, nil
	}
	kind, target, _, err := subscribeTarget(SubscribeOptions{TargetThreadID: o.TargetThreadID, TargetRunID: o.TargetRunID,
		TargetPullRequest: o.TargetPullRequest, TargetPlugin: o.TargetPlugin})
	if err != nil {
		return nil, fmt.Errorf("%w: give a subscription id, or a subscriber and a target", ErrInvalidArgument)
	}
	subscriber := strings.TrimSpace(o.SubscriberID)
	if subscriber == "" {
		return nil, fmt.Errorf("%w: a subscriber thread is required with a target", ErrInvalidArgument)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Subscription
	var ids []string
	for id, r := range s.byID {
		if r.s.SubscriberID == subscriber && r.s.TargetKind == kind && r.s.TargetID == target {
			out = append(out, r.s)
			ids = append(ids, id)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: thread %s has no subscription to %s", ErrNotFound, subscriber, target)
	}
	sortSubscriptions(out)
	s.removeLocked(ids)
	m.log.Info("wake subscriptions removed", "subscriber", subscriber, "target", target, "count", len(ids))
	return out, nil
}

// Subscriptions implements Store.
func (m *Manager) Subscriptions(ctx context.Context, subscriber string) ([]Subscription, error) {
	subscriber = strings.TrimSpace(subscriber)
	snap := m.Snapshot()
	if _, ok := snap.Thread(subscriber); subscriber != "" && !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, subscriber)
	}
	s := m.subs
	s.mu.Lock()
	var out []Subscription
	for _, r := range s.byID {
		if subscriber == "" || r.s.SubscriberID == subscriber {
			out = append(out, r.s)
		}
	}
	s.mu.Unlock()
	for i := range out {
		sub := &out[i]
		if t, ok := snap.Thread(sub.SubscriberID); ok {
			sub.SubscriberName = t.Name
		}
		sub.TargetStatus = "gone"
		switch sub.TargetKind {
		case TargetThread:
			if t, ok := snap.Thread(sub.TargetID); ok {
				sub.TargetName, sub.TargetStatus = t.Name, statusWords(t)
			}
		case TargetActionRun:
			if m.opts.ActionRun == nil {
				continue
			}
			if run, ok := m.opts.ActionRun(ctx, sub.TargetID); ok {
				sub.TargetName, sub.TargetStatus = run.ActionName, "running"
				if run.Finished {
					sub.TargetStatus = "exited " + strconv.Itoa(run.ExitCode)
				}
			}
		case TargetPullRequest:
			sub.TargetName, sub.TargetStatus = sub.TargetID, "not polled yet"
			if m.opts.PullRequest == nil {
				continue
			}
			if p, ok := m.opts.PullRequest(ctx, sub.TargetID); ok {
				sub.TargetName, sub.TargetStatus = prTargetName(p), prStatusWords(p)
			}
		case TargetPlugin:
			s.describePlugin(sub)
		}
	}
	sortSubscriptions(out)
	return out, nil
}

// sortSubscriptions orders by subscriber, then creation, then id.
func sortSubscriptions(subs []Subscription) {
	slices.SortFunc(subs, func(a, b Subscription) int {
		return cmp.Or(strings.Compare(a.SubscriberID, b.SubscriberID), a.CreatedAt.Compare(b.CreatedAt), strings.Compare(a.ID, b.ID))
	})
}

// statusWords is a thread's status for a listing: "needs attention (finished)", with
// ", disconnected" when no Claude process runs.
func statusWords(t Thread) string {
	w := t.Status.String()
	if t.StatusReason != "" {
		w += " (" + t.StatusReason + ")"
	}
	if t.State == StateDisconnected {
		w += ", disconnected"
	}
	return w
}

// checkNotify validates CreateOptions.Notify for Create, before anything is made: it
// needs a creator, which must not be archived.
func (m *Manager) checkNotify(notify bool, creator string) error {
	if !notify {
		return nil
	}
	if creator == "" {
		return fmt.Errorf("%w: notify needs created-by (the thread to wake)", ErrInvalidArgument)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[creator]; ok && !rec.s.ArchivedAt.IsZero() {
		return fmt.Errorf("%w: thread %s is archived; it cannot be notified", ErrFailedPrecondition, creator)
	}
	return nil
}

// notifyCreator subscribes creator to the new thread child (CreateOptions.Notify):
// settled, repeat. The thread exists by now, so a failure is logged, not returned.
func (m *Manager) notifyCreator(ctx context.Context, creator, child string) {
	res, err := m.Subscribe(ctx, SubscribeOptions{SubscriberID: creator, TargetThreadID: child, Condition: CondSettled, Repeat: true})
	if err != nil {
		m.log.Warn("subscribe the creator to its new thread", "thread", child, "created_by", creator, "err", err)
		return
	}
	m.log.Info("creator notified of its new thread", "thread", child, "created_by", creator, "subscription", res.Subscription.ID)
}

// waitTargets are the threads subscriber's subscriptions wait on (waiting.go): the
// targets of its thread subscriptions whose condition a working thread meets when it
// settles (settled, idle, attention), each once.
func (s *subscriptions) waitTargets(subscriber string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, r := range s.byID {
		if r.s.SubscriberID != subscriber || r.s.TargetKind != TargetThread || !slices.Contains(waitConditions, r.s.Condition) ||
			slices.Contains(out, r.s.TargetID) {
			continue
		}
		out = append(out, r.s.TargetID)
	}
	slices.Sort(out)
	return out
}

// waitConditions are the thread conditions a subscriber waits on (waitTargets).
var waitConditions = []Condition{CondSettled, CondIdle, CondAttention}

// subscribersOf are the threads with a subscription to thread target, each once.
func (s *subscriptions) subscribersOf(target string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, r := range s.byID {
		if r.s.TargetKind == TargetThread && r.s.TargetID == target && !slices.Contains(out, r.s.SubscriberID) {
			out = append(out, r.s.SubscriberID)
		}
	}
	slices.Sort(out)
	return out
}

// wakeQueued reports whether a wake to thread id is queued or being delivered.
func (s *subscriptions) wakeQueued(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.queues[id]
	return ok
}
