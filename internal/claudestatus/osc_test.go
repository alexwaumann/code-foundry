package claudestatus

import "testing"

func TestParseOSC(t *testing.T) {
	tests := []struct {
		in   string
		want oscEvent
	}{
		{"0;✳ Claude Code", oscEvent{kind: oscTitle, text: "✳ Claude Code"}},
		{"2;◐ Touch hello.txt", oscEvent{kind: oscTitle, text: "◐ Touch hello.txt"}},
		{"0;", oscEvent{kind: oscTitle}},
		{"0;a\x01b", oscEvent{kind: oscTitle, text: "ab"}},
		{"1;icon", oscEvent{}},
		{"9;Claude needs your permission", oscEvent{kind: oscNotify, text: "Claude needs your permission"}},
		{"9;4;1;50", oscEvent{kind: oscProgress, progressActive: true}},
		{"9;4;3", oscEvent{kind: oscProgress, progressActive: true}},
		{"9;4;0;0", oscEvent{kind: oscProgress}},
		{"9;4;2;100", oscEvent{kind: oscProgress}},
		{"9;9;/tmp", oscEvent{}}, // ConEmu cwd report
		{"777;notify;Claude Code;Claude needs your permission", oscEvent{kind: oscNotify, text: "Claude needs your permission"}},
		{"777;notify;Only title", oscEvent{kind: oscNotify, text: "Only title"}},
		{"777;preexec", oscEvent{}},
		{"99;i=1:d=0;Claude Code", oscEvent{kind: oscNotify, text: "Claude Code"}},
		{"99;i=1:e=1;Q2xhdWRl", oscEvent{kind: oscNotify, text: "Claude"}},
		{"7501;state=blocked:kind=permission:app=claude:msg=QXBwbHk/", oscEvent{kind: oscProgramStatus,
			psState: "blocked", psKind: "permission", text: "Apply?"}},
		{"7501;state=working", oscEvent{kind: oscProgramStatus, psState: "working"}},
		{"7;file:///tmp", oscEvent{}},
		{"garbage", oscEvent{}},
	}
	for _, tt := range tests {
		if got := parseOSC([]byte(tt.in)); got != tt.want {
			t.Errorf("parseOSC(%q) = %+v, want %+v", tt.in, got, tt.want)
		}
	}
}

func TestClassifyTitle(t *testing.T) {
	tests := []struct {
		in   string
		kind titleKind
		task string
	}{
		{"", titleNone, ""},
		{"✳ Claude Code", titleIdle, "Claude Code"},
		{"✳ Touch hello.txt", titleIdle, "Touch hello.txt"},
		{"◐ Claude Code", titleSpinner, "Claude Code"},
		{"◑ add-subtract-function", titleSpinner, "add-subtract-function"},
		{"⠋ Thinking", titleSpinner, "Thinking"},
		{"zsh", titleOther, "zsh"},
		{"vim notes.md", titleOther, "vim notes.md"},
	}
	for _, tt := range tests {
		kind, _, task := classifyTitle(tt.in)
		if kind != tt.kind || task != tt.task {
			t.Errorf("classifyTitle(%q) = %v %q, want %v %q", tt.in, kind, task, tt.kind, tt.task)
		}
	}
}
