package thread

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

// flagSummary is a thread's flags as "source level reason [seen]" lines, in order.
func flagSummary(fs []Flag) []string {
	out := make([]string, len(fs))
	for i, f := range fs {
		out[i] = f.Source + " " + f.Level.String() + " " + f.Reason
		if f.UntilSeen {
			out[i] += " [seen]"
		}
	}
	return out
}

// The flag lifecycle: set, replace, clear, until-seen, archive, the source going, and
// persistence across a daemon restart.
func TestFlagLifecycle(t *testing.T) {
	type step struct {
		do   func(e *env, id string) error
		want []string
	}
	set := func(source string, level FlagLevel, reason string, untilSeen bool, changed *bool) func(e *env, id string) error {
		return func(e *env, id string) error {
			time.Sleep(2 * time.Millisecond) // set_at has millisecond precision: newest first
			_, ch, err := e.m.SetFlag(e.ctx(), id, Flag{Source: source, SourceName: strings.ToUpper(source), Level: level, Reason: reason, UntilSeen: untilSeen})
			if changed != nil && err == nil && ch != *changed {
				return errors.New("changed = " + map[bool]string{true: "true", false: "false"}[ch])
			}
			return err
		}
	}
	yes, no := true, false
	watch := func(e *env, id string) error {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		_, err := e.m.WatchItems(ctx, id)
		return err
	}
	tests := []struct {
		name  string
		steps []step
	}{
		{"set, same again, replace", []step{
			{do: set("gh", FlagAttention, "deploy failed", false, &yes), want: []string{"gh attention deploy failed"}},
			{do: set("gh", FlagAttention, "deploy failed", false, &no), want: []string{"gh attention deploy failed"}},
			{do: set("gh", FlagError, "deploy broke", false, &yes), want: []string{"gh error deploy broke"}},
		}},
		{"errors sort first, then newest", []step{
			{do: set("a", FlagAttention, "one", false, nil), want: []string{"a attention one"}},
			{do: set("b", FlagError, "two", false, nil), want: []string{"b error two", "a attention one"}},
			{do: set("c", FlagAttention, "three", false, nil), want: []string{"b error two", "c attention three", "a attention one"}},
		}},
		{"none clears; clearing nothing is no change", []step{
			{do: set("gh", FlagAttention, "x", false, nil), want: []string{"gh attention x"}},
			{do: set("gh", FlagNone, "", false, &yes), want: []string{}},
			{do: set("gh", FlagNone, "", false, &no), want: []string{}},
		}},
		{"until seen clears when the thread is opened, the rest stays", []step{
			{do: set("gh", FlagAttention, "look", true, nil), want: []string{"gh attention look [seen]"}},
			{do: set("ci", FlagError, "red", false, nil), want: []string{"ci error red", "gh attention look [seen]"}},
			{do: watch, want: []string{"ci error red"}},
		}},
		{"ClearFlags one source, then all", []step{
			{do: set("a", FlagAttention, "one", false, nil), want: []string{"a attention one"}},
			{do: set("b", FlagAttention, "two", false, nil), want: []string{"b attention two", "a attention one"}},
			{do: func(e *env, id string) error { _, _, err := e.m.ClearFlags(e.ctx(), id, "a"); return err }, want: []string{"b attention two"}},
			{do: func(e *env, id string) error { _, _, err := e.m.ClearFlags(e.ctx(), id, ""); return err }, want: []string{}},
		}},
		{"the source going clears it (plugin disabled)", []step{
			{do: set("gh", FlagAttention, "x", false, nil), want: []string{"gh attention x"}},
			{do: set("ci", FlagAttention, "y", false, nil), want: []string{"ci attention y", "gh attention x"}},
			{do: func(e *env, _ string) error { _, err := e.m.ClearFlagSource(e.ctx(), "gh"); return err }, want: []string{"ci attention y"}},
		}},
		{"archive clears every flag", []step{
			{do: set("gh", FlagError, "x", false, nil), want: []string{"gh error x"}},
			{do: func(e *env, id string) error { _, err := e.m.Archive(e.ctx(), id, true); return err }, want: []string{}},
		}},
		{"restart keeps them", []step{
			{do: set("gh", FlagAttention, "kept", true, nil), want: []string{"gh attention kept [seen]"}},
			{do: func(e *env, _ string) error { e.restart(); return nil }, want: []string{"gh attention kept [seen]"}},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.stopped("flagged")
			for i, st := range tt.steps {
				if err := st.do(e, s.ID); err != nil {
					t.Fatalf("step %d: %v", i, err)
				}
				got, _ := e.m.Snapshot().Thread(s.ID)
				if g := flagSummary(got.Flags); !slices.Equal(g, st.want) {
					t.Fatalf("step %d: flags = %q, want %q", i, g, st.want)
				}
			}
		})
	}
}

func TestSetFlagRefusals(t *testing.T) {
	e := newEnv(t)
	s := e.stopped("flagged")
	tests := []struct {
		name string
		id   string
		f    Flag
		want error
	}{
		{"unknown thread", "s-nope", Flag{Source: "gh", Level: FlagAttention, Reason: "x"}, ErrNotFound},
		{"no source", s.ID, Flag{Level: FlagAttention, Reason: "x"}, ErrInvalidArgument},
		{"no reason", s.ID, Flag{Source: "gh", Level: FlagAttention, Reason: "  "}, ErrInvalidArgument},
		{"two lines", s.ID, Flag{Source: "gh", Level: FlagAttention, Reason: "a\nb"}, ErrInvalidArgument},
		{"too long", s.ID, Flag{Source: "gh", Level: FlagError, Reason: strings.Repeat("é", MaxFlagReasonRunes+1)}, ErrInvalidArgument},
		{"bad level", s.ID, Flag{Source: "gh", Level: FlagLevel(7), Reason: "x"}, ErrInvalidArgument},
	}
	for _, tt := range tests {
		if _, _, err := e.m.SetFlag(e.ctx(), tt.id, tt.f); !errors.Is(err, tt.want) {
			t.Errorf("%s: err = %v, want %v", tt.name, err, tt.want)
		}
	}
	if _, _, err := e.m.SetFlag(e.ctx(), s.ID, Flag{Source: "gh", Level: FlagAttention, Reason: strings.Repeat("é", MaxFlagReasonRunes)}); err != nil {
		t.Errorf("80 characters: %v", err)
	}
	a := e.archived()
	if _, _, err := e.m.SetFlag(e.ctx(), a.ID, Flag{Source: "gh", Level: FlagAttention, Reason: "x"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("archived: err = %v, want failed precondition", err)
	}
}

// An until-seen flag on a thread someone watches is seen at once: it is never stored.
func TestUntilSeenFlagWhileWatched(t *testing.T) {
	e := newEnv(t)
	s := e.stopped("watched")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := e.m.WatchItems(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	if got, changed, err := e.m.SetFlag(e.ctx(), s.ID, Flag{Source: "gh", Level: FlagAttention, Reason: "x", UntilSeen: true}); err != nil || changed || len(got.Flags) != 0 {
		t.Fatalf("SetFlag while watched = %v %v %v", got.Flags, changed, err)
	}
	// A flag that is not until-seen stays.
	if got, _, err := e.m.SetFlag(e.ctx(), s.ID, Flag{Source: "gh", Level: FlagAttention, Reason: "x"}); err != nil || len(got.Flags) != 1 {
		t.Fatalf("plain flag while watched = %v %v", got.Flags, err)
	}
	if got := e.m.FlagsOf("gh"); len(got) != 1 || got[s.ID].Reason != "x" {
		t.Errorf("FlagsOf = %v", got)
	}
	// Removing the thread removes its flags' rows (restart finds none).
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.restart()
	if got := e.m.FlagsOf("gh"); len(got) != 0 {
		t.Errorf("after remove + restart FlagsOf = %v", got)
	}
}
