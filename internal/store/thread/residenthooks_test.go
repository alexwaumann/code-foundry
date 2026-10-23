package thread

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// A resident's own rules follow the protocol's on every spawn of it, and of no other
// thread; its deny rules are --disallowedTools.
func TestResidentAllowedTools(t *testing.T) {
	e := newEnv(t)
	rules := []string{"Bash(code-foundry ember:*)", "Bash(code-foundry thread:*)"}
	e.m.SetResidentTools("ember", ResidentTools{Allow: rules, Deny: []string{"Edit", "Write"}})
	r, _, err := e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: filepath.Join(e.home, "residents", "ember")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Send(e.ctx(), r.ID, Message{Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(r.ID, "the turn", turnOver)
	want := append(slices.Clone(ProtocolAllowedTools), rules...)
	argv := e.spec(r.ID).Argv
	if got := flagList(argv, "--allowedTools"); !slices.Equal(got, want) {
		t.Errorf("resident --allowedTools = %q\nwant %q", got, want)
	}
	if got := flagList(argv, "--disallowedTools"); !slices.Equal(got, []string{"Edit", "Write"}) {
		t.Errorf("resident --disallowedTools = %q", got)
	}
	plain := e.connected(CreateOptions{})
	if got := flagList(e.spec(plain.ID).Argv, "--allowedTools"); !slices.Equal(got, ProtocolAllowedTools) {
		t.Errorf("plain --allowedTools = %q", got)
	}
	if got := flagList(e.spec(plain.ID).Argv, "--disallowedTools"); got != nil {
		t.Errorf("plain --disallowedTools = %q", got)
	}
	e.m.SetResidentTools("ember", ResidentTools{})
	if allow, deny := e.m.residentRules(r); allow != nil || deny != nil {
		t.Errorf("after removal = %q, %q", allow, deny)
	}
}

// flagList is the values after a variadic flag in argv, up to the next flag.
func flagList(argv []string, flag string) []string {
	i := slices.Index(argv, flag)
	if i < 0 {
		return nil
	}
	var out []string
	for _, a := range argv[i+1:] {
		if len(a) > 1 && a[:2] == "--" {
			break
		}
		out = append(out, a)
	}
	return out
}

// The create defaults fill what a creator's new thread left open, and only that.
func TestCreateDefaults(t *testing.T) {
	e := newEnv(t)
	creator := e.stopped("creator")
	type call struct {
		by                    string
		needModel, needEffort bool
	}
	var calls []call
	e.m.SetCreateDefaults(func(_ context.Context, by string, needModel, needEffort bool) (string, string) {
		calls = append(calls, call{by, needModel, needEffort})
		return "claude-opus-4-7[1m]", "high"
	})
	tests := []struct {
		name               string
		o                  CreateOptions
		wantModel, wantEff string
		wantCall           *call
	}{
		{"nothing chosen", CreateOptions{CreatedBy: creator.ID}, "claude-opus-4-7[1m]", "high", &call{creator.ID, true, true}},
		{"the settings' defaults", CreateOptions{CreatedBy: creator.ID, Model: "claude-sonnet-5[1m]", Effort: "medium", ModelDefaulted: true, EffortDefaulted: true},
			"claude-opus-4-7[1m]", "high", &call{creator.ID, true, true}},
		{"an explicit model wins", CreateOptions{CreatedBy: creator.ID, Model: "claude-haiku-5-5[1m]", Effort: "medium", EffortDefaulted: true},
			"claude-haiku-5-5[1m]", "high", &call{creator.ID, false, true}},
		{"both explicit", CreateOptions{CreatedBy: creator.ID, Model: "claude-haiku-5-5[1m]", Effort: "low"}, "claude-haiku-5-5[1m]", "low", nil},
		{"the user's thread", CreateOptions{Model: "claude-sonnet-5[1m]", ModelDefaulted: true}, "claude-sonnet-5[1m]", "", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls = nil
			s := e.create(tt.o)
			if s.Model != tt.wantModel || s.Effort != tt.wantEff {
				t.Errorf("model, effort = %q, %q; want %q, %q", s.Model, s.Effort, tt.wantModel, tt.wantEff)
			}
			switch {
			case tt.wantCall == nil && len(calls) > 0:
				t.Errorf("calls = %+v, want none", calls)
			case tt.wantCall != nil && (len(calls) != 1 || calls[0] != *tt.wantCall):
				t.Errorf("calls = %+v, want %+v", calls, *tt.wantCall)
			}
		})
	}
	e.m.SetCreateDefaults(func(context.Context, string, bool, bool) (string, string) { return "", "loud" })
	if _, err := e.m.Create(e.ctx(), CreateOptions{CreatedBy: creator.ID, Name: "bad"}); err == nil {
		t.Error("an invalid default effort was accepted")
	}
}

// A wake to a resident ends with its store's note, told which threads the wake is about;
// another thread's wake has none, nor has a resident whose note is gone or blank.
func TestResidentWakeNote(t *testing.T) {
	e := newEnv(t)
	r, _, err := e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: filepath.Join(e.home, "residents", "ember")})
	if err != nil {
		t.Fatal(err)
	}
	const note = "[code-foundry ember] Unclosed on your board: t-1."
	var mu sync.Mutex
	var abouts [][]string
	e.m.SetResidentWakeNote("ember", func(about []string) string {
		mu.Lock()
		defer mu.Unlock()
		abouts = append(abouts, slices.Clone(about))
		return note
	})
	kid := e.create(CreateOptions{Name: "Worker", InitialPrompt: "go", CreatedBy: r.ID, Notify: true})
	items := e.waitItems(r.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if w := wakes(items)[0]; !strings.HasSuffix(w.Text, "```\n\n"+note) || w.WakeTitle == "" {
		t.Errorf("the resident's wake = %q", w.Text)
	}
	mu.Lock()
	if len(abouts) != 1 || !slices.Equal(abouts[0], []string{kid.ID}) {
		t.Errorf("about = %q, want [%s]", abouts, kid.ID)
	}
	mu.Unlock()

	plain := e.stopped("Orchestrator")
	if got := e.m.withWakeNote(plain.ID, Message{Text: "wake"}, nil); got.Text != "wake" {
		t.Errorf("a plain thread's wake = %q", got.Text)
	}
	e.m.SetResidentWakeNote("ember", func([]string) string { return "  " })
	if got := e.m.withWakeNote(r.ID, Message{Text: "wake"}, nil); got.Text != "wake" {
		t.Errorf("a blank note = %q", got.Text)
	}
	e.m.SetResidentWakeNote("ember", nil)
	if got := e.m.withWakeNote(r.ID, Message{Text: "wake"}, nil); got.Text != "wake" {
		t.Errorf("after removal = %q", got.Text)
	}
}
