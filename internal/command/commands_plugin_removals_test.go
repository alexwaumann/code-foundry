package command

import (
	"context"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

func TestPluginRemovals(t *testing.T) {
	tests := []struct {
		name string
		rs   []pluginsdk.Removal
		want string
	}{
		{"none", nil, "nothing in the plugin SDK is marked for removal"},
		{"deprecated and retired", []pluginsdk.Removal{
			{Symbols: []string{"Host.SetFlag", "Flag"}, Method: "thread/setFlag", Replacement: "Host.Notify", Hint: "post one",
				Stage: pluginsdk.StageDeprecated, Deprecated: "2026-11-16"},
			{Symbols: []string{"Host.Old"}, Replacement: "Host.New", Hint: "call the new one",
				Stage: pluginsdk.StageRetired, Deprecated: "2026-01-01", Retired: "2026-03-01"},
		}, "Host.SetFlag (thread/setFlag): deprecated since 2026-11-16\n  use: Host.Notify\n  move: post one\n  also: Flag\n\n" +
			"Host.Old: retired since 2026-03-01\n  deprecated 2026-01-01; does nothing now\n  use: Host.New\n  move: call the new one"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			old := pluginsdk.Removals
			pluginsdk.Removals = tt.rs
			defer func() { pluginsdk.Removals = old }()
			r := NewRegistry()
			if err := RegisterPluginRemovals(r); err != nil {
				t.Fatal(err)
			}
			res, err := r.Invoke(context.Background(), Context{}, "plugin.removals", nil)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Errorf("message:\n%s\nwant:\n%s", res.Message, tt.want)
			}
			js, _ := res.EncodeJSON()
			if !strings.HasPrefix(js, `{"removals":[`) {
				t.Errorf("json = %s", js)
			}
		})
	}
	// The real list has the flag first.
	r := NewRegistry()
	if err := RegisterPluginRemovals(r); err != nil {
		t.Fatal(err)
	}
	res, _ := r.Invoke(context.Background(), Context{}, "plugin.removals", nil)
	if js, _ := res.EncodeJSON(); !strings.Contains(js, `"symbols":["Host.SetFlag",`) || !strings.Contains(js, `"method":"thread/setFlag","replacement":"Host.Notify"`) ||
		!strings.Contains(js, `"stage":"deprecated","deprecated":"2026-11-16"`) {
		t.Errorf("json = %s", js)
	}
}
