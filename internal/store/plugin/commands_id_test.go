package plugin_test

import (
	"context"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// A plugin's thread and terminal context args are ids: a unique suffix, given or taken
// from --context-thread, reaches the plugin (and its context) as the full id.
func TestContextArgsResolveIDs(t *testing.T) {
	e := newEnv(t, nil)
	mf := testManifest("hello")
	for i := range mf.Commands {
		if mf.Commands[i].Name == "send" {
			mf.Commands[i].Args = append(mf.Commands[i].Args,
				pluginsdk.ArgSpec{Name: "thread", Context: pluginsdk.ArgContextThread},
				pluginsdk.ArgSpec{Name: "worktree", Type: pluginsdk.ArgPath, Context: pluginsdk.ArgContextWorktree})
		}
	}
	e.install(e.opts.Dir, "hello", "ok", mf)
	e.reg.SetIDLister(command.ThreadID, func(context.Context) ([]string, error) {
		return []string{"s-0123456789ab", "s-ffffffffffff"}, nil
	})
	m := e.start()
	if _, err := m.Enable(context.Background(), "hello", true); err != nil {
		t.Fatal(err)
	}
	e.waitState("hello", plugin.StateRunning)

	c, _ := e.reg.Get("plugin.hello.send")
	kinds := map[string]command.IDKind{}
	for _, a := range c.Args {
		kinds[a.Name] = a.ID
	}
	if kinds["thread"] != command.ThreadID || kinds["worktree"] != command.NoID || kinds["text"] != command.NoID {
		t.Errorf("id kinds = %v", kinds)
	}
	for _, tt := range []struct {
		name string
		args map[string]string
		uctx command.Context
		want string
	}{
		{"suffix from the context", map[string]string{"text": "hi"}, command.Context{ActiveThreadID: "89ab"}, "s-0123456789ab:hi"},
		{"suffix as the arg", map[string]string{"text": "hi", "thread": "ffff"}, command.Context{}, "s-ffffffffffff:hi"},
		{"a full id", map[string]string{"text": "hi"}, command.Context{ActiveThreadID: "s-0123456789ab"}, "s-0123456789ab:hi"},
	} {
		if _, err := e.invoke("plugin.hello.send", tt.args, tt.uctx); err != nil {
			t.Fatalf("%s: %v", tt.name, err)
		}
		if got := <-e.sent; got != tt.want {
			t.Errorf("%s: thread.send got %q, want %q", tt.name, got, tt.want)
		}
	}
	if _, err := e.invoke("plugin.hello.send", map[string]string{"text": "hi", "thread": "9999"}, command.Context{}); err == nil {
		t.Error("an unknown suffix passed")
	}
}
