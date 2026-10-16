package repo

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Operation values on Status.Operation (and GitStatus.operation).
const (
	OpRebase     = "rebase"
	OpAm         = "am"
	OpMerge      = "merge"
	OpCherryPick = "cherry-pick"
	OpRevert     = "revert"
	OpBisect     = "bisect"
)

// operationInfo is the git operation in progress in a worktree, read from marker files
// in its git admin dir. Step and Total are 0 when git does not record them.
type operationInfo struct {
	Op          string
	Step, Total int
}

// operationMarkers are the admin dir entries whose creation or removal starts or ends
// an operation. classify refreshes status when one changes in a watched admin dir.
var operationMarkers = map[string]bool{
	"rebase-merge":     true,
	"rebase-apply":     true,
	"MERGE_HEAD":       true,
	"CHERRY_PICK_HEAD": true,
	"REVERT_HEAD":      true,
	"BISECT_LOG":       true,
}

// readOperation reports the operation in progress in the worktree whose git admin dir
// is adminDir (<main>/.git, or <common>/worktrees/<name> for a linked worktree). It
// only stats and reads files: no git command runs. Precedence follows git's own
// wt-status: a rebase (whose steps may leave MERGE_HEAD or CHERRY_PICK_HEAD behind)
// wins over merge, cherry-pick and revert; bisect, which outlives checkouts, comes
// last. Missing files are the normal case and are not errors.
func readOperation(adminDir string) operationInfo {
	if adminDir == "" {
		return operationInfo{}
	}
	at := func(name ...string) string { return filepath.Join(append([]string{adminDir}, name...)...) }
	switch {
	case isDir(at("rebase-merge")):
		// The merge backend (the default, and every interactive rebase).
		return operationInfo{Op: OpRebase, Step: readInt(at("rebase-merge", "msgnum")), Total: readInt(at("rebase-merge", "end"))}
	case isDir(at("rebase-apply")):
		// The apply backend, shared with `git am`; "applying" marks an am thread.
		op := OpRebase
		if exists(at("rebase-apply", "applying")) {
			op = OpAm
		}
		return operationInfo{Op: op, Step: readInt(at("rebase-apply", "next")), Total: readInt(at("rebase-apply", "last"))}
	case exists(at("MERGE_HEAD")):
		return operationInfo{Op: OpMerge}
	case exists(at("CHERRY_PICK_HEAD")):
		return operationInfo{Op: OpCherryPick}
	case exists(at("REVERT_HEAD")):
		return operationInfo{Op: OpRevert}
	case exists(at("BISECT_LOG")):
		return operationInfo{Op: OpBisect}
	}
	return operationInfo{}
}

// worktreeAdminDir is the git admin dir of the worktree at path: <path>/.git when that
// is a directory (a main worktree), else the dir a .git file points to (a linked
// worktree, or a main worktree with a separate git dir), else "". The reconcile job
// resolves it once per slot (wtSlot.gitDir); the status job only reads it.
func worktreeAdminDir(path string) string {
	dotGit := filepath.Join(path, ".git")
	if isDir(dotGit) {
		return dotGit
	}
	if dir, err := readGitFile(path); err == nil {
		return dir
	}
	return ""
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// readInt is the integer in file p, or 0 when it is missing or not a number.
func readInt(p string) int {
	b, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n < 0 {
		return 0
	}
	return n
}
