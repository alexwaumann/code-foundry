// Package termlabel is the label contract on terminals: the names creators put in
// terminal.Spec.Labels (proto Terminal.labels) and what they mean. The terminal store
// itself treats labels as opaque; this package exists so the thread store, the
// terminal.* commands, the action store, the daemon's shell reaper, and the GUI agree on
// one set of names. It has no dependencies (in particular no cgo), so any package may
// import it.
//
// Two kinds of terminal carry labels, both shown in the bottom panel of their owner:
//
//   - A shell started by terminal.new has Kind = KindShell, Repo and Worktree for the
//     worktree it belongs to, and Thread when it belongs to a thread (Repo and
//     Worktree are then the thread's: for a thread without a project, Repo is empty
//     and Worktree is its cwd, the home directory).
//   - An action run in a terminal (internal/store/action) has Kind = KindAction, the
//     same owner labels as a shell (Thread, Repo, Worktree), plus Action (the action's
//     id), ActionName (its name when it started) and ActionRun (the run's id).
//
// Claude itself never runs in a terminal. A terminal without labels
// (TerminalService.Create called directly) belongs to nothing.
package termlabel

const (
	// Kind says what started the terminal: KindShell or KindAction.
	Kind = "kind"
	// Thread is the id of the thread the terminal belongs to.
	Thread = "thread"
	// Repo is the id of the registered repository whose worktree the terminal belongs to.
	Project = "repo"
	// Worktree is the path (symlinks resolved, as in the repo snapshot) of the worktree
	// the terminal belongs to.
	Worktree = "worktree"
	// Action is the id of the action a KindAction terminal runs.
	Action = "action"
	// ActionName is the name the action had when the terminal started (a tab title).
	ActionName = "action.name"
	// ActionRun is the id of the run (ActionService's ActionRun) a KindAction terminal
	// belongs to.
	ActionRun = "action.run"
)

// KindShell is Kind's value on a shell started by terminal.new. The daemon removes such a
// terminal as soon as it exits, and kills and removes it when its thread (Thread) or its
// worktree (Worktree) is removed.
const KindShell = "shell"

// KindAction is Kind's value on an action run in a terminal. Unlike a shell it stays
// when it exits (EXITED, so the user can read the output; the GUI closes it), but it is
// killed and removed with its thread, worktree or project exactly like a shell.
const KindAction = "action"

// IsShell reports whether labels mark a shell started by terminal.new.
func IsShell(labels map[string]string) bool { return labels[Kind] == KindShell }

// IsAction reports whether labels mark an action run in a terminal.
func IsAction(labels map[string]string) bool { return labels[Kind] == KindAction }

// IsPanel reports whether labels mark a terminal the bottom panel shows (a shell or an
// action run): one with an owner, closed with terminal.close, and cleaned up when its
// owner goes away.
func IsPanel(labels map[string]string) bool { return IsShell(labels) || IsAction(labels) }

// Shell returns the labels of a shell owned by worktree path of repo repoID, and by
// thread threadID when it is not empty.
func Shell(threadID, projectID, worktree string) map[string]string {
	l := map[string]string{Kind: KindShell, Project: projectID, Worktree: worktree}
	if threadID != "" {
		l[Thread] = threadID
	}
	return l
}

// ActionTerminal returns the labels of run runID of action actionID (named name) in a
// terminal owned like a shell (see Shell).
func ActionTerminal(threadID, projectID, worktree, actionID, name, runID string) map[string]string {
	l := Shell(threadID, projectID, worktree)
	l[Kind] = KindAction
	l[Action] = actionID
	l[ActionName] = name
	l[ActionRun] = runID
	return l
}
