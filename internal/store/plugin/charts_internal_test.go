package plugin

import (
	"encoding/json"
	"strings"
	"testing"
)

// A stat card's and a bar's command actions are held to the plugin's permissions like a
// button's, and an empty bar chart reaches viewers with [] bars (docs/notes/plugin-stats-bars.md).
func TestStatsAndBarsInTheHost(t *testing.T) {
	for _, tt := range []struct {
		name, view, want string
	}{
		{"a card's foreign command", `{"nodes": [{"key": "st", "stats": {"cards": [{"key": "c", "label": "L", "value": "1", "action": {"command": {"name": "project.remove"}}}]}}]}`,
			`c: command "project.remove" is neither plugin.p.* nor in plugin.json's permissions.commands`},
		{"a bar's foreign command", `{"nodes": [{"key": "ch", "bars": {"bars": [{"key": "b", "value": 1, "title": "#1", "action": {"command": {"name": "project.remove"}}}]}}]}`,
			`b: command "project.remove" is neither`},
		{"a bar's own command", `{"nodes": [{"key": "ch", "bars": {"bars": [{"key": "b", "value": 1, "title": "#1", "action": {"command": {"name": "plugin.p.open", "args": {"id": "1"}}}}]}}]}`, ""},
		{"a negative bar", `{"nodes": [{"key": "ch", "bars": {"bars": [{"key": "b", "value": -2, "title": "#1"}]}}]}`, "nodes[0].bars.bars[0].value: -2 is negative"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, _, errs := validateView(json.RawMessage(tt.view), "p", everyPerms)
			got := strings.Join(errs, "\n")
			if (tt.want == "") != (got == "") || !strings.Contains(got, tt.want) {
				t.Fatalf("errors %q, want %q", got, tt.want)
			}
		})
	}
	_, canon, errs := validateView(json.RawMessage(`{"nodes": [{"key": "ch", "bars": {"title": "Empty"}}]}`), "p", everyPerms)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	if want := `{"nodes":[{"key":"ch","bars":{"title":"Empty","bars":[]}}]}`; string(canon) != want {
		t.Fatalf("canonical %s, want %s", canon, want)
	}
}
