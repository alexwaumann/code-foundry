package thread

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestThreadNamingContext(t *testing.T) {
	user := func(s string) Item { return Item{Kind: KindUserMessage, Text: s} }
	asst := func(s string) Item { return Item{Kind: KindAssistantText, Text: s} }
	turns := func(from, to int) []Item {
		var items []Item
		for i := from; i <= to; i++ {
			items = append(items, user(fmt.Sprintf("u%d", i)), asst(fmt.Sprintf("r%d", i)))
		}
		return items
	}
	longReply := "Done. " + strings.Repeat("Here is what changed. ", 200) + "All tests pass."
	tests := []struct {
		name        string
		cur         string
		provisional bool
		items       []Item
		want        string
	}{
		{"nothing", "", false, nil, ""},
		{"no user message, even with a name", "Fix it", false, []Item{asst("hello"), {Kind: KindNote, Text: "Forked from x"}}, ""},
		{"only a wake", "", false, []Item{{Kind: KindUserMessage, Text: "PR merged", WakeTitle: "PR merged"}, asst("ok")}, ""},
		{"one turn", "", false, []Item{user("fix the login"), asst("Looking."), asst("Fixed it.")},
			"User: fix the login\n\nAssistant: Looking.\n\nFixed it."},
		{"the current name line", "Fix the login redirect", false, []Item{user("fix the login"), asst("ok")},
			"Current name: Fix the login redirect\n\nUser: fix the login\n\nAssistant: ok"},
		{"no line for a provisional name", "fix the login", true, []Item{user("fix the login")}, "User: fix the login"},
		{"no line for a blank name", "  ", false, []Item{user("fix the login")}, "User: fix the login"},
		{"the first message is there once when it is a recent one", "", false, turns(1, recentTurns),
			"User: u1\n\nAssistant: r1\n\nUser: u2\n\nAssistant: r2\n\nUser: u3\n\nAssistant: r3\n\n" +
				"User: u4\n\nAssistant: r4\n\nUser: u5\n\nAssistant: r5\n\nUser: u6\n\nAssistant: r6"},
		{"the first message right before the recent turns", "", false, turns(1, recentTurns+1),
			"User: u1\n\nUser: u2\n\nAssistant: r2\n\nUser: u3\n\nAssistant: r3\n\nUser: u4\n\nAssistant: r4\n\n" +
				"User: u5\n\nAssistant: r5\n\nUser: u6\n\nAssistant: r6\n\nUser: u7\n\nAssistant: r7"},
		{"the first message, the gap, then the recent turns", "Add dark mode", false, turns(1, 10),
			"Current name: Add dark mode\n\nUser: u1\n\n(3 user messages left out)\n\n" +
				"User: u5\n\nAssistant: r5\n\nUser: u6\n\nAssistant: r6\n\nUser: u7\n\nAssistant: r7\n\n" +
				"User: u8\n\nAssistant: r8\n\nUser: u9\n\nAssistant: r9\n\nUser: u10\n\nAssistant: r10"},
		// The reported case: a long last reply after a small follow-up crowded out
		// everything but its own tail.
		{"a long last reply after a small follow-up keeps the task", "Add a release channel switcher", false, []Item{
			user("add a release channel switcher to the settings page"), asst("I'll add it."),
			user("also persist the choice"), asst("Persisted."),
			user("thanks, also fix the typo"), asst(longReply),
		}, "Current name: Add a release channel switcher\n\n" +
			"User: add a release channel switcher to the settings page\n\nAssistant: I'll add it.\n\n" +
			"User: also persist the choice\n\nAssistant: Persisted.\n\n" +
			"User: thanks, also fix the typo\n\nAssistant: " + clip(longReply, maxAssistantBlock)},
		{"other kinds, wakes, subagents and API errors are left out", "", false, []Item{
			user("go"),
			{Kind: KindThinking, Text: "hmm"},
			{Kind: KindToolCall, Text: "ls"},
			{Kind: KindAssistantText, Text: "subagent says", ParentToolUseID: "t1"},
			{Kind: KindUserMessage, Text: "subagent prompt", ParentToolUseID: "t1"},
			{Kind: KindAssistantText, Text: "Invalid API key", APIError: true},
			{Kind: KindCommandOutput, Text: "Compacted"},
			{Kind: KindCompaction, Text: "summary"},
			{Kind: KindNote, Text: "note"},
			asst("done"),
			{Kind: KindUserMessage, Text: "timer fired", WakeTitle: "timer"},
			asst("woke up"),
		}, "User: go\n\nAssistant: done\n\nwoke up"},
		{"a reply before any user message is left out", "", false, []Item{asst("parent reply"), user("next"), asst("ok")},
			"User: next\n\nAssistant: ok"},
		{"blank text is skipped", "", false, []Item{user("  "), user("real"), asst(" ")}, "User: real"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := threadNamingContext(tt.cur, tt.provisional, tt.items)
			if got != tt.want {
				t.Errorf("threadNamingContext =\n%q\nwant\n%q", got, tt.want)
			}
		})
	}
}

// Each block is cut on its own: the first message, a later user message and an
// assistant block each to their cap, head and end kept.
func TestThreadNamingContextPerBlockCaps(t *testing.T) {
	body := func(tag string) string { return tag + "-start " + strings.Repeat("x", 3000) + " " + tag + "-end" }
	items := []Item{
		{Kind: KindUserMessage, Text: body("first")},
		{Kind: KindAssistantText, Text: body("reply0")},
	}
	for i := 1; i <= recentTurns; i++ {
		items = append(items,
			Item{Kind: KindUserMessage, Text: body(fmt.Sprintf("user%d", i))},
			Item{Kind: KindAssistantText, Text: body(fmt.Sprintf("part%da", i))},
			Item{Kind: KindAssistantText, Text: body(fmt.Sprintf("part%db", i))})
	}
	blocks := strings.Split(threadNamingContext("", false, items), "\n\n")
	// The first message, then the recent turns (no gap line: none is left out between).
	if len(blocks) != 1+2*recentTurns {
		t.Fatalf("%d blocks, want %d: %q", len(blocks), 1+2*recentTurns, blocks)
	}
	check := func(b, label string, max int, start, end string) {
		t.Helper()
		text, ok := strings.CutPrefix(b, label+": ")
		if !ok || len(text) > max || !strings.HasPrefix(text, start) || !strings.HasSuffix(text, end) || !strings.Contains(text, "…") {
			t.Errorf("block %.40q… (len %d): want %s, at most %d bytes, %q…%q", b, len(text), label, max, start, end)
		}
	}
	check(blocks[0], "User", maxFirstMessage, "first-start", "first-end")
	for i := 1; i <= recentTurns; i++ {
		check(blocks[2*i-1], "User", maxUserBlock, fmt.Sprintf("user%d-start", i), fmt.Sprintf("user%d-end", i))
		// An assistant's blocks in a row are one block, cut as one.
		check(blocks[2*i], "Assistant", maxAssistantBlock, fmt.Sprintf("part%da-start", i), fmt.Sprintf("part%db-end", i))
	}
}

// No context is over maxNamingContext: every block at its cap, a long name, a big gap.
func TestThreadNamingContextBound(t *testing.T) {
	long := strings.Repeat("é", 5000)
	var items []Item
	for i := 0; i < 1000; i++ {
		items = append(items, Item{Kind: KindUserMessage, Text: long}, Item{Kind: KindAssistantText, Text: long})
	}
	got := threadNamingContext(strings.Repeat("n", 500), false, items)
	if len(got) > maxNamingContext {
		t.Errorf("len = %d, over %d", len(got), maxNamingContext)
	}
	if !strings.Contains(got, "(993 user messages left out)") {
		t.Errorf("no gap line in %.200q", got)
	}
}

func TestClip(t *testing.T) {
	tests := []struct {
		name string
		s    string
		n    int
		want string
	}{
		{"fits", "short", 5, "short"},
		{"head and end", "abcdefghijklmnopqrstuvwxyz", 13, "abcdef…wxyz"},
		{"spaces at the cut go", "one two three four five six seven", 16, "one two…seven"},
		// "é" is two bytes: neither side starts or ends inside one.
		{"rune boundaries", strings.Repeat("é", 20), 11, "éé…éé"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := clip(tt.s, tt.n)
			if got != tt.want || len(got) > tt.n || !utf8.ValidString(got) {
				t.Errorf("clip(%q, %d) = %q (len %d), want %q", tt.s, tt.n, got, len(got), tt.want)
			}
		})
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
			[]string{"overall task", "small follow-ups", "keep its subject", "sentence case", "Reply with only the title.", "Thread:\nUser: fix it\n\nAssistant: done"},
			[]string{"Request:", "Branch"}},
		{"the conversation wins over a message", NamingRequest{Message: "first ask", Conversation: "User: now"},
			[]string{"Thread:\nUser: now"}, []string{"first ask"}},
		{"a blank conversation is the first-message prompt", NamingRequest{Message: "fix it", Conversation: " \n"},
			[]string{namingPrompt + "fix it"}, []string{"Thread:"}},
		// A move into a new worktree (move.go): the title and the branch from the conversation.
		{"conversation and a semantic branch", NamingRequest{Conversation: "User: fix it", Branch: &BranchRequest{Mode: BranchModeSemantic}},
			[]string{"overall task", "small follow-ups", "twice: a title and a git branch", "Branch: <type>/<slug>", "Title: <title>\nBranch: <branch>", "Thread:\nUser: fix it"},
			[]string{"Request:", "Reply with only the title."}},
		{"conversation and a prefix branch", NamingRequest{Conversation: "User: fix it", Branch: &BranchRequest{Mode: BranchModePrefix}},
			[]string{"Branch: a slug of", "Thread:\nUser: fix it"}, []string{"Request:"}},
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

// RegenerateName names from the thread (current name, first message, latest turns), replaces a hand-typed name, marks the call
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
	if !strings.HasPrefix(req.Conversation, "Current name: Mine\n\nUser: fix the login redirect\n\nAssistant: ") || req.Message != "" || req.Branch != nil {
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
