package thread

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
)

// A resident's own rules follow the protocol's on every spawn of it, and of no other
// thread.
func TestResidentAllowedTools(t *testing.T) {
	e := newEnv(t)
	rules := []string{"Bash(code-foundry ember:*)", "Bash(code-foundry thread:*)"}
	e.m.SetResidentAllowedTools("ember", rules)
	r, _, err := e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: filepath.Join(e.home, "residents", "ember")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Send(e.ctx(), r.ID, Message{Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(r.ID, "the turn", turnOver)
	want := append(slices.Clone(ProtocolAllowedTools), rules...)
	if got := allowedOf(e.spec(r.ID).Argv); !slices.Equal(got, want) {
		t.Errorf("resident --allowedTools = %q\nwant %q", got, want)
	}
	plain := e.connected(CreateOptions{})
	if got := allowedOf(e.spec(plain.ID).Argv); !slices.Equal(got, ProtocolAllowedTools) {
		t.Errorf("plain --allowedTools = %q", got)
	}
	e.m.SetResidentAllowedTools("ember", nil)
	if got := e.m.residentAllowed(r); got != nil {
		t.Errorf("after removal = %q", got)
	}
}

// allowedOf is the --allowedTools list of argv: the values after the flag up to the
// next flag.
func allowedOf(argv []string) []string {
	i := slices.Index(argv, "--allowedTools")
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
