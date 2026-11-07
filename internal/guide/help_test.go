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
	guiArgs := &v1.Command{Name: "thread.send", Title: "Send", Args: []*v1.ArgSpec{
		{Name: "name", Description: "A name"},
		{Name: "composer-text", Description: "The composer's text (the GUI sets it)"},
		{Name: "attachments", Description: "Paths from StageAttachment"},
		{Name: "by", Description: "Who sends it (the CLI sets it from $CODE_FOUNDRY_THREAD)"},
	}}
	for _, tt := range []struct {
		name      string
		style     HelpStyle
		cmd       *v1.Command
		want, not []string
	}{
		{
			name: "full", cmd: cmd,
			want: []string{
				"plugin.secrets.delete - Delete Plugin Secret\n\nDelete one of a plugin's secrets.\n",
				"  code-foundry plugin.secrets.delete <name> [<key>] [flags]\n  code-foundry plugin secrets delete <name> [<key>] [flags]\n",
				"  --lines n ", "How many (default \"50\")", "Common flags:", "  --yes", "  --context-thread id", "Keybindings: cmd+k",
			},
			not: []string{"Asks for confirmation"},
		},
		{
			// Repeatable: the usage shows it takes several, and its flag says so too.
			name: "a repeatable positional", cmd: &v1.Command{Name: "view.panel.diff", Title: "Show Diff", Args: []*v1.ArgSpec{
				{Name: "path", Type: v1.ArgType_ARG_TYPE_PATH, Positional: true, Repeatable: true, Description: "A file"},
			}},
			want: []string{"  code-foundry view.panel.diff [<path>…] [flags]\n", "A file (repeatable)"},
		},
		{
			name: "without the common flags", style: HelpReference, cmd: cmd,
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
			name: "no args, no confirmation", style: HelpReference, cmd: &v1.Command{Name: "plugin.list", Title: "List Plugins"},
			want: []string{"  code-foundry plugin list [flags]\n"},
			not:  []string{"Flags:", "Asks for confirmation", "\n\n\n"},
		},
		{
			// Everywhere but in a thread, a flag someone else sets is still listed.
			name: "the GUI's flags, outside a thread", cmd: guiArgs,
			want: []string{"--composer-text", "--attachments", "--by", "Common flags:\n", "  --context-worktree path"},
		},
		{
			name: "the GUI's flags, in a thread", style: HelpThread, cmd: guiArgs,
			want: []string{"  --name string", "Common flags: --json, --context-<thread|project|worktree|workspace|terminal>\n"},
			not:  []string{"--composer-text", "--attachments", "--by", "--yes", "Common flags:\n", "  --context-worktree path"},
		},
		{
			name: "confirmation, in a thread", style: HelpThread, cmd: cmd,
			want: []string{"  --lines n ", "Common flags: --json, --yes (it asks first), --context-<"},
			not:  []string{"Asks for confirmation"},
		},
		{
			// All its flags are set for it, so no empty heading.
			name: "only hidden flags, in a thread", style: HelpThread,
			cmd: &v1.Command{Name: "composer.x", Title: "X", Args: guiArgs.GetArgs()[1:]},
			not: []string{"Flags:\n"},
		},
	} {
		var buf bytes.Buffer
		WriteHelp(&buf, tt.cmd, tt.style)
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
