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
		"split up, run in parallel or landed on several branches", "nor the Agent tool (read-only research)", "never hand-made worktrees"} {
		if !strings.Contains(ThreadPrompt, want) {
			t.Errorf("ThreadPrompt does not name %q: %q", want, ThreadPrompt)
		}
	}
	// The routing that holds when no skill fires (control-7-skill-routing): preferences,
	// cost, showing things in the thread's own panel, path chips (how to write a path:
	// model-paths) and HTML, pull requests, where thread new puts a thread (the model's
	// call, no recommendation: thread-new-base-origin), replaced slash commands, page
	// verbs, no command names to the user.
	//
	// The scope rule (control-8-memory-scope), with the workspace's folder between the app
	// memory and Claude's own: without it a "remember for this workspace" went to memory add,
	// then to the primary repo's CLAUDE.md (workspaces-v2-5-skills).
	for _, want := range []string{"how you should act in every project (always, never, keep answers short) goes to code-foundry memory add <their words> at once, without asking; " +
		"a rule or skill for a workspace's projects: the folder code-foundry thread checkouts prints (CLAUDE.md, .claude/skills), not a repo; " +
		"what you learn about the user, a project or its code goes in your memory files; asked what you remember, give both",
		"code-foundry usage.show", "view.open.file, diff or pr (a tab beside you; --focus only if asked)", "secrets: view.open.file --edit --note, not chat",
		"a path in your reply is a clickable chip: write it in full, absolute or relative to your primary working directory (not a folder you cd into), with :line for a line", "a page, mockup, chart or form to fill in is an .html file in $CODE_FOUNDRY_PAGES, not the repo unless asked (skill code-foundry-pages first), shown with view.inline <file>, not markdown", "code-foundry pr.create (project.github.publish",
		"thread new: the project checkout or --new-worktree (--base, --base-from-origin yes|no), your call",
		"/model or /cost", "page verbs (view.*) move every window: prefer view.open", "not command or skill names"} {
		if !strings.Contains(ThreadPrompt, want) {
			t.Errorf("ThreadPrompt does not route %q: %q", want, ThreadPrompt)
		}
	}
	// Its size budget, 1,641 bytes, is in the skills' table (internal/skills/budget_test.go).
	for _, sway := range []string{"In place", "Fresh copy", "prefer", "unless the user"} {
		if strings.Contains(placementClause(t), sway) {
			t.Errorf("the thread new clause recommends a placement (%q): %q", sway, placementClause(t))
		}
	}
	ws := workspaceBlock("login", "Use tabs.")
	if got := systemPrompt(ws, nil, ""); got != ThreadPrompt+"\n\n"+ws {
		t.Errorf("workspace thread: %q", got)
	}
	// A reseed's (or a resident's) append comes last, after a blank line.
	if got := systemPrompt(ws, nil, "You are Ember."); got != ThreadPrompt+"\n\n"+ws+"\n\nYou are Ember." {
		t.Errorf("seeded thread: %q", got)
	}
	// The one $ is the pages folder's variable, which the model expands in its shell.
	if strings.ContainsAny(strings.ReplaceAll(ThreadPrompt, "$CODE_FOUNDRY_PAGES", ""), "\n$`") {
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
