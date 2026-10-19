package plugin_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The "wakes" helper plugin: it keeps what wake/subscribed and wake/unsubscribed told
// it ("armed" lists it, with how often each subscription was sent and whether the last
// was a re-arm), the counts wake/armed brought ("signals"), and fires a source on "fire"
// (source, match "k=v,…", title).
var _ = func() bool {
	extraHelpers["wakes"] = func() int {
		if err := pluginsdk.Serve(wakesPlugin()); err != nil {
			fmt.Fprintln(os.Stderr, "serve:", err)
			return 1
		}
		return 0
	}
	return true
}()

func wakesPlugin() pluginsdk.Plugin {
	var mu sync.Mutex
	armed := map[string]pluginsdk.WakeSubscription{}
	sent := map[string]int{}
	var signals []string
	return pluginsdk.Plugin{
		OnWakeSubscribed: func(_ context.Context, _ *pluginsdk.Host, s pluginsdk.WakeSubscription) {
			mu.Lock()
			defer mu.Unlock()
			armed[s.Subscription] = s
			sent[s.Subscription]++
		},
		OnWakeUnsubscribed: func(_ context.Context, _ *pluginsdk.Host, u pluginsdk.WakeUnsubscribed) {
			mu.Lock()
			defer mu.Unlock()
			delete(armed, u.Subscription)
		},
		OnWakeArmed: func(_ context.Context, _ *pluginsdk.Host, count int) {
			mu.Lock()
			defer mu.Unlock()
			signals = append(signals, fmt.Sprint(count))
		},
		Commands: map[string]pluginsdk.CommandFunc{
			"signals": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				mu.Lock()
				defer mu.Unlock()
				return msg(strings.Join(signals, ","))
			},
			"armed": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				mu.Lock()
				defer mu.Unlock()
				var out []string
				for id, s := range armed {
					line := fmt.Sprintf("%s %s %s %s/%s x%d", id, s.Source, pluginsdk.FormatWakeArgs(s.Args), s.Context.ThreadID, s.Context.ProjectID, sent[id])
					if s.Rearm {
						line += " rearm"
					}
					out = append(out, line)
				}
				sort.Strings(out)
				return msg(strings.Join(out, "; "))
			},
			"fire": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				match := map[string]string{}
				for kv := range strings.SplitSeq(req.Arg("match"), ",") {
					if k, v, ok := strings.Cut(kv, "="); ok {
						match[k] = v
					}
				}
				n, err := h.FireWake(ctx, req.Arg("source"), match, req.Arg("title"), map[string]string{"why": "test"})
				if err != nil {
					return msg(fmt.Sprintf("code %d: %v", pluginsdk.ErrorCode(err), err))
				}
				return msg(fmt.Sprintf("delivered %d", n))
			},
		},
	}
}

func wakesManifest(name string) pluginsdk.Manifest {
	return pluginsdk.Manifest{
		Name: name, DisplayName: "Wakes " + name, Version: "0.1.0", Protocol: 1, Exec: []string{"bin/plugin"},
		Commands: []pluginsdk.CommandSpec{
			{Name: "armed", Title: "Armed"},
			{Name: "signals", Title: "Signals"},
			{Name: "fire", Title: "Fire", Args: []pluginsdk.ArgSpec{{Name: "source"}, {Name: "match"}, {Name: "title"}}},
		},
		Wakes: []pluginsdk.WakeSpec{
			{Name: "tick", Title: "Tick", Args: []pluginsdk.WakeArgSpec{{Name: "every", Type: pluginsdk.ArgDuration, Default: "10s"}}},
			{Name: "checks", Title: "Checks done", Scope: pluginsdk.WakeScopePR, Args: []pluginsdk.WakeArgSpec{
				{Name: "pr", Context: pluginsdk.WakeContextPR, Required: true},
				{Name: "conclusion", Type: pluginsdk.ArgEnum, Enum: []string{"success", "failure"}},
			}},
			{Name: "mine", Title: "Mine", Args: []pluginsdk.WakeArgSpec{
				{Name: "thread", Context: pluginsdk.WakeContextThread},
				{Name: "project", Context: pluginsdk.WakeContextProject},
			}},
		},
	}
}

// fakeSink is the thread store's side (plugin.WakeSink): subscriptions in memory, fires
// counted against them, Gone recorded.
type fakeSink struct {
	mu    sync.Mutex
	subs  []plugin.WakeSub
	fires []string
	gone  []string
}

func (f *fakeSink) Fire(p, display, source string, match map[string]string, title string, payload json.RawMessage) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, s := range f.subs {
		if s.Plugin == p && s.Source == source && pluginsdk.MatchWake(s.Args, match) {
			n++
		}
	}
	f.fires = append(f.fires, fmt.Sprintf("%s|%s|%s|%s|%s|%s", p, display, source, pluginsdk.FormatWakeArgs(match), title, payload))
	return n
}

func (f *fakeSink) Gone(p, display string, sources []string, reason string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	f.subs = slices.DeleteFunc(f.subs, func(s plugin.WakeSub) bool {
		hit := s.Plugin == p && (sources == nil || slices.Contains(sources, s.Source))
		if hit {
			n++
		}
		return hit
	})
	if n > 0 {
		f.gone = append(f.gone, fmt.Sprintf("%s|%s|%v|%s", p, display, sources, reason))
	}
	return n
}

func (f *fakeSink) Subscriptions(p string) []plugin.WakeSub {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []plugin.WakeSub
	for _, s := range f.subs {
		if p == "" || s.Plugin == p {
			s.Args = maps.Clone(s.Args)
			out = append(out, s)
		}
	}
	return out
}

func (f *fakeSink) add(s plugin.WakeSub) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subs = append(f.subs, s)
}

func (f *fakeSink) remove(id string) plugin.WakeSub {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := slices.IndexFunc(f.subs, func(s plugin.WakeSub) bool { return s.ID == id })
	s := f.subs[i]
	f.subs = slices.Delete(f.subs, i, i+1)
	return s
}

func (f *fakeSink) seen() (fires, gone []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.fires), slices.Clone(f.gone)
}

// wakeFacts knows a thread with a pull request (s-pr), one in a GitHub project without
// one (s-gh) and one in a project not on GitHub (s-local).
type wakeFacts struct{}

func (wakeFacts) Thread(id string) (plugin.ThreadFacts, bool) {
	switch id {
	case "s-pr":
		return plugin.ThreadFacts{ID: id, ProjectID: "p-gh", WorktreePath: "/w/pr",
			PullRequests: []plugin.PullRequestRef{{Slug: "Alex/CF", Number: 12}, {Slug: "alex/cf", Number: 3}}}, true
	case "s-gh":
		return plugin.ThreadFacts{ID: id, ProjectID: "p-gh"}, true
	case "s-local":
		return plugin.ThreadFacts{ID: id, ProjectID: "p-local"}, true
	}
	return plugin.ThreadFacts{}, false
}

func (wakeFacts) Project(id string) (plugin.ProjectFacts, bool) {
	switch id {
	case "p-gh":
		return plugin.ProjectFacts{ID: id, Slug: "Owner/Repo", Git: true}, true
	case "p-local":
		return plugin.ProjectFacts{ID: id, Git: true}, true
	}
	return plugin.ProjectFacts{}, false
}

func (wakeFacts) PullRequestChecks(context.Context, string, int) ([]plugin.CheckRun, error) {
	return nil, nil
}

func newWakesEnv(t *testing.T, sink *fakeSink) *env {
	t.Helper()
	e := newEnv(t, func(o *plugin.Options) { o.Wakes, o.Facts = sink, wakeFacts{} })
	e.install(e.opts.Dir, "waker", "wakes", wakesManifest("waker"))
	e.install(e.opts.Dir, "sleeper", "wakes", wakesManifest("sleeper"))
	m := e.start()
	if _, err := m.Enable(context.Background(), "waker", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("waker", plugin.StateRunning)
	// Armed (wake/armed with no subscription), so what a test adds next is a new one.
	e.eventually("the arm", func() bool {
		r, err := e.invoke("plugin.waker.signals", nil, command.Context{})
		return err == nil && r.Message == "0"
	})
	return e
}

func TestResolveWake(t *testing.T) {
	e := newWakesEnv(t, &fakeSink{})
	tests := []struct {
		name            string
		thread, project string
		target          string
		args            map[string]string
		want            map[string]string
		err             error
		msg             string
	}{
		{name: "defaults", thread: "s-gh", target: "waker/tick", want: map[string]string{"every": "10s"}},
		{name: "given", thread: "s-gh", target: "waker/tick", args: map[string]string{"every": " 2s "}, want: map[string]string{"every": "2s"}},
		{name: "bad value", thread: "s-gh", target: "waker/tick", args: map[string]string{"every": "soon"}, err: plugin.ErrInvalidArgument, msg: "every: want a duration"},
		{name: "unknown arg", thread: "s-gh", target: "waker/tick", args: map[string]string{"often": "1s"}, err: plugin.ErrInvalidArgument, msg: `waker/tick has no arg "often"`},
		{name: "pr from the thread", thread: "s-pr", target: "waker/checks", want: map[string]string{"pr": "alex/cf#12"}},
		{name: "pr given", thread: "s-pr", target: "waker/checks", args: map[string]string{"pr": "Alex/CF#4", "conclusion": "failure"},
			want: map[string]string{"pr": "alex/cf#4", "conclusion": "failure"}},
		{name: "pr number in the thread's repository", thread: "s-pr", target: "waker/checks", args: map[string]string{"pr": "#9"}, want: map[string]string{"pr": "alex/cf#9"}},
		{name: "pr number in the project's repository", thread: "s-gh", target: "waker/checks", args: map[string]string{"pr": "7"}, want: map[string]string{"pr": "owner/repo#7"}},
		{name: "pr url", thread: "s-local", target: "waker/checks", args: map[string]string{"pr": "https://github.com/O/R/pull/5"}, want: map[string]string{"pr": "o/r#5"}},
		{name: "pr number without a repository", thread: "s-local", target: "waker/checks", args: map[string]string{"pr": "7"}, err: plugin.ErrInvalidArgument, msg: "not on GitHub"},
		{name: "pr not a pull request", thread: "s-gh", target: "waker/checks", args: map[string]string{"pr": "main"}, err: plugin.ErrInvalidArgument, msg: "is not a pull request"},
		{name: "pr required, none in context", thread: "s-gh", target: "waker/checks", err: plugin.ErrInvalidArgument, msg: "waker/checks needs pr (the thread has no pull request"},
		{name: "thread and project from the context", thread: "s-gh", target: "waker/mine", want: map[string]string{"thread": "s-gh", "project": "p-gh"}},
		{name: "the caller's project", thread: "s-unknown", project: "p-x", target: "waker/mine", want: map[string]string{"thread": "s-unknown", "project": "p-x"}},
		{name: "given over the context", thread: "s-gh", target: "waker/mine", args: map[string]string{"thread": "s-other"}, want: map[string]string{"thread": "s-other", "project": "p-gh"}},
		{name: "no such plugin", thread: "s-gh", target: "nope/tick", err: plugin.ErrNotFound, msg: "code-foundry plugin list"},
		{name: "disabled plugin", thread: "s-gh", target: "sleeper/tick", err: plugin.ErrFailedPrecondition, msg: "is disabled"},
		{name: "no such source", thread: "s-gh", target: "waker/tock", err: plugin.ErrNotFound, msg: "it has tick, checks, mine"},
		{name: "not a target", thread: "s-gh", target: "waker", err: plugin.ErrInvalidArgument, msg: "<plugin>/<source>"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := e.m.ResolveWake(context.Background(), tt.thread, tt.project, tt.target, tt.args)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || !strings.Contains(err.Error(), tt.msg) {
					t.Fatalf("err = %v, want %v with %q", err, tt.err, tt.msg)
				}
				return
			}
			if err != nil || !maps.Equal(got, tt.want) {
				t.Fatalf("ResolveWake = %v, %v; want %v", got, err, tt.want)
			}
		})
	}
	if name, status := e.m.DescribeWake("waker/checks"); name != "Wakes waker: Checks done" || status != "running" {
		t.Errorf("DescribeWake = %q %q", name, status)
	}
	if _, status := e.m.DescribeWake("waker/tock"); status != "source gone" {
		t.Errorf("DescribeWake of a source the plugin dropped = %q", status)
	}
	if line := plugin.WakeSubscribeLine("waker", wakesManifest("waker").Wakes[1]); line != "code-foundry thread subscribe --plugin waker/checks" {
		t.Errorf("subscribe line = %q", line)
	}
	if line := plugin.WakeSubscribeLine("x", pluginsdk.WakeSpec{Name: "y", Args: []pluginsdk.WakeArgSpec{{Name: "job", Required: true}}}); line != "code-foundry thread subscribe --plugin x/y --arg job=<job>" {
		t.Errorf("subscribe line = %q", line)
	}
}

// A starting plugin gets every live subscription (again after each restart); later ones
// arrive as they come and go; its fires reach the sink checked and named.
func TestWakeArmAndFire(t *testing.T) {
	sink := &fakeSink{}
	e := newWakesEnv(t, sink)
	sub1 := plugin.WakeSub{ID: "sub-1", Plugin: "waker", Source: "tick", ThreadID: "s-pr", Args: map[string]string{"every": "2s"}, Repeat: true}
	sink.add(sub1)
	sink.add(plugin.WakeSub{ID: "sub-other", Plugin: "sleeper", Source: "tick", ThreadID: "s-pr"})
	e.m.WakeChanged(sub1, true)
	armed := func() string {
		t.Helper()
		r, err := e.invoke("plugin.waker.armed", nil, command.Context{})
		if err != nil {
			t.Fatal(err)
		}
		return r.Message
	}
	e.eventually("the subscription", func() bool { return armed() == "sub-1 tick every=2s s-pr/p-gh x1" })

	sub2 := plugin.WakeSub{ID: "sub-2", Plugin: "waker", Source: "checks", ThreadID: "s-gh", Args: map[string]string{"pr": "owner/repo#7"}}
	sink.add(sub2)
	e.m.WakeChanged(sub2, true)
	e.eventually("the new subscription", func() bool {
		return armed() == "sub-1 tick every=2s s-pr/p-gh x1; sub-2 checks pr=owner/repo#7 s-gh/p-gh x1"
	})
	e.m.WakeChanged(sink.remove("sub-2"), false)
	e.eventually("the subscription gone", func() bool { return armed() == "sub-1 tick every=2s s-pr/p-gh x1" })

	fire := func(source, match, title string) string {
		t.Helper()
		r, err := e.invoke("plugin.waker.fire", map[string]string{"source": source, "match": match, "title": title}, command.Context{})
		if err != nil {
			t.Fatal(err)
		}
		return r.Message
	}
	for _, tt := range []struct{ source, match, title, want string }{
		{"tick", "every=2s", "tick 1", "delivered 1"},
		{"tick", "every=5s", "tick 2", "delivered 0"},
		{"tick", "", "  padded  ", "delivered 0"},
		{"tock", "", "x", "code -32004"},
		{"tick", "often=1s", "x", "code -32602"},
		{"tick", "", "two\nlines", "code -32602"},
		{"tick", "", "", "code -32602"},
		{"tick", "", strings.Repeat("é", pluginsdk.MaxWakeTitle+1), "code -32602"},
	} {
		if got := fire(tt.source, tt.match, tt.title); !strings.HasPrefix(got, tt.want) {
			t.Errorf("fire %s %q %q = %q, want %q", tt.source, tt.match, tt.title, got, tt.want)
		}
	}
	fires, _ := sink.seen()
	want := []string{
		`waker|Wakes waker|tick|every=2s|tick 1|{"why":"test"}`,
		`waker|Wakes waker|tick|every=5s|tick 2|{"why":"test"}`,
		`waker|Wakes waker|tick||padded|{"why":"test"}`,
	}
	if !slices.Equal(fires, want) {
		t.Errorf("fires\n%q\nwant\n%q", fires, want)
	}
	if !strings.Contains(e.logText("waker"), "wake tick fired (every=2s): woke 1") {
		t.Errorf("log:\n%s", e.logText("waker"))
	}

	// A restart re-arms: the live subscription with rearm, then wake/armed with 1.
	if _, err := e.m.Restart(context.Background(), "waker"); err != nil {
		t.Fatal(err)
	}
	e.waitState("waker", plugin.StateRunning)
	e.eventually("the re-arm after a restart", func() bool { return armed() == "sub-1 tick every=2s s-pr/p-gh x1 rearm" })
	if !strings.Contains(e.logText("waker"), "re-armed 1 wake subscriptions") {
		t.Errorf("log:\n%s", e.logText("waker"))
	}
	e.eventually("wake/armed with 1 after the restart", func() bool {
		r, err := e.invoke("plugin.waker.signals", nil, command.Context{})
		return err == nil && r.Message == "1"
	})
	// A subscription made after the arm is not a re-arm.
	sub3 := plugin.WakeSub{ID: "sub-3", Plugin: "waker", Source: "tick", ThreadID: "s-gh", Args: map[string]string{"every": "1h"}}
	sink.add(sub3)
	e.m.WakeChanged(sub3, true)
	e.eventually("a new subscription after the re-arm", func() bool {
		return armed() == "sub-1 tick every=2s s-pr/p-gh x1 rearm; sub-3 tick every=1h s-gh/p-gh x1"
	})
}

// A plugin that goes ends its subscriptions with a reason; an update that drops a source
// ends that source's; at startup, a plugin that is not installed or not enabled loses
// its subscriptions.
func TestWakesGone(t *testing.T) {
	sink := &fakeSink{subs: []plugin.WakeSub{
		{ID: "sub-ghost", Plugin: "ghost", Source: "tick", ThreadID: "s-1"},
		{ID: "sub-sleep", Plugin: "sleeper", Source: "tick", ThreadID: "s-1"},
	}}
	e := newWakesEnv(t, sink)
	ctx := context.Background()
	sink.add(plugin.WakeSub{ID: "sub-tick", Plugin: "waker", Source: "tick", ThreadID: "s-1"})
	sink.add(plugin.WakeSub{ID: "sub-checks", Plugin: "waker", Source: "checks", ThreadID: "s-1"})
	_, gone := sink.seen()
	want := []string{"ghost|ghost|[]|the plugin is not installed", "sleeper|Wakes sleeper|[]|the plugin is disabled"}
	if !slices.Equal(gone, want) {
		t.Fatalf("at startup: %q, want %q", gone, want)
	}

	// An update drops checks.
	mf := wakesManifest("waker")
	mf.Version, mf.Wakes = "0.2.0", mf.Wakes[:1]
	e.install(e.opts.Dir, "waker", "wakes", mf)
	if err := e.m.Reload(ctx); err != nil {
		t.Fatal(err)
	}
	_, gone = sink.seen()
	if want = append(want, "waker|Wakes waker|[checks]|no longer in the plugin's manifest"); !slices.Equal(gone, want) {
		t.Fatalf("after the update: %q, want %q", gone, want)
	}
	if _, err := e.m.Disable(ctx, "waker"); err != nil {
		t.Fatal(err)
	}
	_, gone = sink.seen()
	if want = append(want, "waker|Wakes waker|[]|the plugin was disabled"); !slices.Equal(gone, want) {
		t.Fatalf("after disable: %q, want %q", gone, want)
	}

	// Uninstall, and a package removed by hand.
	sink.add(plugin.WakeSub{ID: "sub-2", Plugin: "waker", Source: "tick", ThreadID: "s-1"})
	sink.add(plugin.WakeSub{ID: "sub-3", Plugin: "sleeper", Source: "tick", ThreadID: "s-1"})
	if _, err := e.m.Uninstall(ctx, "waker", false); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(e.opts.Dir, "sleeper")); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Reload(ctx); err != nil {
		t.Fatal(err)
	}
	_, gone = sink.seen()
	want = append(want, "waker|Wakes waker|[]|the plugin was uninstalled", "sleeper|Wakes sleeper|[]|the plugin was removed")
	if !slices.Equal(gone, want) {
		t.Fatalf("after uninstall and removal: %q, want %q", gone, want)
	}
}
