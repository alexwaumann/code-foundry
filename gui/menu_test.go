package main

import (
	"slices"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// menuLabels lists m's items, "-" for a separator, and fails on any key equivalent.
func menuLabels(t *testing.T, m *application.Menu) []string {
	t.Helper()
	var out []string
	for i := 0; ; i++ {
		item := m.ItemAt(i)
		if item == nil {
			return out
		}
		if item.IsSeparator() {
			out = append(out, "-")
			continue
		}
		if acc := item.GetAccelerator(); acc != "" {
			t.Errorf("%q has key equivalent %q; the page owns every chord", item.Label(), acc)
		}
		out = append(out, item.Label())
	}
}

func TestCommandMenus(t *testing.T) {
	tests := []struct {
		name   string
		groups [][]menuCommand
		want   []string
		cmds   []string
	}{
		{
			name:   "settings",
			groups: [][]menuCommand{{settingsItem}},
			want:   []string{"Settings…"},
			cmds:   []string{"view.settings"},
		},
		{
			name:   "thread",
			groups: threadMenu,
			want:   []string{"New Thread", "Add Project…", "-", "Rename Thread", "Fork Thread", "Snooze…", "Archive", "-", "Next Needing Attention"},
			cmds:   []string{"session.new", "repo.add", "session.rename", "session.fork", "session.snooze", "session.archive", "attention.next"},
		},
		{
			name:   "help",
			groups: helpMenu,
			want:   []string{"Getting Started", "Keyboard Shortcuts and Help", "-", "Open Command Palette"},
			cmds:   []string{"help.guide", "help.shortcuts", "ui.palette.open"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := application.NewMenu()
			addCommandGroups(m, tt.groups, func(string) {})
			if got := menuLabels(t, m); !slices.Equal(got, tt.want) {
				t.Errorf("labels = %q, want %q", got, tt.want)
			}
			var cmds []string
			for _, g := range tt.groups {
				for _, c := range g {
					cmds = append(cmds, c.command)
				}
			}
			if !slices.Equal(cmds, tt.cmds) {
				t.Errorf("commands = %q, want %q", cmds, tt.cmds)
			}
		})
	}
}
