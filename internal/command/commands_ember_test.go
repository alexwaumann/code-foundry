package command_test

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/ember"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// emberSettings is the settings service ember.enable and ember.disable update: it
// records the values and turns the fixture's config on or off.
type emberSettings struct {
	codefoundryv1connect.UnimplementedSettingsServiceHandler
	mu      sync.Mutex
	updates []map[string]string
	apply   func(on bool)
}

func (s *emberSettings) Update(_ context.Context, req *connect.Request[v1.UpdateSettingsRequest]) (*connect.Response[v1.UpdateSettingsResponse], error) {
	s.mu.Lock()
	s.updates = append(s.updates, req.Msg.GetValues())
	s.mu.Unlock()
	s.apply(req.Msg.GetValues()["ember.enabled"] == "true")
	return connect.NewResponse(&v1.UpdateSettingsResponse{}), nil
}

type emberFixture struct {
	reg      *command.Registry
	store    *ember.Store
	threads  *threadtest.Fake
	settings *emberSettings
}

// newEmberFixture registers ember.* against a real Ember store over the thread store's
// fake, off at start.
func newEmberFixture(t *testing.T) *emberFixture {
	t.Helper()
	b := bus.New()
	f := &emberFixture{reg: command.NewRegistry(), threads: threadtest.New(b), settings: &emberSettings{}}
	var mu sync.Mutex
	cfg := ember.Config{Model: "claude-opus-4-8[1m]", Effort: "high", WorkerModels: []string{"claude-opus-4-7[1m]"}, WorkerEffort: "high",
		EpochContextTokens: 400000, EpochMaxHours: 24}
	s, err := ember.New(context.Background(), ember.Options{
		DB: dbtest.Open(t), Bus: b, Log: slog.New(slog.DiscardHandler), Threads: f.threads, Dir: filepath.Join(t.TempDir(), "ember"),
		Config:      func() ember.Config { mu.Lock(); defer mu.Unlock(); return cfg },
		Consolidate: func(context.Context, string, string) (string, error) { return "# Memory\n", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	f.store = s
	f.settings.apply = func(on bool) {
		mu.Lock()
		cfg.Enabled = on
		mu.Unlock()
		s.ConfigChanged()
	}
	if err := command.RegisterEmber(f.reg, command.EmberDeps{Ember: s, Settings: f.settings}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *emberFixture) invoke(t *testing.T, name string, args map[string]string) command.Result {
	t.Helper()
	res, err := f.reg.Invoke(context.Background(), command.Context{}, name, args)
	if err != nil {
		t.Fatalf("%s %v: %v", name, args, err)
	}
	return res
}

func TestEmberCommands(t *testing.T) {
	f := newEmberFixture(t)
	if res := f.invoke(t, "ember.status", nil); !strings.Contains(res.Message, "Ember: off") || !strings.Contains(res.Message, "thread: none yet") {
		t.Errorf("status off = %q", res.Message)
	}

	// enable sets the setting and waits for the thread.
	res := f.invoke(t, "ember.enable", nil)
	v, ok := res.JSON.(command.EmberStatusView)
	if !ok || !v.Enabled || v.ThreadID == "" || !strings.HasPrefix(res.Message, "Ember is on: thread s-") {
		t.Fatalf("enable = %q, %+v", res.Message, res.JSON)
	}
	if len(f.settings.updates) != 1 || f.settings.updates[0]["ember.enabled"] != "true" {
		t.Errorf("settings updates = %v", f.settings.updates)
	}
	if res := f.invoke(t, "ember.status", nil); !strings.Contains(res.Message, "Ember: on") || !strings.Contains(res.Message, "epoch 1 since") ||
		!strings.Contains(res.Message, "context 0 of 400.0K tokens") {
		t.Errorf("status on = %q", res.Message)
	}

	// Tasks: add, a subtask with a worker, list, show, update, done, cancel.
	worker, err := f.threads.Create(context.Background(), thread.CreateOptions{Name: "README worker"})
	if err != nil {
		t.Fatal(err)
	}
	res = f.invoke(t, "ember.task.add", map[string]string{"title": "Ship the docs", "detail": "README and changelog"})
	parent := res.JSON.(command.EmberTaskView)
	if !strings.HasPrefix(res.Message, "added "+parent.ID+" [todo] Ship the docs") {
		t.Errorf("add = %q", res.Message)
	}
	res = f.invoke(t, "ember.task.add", map[string]string{"title": "README line", "parent": parent.ID[len(parent.ID)-4:], "thread": worker.ID, "state": "doing"})
	child := res.JSON.(command.EmberTaskView)
	if child.ParentID != parent.ID || child.ThreadID != worker.ID || child.State != "doing" || child.Thread == nil || child.Thread.Name != "README worker" {
		t.Errorf("subtask = %+v", child)
	}
	res = f.invoke(t, "ember.task.list", nil)
	if lines := strings.Split(res.Message, "\n"); len(lines) != 2 || !strings.Contains(lines[1], "↳ README line") || !strings.Contains(lines[1], "worker "+worker.ID) {
		t.Errorf("list = %q", res.Message)
	}
	if res := f.invoke(t, "ember.task.show", map[string]string{"id": parent.ID}); !strings.Contains(res.Message, "subtask: "+child.ID+" [doing] README line") ||
		!strings.Contains(res.Message, "README and changelog") {
		t.Errorf("show = %q", res.Message)
	}
	if res := f.invoke(t, "ember.task.update", map[string]string{"id": parent.ID, "title": "Ship all docs", "state": "doing"}); !strings.Contains(res.Message, "[doing] Ship all docs") {
		t.Errorf("update = %q", res.Message)
	}
	if res := f.invoke(t, "ember.task.done", map[string]string{"id": child.ID, "outcome": "pushed cf/readme"}); !strings.HasPrefix(res.Message, "done: "+child.ID+" [done] README line") ||
		res.JSON.(command.EmberTaskView).DoneAt == nil {
		t.Errorf("done = %q", res.Message)
	}
	if res := f.invoke(t, "ember.task.cancel", map[string]string{"id": parent.ID, "why": "not needed"}); !strings.Contains(res.Message, "— not needed") {
		t.Errorf("cancel = %q", res.Message)
	}
	if res := f.invoke(t, "ember.task.list", nil); res.Message != "no open tasks (--all includes done and cancelled ones)" {
		t.Errorf("open list = %q", res.Message)
	}
	if res := f.invoke(t, "ember.task.list", map[string]string{"all": "true"}); len(res.JSON.([]command.EmberTaskView)) != 2 {
		t.Errorf("all = %+v", res.JSON)
	}
	if res := f.invoke(t, "ember.board", nil); !strings.Contains(res.Message, "# Task board") || !strings.Contains(res.Message, "## Done today") {
		t.Errorf("board = %q", res.Message)
	}

	// Refusals are the caller's mistakes.
	for _, c := range []struct {
		name string
		args map[string]string
		code connect.Code
	}{
		{"ember.task.add", map[string]string{"title": "x", "parent": child.ID}, connect.CodeInvalidArgument},
		{"ember.task.update", map[string]string{"id": parent.ID}, connect.CodeInvalidArgument},
		{"ember.task.show", map[string]string{"id": "t-00000000"}, connect.CodeNotFound},
		{"ember.task.done", map[string]string{"id": "t-00000000"}, connect.CodeNotFound},
		{"ember.remember", map[string]string{"fact": strings.Repeat("x", 1001)}, connect.CodeInvalidArgument},
	} {
		_, err := f.reg.Invoke(context.Background(), command.Context{}, c.name, c.args)
		var ae *command.ArgError
		switch {
		case c.code == connect.CodeInvalidArgument && errors.As(err, &ae):
		case c.code != connect.CodeInvalidArgument && connect.CodeOf(err) == c.code:
		default:
			t.Errorf("%s %v: err = %v, want %v", c.name, c.args, err, c.code)
		}
	}

	if res := f.invoke(t, "ember.remember", map[string]string{"fact": "Alex reviews on Fridays"}); !strings.HasPrefix(res.Message, "remembered: - ") {
		t.Errorf("remember = %q", res.Message)
	}
	if res := f.invoke(t, "ember.reseed", nil); !strings.Contains(res.Message, "epoch 2") {
		t.Errorf("reseed = %q", res.Message)
	}

	// disable: off, the thread stays.
	res = f.invoke(t, "ember.disable", nil)
	if v := res.JSON.(command.EmberStatusView); v.Enabled || v.ThreadID == "" || !strings.HasPrefix(res.Message, "Ember is off") {
		t.Errorf("disable = %q, %+v", res.Message, v)
	}
	if _, err := f.reg.Invoke(context.Background(), command.Context{}, "ember.reseed", nil); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("reseed while off: err = %v", err)
	}
}

// Without an Ember store the commands still list and fail with Unimplemented.
func TestEmberCommandsWithoutStore(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterEmber(reg, command.EmberDeps{}); err != nil {
		t.Fatal(err)
	}
	if _, ok := reg.Get("ember.task.add"); !ok {
		t.Fatal("ember.task.add not registered")
	}
	_, err := reg.Invoke(context.Background(), command.Context{}, "ember.task.add", map[string]string{"title": "x"})
	if connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("err = %v", err)
	}
}
