package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

type fakeResolver struct {
	err     error
	changed []string
}

func (f *fakeResolver) ResolveWake(_ context.Context, threadID, projectID, target string, args map[string]string) (map[string]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return map[string]string{"thread": threadID, "project": projectID, "target": target, "n": fmt.Sprint(len(args))}, nil
}

func (f *fakeResolver) WakeChanged(s plugin.WakeSub, added bool) {
	f.changed = append(f.changed, fmt.Sprintf("%s %s %s %s %v %v", s.ID, s.Plugin, s.Source, s.ThreadID, s.Args, added))
}

func (f *fakeResolver) DescribeWake(target string) (string, string) { return "Hello: " + target, "running" }

// The plugin store's errors read as the thread store's (the API maps those to codes);
// subscriptions split their target into plugin and source.
func TestThreadPluginWakes(t *testing.T) {
	for _, tt := range []struct {
		err  error
		want error
	}{
		{fmt.Errorf("%w: no plugin", plugin.ErrNotFound), thread.ErrNotFound},
		{fmt.Errorf("%w: hello/tick needs pr", plugin.ErrInvalidArgument), thread.ErrInvalidArgument},
		{fmt.Errorf("%w: disabled", plugin.ErrFailedPrecondition), thread.ErrFailedPrecondition},
	} {
		w := threadPluginWakes{plugins: &fakeResolver{err: tt.err}}
		_, err := w.Resolve(context.Background(), thread.Thread{ID: "s-1"}, "hello/tick", nil)
		if !errors.Is(err, tt.want) || err.Error() != tt.err.Error() {
			t.Errorf("Resolve error %v: got %v, want it to match %v", tt.err, err, tt.want)
		}
	}
	f := &fakeResolver{}
	w := threadPluginWakes{plugins: f}
	got, err := w.Resolve(context.Background(), thread.Thread{ID: "s-1", ProjectID: "p-1"}, "hello/tick", map[string]string{"every": "2s"})
	if err != nil || got["thread"] != "s-1" || got["project"] != "p-1" || got["n"] != "1" {
		t.Errorf("Resolve = %v, %v", got, err)
	}
	w.Changed(thread.Subscription{ID: "sub-1", SubscriberID: "s-1", TargetKind: thread.TargetPlugin, TargetID: "hello/tick",
		Args: map[string]string{"every": "2s"}}, true)
	if len(f.changed) != 1 || f.changed[0] != "sub-1 hello tick s-1 map[every:2s] true" {
		t.Errorf("Changed = %q", f.changed)
	}
	if name, status := w.Describe("hello/tick"); name != "Hello: hello/tick" || status != "running" {
		t.Errorf("Describe = %q %q", name, status)
	}
}

type fakeThreadWakes struct{ calls []string }

func (f *fakeThreadWakes) FirePlugin(p, display, source string, match map[string]string, title string, payload json.RawMessage) int {
	f.calls = append(f.calls, fmt.Sprintf("fire %s %s %s %v %s %s", p, display, source, match, title, payload))
	return 2
}

func (f *fakeThreadWakes) PluginWakesGone(p, display string, sources []string, reason string) int {
	f.calls = append(f.calls, fmt.Sprintf("gone %s %s %v %s", p, display, sources, reason))
	return 1
}

func (f *fakeThreadWakes) PluginSubscriptions(p string) []thread.Subscription {
	return []thread.Subscription{{ID: "sub-1", SubscriberID: "s-1", TargetKind: thread.TargetPlugin, TargetID: p + "/tick", Repeat: true}}
}

func TestPluginWakeSink(t *testing.T) {
	f := &fakeThreadWakes{}
	s := pluginWakeSink{threads: f}
	if n := s.Fire("hello", "Hello", "tick", map[string]string{"every": "2s"}, "tick", json.RawMessage(`{}`)); n != 2 {
		t.Errorf("Fire = %d", n)
	}
	if n := s.Gone("hello", "Hello", nil, "disabled"); n != 1 {
		t.Errorf("Gone = %d", n)
	}
	want := []string{"fire hello Hello tick map[every:2s] tick {}", "gone hello Hello [] disabled"}
	if fmt.Sprint(f.calls) != fmt.Sprint(want) {
		t.Errorf("calls = %q", f.calls)
	}
	subs := s.Subscriptions("hello")
	if len(subs) != 1 || fmt.Sprintf("%+v", subs[0]) != fmt.Sprintf("%+v", plugin.WakeSub{ID: "sub-1", Plugin: "hello", Source: "tick", ThreadID: "s-1", Repeat: true}) {
		t.Errorf("Subscriptions = %+v", subs)
	}
}
