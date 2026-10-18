package guide

import (
	"bytes"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestWriteSettings(t *testing.T) {
	groups := []*v1.SettingGroup{{Id: "threads", Title: "Threads", Description: "Defaults for\nnew threads."}, {Id: "empty", Title: "Empty"}}
	tests := []struct {
		name  string
		field *v1.SettingField
		want  string
	}{
		{"enum with labels", &v1.SettingField{Key: "threads.effort", Group: "threads", Title: "Effort", Description: "How hard.",
			Type: v1.SettingType_SETTING_TYPE_ENUM, EnumValues: []string{"low", "", "max"}, EnumLabels: []string{"Low", "None", "max"}, DefaultValue: "low"},
			"- `threads.effort` **Effort**: How hard.\n  Type: enum, one of `low` (Low), `\"\"` (None), `max`. Default: `low`.\n"},
		{"int with bounds, unit and restart", &v1.SettingField{Key: "threads.grace", Group: "threads", Title: "Grace",
			Type: v1.SettingType_SETTING_TYPE_INT, Min: 1, Max: 120, Unit: "s", DefaultValue: "10", RestartRequired: true},
			"- `threads.grace` **Grace**\n  Type: int, 1 to 120 s. Default: `10`. Applies after a daemon restart.\n"},
		{"bool", &v1.SettingField{Key: "threads.auto", Group: "threads", Title: "Auto", Type: v1.SettingType_SETTING_TYPE_BOOL, DefaultValue: "true"},
			"  Type: bool (`true` or `false`). Default: `true`.\n"},
		{"empty default", &v1.SettingField{Key: "threads.editor", Group: "threads", Title: "Editor", Type: v1.SettingType_SETTING_TYPE_STRING},
			"  Type: string. Default: none (empty).\n"},
		{"keybinding", &v1.SettingField{Key: "keybindings.thread.new", Group: "keybindings", Title: "New Thread",
			Type: v1.SettingType_SETTING_TYPE_KEYBINDING, DefaultValue: "cmd+n", Description: "not shown"},
			"## keybindings (`[keybindings]`)\n\n- `keybindings.thread.new` New Thread: `cmd+n`\n"},
		{"keybinding without a chord", &v1.SettingField{Key: "keybindings.x", Group: "keybindings", Title: "X",
			Type: v1.SettingType_SETTING_TYPE_KEYBINDING}, "- `keybindings.x` X: no default chord\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			WriteSettings(&buf, groups, []*v1.SettingField{tt.field})
			got := buf.String()
			if !strings.Contains(got, tt.want) {
				t.Errorf("got\n%s\nwant it to contain\n%s", got, tt.want)
			}
			if strings.Contains(got, "Empty") || strings.Contains(got, "not shown") {
				t.Errorf("got\n%s", got)
			}
			if tt.field.GetGroup() == "threads" && !strings.Contains(got, "## Threads (`[threads]`)\n\nDefaults for new threads.\n\n") {
				t.Errorf("group heading missing:\n%s", got)
			}
		})
	}
}
