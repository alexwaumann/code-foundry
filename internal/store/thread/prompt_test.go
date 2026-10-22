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
	// requests, where thread new puts a thread (the model's call, no recommendation:
	// thread-new-base-origin), replaced slash commands, page verbs, no command names
	// to the user.
	for _, want := range []string{"how you should act in every project (always, never, keep answers short) goes to code-foundry memory add <their words> at once, without asking; what you learn about the user, a project or its code goes in your memory files; asked what you remember, give both",
		"code-foundry usage.show", "view.panel.file, diff, pr, usage or worktree (your own thread's panel; --focus only if asked)",
		"clickable chip", "show .html pages: view.inline <file>", "code-foundry pr.create (project.github.publish",
		"thread new: the project checkout or --new-worktree (--base, --base-from-origin yes|no), your call",
		"/model or /cost", "page verbs (view.*) move every window: prefer panel verbs", "not command or skill names"} {
		if !strings.Contains(ThreadPrompt, want) {
			t.Errorf("ThreadPrompt does not route %q: %q", want, ThreadPrompt)
		}
	}
	// It is paid on every request of every thread (about 260 tokens over the
	// orchestration-only line, measured with claude -p; the thread new clause added 12
	// more, thread-new-base-origin): grow it only by cutting.
	if n := len(ThreadPrompt); n > 1430 {
		t.Errorf("ThreadPrompt has %d bytes; keep it under 1430", n)
	}
	for _, sway := range []string{"In place", "Fresh copy", "prefer", "unless the user"} {
		if strings.Contains(placementClause(t), sway) {
			t.Errorf("the thread new clause recommends a placement (%q): %q", sway, placementClause(t))
		}
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

// placementClause is ThreadPrompt's clause on where thread new puts a thread.
func placementClause(t *testing.T) string {
	t.Helper()
	for _, c := range strings.Split(ThreadPrompt, "; ") {
		if strings.HasPrefix(c, "thread new:") {
			return c
		}
	}
	t.Fatalf("ThreadPrompt has no thread new clause: %q", ThreadPrompt)
	return ""
}
