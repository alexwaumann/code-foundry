package thread

import (
	"strings"
	"testing"
)

// Every thread's system prompt points at the skills the daemon ships and routes
// parallel work to the orchestrate skill even when it does not fire; a workspace
// thread's adds its line. Static: claude caches the system prompt, so nothing per spawn
// may be in it.
func TestSystemPrompt(t *testing.T) {
	if got := systemPrompt("", nil, ""); got != ThreadPrompt {
		t.Errorf("project thread: %q", got)
	}
	// The entry skill comes first (control-4-capabilities).
	if !strings.HasPrefix(ThreadPrompt, "This thread runs inside code-foundry. Its skill code-foundry says what the app can do and which of its other skills to read (") {
		t.Errorf("ThreadPrompt does not name the entry skill first: %q", ThreadPrompt)
	}
	for _, want := range []string{"code-foundry-orchestrate", "code-foundry-help", "code-foundry-plugin", "delegate work to other threads", "build plugins",
		"split up, run in parallel or landed on several branches", "never the Agent tool", "hand-made worktrees", "read-only research"} {
		if !strings.Contains(ThreadPrompt, want) {
			t.Errorf("ThreadPrompt does not name %q: %q", want, ThreadPrompt)
		}
	}
	// The routing that holds when no skill fires (control-7-skill-routing): preferences,
	// cost, showing things in the thread's own panel, path chips and HTML, pull
	// requests, the In place default, replaced slash commands, page verbs, no command
	// names to the user.
	for _, want := range []string{"from now on (always, never, keep answers short), save it at once with code-foundry memory add <their words>, not your own memory files",
		"code-foundry usage.show", "view.panel.file, diff, pr, usage or worktree (your own thread's panel; --focus only if asked)",
		"clickable chip", ".html file renders interactively", "code-foundry pr.create (project.github.publish", "threads work In place",
		"/model or /cost", "page verbs (view.*) move every window: prefer panel verbs", "not command or skill names"} {
		if !strings.Contains(ThreadPrompt, want) {
			t.Errorf("ThreadPrompt does not route %q: %q", want, ThreadPrompt)
		}
	}
	// It is paid on every request of every thread (about 260 tokens over the
	// orchestration-only line, measured with claude -p): grow it only by cutting.
	if n := len(ThreadPrompt); n > 1400 {
		t.Errorf("ThreadPrompt has %d bytes; keep it under 1400", n)
	}
	ws := workspacePrompt("login")
	if got := systemPrompt(ws, nil, ""); got != ThreadPrompt+" "+ws {
		t.Errorf("workspace thread: %q", got)
	}
	// A reseed's (or a resident's) append comes last, after a blank line.
	if got := systemPrompt(ws, nil, "You are Ember."); got != ThreadPrompt+" "+ws+"\n\nYou are Ember." {
		t.Errorf("seeded thread: %q", got)
	}
	if strings.ContainsAny(ThreadPrompt, "\n$`") {
		t.Errorf("ThreadPrompt is one static line: %q", ThreadPrompt)
	}
}
