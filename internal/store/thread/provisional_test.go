package thread

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// The rules around a provisional name: the namer replaces it, a rename wins over it and
// over a namer that answers later, an explicit name is never provisional, a prompt with
// no text leaves the thread unnamed, the flag survives a restart (and the namer runs
// again), and the first message to a thread created without a prompt names it.
func TestProvisionalNameRules(t *testing.T) {
	type step func(t *testing.T, e *env, release chan struct{}) // release unblocks the namer
	tests := []struct {
		name string
		o    CreateOptions
		// wantName and wantProvisional right after Create.
		wantName        string
		wantProvisional bool
		then            step
	}{
		{name: "the namer replaces it", o: CreateOptions{InitialPrompt: "fix the login redirect. It loops"},
			wantName: "fix the login redirect", wantProvisional: true,
			then: func(t *testing.T, e *env, release chan struct{}) {
				s := firstThread(t, e)
				e.writeTranscript(argOf(e.spec(s.ID).Argv, "--session-id"), userLine("fix the login redirect. It loops"))
				close(release)
				got := e.waitFor(s.ID, "named", func(s Thread) bool { return s.Name == "named-fix" })
				if !got.AutoNamed || got.NameProvisional {
					t.Errorf("after the namer = %+v", got)
				}
				if rows, _ := loadThreads(context.Background(), e.m.opts.DB); len(rows) != 1 || rows[0].NameProvisional || rows[0].Name != "named-fix" {
					t.Errorf("rows = %+v", rows)
				}
			}},
		{name: "a rename before the namer answers wins", o: CreateOptions{InitialPrompt: "add a dark mode"},
			wantName: "add a dark mode", wantProvisional: true,
			then: func(t *testing.T, e *env, release chan struct{}) {
				s := firstThread(t, e)
				e.writeTranscript(argOf(e.spec(s.ID).Argv, "--session-id"), userLine("add a dark mode"))
				waitNamerCalled(t, e)
				r, err := e.m.Rename(e.ctx(), s.ID, "Mine")
				if err != nil || r.Name != "Mine" || r.AutoNamed || r.NameProvisional {
					t.Fatalf("rename = %+v, %v", r, err)
				}
				close(release)
				time.Sleep(100 * time.Millisecond)
				if got, _ := e.m.Get(e.ctx(), s.ID); got.Name != "Mine" || got.AutoNamed || got.NameProvisional {
					t.Errorf("the namer overwrote the rename: %+v", got)
				}
			}},
		{name: "an explicit name is never provisional", o: CreateOptions{Name: "Chosen", InitialPrompt: "do the thing"},
			wantName: "Chosen"},
		{name: "an image-only prompt leaves it unnamed", o: CreateOptions{
			ComposerPrompt: "![shot.png](cf-attachment://a1)", InitialPrompt: "[Image: shot.png]"},
			then: func(t *testing.T, e *env, release chan struct{}) {
				s := firstThread(t, e)
				e.writeTranscript(argOf(e.spec(s.ID).Argv, "--session-id"), userLine("look at this"))
				close(release)
				if got := e.waitFor(s.ID, "named", func(s Thread) bool { return s.Name != "" }); got.Name != "named-look" || got.NameProvisional {
					t.Errorf("after the namer = %+v", got)
				}
			}},
		{name: "a failed namer keeps it, and it survives a restart", o: CreateOptions{InitialPrompt: "bump the go version"},
			wantName: "bump the go version", wantProvisional: true,
			then: func(t *testing.T, e *env, release chan struct{}) {
				s := firstThread(t, e)
				e.mu.Lock()
				e.namer = func(string) (string, error) { return "", errors.New("rate limit") }
				e.mu.Unlock()
				e.writeTranscript(argOf(e.spec(s.ID).Argv, "--session-id"), userLine("bump the go version"))
				close(release)
				waitNamerCalled(t, e)
				time.Sleep(50 * time.Millisecond)
				e.restart()
				got, _ := e.m.Get(e.ctx(), s.ID)
				e.m.mu.Lock()
				tried := e.m.recs[s.ID].namingTried
				e.m.mu.Unlock()
				if got.Name != "bump the go version" || !got.NameProvisional || tried {
					t.Errorf("after restart = %+v, naming tried %v; want the provisional name, the namer still to run", got, tried)
				}
			}},
		{name: "the first message to a thread without a prompt names it", o: CreateOptions{},
			then: func(t *testing.T, e *env, release chan struct{}) {
				s := firstThread(t, e)
				e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected && s.Status != StatusUnknown })
				if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "write the release notes\nfor v2"}); err != nil {
					t.Fatal(err)
				}
				got, _ := e.m.Get(e.ctx(), s.ID)
				if got.Name != "write the release notes" || !got.NameProvisional {
					t.Errorf("after the first message = %+v", got)
				}
				if _, err := e.m.Rename(e.ctx(), s.ID, "Notes"); err != nil {
					t.Fatal(err)
				}
				if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "and more"}); err != nil {
					t.Fatal(err)
				}
				if got, _ := e.m.Get(e.ctx(), s.ID); got.Name != "Notes" || got.NameProvisional {
					t.Errorf("a later message renamed it: %+v", got)
				}
				close(release)
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			release := make(chan struct{})
			e.namer = func(msg string) (string, error) {
				<-release
				return "named-" + strings.Fields(msg)[0], nil
			}
			s := e.create(tt.o)
			if s.Name != tt.wantName || s.NameProvisional != tt.wantProvisional || s.AutoNamed {
				t.Fatalf("created = name %q provisional %v auto %v; want %q, %v, false", s.Name, s.NameProvisional, s.AutoNamed, tt.wantName, tt.wantProvisional)
			}
			if rows, _ := loadThreads(context.Background(), e.m.opts.DB); len(rows) != 1 || rows[0].Name != tt.wantName || rows[0].NameProvisional != tt.wantProvisional {
				t.Errorf("rows = %+v", rows)
			}
			if tt.then != nil {
				tt.then(t, e, release)
			} else {
				close(release)
			}
		})
	}
}

// A fork of a thread with a provisional name keeps it, for good: no namer runs for a fork.
func TestForkOfProvisionalName(t *testing.T) {
	e := newEnv(t)
	e.namer = func(string) (string, error) { return "", errors.New("rate limit") }
	s := e.connected(CreateOptions{InitialPrompt: "add a dark mode"})
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.writeTranscript(cid, userLine("add a dark mode"))
	e.waitFor(s.ID, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid })
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if f.Name != "add a dark mode (fork)" || f.NameProvisional || f.AutoNamed {
		t.Errorf("fork = name %q provisional %v auto %v", f.Name, f.NameProvisional, f.AutoNamed)
	}
}

func firstThread(t *testing.T, e *env) Thread {
	t.Helper()
	threads := e.m.Snapshot().Threads
	if len(threads) != 1 {
		t.Fatalf("%d threads, want 1", len(threads))
	}
	return threads[0]
}

func waitNamerCalled(t *testing.T, e *env) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		e.mu.Lock()
		n := len(e.named)
		e.mu.Unlock()
		if n > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the namer was never called")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestProvisionalName(t *testing.T) {
	long := "Refactor the authentication middleware so that every handler checks the session token"
	tests := []struct {
		name     string
		composer string
		text     string
		want     string
	}{
		{name: "short prompt as is", text: "Fix the login redirect", want: "Fix the login redirect"},
		{name: "empty", text: "  \n\t ", want: ""},
		{name: "whitespace collapses", text: "  Fix   the\tlogin   redirect  ", want: "Fix the login redirect"},
		{name: "first line", text: "Fix the login redirect\nIt loops forever on Safari", want: "Fix the login redirect"},
		{name: "first line with text", text: "\n\n   \nAdd a dark mode\nmore", want: "Add a dark mode"},
		{name: "first sentence", text: "Fix the login redirect. It loops forever on Safari.", want: "Fix the login redirect"},
		{name: "question kept", text: "Why does the build fail? It worked yesterday", want: "Why does the build fail?"},
		{name: "exclamation kept", text: "Ship the release now! Everything is green", want: "Ship the release now!"},
		{name: "trailing period goes", text: "Add a dark mode.", want: "Add a dark mode"},
		{name: "trailing colon goes", text: "Fix these tests:\n- a\n- b", want: "Fix these tests"},
		{name: "abbreviation does not end a sentence", text: "Use a schema library, e.g. zod for the forms. Then test", want: "Use a schema library, e.g. zod for the forms"},
		{name: "a version is a word, its period ends the sentence", text: "Upgrade to v1.2. Then rebuild", want: "Upgrade to v1.2"},
		{name: "one-word sentence does not end it", text: "Hi. Please fix the flaky test", want: "Hi. Please fix the flaky test"},
		{name: "period inside a word", text: "Rename config.yaml to settings.yaml", want: "Rename config.yaml to settings.yaml"},
		{name: "heading marker", text: "## Add usage docs\n\nbody", want: "Add usage docs"},
		{name: "list marker", text: "- fix the login page", want: "fix the login page"},
		{name: "numbered marker", text: "1. Bump the Go version", want: "Bump the Go version"},
		{name: "issue ref kept", text: "#123 is broken again", want: "#123 is broken again"},
		{name: "code fence skipped", text: "```go\nfunc main() {}\n```", want: "func main() {}"},
		{name: "cut at a word boundary", text: long, want: "Refactor the authentication middleware so that…"},
		{name: "long word cut mid-word", text: strings.Repeat("a", 60), want: strings.Repeat("a", 47) + "…"},
		{name: "long second word cuts mid-word", text: "Fix " + strings.Repeat("b", 60), want: "Fix " + strings.Repeat("b", 43) + "…"},
		{name: "url after a short word cuts mid-word", text: "Review https://github.com/alexwaumann/code-foundry/pull/187 and fix CI",
			want: "Review https://github.com/alexwaumann/code-foun…"},
		{name: "boundary at half the room is kept", text: strings.Repeat("abcd ", 4) + "abc " + strings.Repeat("z", 40), want: strings.Repeat("abcd ", 4) + "abc…"},
		{name: "cjk with an early space cuts mid-word", text: "修复 " + strings.Repeat("登录重定向", 10), want: "修复 " + strings.Repeat("登录重定向", 8) + "登录重定…"},
		{name: "combining marks stay with their letter", text: strings.Repeat("e\u0301", 30), want: strings.Repeat("e\u0301", 23) + "…"},
		{name: "skin tone stays with its emoji", text: "Ship " + strings.Repeat("👍🏽", 30), want: "Ship " + strings.Repeat("👍🏽", 21) + "…"},
		{name: "zwj sequence stays whole", text: "Fix " + strings.Repeat("👨\u200d👩\u200d👧", 10), want: "Fix " + strings.Repeat("👨\u200d👩\u200d👧", 8) + "…"},
		{name: "flag pair stays whole", text: "Go to " + strings.Repeat("🇩🇪", 30), want: "Go to " + strings.Repeat("🇩🇪", 20) + "…"},
		{name: "punctuation before the cut goes", text: "Fix the login, the signup, and the reset flows, all of them, today", want: "Fix the login, the signup, and the reset flows…"},
		{name: "exactly the limit is not cut", text: strings.Repeat("abcd ", 9) + "xyz", want: strings.Repeat("abcd ", 9) + "xyz"},
		{name: "unicode counted in runes", text: strings.Repeat("ü", 60), want: strings.Repeat("ü", 47) + "…"},
		{name: "unicode words", text: "Überarbeite die Anmeldung, damit Weiterleitungen nicht mehr endlos laufen", want: "Überarbeite die Anmeldung, damit…"},
		{name: "cjk sentence end", text: "修复登录重定向。然后运行测试", want: "修复登录重定向"},
		{name: "emoji", text: "🚀 Ship it", want: "🚀 Ship it"},
		{name: "control characters go", text: "Fix\x1b[31m the\x07 bug", want: "Fix [31m the bug"},

		{name: "image only", composer: "![shot.png](cf-attachment://a3)", text: "[Image: shot.png; ref=/tmp/a.png]", want: ""},
		{name: "images only", composer: "![a.png](cf-attachment://a1) ![b.pdf](cf-attachment://a2)\n", want: ""},
		{name: "image dropped", composer: "![shot.png](cf-attachment://a3) why is this red?", want: "why is this red?"},
		{name: "image mid-text", composer: "Match ![shot.png](cf-attachment://a3) this design", want: "Match this design"},
		{name: "skill keeps its label", composer: "[/deploy](cf-skill://~/deploy) to staging", want: "/deploy to staging"},
		{name: "project skill", composer: "[/review](cf-skill://p-1/review) PR 12", want: "/review PR 12"},
		{name: "file keeps its label", composer: "Fix [Composer.tsx](cf-file://p-1/src/Composer.tsx) crash", want: "Fix Composer.tsx crash"},
		{name: "directory label", composer: "Explain [api/](cf-file://p-1/internal/api/)", want: "Explain api/"},
		{name: "other cf link", composer: "See [run 4](cf-run://r/4) logs", want: "See run 4 logs"},
		{name: "other cf image link", composer: "![x](cf-thing://y) Look", want: "Look"},
		{name: "plain markdown link kept", composer: "Read [the docs](https://example.com) first", want: "Read [the docs](https://example.com) first"},
		{name: "composer wins over text", composer: "From the composer", text: "From the text", want: "From the composer"},
		{name: "empty composer falls back to text", composer: "  ", text: "From the text", want: "From the text"},

		{name: "projected image dropped", text: "[Image: shot.png; ref=/tmp/x/a.png] why is this red?", want: "why is this red?"},
		{name: "projected pdf dropped", text: "[PDF: spec.pdf; ref=/tmp/x/s.pdf]\nSummarize the spec", want: "Summarize the spec"},
		{name: "projected file ref", text: "Fix @cf-file://p-1/src/components/Composer.tsx crash", want: "Fix Composer.tsx crash"},
		{name: "projected file ref decoded", text: "Read @cf-file://p-1/docs/My%20Notes.md now", want: "Read My Notes.md now"},
		{name: "projected directory ref", text: "Explain @cf-file://p-1/internal/api/", want: "Explain api/"},
		{name: "projected skill", text: "/deploy to staging", want: "/deploy to staging"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := provisionalName(tt.composer, tt.text)
			if got != tt.want {
				t.Errorf("provisionalName(%q, %q) = %q, want %q", tt.composer, tt.text, got, tt.want)
			}
			if n := utf8.RuneCountInString(got); n > maxProvisionalName {
				t.Errorf("%q has %d runes, more than %d", got, n, maxProvisionalName)
			}
			if _, err := cleanName(got, true); err != nil {
				t.Errorf("%q is not a valid name: %v", got, err)
			}
		})
	}
}
