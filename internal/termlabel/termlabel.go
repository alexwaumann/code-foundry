// Package termlabel is the label contract on terminals: the names creators put in
// terminal.Spec.Labels (proto Terminal.labels) and what they mean. The terminal store
// itself treats labels as opaque; this package exists so the session store, the
// terminal.* commands, the daemon's shell reaper, and the GUI agree on one set of names.
// It has no dependencies (in particular no cgo), so any package may import it.
//
// Two kinds of terminal carry labels:
//
//   - A Claude session's terminal (session store): Session and Worktree. No Kind.
//   - A shell started by terminal.new: Kind = KindShell, Repo and Worktree for the
//     worktree it belongs to, and Session when it belongs to a thread (Repo and Worktree
//     are then the thread's).
//
// A terminal without labels (TerminalService.Create called directly) belongs to nothing.
package termlabel

const (
	// Kind says what started the terminal. Only KindShell is defined; a session's Claude
	// terminal has no Kind.
	Kind = "kind"
	// Session is the id of the thread (session) the terminal belongs to.
	Session = "session"
	// Repo is the id of the registered repository whose worktree the terminal belongs to.
	Repo = "repo"
	// Worktree is the path (symlinks resolved, as in the repo snapshot) of the worktree
	// the terminal belongs to.
	Worktree = "worktree"
)

// KindShell is Kind's value on a shell started by terminal.new. The daemon removes such a
// terminal as soon as it exits, and kills and removes it when its thread (Session) or its
// worktree (Worktree) is removed.
const KindShell = "shell"

// IsShell reports whether labels mark a shell started by terminal.new.
func IsShell(labels map[string]string) bool { return labels[Kind] == KindShell }

// Shell returns the labels of a shell owned by worktree path of repo repoID, and by
// thread sessionID when it is not empty.
func Shell(sessionID, repoID, worktree string) map[string]string {
	l := map[string]string{Kind: KindShell, Repo: repoID, Worktree: worktree}
	if sessionID != "" {
		l[Session] = sessionID
	}
	return l
}
