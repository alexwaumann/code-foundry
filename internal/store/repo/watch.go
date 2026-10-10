package repo

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/fsnotify/fsnotify"
)

// watchKind says what a watched directory is. Watches are non-recursive: fsnotify on
// macOS uses kqueue, which reports changes to a directory's entries and to the files
// directly inside it, but not to anything deeper.
type watchKind uint8

const (
	wkCommon       watchKind = iota + 1 // <common>            (= <main>/.git)
	wkCommonLogs                        // <common>/logs       (main worktree reflog)
	wkRemoteRefs                        // <common>/refs/remotes/origin
	wkWorktreesDir                      // <common>/worktrees  (one entry per linked worktree)
	wkLinkedAdmin                       // <common>/worktrees/<name>
	wkLinkedLogs                        // <common>/worktrees/<name>/logs
	wkRoot                              // a worktree's root directory
)

func (k watchKind) String() string {
	switch k {
	case wkCommon:
		return "common"
	case wkCommonLogs:
		return "common-logs"
	case wkRemoteRefs:
		return "remote-refs"
	case wkWorktreesDir:
		return "worktrees-dir"
	case wkLinkedAdmin:
		return "linked-admin"
	case wkLinkedLogs:
		return "linked-logs"
	case wkRoot:
		return "root"
	}
	return fmt.Sprintf("watchKind(%d)", k)
}

// watchTarget is what a watched directory belongs to.
type watchTarget struct {
	kind   watchKind
	repoID string
	// wtPath is the worktree whose status the directory affects (empty for
	// repo-wide kinds).
	wtPath string
}

// action is what an fs event asks for.
type action uint8

const (
	actNone      action = iota
	actStatus           // refresh the target's worktree
	actStatusAll        // re-resolve the repo's base (jobBase), then refresh every worktree
	actReconcile        // re-list worktrees and repo metadata, then refresh all
)

func (a action) String() string {
	return [...]string{"none", "status", "status-all", "reconcile"}[a]
}

// classify maps an event on entry name inside a watched directory of kind to an
// action. It is the single source of truth for what triggers a refresh; the table in
// docs/notes/phase1b-repo.md mirrors it.
func classify(kind watchKind, name string, op fsnotify.Op) action {
	// <common>/config.lock appearing means config is about to be rewritten (remote
	// add/remove, url change). kqueue has been seen to drop the rename of config.lock
	// onto config (a remote removal went unnoticed on a slow CI runner), so the lock
	// itself triggers a reconcile too: its debounce window outlasts the rewrite, and
	// the rename's own event, when it does arrive, is absorbed or re-runs the job.
	if kind == wkCommon && name == "config.lock" && op.Has(fsnotify.Create) {
		return actReconcile
	}
	// Other lock files come and go during every git operation; the rename onto the
	// real name that follows is the event that matters.
	if strings.HasSuffix(name, ".lock") {
		return actNone
	}
	// Attribute-only changes cannot change status. They are also self-inflicted: kqueue
	// reports NOTE_ATTRIB (Chmod) when git merely reads .git/index, so reacting to them
	// makes every status refresh trigger the next one.
	if op == fsnotify.Chmod {
		return actNone
	}
	switch kind {
	case wkCommon:
		switch name {
		case "HEAD", "index":
			return actStatus // main worktree: checkout, staging, commit
		case "FETCH_HEAD", "packed-refs", "config", "worktrees":
			// fetch, gc/pack-refs, remote url change, first/last linked worktree
			return actReconcile
		}
	case wkCommonLogs, wkLinkedLogs:
		if name == "HEAD" {
			return actStatus // reflog append: every commit, reset, rebase, merge, pull
		}
	case wkLinkedAdmin:
		switch name {
		case "HEAD", "index":
			return actStatus
		}
	case wkRemoteRefs:
		return actStatusAll // push/fetch moved a remote-tracking ref: ahead/behind
	case wkWorktreesDir:
		if op.Has(fsnotify.Create) || op.Has(fsnotify.Remove) || op.Has(fsnotify.Rename) {
			return actReconcile // `git worktree add/remove/prune` run anywhere
		}
	case wkRoot:
		if name == ".git" {
			return actNone
		}
		return actStatus // top-level file created, removed, renamed, or written
	}
	return actNone
}

// watchWorktree is the input to desiredWatches for one worktree.
type watchWorktree struct {
	path   string
	isMain bool
	admin  string // linked worktree admin dir (<common>/worktrees/<name>); unused for main
}

// desiredWatches returns every directory to watch for a repo, keyed by path.
// Directories that do not exist are filtered out by the caller when adding.
func desiredWatches(repoID, mainPath, commonDir string, wts []watchWorktree) map[string]watchTarget {
	out := map[string]watchTarget{
		commonDir:                        {kind: wkCommon, repoID: repoID, wtPath: mainPath},
		filepath.Join(commonDir, "logs"): {kind: wkCommonLogs, repoID: repoID, wtPath: mainPath},
		filepath.Join(commonDir, "refs", "remotes", "origin"): {kind: wkRemoteRefs, repoID: repoID},
		filepath.Join(commonDir, "worktrees"):                 {kind: wkWorktreesDir, repoID: repoID},
	}
	for _, w := range wts {
		out[w.path] = watchTarget{kind: wkRoot, repoID: repoID, wtPath: w.path}
		if w.isMain || w.admin == "" {
			continue
		}
		out[w.admin] = watchTarget{kind: wkLinkedAdmin, repoID: repoID, wtPath: w.path}
		out[filepath.Join(w.admin, "logs")] = watchTarget{kind: wkLinkedLogs, repoID: repoID, wtPath: w.path}
	}
	return out
}

// readGitFile returns the admin dir a linked worktree's .git file points to
// ("gitdir: /repo/.git/worktrees/name"), resolved against the worktree.
func readGitFile(worktree string) (string, error) {
	b, err := os.ReadFile(filepath.Join(worktree, ".git"))
	if err != nil {
		return "", fmt.Errorf("read .git file: %w", err)
	}
	return parseGitFile(worktree, string(b))
}

func parseGitFile(worktree, content string) (string, error) {
	dir, ok := strings.CutPrefix(strings.TrimSpace(content), "gitdir:")
	if !ok {
		return "", fmt.Errorf("parse .git file in %s: %q", worktree, content)
	}
	dir = strings.TrimSpace(dir)
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(worktree, dir)
	}
	return filepath.Clean(dir), nil
}
