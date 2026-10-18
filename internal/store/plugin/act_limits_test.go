package plugin_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// An act refused for its size stores none of its secrets (the store used to happen
// first, so the plugin never heard of a secret the Keychain now held): values over
// ui.MaxActValues are refused before anything else, and values just under it whose act
// payload is over the wire cap are refused before the store.
func TestOversizeActStoresNoSecret(t *testing.T) {
	// {"name":"…","tok":"s3cr3t"} encodes to exactly ui.MaxActValues bytes.
	atLimit := ui.MaxActValues - len(`{"name":"","tok":"s3cr3t"}`)
	tests := []struct {
		name string
		size int
		want string
	}{
		{name: "values over the limit", size: 70 << 10, want: "values are over"},
		{name: "payload over the wire cap", size: atLimit, want: "payload is over"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newSurfEnv(t, nil)
			w := e.watch("panel", s1)
			w.view("first", contains("count 0"))
			_, err := e.act(w.key, plugin.ActRequest{Action: "save", Values: map[string]any{"name": strings.Repeat("x", tt.size), "tok": "s3cr3t"}})
			if !errors.Is(err, plugin.ErrInvalidArgument) || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
			if _, ok, _ := e.secrets.Get(context.Background(), "surf", "tok"); ok {
				t.Error("the refused act stored its secret")
			}
		})
	}
}
