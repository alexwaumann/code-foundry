package thread

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecentTurnsContext(t *testing.T) {
	user := func(s string) Item { return Item{Kind: KindUserMessage, Text: s} }
	asst := func(s string) Item { return Item{Kind: KindAssistantText, Text: s} }
	long := strings.Repeat("a", 3000) + "END"
	tests := []struct {
		name  string
		items []Item
		want  string
	}{
		{"nothing", nil, ""},
		{"no user message", []Item{asst("hello"), {Kind: KindNote, Text: "Forked from x"}}, ""},
		{"only a wake", []Item{{Kind: KindUserMessage, Text: "PR merged", WakeTitle: "PR merged"}, asst("ok")}, ""},
		{"one turn", []Item{user("fix the login"), asst("Looking."), asst("Fixed it.")},
			"User: fix the login\n\nAssistant: Looking.\n\nFixed it."},
		{"the last three user messages, oldest first", []Item{
			user("one"), asst("r1"), user("two"), asst("r2"), user("three"), asst("r3"), user("four"), asst("r4"),
		}, "User: two\n\nAssistant: r2\n\nUser: three\n\nAssistant: r3\n\nUser: four\n\nAssistant: r4"},
		{"other kinds, wakes, subagents and API errors are left out", []Item{
			user("go"),
			{Kind: KindThinking, Text: "hmm"},
			{Kind: KindToolCall, Text: "ls"},
			{Kind: KindAssistantText, Text: "subagent says", ParentToolUseID: "t1"},
			{Kind: KindAssistantText, Text: "Invalid API key", APIError: true},
			{Kind: KindCommandOutput, Text: "Compacted"},
			{Kind: KindCompaction, Text: "summary"},
			{Kind: KindNote, Text: "note"},
			asst("done"),
			{Kind: KindUserMessage, Text: "timer fired", WakeTitle: "timer"},
			asst("woke up"),
		}, "User: go\n\nAssistant: done\n\nwoke up"},
		{"a reply before any user message is left out", []Item{asst("parent reply"), user("next"), asst("ok")},
			"User: next\n\nAssistant: ok"},
		{"blank text is skipped", []Item{user("  "), user("real"), asst(" ")}, "User: real"},
		{"over the cap the oldest block loses its start", []Item{user(long), asst(long)},
			"User: …" + long[len(long)-(maxRecentTurnsContext-len("Assistant: ")-len(long)-2-len("User: ")-len("…")):] + "\n\nAssistant: " + long},
		{"a block that does not fit at all goes", []Item{user("old"), asst(strings.Repeat("b", maxRecentTurnsContext-len("Assistant: ")))},
			"Assistant: " + strings.Repeat("b", maxRecentTurnsContext-len("Assistant: "))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := recentTurnsContext(tt.items)
			if got != tt.want {
				t.Errorf("recentTurnsContext =\n%q\nwant\n%q", got, tt.want)
			}
			if len(got) > maxRecentTurnsContext {
				t.Errorf("len = %d, over the cap", len(got))
			}
		})
	}
}

func TestRecentTurnsContextCutsAtARune(t *testing.T) {
	got := recentTurnsContext([]Item{{Kind: KindUserMessage, Text: strings.Repeat("é", 3000)}})
	if !strings.HasPrefix(got, "User: …é") || len(got) > maxRecentTurnsContext {
		t.Errorf("got %q… (len %d)", got[:20], len(got))
	}
}

func TestBuildNamingPromptConversation(t *testing.T) {
	tests := []struct {
		name   string
		req    NamingRequest
		want   []string
		absent []string
	}{
		{"conversation", NamingRequest{Conversation: "User: fix it\n\nAssistant: done"},
			[]string{"currently working on", "most recent turns", "sentence case", "Reply with only the title.", "Recent conversation:\nUser: fix it\n\nAssistant: done"},
			[]string{"Request:", "Branch"}},
		{"the conversation wins over a message", NamingRequest{Message: "first ask", Conversation: "User: now"},
			[]string{"Recent conversation:\nUser: now"}, []string{"first ask"}},
		{"a blank conversation is the first-message prompt", NamingRequest{Message: "fix it", Conversation: " \n"},
			[]string{namingPrompt + "fix it"}, []string{"Recent conversation"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildNamingPrompt(tt.req)
			for _, w := range tt.want {
				if !strings.Contains(got, w) {
					t.Errorf("prompt misses %q:\n%s", w, got)
				}
			}
			for _, w := range tt.absent {
				if strings.Contains(got, w) {
					t.Errorf("prompt has %q:\n%s", w, got)
				}
			}
		})
	}
}

// RegenerateName names from the recent turns, replaces a hand-typed name, marks the call
// explicit, shows Naming while it runs and refuses a second call meanwhile; a failure
// keeps the name.
func TestRegenerateName(t *testing.T) {
	e := newEnv(t)
	var explicit []bool
	e.restart(func(o *Options) {
		inner := o.Namer
		o.Namer = func(ctx context.Context, req NamingRequest) (Naming, error) {
			e.mu.Lock()
			explicit = append(explicit, ExplicitNaming(ctx))
			e.mu.Unlock()
			return inner(ctx, req)
		}
	})
	s := e.connected(CreateOptions{Name: "Mine", InitialPrompt: "fix the login redirect"})
	e.waitItems(s.ID, "a turn", func(items []Item) bool {
		for _, it := range items {
			if it.Kind == KindTurnEnd {
				return true
			}
		}
		return false
	})

	release := make(chan struct{})
	e.mu.Lock()
	e.namer = func(string) (string, error) { <-release; return "Tighten the redirect loop", nil }
	e.mu.Unlock()
	type result struct {
		s   Thread
		err error
	}
	done := make(chan result, 1)
	go func() {
		r, err := e.m.RegenerateName(e.ctx(), s.ID)
		done <- result{r, err}
	}()
	e.waitFor(s.ID, "naming", func(s Thread) bool { return s.Naming })
	if _, err := e.m.RegenerateName(e.ctx(), s.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("second call while one runs: err = %v", err)
	}
	close(release)
	r := <-done
	if r.err != nil || r.s.Name != "Tighten the redirect loop" || !r.s.AutoNamed || r.s.NameProvisional || r.s.Naming {
		t.Fatalf("RegenerateName = %+v, %v", r.s, r.err)
	}
	if rows, _ := loadThreads(context.Background(), e.m.opts.DB); len(rows) != 1 || rows[0].Name != "Tighten the redirect loop" || !rows[0].AutoNamed {
		t.Errorf("rows = %+v", rows)
	}
	e.mu.Lock()
	req := e.namingReqs[len(e.namingReqs)-1]
	calls := append([]bool(nil), explicit...)
	e.mu.Unlock()
	if !strings.HasPrefix(req.Conversation, "User: fix the login redirect\n\nAssistant: ") || req.Message != "" || req.Branch != nil {
		t.Errorf("naming request = %+v", req)
	}
	if len(calls) == 0 || !calls[len(calls)-1] {
		t.Errorf("the call was not marked explicit: %v", calls)
	}

	// A failure keeps the name and clears the flag.
	e.mu.Lock()
	e.namer = func(string) (string, error) { return "", errors.New("model unavailable") }
	e.mu.Unlock()
	if _, err := e.m.RegenerateName(e.ctx(), s.ID); err == nil || !strings.Contains(err.Error(), "model unavailable") {
		t.Errorf("failed call err = %v", err)
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.Name != "Tighten the redirect loop" || got.Naming {
		t.Errorf("after a failure = %+v", got)
	}
}

func TestRegenerateNameRefusals(t *testing.T) {
	e := newEnv(t)
	empty := e.connected(CreateOptions{})
	if _, err := e.m.RegenerateName(e.ctx(), empty.ID); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "nothing to name yet") {
		t.Errorf("no user message: err = %v", err)
	}
	if got, _ := e.m.Get(e.ctx(), empty.ID); got.Naming {
		t.Errorf("refused call left Naming set: %+v", got)
	}
	r, _, err := e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: filepath.Join(e.home, "residents", "ember"), DisplayName: "Ember"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.RegenerateName(e.ctx(), r.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("resident: err = %v", err)
	}
	if _, err := e.m.RegenerateName(e.ctx(), "s-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: err = %v", err)
	}
}
