package plugin_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// TestSecretNamespaceEscapes: plugin evil tries to read and delete plugin hello's
// secret through secret/get and secret/delete with crafted keys. Every key is refused
// (invalid params) or names evil's own namespace; hello's secret is untouched.
func TestSecretNamespaceEscapes(t *testing.T) {
	e := newEnv(t, nil)
	e.install(e.opts.Dir, "hello", "ok", testManifest("hello"))
	e.install(e.opts.Dir, "evil", "ok", testManifest("evil"))
	m := e.start()
	for _, n := range []string{"hello", "evil"} {
		if _, err := m.Enable(context.Background(), n, true); err != nil {
			t.Fatal(err)
		}
		e.waitState(n, plugin.StateRunning)
	}
	if r, err := e.invoke("plugin.hello.remember", map[string]string{"word": "s3cret"}, command.Context{}); err != nil || r.Message != "remembered" {
		t.Fatalf("remember = %q, %v", r.Message, err)
	}
	invalid := fmt.Sprintf("code %d", pluginsdk.CodeInvalidParams)
	tests := []struct{ key, want string }{
		{"../hello/word", invalid},
		{"hello/word", invalid},
		{"/hello/word", invalid},
		{"hello%2Fword", invalid},
		{"", invalid},
		{"wörd", invalid},
		{strings.Repeat("w", 129), invalid},
		{"word\x00", invalid},
		{"word\n", invalid},
		{"..", "nothing"}, // a valid key: evil's own "..", which is unset
		{"word", "nothing"},
	}
	for _, tt := range tests {
		r, err := e.invoke("plugin.evil.peek", map[string]string{"key": tt.key}, command.Context{})
		if err != nil || r.Message != tt.want {
			t.Errorf("peek %q = %q, %v; want %q", tt.key, r.Message, err, tt.want)
		}
		want := tt.want
		if want == "nothing" {
			want = "forgotten"
		}
		r, err = e.invoke("plugin.evil.forget", map[string]string{"key": tt.key}, command.Context{})
		if err != nil || r.Message != want {
			t.Errorf("forget %q = %q, %v; want %q", tt.key, r.Message, err, want)
		}
	}
	if v, ok, _ := e.secrets.Get(context.Background(), "hello", "word"); !ok || v != "s3cret" {
		t.Fatalf("hello's secret after the attempts: %q %v", v, ok)
	}
	if r, _ := e.invoke("plugin.hello.recall", nil, command.Context{}); r.Message != "s3cret" {
		t.Errorf("hello recall = %q", r.Message)
	}

	// A Keychain item the database does not record for evil (left by an earlier package
	// of the name, or another home's) is out of reach.
	if err := e.secrets.Set(context.Background(), "evil", "word", "stale"); err != nil {
		t.Fatal(err)
	}
	if r, _ := e.invoke("plugin.evil.peek", map[string]string{"key": "word"}, command.Context{}); r.Message != "nothing" {
		t.Errorf("unrecorded item: peek = %q", r.Message)
	}

	// The management side refuses names and keys outside the shapes too.
	for _, c := range []struct{ name, key string }{{"../hello", "word"}, {"hello/x", "word"}, {"hello", "../word"}, {"", "word"}} {
		if err := m.DeleteSecret(context.Background(), c.name, c.key); err == nil {
			t.Errorf("DeleteSecret(%q, %q): no error", c.name, c.key)
		}
	}
	if _, err := m.Secrets(context.Background(), "../hello"); err == nil {
		t.Error("Secrets(../hello): no error")
	}
	if logs := e.logText("evil") + e.logText("hello"); strings.Contains(logs, "s3cret") {
		t.Error("a secret value reached a log")
	}
}
