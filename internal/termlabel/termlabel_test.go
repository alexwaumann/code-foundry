package termlabel

import "testing"

func TestShellKinds(t *testing.T) {
	tests := []struct {
		name               string
		labels             map[string]string
		shell, free, quick bool
	}{
		{name: "free", labels: Free(), shell: true, free: true},
		{name: "a thread's shell", labels: Shell("s1", "r1", "/w"), shell: true},
		{name: "a thread without a project", labels: Shell("s1", "", "/home"), shell: true},
		{name: "a worktree's shell", labels: Shell("", "r1", "/w"), shell: true},
		{name: "a quick shell", labels: QuickShell("s1", "r1", "/w"), shell: true, quick: true},
		{name: "a quick slot without a thread is not quick", labels: map[string]string{Kind: KindShell, Slot: SlotQuick}, shell: true, free: true},
		{name: "an action run", labels: ActionTerminal("s1", "r1", "/w", "a1", "test", "run1")},
		{name: "an action without owner is not free", labels: map[string]string{Kind: KindAction}},
		{name: "a plugin's terminal", labels: PluginTerminal("p", "t")},
		{name: "unlabelled", labels: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsShell(tt.labels); got != tt.shell {
				t.Errorf("IsShell = %v, want %v", got, tt.shell)
			}
			if got := IsFree(tt.labels); got != tt.free {
				t.Errorf("IsFree = %v, want %v", got, tt.free)
			}
			if got := IsQuick(tt.labels); got != tt.quick {
				t.Errorf("IsQuick = %v, want %v", got, tt.quick)
			}
		})
	}
}
