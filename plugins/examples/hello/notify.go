package main

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Notifications (permission notifications): the notify command posts one about a failed
// build on a thread, whose primary button runs hello's own open-run command; open-run
// picks that run in the demo's Runs tab and asks the host to show the demo beside the
// thread (plugin.hello.show.demo through host/invoke, which plugin.json's
// permissions.commands allows). The tick wake source attaches a notification to each fire
// (wakes.go): the host raises it only when no subscribed thread got the wake, or always
// when it is time-sensitive. The host raises the arrival toast; hello never toasts for a
// notification.

// buildKey is the notify command's notification key: posting again with the same content
// changes nothing, and --withdraw takes it back.
const buildKey = "build-5"

// failedRun is the demo's failed run the notification points at (layoutRuns).
var failedRun = runKey(5)

// runPicks is the run a notification's button asked the demo to show, per thread: an
// open demo instance of the thread switches to it at once, and one opened later starts
// on it.
type runPicks struct {
	mu      sync.Mutex
	pending map[string]string // thread → run key, for the next instance
	open    map[*demo]bool
}

func newRunPicks() *runPicks {
	return &runPicks{pending: map[string]string{}, open: map[*demo]bool{}}
}

// opened registers d and starts it on its thread's pending pick, if any.
func (p *runPicks) opened(d *demo) {
	p.mu.Lock()
	p.open[d] = true
	run, ok := p.pending[d.open.Context.ThreadID]
	delete(p.pending, d.open.Context.ThreadID)
	p.mu.Unlock()
	if ok {
		d.mu.Lock()
		d.tab, d.runs.selected = "run-list", run
		d.mu.Unlock()
	}
}

// closed forgets d.
func (p *runPicks) closed(d *demo) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.open, d)
}

// pick shows run in thread's open demo instances, or in the next one when none is open,
// and says how many open ones took it.
func (p *runPicks) pick(thread, run string) int {
	p.mu.Lock()
	var hit []*demo
	for d := range p.open {
		if d.open.Context.ThreadID == thread {
			hit = append(hit, d)
		}
	}
	if len(hit) == 0 {
		p.pending[thread] = run
	}
	p.mu.Unlock()
	for _, d := range hit {
		d.mu.Lock()
		d.tab, d.runs.selected = "run-list", run
		d.mu.Unlock()
		_ = d.render()
	}
	return len(hit)
}

// threadArg is a command's thread arg, else the thread it was run in.
func threadArg(req pluginsdk.CommandRequest) string {
	if t := req.Arg("thread"); t != "" {
		return t
	}
	return req.Context.ThreadID
}

// notify posts (or with --withdraw withdraws) the failed-build notification on a thread.
func notify(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	if !h.HasCapability(pluginsdk.NotificationsCapability) {
		return pluginsdk.CommandResult{}, errors.New("this Code Foundry has no notifications; update it")
	}
	if req.Arg("withdraw") == "true" {
		gone, err := h.WithdrawNotification(ctx, buildKey)
		if err != nil {
			return pluginsdk.CommandResult{}, fmt.Errorf("withdraw: %w", err)
		}
		if !gone {
			return pluginsdk.CommandResult{Message: "no notification to withdraw"}, nil
		}
		return pluginsdk.CommandResult{Message: "withdrew " + buildKey}, nil
	}
	thread := threadArg(req)
	if thread == "" {
		return pluginsdk.CommandResult{}, errors.New("no thread: run it from a thread, or pass --thread <id>")
	}
	r, err := h.Notify(ctx, buildNotification(thread, req.Arg("level"), req.Arg("time-sensitive") == "true"))
	if err != nil {
		return pluginsdk.CommandResult{}, fmt.Errorf("notify: %w", err)
	}
	return pluginsdk.CommandResult{Message: fmt.Sprintf("notification %s %s (%s)", r.Key, r.Outcome, r.Status)}, nil
}

// buildNotification is the failed-build notification: Open run (hello's own command, the
// primary) and the docs.
func buildNotification(thread, level string, timeSensitive bool) pluginsdk.Notification {
	if level == "" {
		level = pluginsdk.NotifyError
	}
	return pluginsdk.Notification{
		Key: buildKey, Level: level, TimeSensitive: timeSensitive, ThreadID: thread,
		Title: "Build #5 failed on cf/fix",
		Body:  "The demo's Runs tab has its log.",
		Actions: []pluginsdk.NotificationAction{
			pluginsdk.CommandAction("Open run", "open-run", map[string]string{"run": failedRun, "thread": thread}),
			pluginsdk.OpenAction("Docs", "https://github.com/alexwaumann/code-foundry"),
		},
	}
}

// openRun is the open-run command: pick the run in the thread's demo and show the demo
// beside the thread, taking the user there (they pressed the button).
func (p *runPicks) openRun(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
	thread := threadArg(req)
	run, ok := runOf(req.Arg("run"))
	switch {
	case thread == "":
		return pluginsdk.CommandResult{}, errors.New("no thread: run it from a thread, or pass --thread <id>")
	case !ok:
		return pluginsdk.CommandResult{}, fmt.Errorf("no run %q", req.Arg("run"))
	}
	n := p.pick(thread, runKey(run.n))
	res, err := h.Invoke(ctx, "plugin.hello.show.demo", map[string]string{"focus": "true"}, pluginsdk.UiContext{ThreadID: thread})
	if err != nil {
		return pluginsdk.CommandResult{}, fmt.Errorf("show the demo: %w", err)
	}
	where := "the demo opens on it"
	if n > 0 {
		where = "the open demo switched to it"
	}
	msg := fmt.Sprintf("Build #%d on %s: %s", run.n, thread, where)
	if res.Message != "" {
		msg += " (" + res.Message + ")"
	}
	return pluginsdk.CommandResult{Message: msg}, nil
}
