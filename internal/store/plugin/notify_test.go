package plugin_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The "notes" helper plugin: "post" posts the notification its note arg holds (JSON), "withdraw"
// withdraws key, "fire" fires source with the note arg's notification attached. Each
// answers its result as JSON, or "code N: err".
var _ = func() bool {
	extraHelpers["notes"] = func() int {
		if err := pluginsdk.Serve(notesPlugin()); err != nil {
			fmt.Fprintln(os.Stderr, "serve:", err)
			return 1
		}
		return 0
	}
	return true
}()

func notesPlugin() pluginsdk.Plugin {
	answer := func(v any, err error) (pluginsdk.CommandResult, error) {
		if err != nil {
			return msg(fmt.Sprintf("code %d: %v", pluginsdk.ErrorCode(err), err))
		}
		js, _ := json.Marshal(v)
		return msg(string(js))
	}
	note := func(req pluginsdk.CommandRequest) pluginsdk.Notification {
		var n pluginsdk.Notification
		_ = json.Unmarshal([]byte(req.Arg("note")), &n)
		return n
	}
	return pluginsdk.Plugin{Commands: map[string]pluginsdk.CommandFunc{
		"post": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			return answer(h.Notify(ctx, note(req)))
		},
		"withdraw": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			gone, err := h.WithdrawNotification(ctx, req.Arg("key"))
			return answer(gone, err)
		},
		"fire": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			return answer(h.FireWakeNotify(ctx, req.Arg("source"), nil, "done", nil, note(req)))
		},
		"open": func(_ context.Context, _ *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			return msg("opened " + req.Arg("item"))
		},
	}}
}

func notesManifest(name string, granted bool) pluginsdk.Manifest {
	return pluginsdk.Manifest{
		Name: name, DisplayName: "Notes " + name, Version: "0.1.0", Protocol: 1, Exec: []string{"bin/plugin"},
		Permissions: pluginsdk.Permissions{Notifications: granted},
		Commands: []pluginsdk.CommandSpec{
			{Name: "post", Title: "Post", Args: []pluginsdk.ArgSpec{{Name: "note"}}},
			{Name: "withdraw", Title: "Withdraw", Args: []pluginsdk.ArgSpec{{Name: "key"}}},
			{Name: "fire", Title: "Fire", Args: []pluginsdk.ArgSpec{{Name: "source"}, {Name: "note"}}},
			{Name: "open", Title: "Open", Args: []pluginsdk.ArgSpec{{Name: "item"}}},
		},
		Wakes: []pluginsdk.WakeSpec{{Name: "done", Title: "Done"}},
	}
}

// fakeNotes is the notification store's side (plugin.NotificationSink): one active
// notification per source and key, threads s-1 only.
type fakeNotes struct {
	mu     sync.Mutex
	active map[string]pluginsdk.Notification // source + "/" + key
	posts  []string                          // source/key
}

func (f *fakeNotes) Check(_ string, n pluginsdk.Notification) error {
	switch {
	case strings.TrimSpace(n.Title) == "":
		return fmt.Errorf("%w: a notification needs a title", plugin.ErrInvalidArgument)
	case n.ThreadID != "" && n.ThreadID != "s-1":
		return fmt.Errorf("%w: there is no thread %s", plugin.ErrNotFound, n.ThreadID)
	}
	return nil
}

func (f *fakeNotes) Post(_ context.Context, source string, n pluginsdk.Notification) (pluginsdk.NotifyResult, error) {
	if err := f.Check(source, n); err != nil {
		return pluginsdk.NotifyResult{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.active == nil {
		f.active = map[string]pluginsdk.Notification{}
	}
	k := source + "/" + n.Key
	out := pluginsdk.NotifyPosted
	if _, ok := f.active[k]; ok {
		out = pluginsdk.NotifyUpdated
	}
	f.active[k] = n
	f.posts = append(f.posts, k)
	return pluginsdk.NotifyResult{ID: "n-" + k, Key: n.Key, Outcome: out, Status: "shown"}, nil
}

func (f *fakeNotes) Withdraw(_ context.Context, source, key string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.active[source+"/"+key]
	delete(f.active, source+"/"+key)
	return ok, nil
}

func (f *fakeNotes) WithdrawAll(_ context.Context, source string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for k := range f.active {
		if strings.HasPrefix(k, source+"/") {
			delete(f.active, k)
			n++
		}
	}
	return n, nil
}

func (f *fakeNotes) Sources() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for k := range f.active {
		if s, _, _ := strings.Cut(k, "/"); !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	slices.Sort(out)
	return out
}

func (f *fakeNotes) keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for k := range f.active {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func (f *fakeNotes) put(source, key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.active == nil {
		f.active = map[string]pluginsdk.Notification{}
	}
	f.active[source+"/"+key] = pluginsdk.Notification{Key: key, Title: key}
}

// newNotesEnv runs plugins "notes" and "other" (granted notifications) and "mute" (not).
func newNotesEnv(t *testing.T, notes *fakeNotes, wakes *fakeSink) *env {
	t.Helper()
	e := newEnv(t, func(o *plugin.Options) { o.Notifications, o.Wakes = notes, wakes })
	for name, granted := range map[string]bool{"notes": true, "other": true, "mute": false} {
		e.install(e.opts.Dir, name, "notes", notesManifest(name, granted))
	}
	e.start()
	for _, name := range []string{"notes", "other", "mute"} {
		if _, err := e.m.Enable(context.Background(), name, true); err != nil {
			t.Fatal(err)
		}
		e.waitState(name, plugin.StateRunning)
	}
	return e
}

func noteJSON(n pluginsdk.Notification) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// notification/post: the permission, a command action naming the plugin's own command
// with args it declares, the sink's refusals, and source = the plugin's name.
func TestNotificationPost(t *testing.T) {
	notes := &fakeNotes{}
	e := newNotesEnv(t, notes, &fakeSink{})
	open := func(cmd string, args map[string]string) pluginsdk.NotificationAction {
		return pluginsdk.CommandAction("Open", cmd, args)
	}
	for _, tt := range []struct {
		name, plugin string
		n            pluginsdk.Notification
		want         string // a prefix of the answer
	}{
		{"no permission", "mute", pluginsdk.Notification{Key: "a", Title: "A"},
			`code -32001: permission denied: notification/post needs "notifications": true`},
		{"posted", "notes", pluginsdk.Notification{Key: "a", Title: "A", ThreadID: "s-1",
			Actions: []pluginsdk.NotificationAction{open("open", map[string]string{"item": "7"}), pluginsdk.OpenAction("Logs", "https://example.com")}},
			`{"id":"n-notes/a","key":"a","outcome":"posted","status":"shown"}`},
		{"same key from another plugin is its own", "other", pluginsdk.Notification{Key: "a", Title: "A"},
			`{"id":"n-other/a","key":"a","outcome":"posted"`},
		{"a command it does not declare", "notes", pluginsdk.Notification{Key: "b", Title: "B", Actions: []pluginsdk.NotificationAction{open("deploy", nil)}},
			`code -32602: notification/post: action 1 runs "deploy", which is not one of the commands in plugin.json (it has post, withdraw, fire, open)`},
		{"another plugin's command", "notes", pluginsdk.Notification{Key: "b", Title: "B", Actions: []pluginsdk.NotificationAction{open("plugin.other.open", nil)}},
			`code -32602: notification/post: action 1 runs "plugin.other.open"`},
		{"an arg the command does not declare", "notes", pluginsdk.Notification{Key: "b", Title: "B", Actions: []pluginsdk.NotificationAction{open("open", map[string]string{"id": "7"})}},
			`code -32602: notification/post: action 1 gives open an arg "id" it does not declare`},
		{"no title", "notes", pluginsdk.Notification{Key: "b"}, `code -32602: notification/post: invalid argument: a notification needs a title`},
		{"no such thread", "notes", pluginsdk.Notification{Key: "b", Title: "B", ThreadID: "s-9"}, `code -32004: notification/post: not found: there is no thread s-9`},
		{"a flag's key is the host's", "notes", pluginsdk.Notification{Key: "flag:s-1", Title: "B", ThreadID: "s-1"},
			`code -32602: notification/post: key "flag:s-1": keys starting with "flag:" are the host's (thread flags)`},
	} {
		r, err := e.invoke("plugin."+tt.plugin+".post", map[string]string{"note": noteJSON(tt.n)}, command.Context{})
		if err != nil || !strings.HasPrefix(r.Message, tt.want) {
			t.Errorf("%s: %q, %v; want %q…", tt.name, r.Message, err, tt.want)
		}
	}
	if got := notes.keys(); !slices.Equal(got, []string{"notes/a", "other/a"}) {
		t.Errorf("active %v", got)
	}

	// A plugin withdraws only its own keys.
	for _, tt := range []struct{ plugin, key, want string }{
		{"mute", "a", "code -32001"},
		{"other", "zzz", "false"},
		{"notes", "a", "true"},
		{"notes", "a", "false"},
	} {
		r, err := e.invoke("plugin."+tt.plugin+".withdraw", map[string]string{"key": tt.key}, command.Context{})
		if err != nil || !strings.HasPrefix(r.Message, tt.want) {
			t.Errorf("%s withdraw %s: %q, %v; want %s", tt.plugin, tt.key, r.Message, err, tt.want)
		}
	}
	if got := notes.keys(); !slices.Equal(got, []string{"other/a"}) {
		t.Errorf("after withdraw %v", got)
	}
	if !strings.Contains(e.logText("notes"), "notification a posted: A") || !strings.Contains(e.logText("notes"), "notification a withdrawn") {
		t.Errorf("log:\n%s", e.logText("notes"))
	}
}

// A notification attached to wake/fire: checked before the wake goes, then raised only
// when no thread got the wake, unless it is time-sensitive.
func TestNotificationRouting(t *testing.T) {
	notes, wakes := &fakeNotes{}, &fakeSink{}
	e := newNotesEnv(t, notes, wakes)
	fire := func(plugin string, n pluginsdk.Notification) string {
		r, err := e.invoke("plugin."+plugin+".fire", map[string]string{"source": "done", "note": noteJSON(n)}, command.Context{})
		if err != nil {
			t.Fatal(err)
		}
		return r.Message
	}
	for _, tt := range []struct {
		name       string
		subscribed bool
		urgent     bool
		want       string
		raised     bool
	}{
		{"nobody subscribed: raised", false, false, `{"delivered":0,"notification":{"id":"n-notes/k","key":"k","outcome":"posted"`, true},
		{"a thread got it: not raised", true, false, `{"delivered":1,"notification":{"key":"k","outcome":"routed"}}`, false},
		{"time-sensitive, nobody subscribed: raised", false, true, `{"delivered":0,"notification":{"id":"n-notes/k","key":"k","outcome":"posted"`, true},
		{"time-sensitive, a thread got it: raised too", true, true, `{"delivered":1,"notification":{"id":"n-notes/k","key":"k","outcome":"posted"`, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, _ = notes.WithdrawAll(context.Background(), "notes")
			if tt.subscribed {
				wakes.add(plugin.WakeSub{ID: "sub-1", Plugin: "notes", Source: "done", ThreadID: "s-1", Repeat: true})
				defer wakes.remove("sub-1")
			}
			got := fire("notes", pluginsdk.Notification{Key: "k", Title: "Done", TimeSensitive: tt.urgent})
			if !strings.HasPrefix(got, tt.want) {
				t.Errorf("fire = %s, want %s…", got, tt.want)
			}
			if raised := slices.Contains(notes.keys(), "notes/k"); raised != tt.raised {
				t.Errorf("raised = %v", raised)
			}
		})
	}

	// Refused before the wake goes: no permission, a bad notification.
	before, _ := wakes.seen()
	if got := fire("mute", pluginsdk.Notification{Key: "k", Title: "Done"}); !strings.HasPrefix(got, `code -32001: permission denied: a notification on wake/fire needs "notifications": true`) {
		t.Errorf("mute fire = %s", got)
	}
	if got := fire("notes", pluginsdk.Notification{Key: "k", Title: "Done", ThreadID: "s-9"}); !strings.HasPrefix(got, "code -32004: wake/fire: not found") {
		t.Errorf("bad notification fire = %s", got)
	}
	if after, _ := wakes.seen(); len(after) != len(before) {
		t.Errorf("a refused fire went: %v", after[len(before):])
	}
}

// Disabling or uninstalling a plugin withdraws its notifications; a restart keeps them;
// at start, those of plugins not enabled (or gone) are withdrawn.
func TestNotificationsWithdrawnWithThePlugin(t *testing.T) {
	notes := &fakeNotes{}
	notes.put("ghost", "g")   // a plugin removed while the daemon was stopped
	notes.put("sleeper", "s") // installed, disabled
	e := newEnv(t, func(o *plugin.Options) { o.Notifications = notes })
	for name, granted := range map[string]bool{"notes": true, "other": true, "sleeper": true} {
		e.install(e.opts.Dir, name, "notes", notesManifest(name, granted))
	}
	m := e.start()
	ctx := context.Background()
	if got := notes.keys(); len(got) != 0 {
		t.Fatalf("after start: %v", got)
	}
	for _, name := range []string{"notes", "other"} {
		if _, err := m.Enable(ctx, name, true); err != nil {
			t.Fatal(err)
		}
		e.waitState(name, plugin.StateRunning)
		if _, err := e.invoke("plugin."+name+".post", map[string]string{"note": noteJSON(pluginsdk.Notification{Key: "k", Title: "K"})}, command.Context{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Restart(ctx, "notes"); err != nil {
		t.Fatal(err)
	}
	e.waitState("notes", plugin.StateRunning)
	if got := notes.keys(); !slices.Equal(got, []string{"notes/k", "other/k"}) {
		t.Fatalf("after restart: %v", got)
	}
	if _, err := m.Disable(ctx, "notes"); err != nil {
		t.Fatal(err)
	}
	if got := notes.keys(); !slices.Equal(got, []string{"other/k"}) {
		t.Fatalf("after disable: %v", got)
	}
	if !strings.Contains(e.logText("notes"), "withdrew its notifications: 1") {
		t.Errorf("log:\n%s", e.logText("notes"))
	}
	if _, err := m.Uninstall(ctx, "other", false); err != nil {
		t.Fatal(err)
	}
	if got := notes.keys(); len(got) != 0 {
		t.Fatalf("after uninstall: %v", got)
	}
}
