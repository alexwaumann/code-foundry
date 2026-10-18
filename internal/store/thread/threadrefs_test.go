package thread

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRewriteThreadRefs(t *testing.T) {
	refs := map[string]threadRef{
		"s-abc":     {name: "Fix resize race", transcript: "/Users/me/.claude/projects/-Users-me-x/1111.jsonl"},
		"s-new":     {name: "Draft notes"},
		"s-renamed": {name: `Now "quoted" [x]` + "\nname"},
		"s-blank":   {name: "  ", transcript: "/t/2.jsonl"},
	}
	lookup := func(id string) (threadRef, bool) {
		r, ok := refs[id]
		return r, ok
	}
	tests := []struct {
		name, prompt, composer, want string
		unknown                      []string
	}{
		{name: "no refs", prompt: "say hi", want: "say hi"},
		{name: "a transcript",
			prompt: `compare with [Thread "Fix resize race" (id s-abc)] please`,
			want:   `compare with [Thread "Fix resize race" (id s-abc); transcript: /Users/me/.claude/projects/-Users-me-x/1111.jsonl] please`},
		{name: "no transcript yet: the CLI verb",
			prompt: `[Thread "Draft notes" (id s-new)]`,
			want:   `[Thread "Draft notes" (id s-new); inspect with: code-foundry thread read s-new]`},
		{name: "the current name wins, cleaned",
			prompt: `[Thread "old name" (id s-renamed)]`,
			want:   `[Thread "Now quoted x name" (id s-renamed); inspect with: code-foundry thread read s-renamed]`},
		{name: "a blank current name keeps the written one",
			prompt: `[Thread "as typed" (id s-blank)]`,
			want:   `[Thread "as typed" (id s-blank); transcript: /t/2.jsonl]`},
		{name: "unknown id",
			prompt:  `see [Thread "Gone" (id s-gone)] and [Thread "Fix resize race" (id s-abc)]`,
			want:    `see [Thread "Gone" (id s-gone); not found] and [Thread "Fix resize race" (id s-abc); transcript: /Users/me/.claude/projects/-Users-me-x/1111.jsonl]`,
			unknown: []string{"s-gone"}},
		{name: "two on separate lines",
			prompt: "[Thread \"a\" (id s-new)]\n[Thread \"b\" (id s-abc)]",
			want:   "[Thread \"Draft notes\" (id s-new); inspect with: code-foundry thread read s-new]\n[Thread \"Fix resize race\" (id s-abc); transcript: /Users/me/.claude/projects/-Users-me-x/1111.jsonl]"},
		{name: "not the shape: left alone",
			prompt: `[Thread "x" (id s-abc); transcript: /a] [Thread x (id s-abc)] [Thread "x" (id s abc)] [thread "x" (id s-abc)]`,
			want:   `[Thread "x" (id s-abc); transcript: /a] [Thread x (id s-abc)] [Thread "x" (id s abc)] [thread "x" (id s-abc)]`},
		{name: "already completed lines pass through again unchanged",
			prompt: `[Thread "Draft notes" (id s-new); inspect with: code-foundry thread read s-new]`,
			want:   `[Thread "Draft notes" (id s-new); inspect with: code-foundry thread read s-new]`},
		{name: "composer text: only its tagged threads; the same shape as text stays",
			prompt:   `see [Thread "Fix resize race" (id s-abc)] vs fixture [Thread "Draft notes" (id s-new)] and [Thread "Gone" (id s-gone)]`,
			composer: `see [Fix resize race](cf-thread://s-abc) vs fixture [Thread "Draft notes" (id s-new)] and [Thread "Gone" (id s-gone)]`,
			want:     `see [Thread "Fix resize race" (id s-abc); transcript: /Users/me/.claude/projects/-Users-me-x/1111.jsonl] vs fixture [Thread "Draft notes" (id s-new)] and [Thread "Gone" (id s-gone)]`},
		{name: "composer text without thread tags: nothing rewritten",
			prompt:   `[Thread "Draft notes" (id s-new)] owner/repo#1`,
			composer: `[Thread "Draft notes" (id s-new)] [#1](cf-pr://owner/repo/1)`,
			want:     `[Thread "Draft notes" (id s-new)] owner/repo#1`},
		{name: "composer text tagging an unknown thread",
			prompt:   `[Thread "Gone" (id s-gone)]`,
			composer: `[Gone](cf-thread://s-gone)`,
			want:     `[Thread "Gone" (id s-gone); not found]`,
			unknown:  []string{"s-gone"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, unknown := rewriteThreadRefs(tt.prompt, tt.composer, lookup)
			if got != tt.want {
				t.Errorf("got  %q\nwant %q", got, tt.want)
			}
			if !slices.Equal(unknown, tt.unknown) {
				t.Errorf("unknown %q, want %q", unknown, tt.unknown)
			}
		})
	}
}

// A message naming other threads reaches Claude with each thread's transcript (or the
// CLI verb when it has none yet); the item keeps the text as sent.
func TestSendRewritesThreadRefs(t *testing.T) {
	e := newEnv(t)
	withTranscript := e.connected(CreateOptions{Name: "Fix resize race"})
	e.resumable(withTranscript.ID)
	cid := e.snapshot(withTranscript.ID).ClaudeSessionID
	fresh := e.create(CreateOptions{Name: "Draft notes"})
	target := e.connected(CreateOptions{Name: "target"})

	text := `look at [Thread "old" (id ` + withTranscript.ID + `)] and [Thread "Draft notes" (id ` + fresh.ID + `)] and [Thread "Gone" (id s-000000000000)]`
	it, err := e.m.Send(e.ctx(), target.ID, Message{Text: text})
	if err != nil {
		t.Fatal(err)
	}
	if it.Text != text {
		t.Errorf("item text %q", it.Text)
	}
	transcript := filepath.Join(e.paths.projectDir(e.wt), cid+".jsonl")
	want := `look at [Thread "Fix resize race" (id ` + withTranscript.ID + `); transcript: ` + transcript + `]` +
		` and [Thread "Draft notes" (id ` + fresh.ID + `); inspect with: code-foundry thread read ` + fresh.ID + `]` +
		` and [Thread "Gone" (id s-000000000000); not found]`
	got := e.waitSent("the rewritten message", func(m map[string]any) bool { return strings.HasPrefix(userTextOf(m), "look at") })
	if userTextOf(got) != want {
		t.Errorf("claude got\n%q\nwant\n%q", userTextOf(got), want)
	}
}

// The first prompt of a new thread is rewritten the same way.
func TestCreateRewritesThreadRefs(t *testing.T) {
	e := newEnv(t)
	other := e.create(CreateOptions{Name: "Other"})
	s := e.create(CreateOptions{InitialPrompt: `read [Thread "Other" (id ` + other.ID + `)]`})
	want := `read [Thread "Other" (id ` + other.ID + `); inspect with: code-foundry thread read ` + other.ID + `]`
	e.waitSent("the first prompt", func(m map[string]any) bool { return userTextOf(m) == want })
	if items := e.items(s.ID).Items; len(items) == 0 || items[0].Text != `read [Thread "Other" (id `+other.ID+`)]` {
		t.Errorf("first item %+v", items)
	}
}

// A message from the GUI composer completes only the threads it tags: the same shape
// typed or pasted as text (here a fixture's id) reaches Claude as written.
func TestComposerMessagesRewriteOnlyTaggedThreads(t *testing.T) {
	e := newEnv(t)
	other := e.create(CreateOptions{Name: "Other"})
	done := `[Thread "Other" (id ` + other.ID + `); inspect with: code-foundry thread read ` + other.ID + `]`
	fixture := `[Thread "x" (id s-000000000000)]`

	e.create(CreateOptions{
		InitialPrompt:  `first [Thread "Other" (id ` + other.ID + `)] ` + fixture,
		ComposerPrompt: `first [Other](cf-thread://` + other.ID + `) ` + fixture,
	})
	if got := e.waitSent("the first prompt", func(m map[string]any) bool { return strings.HasPrefix(userTextOf(m), "first") }); userTextOf(got) != `first `+done+` `+fixture {
		t.Errorf("create: claude got %q", userTextOf(got))
	}

	target := e.connected(CreateOptions{Name: "target"})
	msg := Message{Text: `then [Thread "Other" (id ` + other.ID + `)] ` + fixture, ComposerText: `then [Other](cf-thread://` + other.ID + `) ` + fixture}
	if _, err := e.m.Send(e.ctx(), target.ID, msg); err != nil {
		t.Fatal(err)
	}
	if got := e.waitSent("the message", func(m map[string]any) bool { return strings.HasPrefix(userTextOf(m), "then") }); userTextOf(got) != `then `+done+` `+fixture {
		t.Errorf("send: claude got %q", userTextOf(got))
	}
}
