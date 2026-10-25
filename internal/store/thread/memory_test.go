package thread

import (
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
)

// The app memory's block follows ThreadPrompt and the workspace line, before a thread's
// own append; without entries the prompt is unchanged.
func TestSystemPromptMemory(t *testing.T) {
	mem := []string{"Always open PRs as drafts", "Explain git terms when you use them"}
	block := MemoryHeading + "\n- Always open PRs as drafts\n- Explain git terms when you use them"
	ws := workspaceBlock("login", "Use tabs.")
	for _, tt := range []struct {
		name         string
		ws           string
		mem          []string
		threadAppend string
		want         string
	}{
		{"no memory", "", nil, "", ThreadPrompt},
		{"empty memory", "", []string{}, "", ThreadPrompt},
		{"project thread", "", mem, "", ThreadPrompt + "\n\n" + block},
		{"workspace thread", ws, mem, "", ThreadPrompt + "\n\n" + ws + "\n\n" + block},
		{"seeded thread", ws, mem, "You are Ember.", ThreadPrompt + "\n\n" + ws + "\n\n" + block + "\n\nYou are Ember."},
		{"seeded without memory", "", nil, "You are Ember.", ThreadPrompt + "\n\nYou are Ember."},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := systemPrompt(tt.ws, tt.mem, tt.threadAppend); got != tt.want {
				t.Errorf("systemPrompt = %q\nwant %q", got, tt.want)
			}
		})
	}
	if !strings.Contains(MemoryHeading, "`code-foundry memory show|add|remove`") || !strings.Contains(MemoryHeading, "belongs in your own memory files") || !strings.Contains(MemoryHeading, "give both lists") ||
		strings.Contains(MemoryHeading, "means this list") ||
		strings.Contains(MemoryHeading, "before any other instruction") {
		t.Errorf("MemoryHeading = %q", MemoryHeading)
	}
}

// Every spawn reads the memory again: a restarted thread gets what was added since, and
// a memory that cannot be read starts the thread without it.
func TestSpawnReadsMemory(t *testing.T) {
	var mu sync.Mutex
	entries, readErr := []string{"Always open PRs as drafts"}, error(nil)
	reads := 0
	e := newEnv(t, func(o *Options) {
		o.Memory = func() ([]string, error) {
			mu.Lock()
			defer mu.Unlock()
			reads++
			return entries, readErr
		}
	})
	s := e.connected(CreateOptions{})
	if got, want := argOf(e.spec(s.ID).Argv, "--append-system-prompt"), ThreadPrompt+"\n\n"+MemoryHeading+"\n- Always open PRs as drafts"; got != want {
		t.Errorf("first spawn prompt = %q\nwant %q", got, want)
	}

	mu.Lock()
	entries = append(entries, "Never open the side panel on your own")
	n := reads
	mu.Unlock()
	e.exit(s.ID, 0)
	e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if got := argOf(e.spec(s.ID).Argv, "--append-system-prompt"); !strings.HasSuffix(got, "\n- Always open PRs as drafts\n- Never open the side panel on your own") {
		t.Errorf("restart prompt = %q", got)
	}
	mu.Lock()
	if reads <= n {
		t.Errorf("the restart did not read the memory again (%d reads, %d before)", reads, n)
	}
	readErr = errors.New("permission denied")
	mu.Unlock()

	p := e.connected(CreateOptions{})
	if got := argOf(e.spec(p.ID).Argv, "--append-system-prompt"); got != ThreadPrompt {
		t.Errorf("unreadable memory: prompt = %q", got)
	}
}

func TestMemorySpawned(t *testing.T) {
	a, b := []string{"Use tabs"}, []string{"Use spaces"}
	fresh, resumed, fork := launch{newID: "n"}, launch{resume: "c"}, launch{resume: "c", fork: true, newID: "n"}
	for _, tt := range []struct {
		name string
		l    launch
		had  string
		mem  []string
		ok   bool
		want spawnMemory
	}{
		{"fresh", fresh, memoryHash(b), a, true, spawnMemory{entries: a, fresh: true, hash: memoryHash(a)}},
		{"fresh without memory", fresh, memoryHash(a), nil, true, spawnMemory{fresh: true}},
		{"resumed, unchanged", resumed, memoryHash(a), a, true, spawnMemory{entries: a, hash: memoryHash(a)}},
		{"resumed, changed", resumed, memoryHash(a), b, true,
			spawnMemory{entries: b, hash: memoryHash(b), note: MemoryRefreshHeading + "\n- Use spaces"}},
		{"resumed, emptied", resumed, memoryHash(a), nil, true, spawnMemory{note: MemoryRefreshNone}},
		{"resumed, never had any", resumed, "", a, true,
			spawnMemory{entries: a, hash: memoryHash(a), note: MemoryRefreshHeading + "\n- Use tabs"}},
		{"resumed, unreadable", resumed, memoryHash(a), nil, false, spawnMemory{}},
		{"fork, changed", fork, memoryHash(a), b, true,
			spawnMemory{entries: b, hash: memoryHash(b), note: MemoryRefreshHeading + "\n- Use spaces"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := memorySpawned(tt.l, tt.had, tt.mem, tt.ok)
			if !slices.Equal(got.entries, tt.want.entries) || got.fresh != tt.want.fresh || got.hash != tt.want.hash || got.note != tt.want.note {
				t.Errorf("memorySpawned = %+v, want %+v", got, tt.want)
			}
		})
	}
	if memoryHash([]string{"a", "b"}) == memoryHash([]string{"a b"}) || memoryHash(nil) != "" || memoryHash(a) == memoryHash(b) {
		t.Error("memoryHash does not tell entries apart")
	}
}

// A resumed conversation keeps the system prompt it started with, so a changed memory
// goes with its next message: after a start on send, a restart and a fork. The message
// itself shows as typed; an unchanged or unreadable memory sends nothing.
func TestMemoryRefreshOnResume(t *testing.T) {
	var mu sync.Mutex
	entries, readErr := []string{"Use tabs"}, error(nil)
	e := newEnv(t, func(o *Options) {
		o.Memory = func() ([]string, error) {
			mu.Lock()
			defer mu.Unlock()
			return slices.Clone(entries), readErr
		}
	})
	s := e.connected(CreateOptions{Name: "memory"})
	e.resumable(s.ID)
	if got, _ := e.m.Get(e.ctx(), s.ID); got.MemoryHash != memoryHash([]string{"Use tabs"}) {
		t.Fatalf("a fresh spawn's hash = %q", got.MemoryHash)
	}
	send := func(id, text string) {
		if _, err := e.m.Send(e.ctx(), id, Message{Text: text}); err != nil {
			t.Fatal(err)
		}
	}
	stopThenSend := func(id, text string) {
		if err := e.m.Close(e.ctx(), id); err != nil {
			t.Fatal(err)
		}
		e.waitFor(id, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
		send(id, text)
	}
	restartThenSend := func(id, text string) {
		if _, restarted, err := e.m.Restart(e.ctx(), id); err != nil || !restarted {
			t.Fatalf("restart: %v, %v", restarted, err)
		}
		send(id, text)
	}
	spaces := []string{"Use spaces", "Be brief"}
	hash := memoryHash([]string{"Use tabs"})
	for _, tt := range []struct {
		name string
		mem  []string
		err  error
		how  func(id, text string)
		text string
		note string // what Claude gets before the text, and the item's MemoryNote
	}{
		{"unchanged, started on send", []string{"Use tabs"}, nil, stopThenSend, "one", ""},
		{"changed, started on send", []string{"Use spaces"}, nil, stopThenSend, "two", MemoryRefreshHeading + "\n- Use spaces"},
		{"the next message of that process", []string{"Use spaces"}, nil, send, "three", ""},
		{"changed, restarted", spaces, nil, restartThenSend, "four", MemoryRefreshHeading + "\n- Use spaces\n- Be brief"},
		{"unchanged since the refresh, restarted", spaces, nil, restartThenSend, "five", ""},
		{"cleared, started on send", nil, nil, stopThenSend, "six", MemoryRefreshNone},
		{"unreadable, started on send", []string{"Use tabs"}, errors.New("permission denied"), stopThenSend, "seven", ""},
	} {
		mu.Lock()
		entries, readErr = tt.mem, tt.err
		mu.Unlock()
		tt.how(s.ID, tt.text)
		want := tt.text
		if tt.note != "" {
			want, hash = tt.note+"\n\n"+tt.text, memoryHash(tt.mem)
		}
		e.waitSent(tt.name, func(m map[string]any) bool { return userTextOf(m) == want })
		items := e.waitItems(s.ID, tt.name, func(items []Item) bool { return lastUser(items).Text == tt.text })
		if u := lastUser(items); u.MemoryNote != tt.note {
			t.Errorf("%s: the item's memory note = %q, want %q", tt.name, u.MemoryNote, tt.note)
		}
		e.waitFor(s.ID, tt.name+": the hash", func(s Thread) bool { return s.MemoryHash == hash && turnOver(s) })
	}
	refreshes := slices.DeleteFunc(e.sentTexts(), func(t string) bool { return !strings.HasPrefix(t, "Updated standing preferences") })
	if len(refreshes) != 3 {
		t.Errorf("the refresh went %d times, want 3: %q", len(refreshes), refreshes)
	}

	// A fork resumes the parent's conversation: it starts with the parent's hash, and its
	// first message carries a memory changed since.
	mu.Lock()
	entries, readErr = []string{"Fork rule"}, nil
	mu.Unlock()
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if f.MemoryHash != hash {
		t.Errorf("the fork's hash = %q, want its parent's %q", f.MemoryHash, hash)
	}
	e.waitFor(f.ID, "the fork connected", func(s Thread) bool { return s.State == StateConnected })
	send(f.ID, "forked")
	forkNote := MemoryRefreshHeading + "\n- Fork rule"
	e.waitSent("the fork's message", func(m map[string]any) bool { return userTextOf(m) == forkNote+"\n\nforked" })
	e.waitFor(f.ID, "the fork's hash", func(s Thread) bool { return s.MemoryHash == memoryHash([]string{"Fork rule"}) && turnOver(s) })

	// Persisted: the row's hash and the item's note.
	e.restart()
	if got, _ := e.m.Get(e.ctx(), f.ID); got.MemoryHash != memoryHash([]string{"Fork rule"}) {
		t.Errorf("the fork's hash after a daemon restart = %q", got.MemoryHash)
	}
	if u := lastUser(e.items(f.ID).Items); u.Text != "forked" || u.MemoryNote != forkNote {
		t.Errorf("the fork's item after a daemon restart = %+v", u)
	}
}
