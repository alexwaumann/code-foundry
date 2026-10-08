package claudestatus

import (
	"strings"
	"testing"
)

const rule = "────────────────────────────────────────────────────────────────────────"

// fullscreenIdle is the bottom of Claude Code 2.1.294's fullscreen UI at the prompt.
var fullscreenIdle = strings.Join([]string{
	" ▐▛███▛█   Claude Code v2.1.294",
	"▝▜██████▀  Fable 5.1 with medium effort · Claude Max",
	" ▝▝   ▝▝   /private/tmp/cf2b-scratch",
	"",
	"❯ What is 17*23? Think it through briefly, then answer in one short sentence.",
	"",
	"⏺ 17 × 23 = 17 × 20 + 17 × 3 = 340 + 51, so the answer is 391.",
	"",
	"✻ Brewed for 4s · done 1:59 AM",
	"",
	"",
	rule,
	"❯ ",
	rule,
	"  cf2b-scratch · main",
	"  Fable 5.1 (medium) · 40k tokens · 23% (resets in 1 hr 10 mins)",
	"  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
}, "\n")

func TestClassifyScreen(t *testing.T) {
	tests := []struct {
		name       string
		screen     string
		promptBox  bool
		input      string
		dialog     DialogKind
		dialogText string
		spinner    bool
	}{
		{name: "empty", screen: ""},
		{name: "fullscreen idle", screen: fullscreenIdle, promptBox: true},
		{name: "placeholder", screen: rule + "\n❯ Try \"fix lint errors\"\n" + rule + "\n", promptBox: true,
			input: `Try "fix lint errors"`},
		{name: "nbsp after glyph", screen: rule + "\n❯ hello\n" + rule, promptBox: true, input: "hello"},
		{name: "legacy > prompt", screen: rule + "\n> \n" + rule, promptBox: true},
		{name: "labelled rule", screen: "──────────────────────────────── add-subtract-function ─\n❯ \n" + rule,
			promptBox: true},
		{name: "multi-line input", screen: rule + "\n❯ line one\n  line two\n  line three\n" + rule, promptBox: true,
			input: "line one"},
		{name: "no closing rule", screen: rule + "\n❯ text\nmore"},
		{name: "echoed prompt is not a box", screen: "banner\n❯ What is 17*23?\n\n⏺ 391"},
		{name: "spinner above box", promptBox: true, spinner: true, screen: strings.Join([]string{
			"❯ Write a poem", "", "✻ Ruminating… (12s · ↓ 566 tokens)", "            ◐ medium · /effort",
			rule, "❯ ", rule, "  -- INSERT --"}, "\n")},
		{name: "thinking spinner", promptBox: true, spinner: true, screen: "✽ Thinking…\n\n" + rule + "\n❯\n" + rule},
		{name: "done row is not a spinner", promptBox: true, screen: "✻ Brewed for 4s · done 1:59 AM\n" + rule + "\n❯\n" + rule},
		{name: "effort row is not a spinner", promptBox: true, screen: "◐ medium · /effort\n" + rule + "\n❯\n" + rule},
		{name: "esc to interrupt (older UI)", promptBox: true, spinner: true,
			screen: "✶ Pondering… (esc to interrupt)\n" + rule + "\n> \n" + rule},
		{name: "prose question above the prompt is not a dialog", promptBox: true, screen: strings.Join([]string{
			"⏺ I can refactor this. Do you want to proceed?", "  1. Yes", "  2. No", rule, "❯ ", rule}, "\n")},
		{name: "permission", dialog: DialogPermission, dialogText: "Do you want to proceed?", screen: strings.Join([]string{
			"  ⎿  $ touch hello.txt", "", rule, " Bash command", " Create empty hello.txt file", "╌╌╌╌╌╌╌╌╌╌",
			" touch hello.txt", "╌╌╌╌╌╌╌╌╌╌", " Do you want to proceed?", " ❯ 1. Yes",
			"   2. Yes, and always allow access to /private/tmp/cf2b-scratch from this project", "   4. No", "",
			" Esc to cancel · Tab to amend"}, "\n")},
		{name: "edit permission", dialog: DialogPermission, dialogText: "Do you want to make this edit to calc.py?",
			screen: rule + "\n Edit file\n Do you want to make this edit to calc.py?\n ❯ 1. Yes\n   2. No\n"},
		{name: "question", dialog: DialogQuestion, dialogText: "Which color do you prefer?", screen: strings.Join([]string{
			"❯ Before doing anything else, use the AskUserQuestion tool to ask me which of two colors I prefer: red or blue. Then",
			"  reply with my choice in one word.", rule, " ☐ Color", "", "Which color do you prefer?", "", "❯ 1. Red",
			"     Pick red", "  2. Blue", "     Pick blue", "  3. Type something.", rule, "  4. Chat about this", "",
			"Enter to select · ↑/↓ to navigate · Esc to cancel"}, "\n")},
		{name: "plan approval", dialog: DialogPlan,
			dialogText: "Claude has written up a plan and is ready to execute. Would you like to proceed?",
			screen: strings.Join([]string{
				"  " + rule, "   Ready to code?", "", "   Here is Claude's plan:", "  ╌╌╌╌╌╌╌╌╌╌", "   Plan: add subtract",
				"  " + rule, "   Claude has written up a plan and is ready to execute. Would you like to proceed?", "",
				"   ❯ 1. Yes, and use auto mode", "     2. Yes, manually approve edits", "     3. Tell Claude what to change",
				"   ctrl+g to edit in Nvim · ~/.claude/plans/plan.md"}, "\n")},
		{name: "trust", dialog: DialogTrust, dialogText: "trust this folder?", screen: strings.Join([]string{
			rule, " Accessing workspace:", "", " /private/tmp/cf2b-scratch", "",
			" Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
			" Security guide", "", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"}, "\n")},
		{name: "press enter", dialog: DialogContinue, dialogText: "Press Enter to continue…",
			screen: "Login successful.\nPress Enter to continue…"},
		{name: "generic menu", dialog: DialogMenu, dialogText: "❯ 1. Default (recommended)",
			screen: " Select model\n ❯ 1. Default (recommended)\n   2. Opus\n"},
		{name: "dialog below the prompt box", promptBox: true, input: "/model", dialog: DialogMenu, dialogText: "Esc to cancel",
			screen: rule + "\n❯ /model\n" + rule + "\n  Esc to cancel"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyScreen(tt.screen)
			if got.PromptBox != tt.promptBox || got.Input != tt.input || got.Dialog != tt.dialog ||
				got.DialogText != tt.dialogText || got.Spinner != tt.spinner {
				t.Errorf("got %+v\nwant promptBox=%v input=%q dialog=%v text=%q spinner=%v", got, tt.promptBox,
					tt.input, tt.dialog, tt.dialogText, tt.spinner)
			}
		})
	}
}

// Screens recorded from the real UI classify as expected (time in ms, see testdata).
func TestClassifyFixtureScreens(t *testing.T) {
	tests := []struct {
		fixture string
		at      int64
		box     bool
		dialog  DialogKind
		spinner bool
	}{
		{"trust", 1000, false, DialogTrust, false},
		{"text", 2000, true, DialogNone, false},
		{"text", 4700, true, DialogNone, true}, // "✳ Wandering…"
		{"text", 12000, true, DialogNone, false},
		{"permission", 9000, false, DialogPermission, false},
		{"permission", 16000, true, DialogNone, false},
		{"question", 7000, false, DialogQuestion, false},
		{"plan", 14000, false, DialogPlan, false},
		{"inline-renderer", 3300, true, DialogNone, true}, // "✻ Thinking…"
		{"inline-renderer", 13000, false, DialogPermission, false},
		{"interrupt", 12000, true, DialogNone, false},
		{"api-error", 6000, true, DialogNone, false},
		{"ghostty-notify", 10000, false, DialogPermission, false},
	}
	for _, tt := range tests {
		screen := screenAt(loadFixture(t, tt.fixture), tt.at)
		got := ClassifyScreen(screen)
		if got.PromptBox != tt.box || got.Dialog != tt.dialog || got.Spinner != tt.spinner {
			t.Errorf("%s@%d: got %+v, want box=%v dialog=%v spinner=%v\n%s", tt.fixture, tt.at, got, tt.box,
				tt.dialog, tt.spinner, screen)
		}
	}
}

// screenAt returns the last screen recorded at or before at (ms).
func screenAt(evs []fixtureEvent, at int64) string {
	s := ""
	for _, ev := range evs {
		if ev.T > at {
			break
		}
		if ev.K == "screen" {
			s = ev.D
		}
	}
	return s
}

func TestTailLines(t *testing.T) {
	tests := []struct {
		in   string
		n    int
		want []string
	}{
		{"", 3, []string{""}},
		{"a", 3, []string{"a"}},
		{"a\nb\nc", 2, []string{"b", "c"}},
		{"a\nb\nc\n\n", 2, []string{"b", "c"}},
		{"\nb", 5, []string{"", "b"}},
		{"a  \nb\t", 5, []string{"a", "b"}},
	}
	for _, tt := range tests {
		got := tailLines(tt.in, tt.n)
		if strings.Join(got, "|") != strings.Join(tt.want, "|") {
			t.Errorf("tailLines(%q, %d) = %q, want %q", tt.in, tt.n, got, tt.want)
		}
	}
}
