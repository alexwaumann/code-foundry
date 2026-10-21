package guide

import (
	"bytes"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestWriteHelp(t *testing.T) {
	cmd := &v1.Command{
		Name: "plugin.secrets.delete", Title: "Delete Plugin Secret", Description: "Delete one of a plugin's secrets.",
		RequiresConfirmation: true,
		Args: []*v1.ArgSpec{
			{Name: "name", Positional: true, Required: true, Description: "Plugin name"},
			{Name: "key", Positional: true, Description: "Secret name"},
			{Name: "lines", Type: v1.ArgType_ARG_TYPE_INT, DefaultValue: "50", Description: "How many"},
		},
		Keybindings: []string{"cmd+k"},
	}
	for _, tt := range []struct {
		name      string
		common    bool
		cmd       *v1.Command
		want, not []string
	}{
		{
			name: "full", common: true, cmd: cmd,
			want: []string{
				"plugin.secrets.delete - Delete Plugin Secret\n\nDelete one of a plugin's secrets.\n",
				"  code-foundry plugin.secrets.delete <name> [<key>] [flags]\n  code-foundry plugin secrets delete <name> [<key>] [flags]\n",
				"  --lines n ", "How many (default \"50\")", "Common flags:", "  --yes", "  --context-thread id", "Keybindings: cmd+k",
			},
			not: []string{"Asks for confirmation"},
		},
		{
			name: "without the common flags", cmd: cmd,
			want: []string{"Flags:", "Asks for confirmation: --yes confirms"},
			not:  []string{"Common flags:", "--context-thread"},
		},
		{
			// A bool shows how to turn it off; a long enum lists its values after the
			// description instead of widening the flag column.
			name: "bool and long enum", cmd: &v1.Command{Name: "thread.new", Title: "New Thread", Args: []*v1.ArgSpec{
				{Name: "sidebar", Type: v1.ArgType_ARG_TYPE_BOOL, Description: "Show it"},
				{Name: "model", Type: v1.ArgType_ARG_TYPE_ENUM, Description: "Model",
					EnumValues: []string{"claude-opus-4-8[1m]", "claude-sonnet-5[1m]", "claude-haiku-5-5[1m]"}},
				{Name: "until", Type: v1.ArgType_ARG_TYPE_ENUM, Description: "When", EnumValues: []string{"idle", "error"}},
			}},
			want: []string{"  --sidebar[=false]   Show it", "  --model value       Model (one of: claude-opus-4-8[1m], claude-sonnet-5[1m], claude-haiku-5-5[1m])\n",
				"  --until idle|error  "},
		},
		{
			name: "no args, no confirmation", cmd: &v1.Command{Name: "plugin.list", Title: "List Plugins"},
			want: []string{"  code-foundry plugin list [flags]\n"},
			not:  []string{"Flags:", "Asks for confirmation", "\n\n\n"},
		},
	} {
		var buf bytes.Buffer
		WriteHelp(&buf, tt.cmd, tt.common)
		got := buf.String()
		for _, w := range tt.want {
			if !strings.Contains(got, w) {
				t.Errorf("%s: lacks %q in\n%s", tt.name, w, got)
			}
		}
		for _, n := range tt.not {
			if strings.Contains(got, n) {
				t.Errorf("%s: has %q in\n%s", tt.name, n, got)
			}
		}
	}
	var buf bytes.Buffer
	WriteCommonFlags(&buf)
	if strings.Contains(buf.String(), "--yes") || !strings.Contains(buf.String(), "--json") {
		t.Errorf("common flags:\n%s", buf.String())
	}
}
