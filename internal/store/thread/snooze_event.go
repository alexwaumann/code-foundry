package thread

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Snoozing a thread until an event (docs/notes/snooze-until-event.md): a pull request's
// checks finish, it is reviewed or merged, a plugin's wake source fires. The thread is put
// away as a save for later is (SavedAt set, no wake time), and the event ends the snooze as
// the time ends a timed one: top of Active as "snooze ended", with SnoozeEndedBy saying what
// happened.
//
// The event is watched by a wake subscription the store owns for the thread (subscriber:
// the thread itself), so the GitHub poll's watch set, the plugin's arming (wake/subscribed,
// re-armed at every start) and the cannot-fire rules are the engine's, not copies. What makes
// it a snooze subscription is its row in thread_snooze_events (subRec.snooze): where an
// ordinary subscription queues a wake message, this one ends the snooze (endSnoozesLocked),
// so the wake limit never sees it, and it is left out of listings and unsubscribes. Any other
// snooze, an unsnooze, the user's message, a pin or an archive drops it (dropSnoozeEventLocked).

// EventSnooze is what Store.SnoozeUntilEvent waits for: exactly one of PullRequest (with
// Condition, CondChecksDone when empty) and Plugin ("<plugin>/<source>", with Args).
type EventSnooze struct {
	// PullRequest is "owner/name#123", a pull request URL, or "#123" (one of the thread's
	// pull requests, else that number in the repository of the thread's first).
	PullRequest string
	Condition   Condition
	Plugin      string
	Args        map[string]string
}

// SnoozeEvent is what a thread snoozed until an event waits on (Thread.SnoozeEvent).
type SnoozeEvent struct {
	SubscriptionID string
	Kind           TargetKind // TargetPullRequest or TargetPlugin
	Target         string     // "owner/name#123", "<plugin>/<source>"
	Condition      Condition  // a pull request's; CondFired for a plugin
	Args           map[string]string
	// Title is the pull request's title, or the wake source's ("Deploy finished");
	// PluginName the plugin's display name ("" for a pull request).
	Title, PluginName string
	Since             time.Time
}

// SnoozeConditions are the pull request conditions a snooze takes, in the Until event
// menu's order. changed is left out: it says nothing a user would wait for.
var SnoozeConditions = []Condition{CondChecksDone, CondReview, CondMerged, CondComment, CondHeadPushed, CondClosed,
	CondReviewRequested, CondChecksPassed, CondChecksFailed}

// prNumber is "#123" of a pull request target "owner/name#123".
func prNumber(target string) string {
	if i := strings.LastIndexByte(target, '#'); i >= 0 {
		return target[i:]
	}
	return target
}

// Label is the event in a few words, for the sidebar row: "#812 checks", "#790 merged",
// "deploy" (a plugin's source name).
func (e SnoozeEvent) Label() string {
	if e.Kind == TargetPlugin {
		_, src, _ := strings.Cut(e.Target, "/")
		return src
	}
	words := map[Condition]string{
		CondChecksDone: "checks", CondChecksPassed: "checks pass", CondChecksFailed: "checks fail", CondReview: "review",
		CondComment: "comment", CondReviewRequested: "review request", CondHeadPushed: "push", CondMerged: "merged", CondClosed: "closed",
	}
	return prNumber(e.Target) + " " + cmp.Or(words[e.Condition], string(e.Condition))
}

// WaitingFor is the event as the end of "Snoozed until …": "checks finish on #812",
// "#790 is merged", "Deploy finished (Vercel)".
func (e SnoozeEvent) WaitingFor() string {
	if e.Kind == TargetPlugin {
		_, src, _ := strings.Cut(e.Target, "/")
		return cmp.Or(e.Title, src) + " (" + cmp.Or(e.PluginName, strings.SplitN(e.Target, "/", 2)[0]) + ")"
	}
	n := prNumber(e.Target)
	switch e.Condition {
	case CondChecksDone:
		return "checks finish on " + n
	case CondChecksPassed:
		return "checks pass on " + n
	case CondChecksFailed:
		return "checks fail on " + n
	case CondReview:
		return n + " is reviewed"
	case CondComment:
		return n + " gets a comment"
	case CondReviewRequested:
		return "a review is requested on " + n
	case CondHeadPushed:
		return n + " gets a push"
	case CondMerged:
		return n + " is merged"
	case CondClosed:
		return n + " is closed"
	}
	return n + " " + string(e.Condition)
}

// canNoLonger is what a pull request can no longer do once closed or merged, as the end of
// "#812 was closed, so it can no longer …".
func canNoLonger(c Condition) string {
	switch c {
	case CondChecksDone:
		return "finish its checks"
	case CondChecksPassed:
		return "pass its checks"
	case CondChecksFailed:
		return "fail its checks"
	case CondReview:
		return "be reviewed"
	case CondComment:
		return "get a comment"
	case CondReviewRequested:
		return "get a review request"
	case CondHeadPushed:
		return "get a push"
	case CondMerged:
		return "be merged"
	}
	return "be " + string(c)
}

// checksCount is "2 of 14": failed (or passed) of the total.
func checksCount(n, total int) string { return strconv.Itoa(n) + " of " + strconv.Itoa(total) }

// prEndedBy says what ended a snooze on condition c of p, which the poll saw change
// (matched: the changes that met it; none when it can no longer happen): "Checks failed on
// #812 (2 of 14)", "#812 was merged", "#812 was closed, so it can no longer be merged".
func prEndedBy(c Condition, p PullRequestInfo, matched []PullRequestChange) string {
	n := "#" + strconv.Itoa(p.Number)
	if len(matched) == 0 && prCannotFire(c, p) {
		what := "closed"
		if p.State == "merged" {
			what = "merged"
		}
		return n + " was " + what + ", so it can no longer " + canNoLonger(c)
	}
	ch := p.Checks
	switch c {
	case CondChecksDone, CondChecksPassed, CondChecksFailed:
		if checksMeet(CondChecksFailed, ch) {
			return "Checks failed on " + n + " (" + checksCount(ch.Failed, ch.Total) + ")"
		}
		return "Checks passed on " + n + " (" + checksCount(ch.Passed, ch.Total) + ")"
	case CondReview:
		if len(p.LatestReviews) > 0 {
			r := p.LatestReviews[len(p.LatestReviews)-1]
			return n + " was reviewed (" + strings.ToLower(strings.ReplaceAll(r.State, "_", " ")) + " by " + r.Author + ")"
		}
		return n + " was reviewed"
	case CondComment:
		return n + " got a new comment"
	case CondReviewRequested:
		return "A review was requested on " + n
	case CondHeadPushed:
		return "New commits were pushed to " + n
	case CondMerged:
		return n + " was merged"
	case CondClosed:
		return n + " was closed"
	}
	return n + " changed"
}

// upperFirst capitalises a sentence's first letter.
func upperFirst(s string) string {
	r, size := utf8.DecodeRuneInString(s)
	if r == utf8.RuneError {
		return s
	}
	return string(unicode.ToUpper(r)) + s[size:]
}

// snoozeMeta marks a snooze subscription (subRec.snooze): what the thread's row in
// thread_snooze_events keeps beside it.
type snoozeMeta struct {
	thread, title, plugin string
	since                 time.Time
}

// snoozeEnd is a snooze an event ended: the thread, its subscription and why.
type snoozeEnd struct {
	thread, sub, why string
}

// SnoozeUntilEvent snoozes thread id until ev happens (Store). It is a save for later
// (SavedAt, no wake time, replacing any earlier snooze) watched by a subscription the store
// owns for the thread. A pull request is asked about on GitHub first: one that does not
// exist, could not be asked about, or is closed or merged so the condition cannot happen is
// refused, and so is a condition already met (checks already finished): there is nothing to
// wait for. A plugin source needs its plugin enabled; its args are resolved as a wake
// subscription's (defaults, the thread's context). What else refuses a snooze refuses this.
func (m *Manager) SnoozeUntilEvent(ctx context.Context, id string, ev EventSnooze) (Thread, error) {
	t, ok := m.Snapshot().Thread(id)
	if !ok {
		return Thread{}, m.notFound(id)
	}
	meta := snoozeMeta{thread: id, since: m.opts.Now().Round(0).Truncate(time.Millisecond)}
	sub := Subscription{SubscriberID: id, CreatedAt: meta.since}
	pr, plugin := strings.TrimSpace(ev.PullRequest), strings.TrimSpace(ev.Plugin)
	switch {
	case (pr == "") == (plugin == ""):
		return Thread{}, fmt.Errorf("%w: give a pull request or a plugin's wake source to snooze until", ErrInvalidArgument)
	case plugin != "" && ev.Condition != "" && ev.Condition != CondFired:
		return Thread{}, fmt.Errorf("%w: a plugin's wake source ends a snooze when it fires; leave the condition out", ErrInvalidArgument)
	case pr != "" && len(ev.Args) > 0:
		return Thread{}, fmt.Errorf("%w: args are for a plugin's wake source", ErrInvalidArgument)
	case pr != "":
		target, err := m.snoozeTarget(ctx, t, pr)
		if err != nil {
			return Thread{}, err
		}
		c := cmp.Or(ev.Condition, CondChecksDone)
		if !slices.Contains(SnoozeConditions, c) {
			return Thread{}, fmt.Errorf("%w: a snooze takes checks_done, review, merged, comment, head_pushed, closed, review_requested, checks_passed or checks_failed, not %q",
				ErrInvalidArgument, c)
		}
		p, err := m.snoozePullRequest(ctx, target, c)
		if err != nil {
			return Thread{}, err
		}
		meta.title = p.Title
		sub.TargetKind, sub.TargetID, sub.Condition = TargetPullRequest, target, c
	default:
		if p, src, ok := strings.Cut(plugin, "/"); !ok || p == "" || src == "" || strings.Contains(src, "/") {
			return Thread{}, fmt.Errorf("%w: %q is not <plugin>/<source> (code-foundry thread snooze events lists them)", ErrInvalidArgument, plugin)
		}
		args, err := m.resolvePluginTarget(ctx, id, plugin, ev.Args)
		if err != nil {
			return Thread{}, err
		}
		meta.title, meta.plugin = m.pluginSourceNames(ctx, t, plugin)
		sub.TargetKind, sub.TargetID, sub.Condition, sub.Args = TargetPlugin, plugin, CondFired, args
	}
	subID, err := newSubscriptionID()
	if err != nil {
		return Thread{}, err
	}
	sub.ID = subID
	var keepErr error
	s, err := m.putAway(ctx, id, func(rec *record) {
		if keepErr = m.keepSnoozeEventLocked(rec, sub, meta); keepErr != nil {
			return // left as it was; the commit is harmless
		}
		rec.s.SnoozedUntil = time.Time{}
		if rec.s.SavedAt.IsZero() {
			rec.s.SavedAt = meta.since
		}
	})
	if err == nil {
		err = keepErr
	}
	if err != nil {
		return Thread{}, err
	}
	if sub.TargetKind == TargetPlugin && askedBy(ctx) == "" {
		m.noteRecentSnooze(sub.TargetID, meta.since)
	}
	m.log.Info("snoozed thread until an event", "thread", id, "target", sub.TargetID, "condition", sub.Condition, "subscription", sub.ID)
	return s, nil
}

// snoozeTarget is a snooze's pull request as "owner/name#123": a "#123" is the thread's
// pull request with that number, else that number in the repository of the thread's first.
func (m *Manager) snoozeTarget(ctx context.Context, t Thread, pr string) (string, error) {
	num, short := strings.CutPrefix(pr, "#")
	if !short {
		if _, err := strconv.Atoi(pr); err == nil {
			num, short = pr, true
		}
	}
	if !short {
		return ParsePullRequestTarget(pr)
	}
	n, err := strconv.Atoi(num)
	if err != nil || n <= 0 {
		return "", fmt.Errorf("%w: %q is not a pull request (owner/name#123, a URL, or #123)", ErrInvalidArgument, pr)
	}
	var mine []string
	if m.opts.ThreadPullRequests != nil {
		mine = m.opts.ThreadPullRequests(ctx, t)
	}
	for _, target := range mine {
		if prNumber(target) == "#"+num {
			return target, nil
		}
	}
	if len(mine) > 0 {
		slug, _, _ := strings.Cut(mine[0], "#")
		return slug + "#" + strconv.Itoa(n), nil
	}
	return "", fmt.Errorf("%w: thread %s has no pull request to take the repository of #%d from; give owner/name#%d", ErrInvalidArgument, t.ID, n, n)
}

// snoozePullRequest asks GitHub about target for a snooze until c, and refuses what cannot
// or need not be waited for.
func (m *Manager) snoozePullRequest(caller context.Context, target string, c Condition) (PullRequestInfo, error) {
	if m.opts.LookupPullRequest == nil {
		return PullRequestInfo{}, fmt.Errorf("%w: pull requests are not available", ErrFailedPrecondition)
	}
	ctx, cancel := context.WithTimeout(caller, prLookupTimeout)
	defer cancel()
	p, err := m.opts.LookupPullRequest(ctx, target)
	n := prNumber(target)
	switch {
	case caller.Err() != nil:
		return PullRequestInfo{}, caller.Err()
	case errors.Is(err, ErrNotFound):
		return PullRequestInfo{}, fmt.Errorf("%w: pull request %s does not exist, or this GitHub login cannot see it", ErrFailedPrecondition, target)
	case err != nil:
		return PullRequestInfo{}, fmt.Errorf("%w: could not check pull request %s on GitHub (%s); try again", ErrFailedPrecondition, target,
			oneLine(err.Error(), maxHeaderSummary))
	case prAlreadyMet(c, p):
		return PullRequestInfo{}, fmt.Errorf("%w: %s; there is nothing to wait for", ErrFailedPrecondition, alreadyWords(c, p))
	case prCannotFire(c, p):
		return PullRequestInfo{}, fmt.Errorf("%w: %s is %s, so it can no longer %s", ErrFailedPrecondition, n, p.State, canNoLonger(c))
	}
	return p, nil
}

// alreadyWords says a condition p already meets: "checks on #812 already finished (12
// passed, 2 failed)", "#812 is already merged".
func alreadyWords(c Condition, p PullRequestInfo) string {
	n := "#" + strconv.Itoa(p.Number)
	ch := p.Checks
	switch c {
	case CondChecksDone:
		return fmt.Sprintf("checks on %s already finished (%d passed, %d failed)", n, ch.Passed, ch.Failed)
	case CondChecksPassed:
		return fmt.Sprintf("checks on %s already passed (%s)", n, checksCount(ch.Passed, ch.Total))
	case CondChecksFailed:
		return fmt.Sprintf("checks on %s already failed (%s)", n, checksCount(ch.Failed, ch.Total))
	}
	return n + " is already " + p.State
}

// pluginSourceNames are a wake source's title and its plugin's display name, from the
// plugin store's sources (falling back to the source and plugin names).
func (m *Manager) pluginSourceNames(ctx context.Context, t Thread, target string) (title, plugin string) {
	p, src, _ := strings.Cut(target, "/")
	title, plugin = src, p
	if ps, ok := m.subs.pluginWakes().(PluginSources); ok {
		for _, s := range ps.Sources(ctx, t) {
			if s.Target == target {
				return cmp.Or(s.Title, src), cmp.Or(s.PluginName, p)
			}
		}
	}
	if pw := m.subs.pluginWakes(); pw != nil {
		if name, _ := pw.Describe(target); name != "" {
			if d, t, ok := strings.Cut(name, ": "); ok {
				return cmp.Or(t, src), cmp.Or(d, p)
			}
		}
	}
	return title, plugin
}

// keepSnoozeEventLocked makes rec wait on sub (a new snooze subscription, meta its
// display): the thread's row in thread_snooze_events first, so a failure after it leaves no
// subscription that would wake the thread with a message; then the subscription, armed as
// any (the poll's watch set, the plugin's wake/subscribed). Callers hold m.mu.
func (m *Manager) keepSnoozeEventLocked(rec *record, sub Subscription, meta snoozeMeta) error {
	if err := saveSnoozeEvent(context.Background(), m.opts.DB, meta, sub.ID, ""); err != nil {
		return err
	}
	if err := saveSubscription(context.Background(), m.opts.DB, sub); err != nil {
		return err
	}
	s := m.subs
	s.mu.Lock()
	r := &subRec{s: sub, snooze: &meta}
	s.byID[sub.ID] = r
	s.syncWatchLocked()
	s.notePluginLocked(sub, true)
	s.mu.Unlock()
	rec.s.SnoozeEvent = snoozeEventOf(sub, meta)
	return nil
}

// snoozeEventOf is Thread.SnoozeEvent for snooze subscription sub.
func snoozeEventOf(sub Subscription, meta snoozeMeta) *SnoozeEvent {
	return &SnoozeEvent{SubscriptionID: sub.ID, Kind: sub.TargetKind, Target: sub.TargetID, Condition: sub.Condition,
		Args: maps.Clone(sub.Args), Title: meta.title, PluginName: meta.plugin, Since: meta.since}
}

// dropSnoozeEventLocked forgets what rec's snooze waited on, if anything: its subscription
// and its row (the plugin is told; the poll stops watching). It clears SnoozeEndedBy too: a
// new snooze or an unsnooze makes the last event's words old news. It reports whether rec
// changed. Callers hold m.mu, not m.subs.mu.
func (m *Manager) dropSnoozeEventLocked(rec *record) bool {
	changed := rec.s.SnoozeEvent != nil || rec.s.SnoozeEndedBy != ""
	if !changed {
		return false
	}
	if ev := rec.s.SnoozeEvent; ev != nil && m.subs != nil {
		s := m.subs
		s.mu.Lock()
		if _, ok := s.byID[ev.SubscriptionID]; ok {
			s.removeLocked([]string{ev.SubscriptionID})
		}
		s.mu.Unlock()
	}
	if err := deleteSnoozeEvent(context.Background(), m.opts.DB, rec.s.ID); err != nil {
		m.log.Error("forget a snooze's event", "thread", rec.s.ID, "err", err)
	}
	rec.s.SnoozeEvent, rec.s.SnoozeEndedBy = nil, ""
	return true
}

// endSnoozesLocked ends the snoozes events ended (each thread still waiting on that
// subscription; the subscriptions are gone already): SavedAt cleared, SnoozeEndedBy set and
// the thread marked "snooze ended" as wakeSnoozed does, on its row when it is stopped. It
// returns the threads whose runner must be told (markSnoozesEnded, off the locks). Callers
// hold m.mu, not m.subs.mu.
func (m *Manager) endSnoozesLocked(ends []snoozeEnd) []string {
	now := m.opts.Now().Round(0)
	var live []string
	for _, e := range ends {
		rec, ok := m.recs[e.thread]
		if !ok || rec.s.SnoozeEvent == nil || rec.s.SnoozeEvent.SubscriptionID != e.sub {
			continue
		}
		meta := snoozeMeta{thread: e.thread}
		if err := saveSnoozeEvent(context.Background(), m.opts.DB, meta, "", e.why); err != nil {
			m.log.Error("record why a snooze ended", "thread", e.thread, "err", err)
		}
		rec.s.SnoozedUntil, rec.s.SavedAt, rec.s.SnoozeEvent, rec.s.SnoozeEndedBy = time.Time{}, time.Time{}, nil, e.why
		if rec.run == nil && rec.s.State == StateDisconnected {
			rec.s.Status, rec.s.StatusReason, rec.s.StatusChangedAt = StatusNeedsAttention, ReasonSnoozeEnded, now
		} else {
			live = append(live, e.thread)
		}
		m.commitLocked(rec, true)
		m.log.Info("snooze ended by its event", "thread", e.thread, "why", e.why)
	}
	return live
}

// markSnoozesEnded marks live threads "snooze ended" on their runners (setSnoozeEnded),
// in the background: callers come from the GitHub poll and the plugin store.
func (m *Manager) markSnoozesEnded(ids []string) {
	if len(ids) == 0 {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		for _, id := range ids {
			if err := m.setSnoozeEnded(m.ctx, id, true); err != nil && m.ctx.Err() == nil {
				m.log.Warn("mark snooze ended", "thread", id, "err", err)
			}
		}
	}()
}

// snoozeHitLocked takes r, a snooze subscription an event ended: it goes, and the end is
// returned for endSnoozesLocked. Callers hold m.subs.mu.
func (s *subscriptions) snoozeHitLocked(r *subRec, why string) snoozeEnd {
	s.removeLocked([]string{r.s.ID})
	return snoozeEnd{thread: r.s.SubscriberID, sub: r.s.ID, why: upperFirst(why)}
}

// loadSnoozeEvents ties the snooze subscriptions to their threads at startup (New): a row
// whose subscription and thread wait still marks it and fills Thread.SnoozeEvent; a row
// whose thread is no longer snoozed, or whose subscription is gone, is dropped (the thread
// stays saved for later); an ended row gives SnoozeEndedBy. Callers hold no lock; nothing
// runs yet.
func (m *Manager) loadSnoozeEvents(ctx context.Context) error {
	rows, err := loadSnoozeEventRows(ctx, m.opts.DB)
	if err != nil {
		return err
	}
	s := m.subs
	var stale, staleSubs []string
	for _, row := range rows {
		rec, ok := m.recs[row.thread]
		if !ok {
			continue
		}
		if row.sub == "" {
			rec.s.SnoozeEndedBy = row.endedBy
			continue
		}
		r, okSub := s.byID[row.sub]
		if !okSub || !rec.s.Snoozed() || !rec.s.SnoozedUntil.IsZero() || r.s.SubscriberID != row.thread {
			stale = append(stale, row.thread)
			if okSub {
				staleSubs = append(staleSubs, row.sub)
			}
			continue
		}
		meta := row.snoozeMeta
		r.snooze = &meta
		rec.s.SnoozeEvent = snoozeEventOf(r.s, meta)
	}
	for _, id := range stale {
		if err := deleteSnoozeEvent(ctx, m.opts.DB, id); err != nil {
			return err
		}
	}
	if len(staleSubs) > 0 {
		s.mu.Lock()
		s.removeLocked(staleSubs)
		s.mu.Unlock()
	}
	if len(stale) > 0 {
		m.log.Info("dropped snooze events at startup (the thread was no longer waiting on them)", "threads", stale)
	}
	return nil
}

// SnoozeEvents is what a thread can be snoozed until now (Store.SnoozeEvents).
type SnoozeEvents struct {
	// PullRequests are the thread's open, non-draft pull requests, newest (highest number)
	// first, each with its pending conditions; one with none is left out.
	PullRequests []SnoozePullRequest
	// Plugins are the wake sources of running plugins, with the args a snooze would use.
	Plugins []PluginSource
	// RecentPlugins are the "<plugin>/<source>" the user last snoozed on, newest first.
	RecentPlugins []string
}

// SnoozePullRequest is one of a thread's pull requests and the conditions a snooze can
// still wait for.
type SnoozePullRequest struct {
	Target     string
	Number     int
	Title      string
	Conditions []Condition
}

// PluginSource is a running plugin's wake source as a thread would use it.
type PluginSource struct {
	Target, Title, PluginName string
	Args                      map[string]string
}

// PluginSources is the optional side of PluginWakes the snooze menu reads: the wake
// sources of running plugins, with the args each would take for thread t (defaults, its
// context). The daemon's adapter implements it.
type PluginSources interface {
	Sources(ctx context.Context, t Thread) []PluginSource
}

// snoozeLookupTimeout bounds the GitHub question for a pull request the cache does not hold.
const snoozeLookupTimeout = 3 * time.Second

// SnoozeEvents lists what thread id can be snoozed until now (Store).
func (m *Manager) SnoozeEvents(ctx context.Context, id string) (SnoozeEvents, error) {
	t, ok := m.Snapshot().Thread(id)
	if !ok {
		return SnoozeEvents{}, m.notFound(id)
	}
	var out SnoozeEvents
	if m.opts.ThreadPullRequests != nil {
		for _, target := range m.opts.ThreadPullRequests(ctx, t) {
			p, ok := m.pullRequestNow(ctx, target)
			if !ok {
				continue
			}
			if conds := pendingConditions(p); len(conds) > 0 {
				out.PullRequests = append(out.PullRequests, SnoozePullRequest{Target: p.Target(), Number: p.Number, Title: p.Title, Conditions: conds})
			}
		}
		slices.SortStableFunc(out.PullRequests, func(a, b SnoozePullRequest) int { return b.Number - a.Number })
	}
	if ps, ok := m.subs.pluginWakes().(PluginSources); ok {
		out.Plugins = ps.Sources(ctx, t)
	}
	recent, err := loadRecentSnoozes(ctx, m.opts.DB)
	if err != nil {
		return SnoozeEvents{}, err
	}
	out.RecentPlugins = recent
	return out, nil
}

// pullRequestNow is target from the GitHub store's cache, else asked of GitHub (bounded).
func (m *Manager) pullRequestNow(ctx context.Context, target string) (PullRequestInfo, bool) {
	if m.opts.PullRequest != nil {
		if p, ok := m.opts.PullRequest(ctx, target); ok {
			return p, true
		}
	}
	if m.opts.LookupPullRequest == nil {
		return PullRequestInfo{}, false
	}
	ctx, cancel := context.WithTimeout(ctx, snoozeLookupTimeout)
	defer cancel()
	p, err := m.opts.LookupPullRequest(ctx, target)
	return p, err == nil
}

// pendingConditions are the conditions a snooze on p can still wait for, in menu order
// (SnoozeConditions): none unless p is open and not a draft; checks finish only while some
// are pending (a pull request with no checks at all never offers it); reviewed while it is
// not approved.
func pendingConditions(p PullRequestInfo) []Condition {
	if p.State != "open" || p.Draft {
		return nil
	}
	var out []Condition
	for _, c := range SnoozeConditions {
		switch c {
		case CondChecksPassed, CondChecksFailed:
			continue // the CLI's; the menu offers checks finish
		case CondChecksDone:
			if (p.Checks.Total == 0 && p.Checks.State == "") || checksMeet(CondChecksDone, p.Checks) {
				continue
			}
		case CondReview:
			if p.ReviewDecision == "APPROVED" {
				continue
			}
		}
		out = append(out, c)
	}
	return out
}

// recentSnoozes is how many recently used plugin sources are remembered.
const recentSnoozes = 10

// noteRecentSnooze remembers that the user snoozed on plugin source target at.
func (m *Manager) noteRecentSnooze(target string, at time.Time) {
	if err := saveRecentSnooze(context.Background(), m.opts.DB, target, at); err != nil {
		m.log.Warn("remember a snooze's plugin event", "target", target, "err", err)
	}
}

// Persistence: thread_snooze_events and snooze_recent_events (migration 0065).

type snoozeEventRow struct {
	snoozeMeta
	sub, endedBy string
}

func loadSnoozeEventRows(ctx context.Context, db *sql.DB) ([]snoozeEventRow, error) {
	rows, err := db.QueryContext(ctx, `SELECT thread_id, subscription_id, title, plugin, since, ended_by FROM thread_snooze_events`)
	if err != nil {
		return nil, fmt.Errorf("thread: load snooze events: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []snoozeEventRow
	for rows.Next() {
		var r snoozeEventRow
		var since int64
		if err := rows.Scan(&r.thread, &r.sub, &r.title, &r.plugin, &since, &r.endedBy); err != nil {
			return nil, fmt.Errorf("thread: load snooze events: %w", err)
		}
		r.since = fromMillis(since)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load snooze events: %w", err)
	}
	return out, nil
}

// saveSnoozeEvent writes meta.thread's row: waiting on sub, or ended (sub "") for why.
func saveSnoozeEvent(ctx context.Context, db *sql.DB, meta snoozeMeta, sub, why string) error {
	_, err := db.ExecContext(ctx, `INSERT INTO thread_snooze_events (thread_id, subscription_id, title, plugin, since, ended_by)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (thread_id) DO UPDATE SET subscription_id = excluded.subscription_id, title = excluded.title,
			plugin = excluded.plugin, since = excluded.since, ended_by = excluded.ended_by`,
		meta.thread, sub, meta.title, meta.plugin, millis(meta.since), why)
	if err != nil {
		return fmt.Errorf("thread: save snooze event of %s: %w", meta.thread, err)
	}
	return nil
}

func deleteSnoozeEvent(ctx context.Context, db *sql.DB, thread string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM thread_snooze_events WHERE thread_id = ?`, thread); err != nil {
		return fmt.Errorf("thread: delete snooze event of %s: %w", thread, err)
	}
	return nil
}

func saveRecentSnooze(ctx context.Context, db *sql.DB, target string, at time.Time) error {
	_, err := db.ExecContext(ctx, `INSERT INTO snooze_recent_events (target, used_at) VALUES (?, ?)
		ON CONFLICT (target) DO UPDATE SET used_at = excluded.used_at`, target, millis(at))
	if err != nil {
		return fmt.Errorf("thread: remember a snooze event: %w", err)
	}
	_, err = db.ExecContext(ctx, `DELETE FROM snooze_recent_events WHERE target NOT IN
		(SELECT target FROM snooze_recent_events ORDER BY used_at DESC, target LIMIT ?)`, recentSnoozes)
	if err != nil {
		return fmt.Errorf("thread: trim the recent snooze events: %w", err)
	}
	return nil
}

func loadRecentSnoozes(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT target FROM snooze_recent_events ORDER BY used_at DESC, target LIMIT ?`, recentSnoozes)
	if err != nil {
		return nil, fmt.Errorf("thread: load the recent snooze events: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("thread: load the recent snooze events: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
