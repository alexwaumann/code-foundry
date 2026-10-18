package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A plugin's feed gets the same events as Watch, as protojson: each source's snapshot
// first, then live events, with the source they came from.
func TestPluginFeed(t *testing.T) {
	f := newEventsFixture(t)
	f.th.Put(thread.Thread{ID: "s-1", Name: "first", State: thread.StateDisconnected})
	feed := NewPluginFeed(f.events, nil)
	if err := feed.Feed(context.Background(), []string{"threads", "ui"}, func(plugin.FeedEvent) {}); err == nil ||
		!strings.Contains(err.Error(), `unknown event source "ui"`) {
		t.Fatalf("ui source: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan plugin.FeedEvent, 16)
	if err := feed.Feed(ctx, []string{"threads"}, func(fe plugin.FeedEvent) { got <- fe }); err != nil {
		t.Fatal(err)
	}
	next := func() plugin.FeedEvent {
		t.Helper()
		select {
		case fe := <-got:
			return fe
		case <-time.After(5 * time.Second):
			t.Fatal("no event")
		}
		return plugin.FeedEvent{}
	}
	snap := next()
	var ev struct {
		ThreadList struct {
			Snapshot struct {
				Threads []struct{ ID, Name string }
			}
			Updated struct{ ID, Name string }
		}
		Epoch string
	}
	if err := json.Unmarshal(snap.Event, &ev); err != nil {
		t.Fatal(err)
	}
	if !snap.Snapshot || snap.Source != "threads" || len(ev.ThreadList.Snapshot.Threads) != 1 || ev.ThreadList.Snapshot.Threads[0].Name != "first" || ev.Epoch == "" {
		t.Fatalf("snapshot = %+v %s", snap, snap.Event)
	}
	f.th.Put(thread.Thread{ID: "s-2", Name: "second"})
	live := next()
	if err := json.Unmarshal(live.Event, &ev); err != nil {
		t.Fatal(err)
	}
	if live.Snapshot || live.Source != "threads" || ev.ThreadList.Updated.Name != "second" || !strings.Contains(string(live.Event), `"seq"`) {
		t.Fatalf("live = %+v %s", live, live.Event)
	}
	if s := feed.Snapshot(context.Background(), "threads"); len(s) != 1 || !s[0].Snapshot || !strings.Contains(string(s[0].Event), "second") {
		t.Errorf("Snapshot = %+v", s)
	}
}

func TestThreadFlagsAPI(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	at := time.UnixMilli(1_700_000_000_000)
	fake.Put(thread.Thread{ID: "s-1", Flags: []thread.Flag{
		{Source: "gh-actions", SourceName: "GitHub Actions", Level: thread.FlagError, Reason: "deploy failed", SetAt: at, UntilSeen: true},
		{Source: "hello", SourceName: "Hello", Level: thread.FlagAttention, Reason: "look", SetAt: at},
	}})
	g, err := c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "s-1"}))
	if err != nil {
		t.Fatal(err)
	}
	fl := g.Msg.GetThread().GetFlags()
	if len(fl) != 2 || fl[0].GetPlugin() != "gh-actions" || fl[0].GetPluginDisplayName() != "GitHub Actions" ||
		fl[0].GetLevel() != v1.ThreadFlagLevel_THREAD_FLAG_LEVEL_ERROR || fl[0].GetReason() != "deploy failed" ||
		!fl[0].GetSetAt().AsTime().Equal(at) || !fl[0].GetUntilSeen() || fl[1].GetLevel() != v1.ThreadFlagLevel_THREAD_FLAG_LEVEL_ATTENTION {
		t.Fatalf("flags = %v", fl)
	}
	res, err := c.ClearFlags(ctx, connect.NewRequest(&v1.ClearThreadFlagsRequest{Id: "s-1", Plugin: "hello"}))
	if err != nil || res.Msg.GetCleared() != 1 || len(res.Msg.GetThread().GetFlags()) != 1 {
		t.Fatalf("ClearFlags(hello) = %v, %v", res, err)
	}
	if _, err := c.ClearFlags(ctx, connect.NewRequest(&v1.ClearThreadFlagsRequest{Id: "s-1", Plugin: "hello"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("nothing to clear: %v", err)
	}
	if res, err := c.ClearFlags(ctx, connect.NewRequest(&v1.ClearThreadFlagsRequest{Id: "s-1"})); err != nil || res.Msg.GetCleared() != 1 {
		t.Errorf("ClearFlags(all) = %v, %v", res, err)
	}
	if _, err := c.ClearFlags(ctx, connect.NewRequest(&v1.ClearThreadFlagsRequest{Id: "s-nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown thread: %v", err)
	}
}

func TestPluginEnvironmentAPI(t *testing.T) {
	fake, c := newPluginServer(t)
	ctx := context.Background()
	fake.Put(helloPlugin())
	at := time.UnixMilli(1_700_000_000_000)
	fake.PutEnvironment(plugin.Environment{Plugin: "hello", Env: map[string]string{"B": "2", "A": "1"}, PathPrepend: []string{"/h/bin"},
		AddDirs: []string{"/h/data"}, Projects: []string{"p1"}, NoProject: true, Issues: []string{"env PATH is reserved"}, UpdatedAt: at})
	res, err := c.Environment(ctx, connect.NewRequest(&v1.PluginEnvironmentRequest{Name: "hello"}))
	if err != nil {
		t.Fatal(err)
	}
	e := res.Msg.GetEnvironments()
	if len(e) != 1 || len(e[0].GetEnv()) != 2 || e[0].GetEnv()[0].GetKey() != "A" || e[0].GetEnv()[1].GetValue() != "2" ||
		e[0].GetPathPrepend()[0] != "/h/bin" || e[0].GetAddDirs()[0] != "/h/data" || e[0].GetProjects()[0] != "p1" || !e[0].GetNoProject() ||
		e[0].GetIssues()[0] != "env PATH is reserved" || !e[0].GetUpdatedAt().AsTime().Equal(at) {
		t.Fatalf("Environment = %v", e)
	}
	if _, err := c.Environment(ctx, connect.NewRequest(&v1.PluginEnvironmentRequest{Name: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown plugin: %v", err)
	}
	if all, err := c.Environment(ctx, connect.NewRequest(&v1.PluginEnvironmentRequest{})); err != nil || len(all.Msg.GetEnvironments()) != 1 {
		t.Errorf("all = %v, %v", all, err)
	}
}
