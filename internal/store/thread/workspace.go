package thread

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Workspace references (docs/notes/workspaces-v2-handoff.md §4,
// docs/notes/workspaces-v2-2-workspaces.md).
//
// A thread may reference a workspace (Thread.WorkspaceID), independent of its project
// set. Every spawn of such a thread re-checks the workspace's managed dir (EnsureDirs:
// a rooted workspace's symlinks), gives Claude the managed dir as an --add-dir and
// appends the workspace's instructions (its CLAUDE.md, else AGENTS.md, read through the
// managed dir) under one heading after ThreadPrompt, unless the thread runs in the
// managed dir or the workspace's root, where Claude loads them itself. The thread store
// reads workspaces from the workspace store, never the other way round.

// MaxWorkspaceInstructions caps the workspace instructions a spawn appends; longer
// files are cut there (logged).
const MaxWorkspaceInstructions = 32 << 10

// ThreadPrompt is the paragraph every thread's system prompt gets. It points at the
// skills the daemon ships to every thread (Options.SkillsDir, internal/skills), the
// entry skill first, which says what the app can do and routes to the others: driving
// other threads, answering questions about the app, building plugins
// (docs/notes/agent-skills.md, control-4-capabilities.md). Then the routing a thread
// needs when no skill fires, as on ordinary task-shaped prompts: where preferences
// (the app memory, a workspace's folder, Claude's own memory files:
// docs/notes/workspaces-v2-5-skills.md), cost, showing things, pull requests and slash
// commands go in this app
// (docs/notes/control-7-skill-routing.md), how to write a path so its chip opens the
// file (absolute or against the cwd, which the chip resolves against:
// docs/notes/model-paths.md), and where thread new puts a thread, stated without a
// recommendation: the model's call (docs/notes/thread-new-base-origin.md). Its last
// sentence holds the orchestration rule (docs/notes/orch-skill-v2.md). Static: it
// never varies per spawn. Every request of every thread carries it: keep it short.
const ThreadPrompt = "This thread runs inside code-foundry. Its skill code-foundry says what the app can do and which of its other skills to read (code-foundry-help for app questions, code-foundry-orchestrate to delegate work to other threads, code-foundry-plugin to build plugins). " +
	"Here: how you should act in every project (always, never, keep answers short) goes to code-foundry memory add <their words> at once, without asking; a rule or skill for a workspace's projects: the folder code-foundry thread checkouts prints (CLAUDE.md, .claude/skills), not a repo; what you learn about the user, a project or its code goes in your memory files; asked what you remember, give both; " +
	"cost: code-foundry usage.show; " +
	"to show: code-foundry view.panel.file, diff, pr, usage or worktree (your own thread's panel; --focus only if asked); " +
	"a path in your reply is a clickable chip: write it in full, absolute or relative to your primary working directory (not a folder you cd into), with :line for a line; a page, chart or form to fill in is an .html file shown with view.inline <file>, not markdown; " +
	"PRs: code-foundry pr.create (project.github.publish off GitHub); " +
	"thread new: the project checkout or --new-worktree (--base, --base-from-origin yes|no), your call; " +
	"never suggest /model or /cost; " +
	"page verbs (view.*) move every window: prefer panel verbs; " +
	"say what you'll do, not command or skill names. " +
	"Work split up, run in parallel or landed on several branches goes through code-foundry-orchestrate, never hand-made worktrees or branches, nor the Agent tool (read-only research)."

// systemPrompt is --append-system-prompt: ThreadPrompt, then a referenced workspace's
// instructions (workspaceBlock) when there are any, then the app memory's entries
// (memoryPrompt) when there are any, then the thread's own append.
func systemPrompt(workspaceInstructions string, memory []string, threadAppend string) string {
	p := ThreadPrompt
	if workspaceInstructions != "" {
		p += "\n\n" + workspaceInstructions
	}
	if mp := memoryPrompt(memory); mp != "" {
		p += "\n\n" + mp
	}
	if threadAppend != "" {
		// The thread's own (Thread.SystemPromptAppend: a reseed's or a resident's).
		p += "\n\n" + threadAppend
	}
	return p
}

// WorkspaceSource is the part of the workspace store threads need: the workspace a
// thread references, and its managed dir made and its links re-checked at every spawn.
// *workspace.Manager implements it.
type WorkspaceSource interface {
	Snapshot() *workspace.Snapshot
	EnsureDirs(ctx context.Context, id string) error
}

// wsSpawn is what a referenced workspace adds to a spawn.
type wsSpawn struct {
	// addDir is the managed dir; "" when the thread runs there or in the root.
	addDir string
	// prompt is the instructions block; "" when there are none or the thread runs there.
	prompt string
}

// workspaceSpawn is what s's workspace reference adds to its spawn now. A workspace
// that is gone adds nothing (logged).
func (m *Manager) workspaceSpawn(ctx context.Context, s Thread) wsSpawn {
	if s.WorkspaceID == "" || m.opts.Workspaces == nil {
		return wsSpawn{}
	}
	w, ok := m.opts.Workspaces.Snapshot().Workspace(s.WorkspaceID)
	if !ok {
		m.log.Warn("workspace of thread not found; starting without it", "thread", s.ID, "workspace", s.WorkspaceID)
		return wsSpawn{}
	}
	if err := m.opts.Workspaces.EnsureDirs(ctx, w.ID); err != nil {
		m.log.Warn("workspace managed dir", "thread", s.ID, "workspace", w.ID, "err", err)
	}
	if samePath(s.WorktreePath, w.ManagedDir) || (w.RootPath != "" && samePath(s.WorktreePath, w.RootPath)) {
		return wsSpawn{} // Claude loads the files from its cwd itself
	}
	out := wsSpawn{}
	if isDir(w.ManagedDir) {
		out.addDir = w.ManagedDir
	}
	text, path, err := readInstructions(w.ManagedDir)
	switch {
	case err != nil:
		m.log.Warn("workspace instructions not read", "thread", s.ID, "workspace", w.ID, "err", err)
	case text != "":
		if len(text) > MaxWorkspaceInstructions {
			m.log.Warn("workspace instructions cut", "thread", s.ID, "workspace", w.ID, "path", path,
				"bytes", len(text), "limit", MaxWorkspaceInstructions)
			text = cutUTF8(text, MaxWorkspaceInstructions)
		}
		out.prompt = workspaceBlock(w.Name, text)
	}
	return out
}

// workspaceBlock is the instructions block of workspace name.
func workspaceBlock(name, text string) string {
	return "Workspace " + name + " instructions\n\n" + strings.TrimSpace(text)
}

// readInstructions reads dir/CLAUDE.md, else dir/AGENTS.md (through the symlinks of a
// rooted workspace); "" when neither exists.
func readInstructions(dir string) (text, path string, err error) {
	if dir == "" {
		return "", "", nil
	}
	for _, name := range []string{"CLAUDE.md", "AGENTS.md"} {
		p := filepath.Join(dir, name)
		b, err := os.ReadFile(p)
		switch {
		case err == nil:
			return string(b), p, nil
		case errors.Is(err, os.ErrNotExist):
			continue
		default:
			return "", p, fmt.Errorf("read %s: %w", p, err)
		}
	}
	return "", "", nil
}

// cutUTF8 is s cut to at most n bytes on a rune boundary.
func cutUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// workspaceDir is where a thread whose primary is workspace ref runs (Workspace.Dir).
func (m *Manager) workspaceDir(ref string) (workspace.Workspace, error) {
	if m.opts.Workspaces == nil {
		return workspace.Workspace{}, fmt.Errorf("%w: workspace threads need the workspace store", ErrFailedPrecondition)
	}
	w, err := workspace.ResolveWorkspace(m.opts.Workspaces.Snapshot(), ref)
	if err != nil {
		return workspace.Workspace{}, workspaceError("workspace", err)
	}
	if err := m.opts.Workspaces.EnsureDirs(context.Background(), w.ID); err != nil {
		m.log.Warn("workspace managed dir", "workspace", w.ID, "err", err)
	}
	if !isDir(w.Dir()) {
		return workspace.Workspace{}, fmt.Errorf("%w: workspace %s has no folder at %s", ErrFailedPrecondition, w.Name, w.Dir())
	}
	return w, nil
}

// isDir reports whether path is an existing directory.
func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// samePath compares two absolute paths cleaned and with symlinks resolved.
func samePath(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b) || realPath(a) == realPath(b)
}

// workspaceError wraps a workspace store error in the thread error class with the
// same meaning, so API codes survive.
func workspaceError(what string, err error) error {
	var kind error
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s: %w", what, err)
	case errors.Is(err, workspace.ErrNotFound):
		kind = ErrNotFound
	case errors.Is(err, workspace.ErrInvalidArgument):
		kind = ErrInvalidArgument
	default:
		kind = ErrFailedPrecondition
	}
	return classified{kind: kind, err: fmt.Errorf("%s: %w", what, err)}
}
