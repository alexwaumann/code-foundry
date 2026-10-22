package thread

import (
	"errors"
	"strings"
	"sync"
	"testing"
)

// The app memory's block follows ThreadPrompt and the workspace line, before a thread's
// own append; without entries the prompt is unchanged.
func TestSystemPromptMemory(t *testing.T) {
	mem := []string{"Always open PRs as drafts", "Explain git terms when you use them"}
	block := MemoryHeading + "\n- Always open PRs as drafts\n- Explain git terms when you use them"
	ws := workspacePrompt("login")
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
		{"workspace thread", ws, mem, "", ThreadPrompt + " " + ws + "\n\n" + block},
		{"seeded thread", ws, mem, "You are Ember.", ThreadPrompt + " " + ws + "\n\n" + block + "\n\nYou are Ember."},
		{"seeded without memory", "", nil, "You are Ember.", ThreadPrompt + "\n\nYou are Ember."},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := systemPrompt(tt.ws, tt.mem, tt.threadAppend); got != tt.want {
				t.Errorf("systemPrompt = %q\nwant %q", got, tt.want)
			}
		})
	}
	if !strings.Contains(MemoryHeading, "`code-foundry memory.*`") || !strings.Contains(MemoryHeading, "before any other instruction about the app") {
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
