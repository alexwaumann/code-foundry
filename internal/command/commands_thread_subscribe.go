package command

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	threadstore "github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Wake subscriptions (docs/notes/agents-4-wake.md, docs/notes/gh-events-3-pr-wake.md,
// docs/notes/plugins-wake-sources.md): thread.subscribe has the daemon send a thread
// (default: the one this runs in) a wake message when another thread settles (or is
// idle, needs attention, has an error, is disconnected), an action run finishes, a pull
// request's checks finish, it gets a review or comment, is pushed, merged or closed, or a
// plugin fires one of its wake sources (--plugin <plugin>/<source> with --arg k=v), or
// at a time or every interval (--at, --every; docs/notes/ember-1-primitives.md), so an
// agent that started other threads or opened a pull request is woken instead of
// polling.
// thread.unsubscribe and thread.subscriptions manage them. thread.new --notify
// subscribes the creator to the new thread (commands_thread_lifecycle.go).

// SubscriptionBackend is the slice of ThreadService the subscription commands need.
type SubscriptionBackend interface {
	Subscribe(context.Context, *connect.Request[v1.SubscribeThreadRequest]) (*connect.Response[v1.SubscribeThreadResponse], error)
	Unsubscribe(context.Context, *connect.Request[v1.UnsubscribeThreadRequest]) (*connect.Response[v1.UnsubscribeThreadResponse], error)
	ListSubscriptions(context.Context, *connect.Request[v1.ListThreadSubscriptionsRequest]) (*connect.Response[v1.ListThreadSubscriptionsResponse], error)
}

// SubscriptionConditions are thread.subscribe's until values: a thread takes settled to
// disconnected, a run only finished (settled means finished for a run), a pull request
// checks_done to changed. A plugin's wake source takes none: its only condition is
// fired.
var SubscriptionConditions = append([]string{"settled", "idle", "attention", "error", "disconnected", "finished"}, pullRequestConditions...)

// pullRequestConditions are the conditions of a pull request target; the first is the
// default.
var pullRequestConditions = []string{"checks_done", "checks_failed", "checks_passed", "review", "comment",
	"review_requested", "head_pushed", "merged", "closed", "changed"}

var subscriptionConditions = map[string]v1.ThreadSubscriptionCondition{
	"settled":      v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
	"idle":         v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_IDLE,
	"attention":    v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION,
	"error":        v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ERROR,
	"disconnected": v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_DISCONNECTED,
	"finished":     v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED,

	"checks_done":      v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_DONE,
	"checks_failed":    v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_FAILED,
	"checks_passed":    v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_PASSED,
	"review":           v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW,
	"comment":          v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_COMMENT,
	"review_requested": v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW_REQUESTED,
	"head_pushed":      v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_HEAD_PUSHED,
	"merged":           v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_MERGED,
	"closed":           v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CLOSED,
	"changed":          v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHANGED,
	"fired":            v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FIRED,
}

// pullRequestVerbs say what a pull request does to meet a condition.
var pullRequestVerbs = map[v1.ThreadSubscriptionCondition]string{
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_DONE:      "finishes its checks",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_FAILED:    "fails its checks",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_PASSED:    "passes its checks",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW:           "gets a review",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_COMMENT:          "gets a comment",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW_REQUESTED: "gets a review request",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_HEAD_PUSHED:      "is pushed",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_MERGED:           "is merged",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CLOSED:           "is closed",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHANGED:          "changes",
}

// conditionName is a condition as thread.subscribe spells it.
func conditionName(c v1.ThreadSubscriptionCondition) string {
	for name, v := range subscriptionConditions {
		if v == c {
			return name
		}
	}
	return "settled"
}

// subscriptionTarget is "thread s-1", "run r-1", "pr acme/web#7", "plugin hello/tick" or
// "timer every 30m".
func subscriptionTarget(s *v1.ThreadSubscription) string {
	switch s.GetTarget() {
	case v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER:
		return "timer " + cmp.Or(s.GetTargetName(), strings.Replace(s.GetTargetId(), ":", " ", 1))
	case v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_ACTION_RUN:
		return "run " + s.GetTargetId()
	case v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST:
		return "pr " + s.GetTargetId()
	case v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PLUGIN:
		return "plugin " + s.GetTargetId()
	}
	return "thread " + s.GetTargetId()
}

// subscriptionArgs is a plugin subscription's args, "every=2s pr=a/b#1" (sorted), "" for
// none.
func subscriptionArgs(s *v1.ThreadSubscription) string {
	args := s.GetArgs()
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + args[k]
	}
	return strings.Join(parts, " ")
}

// parseWakeArgs reads thread.subscribe's --arg values: "k=v" lines (the CLI joins a
// repeated flag's values with newlines).
func parseWakeArgs(raw string) (map[string]string, error) {
	var out map[string]string
	for line := range strings.SplitSeq(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		_, dup := out[k]
		switch {
		case !ok || k == "":
			return nil, InvalidArg("arg", "%q is not name=value", line)
		case dup:
			return nil, InvalidArg("arg", "%s given twice", k)
		}
		if out == nil {
			out = map[string]string{}
		}
		out[k] = strings.TrimSpace(v)
	}
	return out, nil
}

// subscriptionLine is one subscription in a message: "sub-1: s-p wakes when thread s-c
// is settled (repeat)", then " · <note>" when it has one.
func subscriptionLine(s *v1.ThreadSubscription) string {
	line := subscriptionWhat(s)
	if n := s.GetNote(); n != "" {
		line += " · " + n
	}
	return line
}

// subscriptionWhat is subscriptionLine without the note.
func subscriptionWhat(s *v1.ThreadSubscription) string {
	how := "once"
	if s.GetRepeat() {
		how = "repeat"
	}
	verb := "is " + conditionName(s.GetCondition())
	switch s.GetCondition() {
	case v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FIRED:
		verb = "fires"
		if a := subscriptionArgs(s); a != "" {
			verb += " (" + a + ")"
		}
	case v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION:
		verb = "needs attention"
	case v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ERROR:
		verb = "has an error"
	case v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED:
		verb = "finishes"
	}
	if v, ok := pullRequestVerbs[s.GetCondition()]; ok {
		verb = v
	}
	if s.GetTarget() == v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER {
		return s.GetId() + ": " + s.GetSubscriberThreadId() + " wakes " + timerWhen(s) + " (" + how + ")"
	}
	return s.GetId() + ": " + s.GetSubscriberThreadId() + " wakes when " + subscriptionTarget(s) + " " + verb + " (" + how + ")"
}

// timerWhen is a timer subscription's schedule: "every 30m", or "at 14:00 CDT" in local
// time ("at Oct 21 14:00 CDT" when not today), as thread subscriptions lists it and the
// wake says it; --json keeps the UTC target id.
func timerWhen(s *v1.ThreadSubscription) string {
	kind, v, _ := strings.Cut(s.GetTargetId(), ":")
	if kind == "at" {
		if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
			v = threadstore.ClockTime(t, time.Now())
		}
	}
	return kind + " " + v
}

// parseTimerAt reads thread.subscribe's --at: an RFC 3339 time, or a duration from now
// ("30m", "2h").
func parseTimerAt(raw string, now time.Time) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return time.Time{}, InvalidArg("at", "%q is neither an RFC 3339 time (2026-10-20T09:00:00-05:00) nor a duration from now (30m, 2h)", raw)
	}
	return now.Add(d), nil
}

// parseTimerEvery reads thread.subscribe's --every: a duration of at least a minute.
func parseTimerEvery(raw string) (time.Duration, error) {
	d, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil || d < time.Minute {
		return 0, InvalidArg("every", "%q is not a duration of at least 1m (30m, 2h)", raw)
	}
	return d, nil
}

// subscribeTargetArgs reads exactly one of thread, run, pr and plugin, or none of them
// with timers (the count of the timer args given: at, every; unsubscribe's timers).
func subscribeTargetArgs(a Args, timers int) (thread, run, pr, plugin string, err error) {
	thread, run, pr = strings.TrimSpace(a.String("thread")), strings.TrimSpace(a.String("run")), strings.TrimSpace(a.String("pr"))
	plugin = strings.TrimSpace(a.String("plugin"))
	n := timers
	for _, t := range []string{thread, run, pr, plugin} {
		if t != "" {
			n++
		}
	}
	if n != 1 {
		return "", "", "", "", InvalidArg("thread", "give exactly one target: thread (a thread id), run (an action run id), pr (owner/name#123 or a pull request URL), plugin (<plugin>/<source>; code-foundry plugin wakes lists them), or a timer (at or every)")
	}
	return thread, run, pr, plugin, nil
}

// countSet counts the String args of names that are not empty.
func countSet(a Args, names ...string) int {
	n := 0
	for _, name := range names {
		if strings.TrimSpace(a.String(name)) != "" {
			n++
		}
	}
	return n
}

// boolCount is 1 for true.
func boolCount(b bool) int {
	if b {
		return 1
	}
	return 0
}

func threadSubscribe(b ThreadBackend) Command {
	return Command{
		Name:  "thread.subscribe",
		Title: "Subscribe Thread to Wakes",
		Description: "Wake a thread with a message when another thread settles, " +
			"an action run finishes, a pull request's checks finish, a plugin wake fires (plugin wakes), or at a time or every interval (at, every). " +
			"Fires on each change into the condition, and at once when already met; once by default, every time with repeat.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID, Description: "The thread to wake (default: the thread this runs in)" + IDHelp},
			{Name: "thread", Type: String, ID: ThreadID, Description: "Target thread id" + IDHelp},
			{Name: "run", Type: String, ID: RunID, Description: "Target action run id (r-…; see action runs)" + IDHelp},
			{Name: "pr", Type: String, Description: "Target pull request: owner/name#123 or its URL"},
			{Name: "plugin", Type: String, Description: "Target wake source, <plugin>/<source> (code-foundry plugin wakes lists them)"},
			{Name: "arg", Type: String, Repeatable: true, Description: "A wake source's arg as name=value; " +
				"args with a context default to this thread's (its id, pull request, project)"},
			{Name: "at", Type: String, Description: "A timer: wake once at this time, RFC 3339 (2026-10-20T09:00:00-05:00) or a duration from now (30m, 2h)"},
			{Name: "every", Type: String, Description: "A timer: wake every interval (at least 1m: 30m, 2h) until unsubscribed; repeat is implied"},
			{Name: "until", Type: Enum, Enum: SubscriptionConditions,
				Description: "Default: settled for a thread, finished for a run, checks_done for a pull request"},
			{Name: "repeat", Type: Bool, Description: "Wake on every change into the condition, not once"},
			{Name: "note", Type: String, Description: "Why: what to do when it fires (one line, at most 200 characters); " +
				"the wake carries it and thread subscriptions lists it. Subscribing again with a note replaces it"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			thread, run, pr, plugin, err := subscribeTargetArgs(a, countSet(a, "at", "every"))
			if err != nil {
				return Result{}, err
			}
			var at *timestamppb.Timestamp
			var every *durationpb.Duration
			if raw := a.String("at"); raw != "" {
				t, err := parseTimerAt(raw, time.Now())
				if err != nil {
					return Result{}, err
				}
				at = timestamppb.New(t)
			}
			if raw := a.String("every"); raw != "" {
				d, err := parseTimerEvery(raw)
				if err != nil {
					return Result{}, err
				}
				every = durationpb.New(d)
			}
			args, err := parseWakeArgs(a.String("arg"))
			if err != nil {
				return Result{}, err
			}
			if _, err := threadstore.CleanNote(a.String("note")); err != nil {
				return Result{}, InvalidArg("note", "is at most %d characters", threadstore.MaxNote)
			}
			until := a.String("until")
			isPR := slices.Contains(pullRequestConditions, until)
			switch {
			case run != "" && until != "" && until != "settled" && until != "finished":
				return Result{}, InvalidArg("until", "an action run's only condition is finished, not %s", until)
			case thread != "" && (until == "finished" || isPR):
				return Result{}, InvalidArg("until", "%s is not a thread's condition; a thread takes settled, idle, attention, error or disconnected", until)
			case pr != "" && until != "" && !isPR:
				return Result{}, InvalidArg("until", "%s is not a pull request's condition; a pull request takes %s", until, strings.Join(pullRequestConditions, ", "))
			case plugin != "" && until != "" && until != "settled":
				return Result{}, InvalidArg("until", "a plugin's wake source fires when the plugin fires it; leave until out (not %s)", until)
			case (at != nil || every != nil) && until != "" && until != "settled":
				return Result{}, InvalidArg("until", "a timer fires at its time; leave until out (not %s)", until)
			case plugin == "" && len(args) > 0:
				return Result{}, InvalidArg("arg", "args are for a plugin's wake source (--plugin)")
			}
			cond := subscriptionConditions[until]
			if plugin != "" || at != nil || every != nil {
				cond = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_UNSPECIFIED
			}
			res, err := b.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{
				SubscriberThreadId: a.String("id"), TargetThreadId: thread, TargetRunId: run, TargetPullRequest: pr,
				TargetPlugin: plugin, TargetAt: at, TargetEvery: every, Args: args, Condition: cond, Repeat: a.Bool("repeat"),
				Note: a.String("note"),
			}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetSubscription()
			msg := "subscribed " + subscriptionLine(s)
			switch {
			case res.Msg.GetExisted():
				msg = "already subscribed " + subscriptionLine(s)
			case res.Msg.GetFired() && !s.GetRepeat():
				msg = "woke " + s.GetSubscriberThreadId() + " at once: " + subscriptionTarget(s) + " already met the condition (" +
					conditionName(s.GetCondition()) + "); the one-shot subscription " + s.GetId() + " is done"
			case res.Msg.GetFired():
				msg += "; woke it at once: the target already met the condition"
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}

func threadUnsubscribe(b ThreadBackend) Command {
	return Command{
		Name:  "thread.unsubscribe",
		Title: "Unsubscribe Thread from Wakes",
		Description: "Remove a wake subscription by id, or every subscription of a thread (default: the thread this runs in) " +
			"to a target.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "subscription", Type: String, Positional: true, ID: SubscriptionID, Description: "Subscription id (sub-…)" + IDHelp},
			{Name: "id", Type: String, Context: ContextThread, ID: ThreadID, Description: "With a target: the subscribed thread (default: the thread this runs in)" + IDHelp},
			{Name: "thread", Type: String, ID: ThreadID, Description: "Remove the subscriptions to this thread" + IDHelp},
			{Name: "run", Type: String, ID: RunID, Description: "Remove the subscriptions to this action run" + IDHelp},
			{Name: "pr", Type: String, Description: "Remove the subscriptions to this pull request"},
			{Name: "plugin", Type: String, Description: "Remove the subscriptions to this wake source, <plugin>/<source> (whatever their args)"},
			{Name: "timers", Type: Bool, Description: "Remove every timer (at, every) of the thread"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			req := &v1.UnsubscribeThreadRequest{SubscriptionId: strings.TrimSpace(a.String("subscription"))}
			if req.SubscriptionId == "" {
				thread, run, pr, plugin, err := subscribeTargetArgs(a, boolCount(a.Bool("timers")))
				if err != nil {
					return Result{}, InvalidArg("subscription", "give a subscription id, or a target (thread, run, pr, plugin or timers)")
				}
				if a.String("id") == "" {
					return Result{}, InvalidArg("id", "give the subscribed thread's id with a target")
				}
				req.SubscriberThreadId, req.TargetThreadId, req.TargetRunId, req.TargetPullRequest, req.TargetPlugin = a.String("id"), thread, run, pr, plugin
				req.TargetTimer = a.Bool("timers")
			} else if a.String("thread") != "" || a.String("run") != "" || a.String("pr") != "" || a.String("plugin") != "" || a.Bool("timers") {
				return Result{}, InvalidArg("subscription", "give a subscription id or a target, not both")
			}
			res, err := b.Unsubscribe(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			var lines []string
			for _, s := range res.Msg.GetRemoved() {
				lines = append(lines, "removed "+subscriptionLine(s))
			}
			return Result{Message: strings.Join(lines, "\n"), JSON: res.Msg}, nil
		},
	}
}

func threadSubscriptions(b ThreadBackend) Command {
	return Command{
		Name:  "thread.subscriptions",
		Title: "List Thread Wake Subscriptions",
		Description: "List a thread's wake subscriptions (default: the thread this runs in; all for every thread) " +
			"with their targets' status and how often they fired.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "id", Type: String, Context: ContextThread, ID: ThreadID, Description: "Subscribed thread id (default: the thread this runs in)" + IDHelp},
			{Name: "all", Type: Bool, Description: "Every thread's subscriptions"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id := a.String("id")
			if a.Bool("all") {
				id = ""
			} else if id == "" {
				return Result{}, InvalidArg("id", "give a thread id, or all")
			}
			res, err := b.ListSubscriptions(ctx, connect.NewRequest(&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: id}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: formatSubscriptions(res.Msg.GetSubscriptions(), id), JSON: res.Msg}, nil
		},
	}
}

// formatSubscriptions is thread.subscriptions' table, with a NOTE column when any has
// a note.
func formatSubscriptions(subs []*v1.ThreadSubscription, subscriber string) string {
	if len(subs) == 0 {
		if subscriber != "" {
			return "thread " + subscriber + " has no wake subscriptions"
		}
		return "no wake subscriptions"
	}
	named := func(id, name string) string {
		if name != "" {
			return id + " (" + name + ")"
		}
		return id
	}
	notes := slices.ContainsFunc(subs, func(s *v1.ThreadSubscription) bool { return s.GetNote() != "" })
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	header := "ID\tSUBSCRIBER\tTARGET\tUNTIL\tREPEAT\tFIRED\tLAST FIRED\tTARGET STATUS"
	if notes {
		header += "\tNOTE"
	}
	_, _ = fmt.Fprintln(tw, header)
	for _, s := range subs {
		repeat, last := "no", "-"
		if s.GetRepeat() {
			repeat = "yes"
		}
		if t := s.GetLastFiredAt(); t != nil {
			last = t.AsTime().UTC().Format(time.RFC3339) // UTC like every other command (E1, E5)
		}
		id := s.GetTargetId()
		if args := subscriptionArgs(s); args != "" {
			id += " " + args
		}
		target := strings.SplitN(subscriptionTarget(s), " ", 2)[0] + " " + named(id, s.GetTargetName())
		switch s.GetTarget() {
		case v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST:
			target = "pr " + cmp.Or(s.GetTargetName(), s.GetTargetId()) // the name starts with the id
		case v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER:
			target = subscriptionTarget(s) // "timer every 30m"
		}
		row := strings.Join([]string{s.GetId(), named(s.GetSubscriberThreadId(), s.GetSubscriberName()), target,
			conditionName(s.GetCondition()), repeat, strconv.FormatInt(s.GetFiredCount(), 10), last, s.GetTargetStatus()}, "\t")
		if notes {
			row += "\t" + s.GetNote()
		}
		_, _ = fmt.Fprintln(tw, row)
	}
	_ = tw.Flush()
	lines := strings.Split(strings.TrimRight(sb.String(), "\n"), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ") // a row without a note
	}
	return strings.Join(lines, "\n")
}
