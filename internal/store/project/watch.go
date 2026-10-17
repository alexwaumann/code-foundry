package project

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/fsnotify/fsevents"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// The store watches the file system with one FSEvents stream (fsevents.go). Its paths
// are the minimal set of directories covering every worktree root (streamRoots), and
// every event below them is routed by path (route) through a table of known
// directories: each project's git admin dirs and worktree roots (desiredWatches).
// classify decides what an event asks for; docs/notes/fsevents-watcher.md mirrors it.

// watchKind says what a known directory is.
type watchKind uint8

const (
	wkCommon       watchKind = iota + 1 // <common>            (= <main>/.git)
	wkCommonLogs                        // <common>/logs       (main worktree reflog)
	wkRemoteRefs                        // <common>/refs/remotes/origin
	wkWorktreesDir                      // <common>/worktrees  (one entry per linked worktree)
	wkLinkedAdmin                       // <common>/worktrees/<name>
	wkLinkedLogs                        // <common>/worktrees/<name>/logs
	wkRoot                              // a worktree's root directory
	wkPlainRoot                         // a project without git: its directory (nogit.go)
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
	case wkPlainRoot:
		return "plain-root"
	}
	return fmt.Sprintf("watchKind(%d)", k)
}

// recursive reports whether an event anywhere below a directory of kind k counts, not
// only one on its direct entries. A worktree's files are its whole tree, and a
// remote-tracking ref may live in a subdirectory (origin/alex/foo). The admin dirs'
// subtrees (objects/, refs/heads/, logs/refs/, the contents of rebase-merge/) never
// change a status on their own.
func recursive(k watchKind) bool { return k == wkRoot || k == wkRemoteRefs }

// watchTarget is what a known directory belongs to.
type watchTarget struct {
	kind      watchKind
	projectID string
	// wtPath is the worktree whose status the directory affects (empty for
	// project-wide kinds).
	wtPath string
}

// op is what happened to a path (opsOf decodes FSEvents flags).
type op uint8

const (
	opCreate op = 1 << iota
	opWrite
	opRemove
	opRename
	opChmod // attribute-only: mode, owner, xattrs, Finder info
)

func (o op) has(x op) bool { return o&x != 0 }

func (o op) String() string {
	if o == 0 {
		return "none"
	}
	var parts []string
	for i, n := range []string{"create", "write", "remove", "rename", "chmod"} {
		if o&(1<<i) != 0 {
			parts = append(parts, n)
		}
	}
	return strings.Join(parts, "|")
}

// action is what an fs event asks for.
type action uint8

const (
	actNone      action = iota
	actStatus           // refresh the target's worktree
	actStatusAll        // re-resolve the project's base (jobBase), then refresh every worktree
	actReconcile        // re-list worktrees and project metadata, then refresh all
)

func (a action) String() string {
	return [...]string{"none", "status", "status-all", "reconcile"}[a]
}

// classify maps an event on entry name inside a known directory of kind to an
// action. It is the single source of truth for what triggers a refresh; the table in
// docs/notes/fsevents-watcher.md mirrors it. route calls it with the event path's
// base name and the nearest known directory above the path.
func classify(kind watchKind, name string, o op) action {
	// <common>/config.lock appearing means config is about to be rewritten (remote
	// add/remove, url change). The lock triggers a reconcile itself: its debounce
	// window outlasts the rewrite, and the rename onto config re-runs the job if it
	// lands later. (kqueue was seen to drop that rename on a slow CI runner.)
	if kind == wkCommon && name == "config.lock" && o.has(opCreate) {
		return actReconcile
	}
	// Git's lock files come and go during every git operation; the rename onto the
	// real name that follows is the event that matters. Inside a worktree a .lock
	// file is the user's (Cargo.lock, yarn.lock, flake.lock), so there it counts.
	if kind != wkRoot && strings.HasSuffix(name, ".lock") {
		return actNone
	}
	// Attribute-only changes cannot change status. (kqueue reported one when git merely
	// read .git/index. FSEvents reports nothing for reads, and its item flags are
	// cumulative, so a chmod of a file written earlier carries the write flag too.)
	if o == opChmod {
		return actNone
	}
	// An operation starting or ending (rebase-merge/ appearing, MERGE_HEAD removed, …).
	if (kind == wkCommon || kind == wkLinkedAdmin) && operationMarkers[name] {
		return actStatus
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
		if o.has(opCreate | opRemove | opRename) {
			return actReconcile // `git worktree add/remove/prune` run anywhere
		}
	case wkRoot:
		if name == ".git" {
			return actNone
		}
		return actStatus // any file in the worktree created, removed, renamed, or written
	case wkPlainRoot:
		if name == ".git" && o.has(opCreate|opRename) {
			return actReconcile // `git init` run outside the app
		}
	}
	return actNone
}

// route maps an event on path (symlink-resolved, as FSEvents reports it) to the known
// directory it concerns and the action it asks for. dirs is the routing table: every
// project's desiredWatches.
//
//   - A known directory itself removed or renamed: reconcile (a worktree deleted by
//     hand, a project moved).
//   - Otherwise the nearest known directory above path decides, through classify on
//     path's base name. Nearest wins: <main>/.git/HEAD belongs to the common dir, not
//     the main worktree, and a file in a worktree nested inside the main checkout
//     belongs to the nested worktree.
//   - A path deeper than a direct entry counts only below a recursive kind.
//   - No known directory above path: nothing.
func route(dirs map[string]watchTarget, path string, o op) (watchTarget, action) {
	if t, ok := dirs[path]; ok && o.has(opRemove|opRename) {
		return t, actReconcile
	}
	name := filepath.Base(path)
	for d, deep := filepath.Dir(path), false; ; d, deep = filepath.Dir(d), true {
		if t, ok := dirs[d]; ok {
			if deep && !recursive(t.kind) {
				return t, actNone
			}
			return t, classify(t.kind, name, o)
		}
		if filepath.Dir(d) == d {
			return watchTarget{}, actNone
		}
	}
}

// keysFor returns the jobs an action on target t asks for.
func keysFor(t watchTarget, act action) []jobKey {
	switch act {
	case actStatus:
		return []jobKey{{kind: jobStatus, projectID: t.projectID, path: t.wtPath}}
	case actStatusAll:
		// A remote-tracking ref moved: re-resolve the base, which then refreshes
		// every worktree (upstream and base ahead/behind).
		return []jobKey{{kind: jobBase, projectID: t.projectID}}
	case actReconcile:
		return []jobKey{{kind: jobReconcile, projectID: t.projectID}}
	}
	return nil
}

// rescanFlags mean FSEvents cannot say exactly what changed: events were dropped or
// coalesced into a directory (MustScanSubDirs, with KernelDropped or UserDropped
// saying where), a stream root or a directory above it moved (RootChanged), or a
// volume was mounted or unmounted below a root.
const rescanFlags = fsevents.MustScanSubDirs | fsevents.KernelDropped | fsevents.UserDropped |
	fsevents.RootChanged | fsevents.Mount | fsevents.Unmount

// itemCloned is kFSEventStreamEventFlagItemCloned (an APFS clone, `cp -c`), which the
// fsevents package does not name. A clone's event may carry no other change flag.
const itemCloned fsevents.EventFlags = 0x00400000

// opsOf decodes an event's item flags. A change with no flag this knows counts as a
// write.
func opsOf(f fsevents.EventFlags) op {
	var o op
	if f&(fsevents.ItemCreated|itemCloned) != 0 {
		o |= opCreate
	}
	if f&fsevents.ItemModified != 0 {
		o |= opWrite
	}
	if f&fsevents.ItemRemoved != 0 {
		o |= opRemove
	}
	if f&fsevents.ItemRenamed != 0 {
		o |= opRename
	}
	if f&(fsevents.ItemInodeMetaMod|fsevents.ItemXattrMod|fsevents.ItemFinderInfoMod|fsevents.ItemChangeOwner) != 0 {
		o |= opChmod
	}
	if o == 0 {
		o = opWrite
	}
	return o
}

// eventKeys maps one FSEvents event to the jobs it asks for. A rescan event
// reconciles every project with a known directory at, above, or below its path (for a
// stream root, every project it covers).
func eventKeys(dirs map[string]watchTarget, path string, flags fsevents.EventFlags) []jobKey {
	path = filepath.Clean(path)
	if flags&rescanFlags != 0 {
		ids := map[string]bool{}
		for d, t := range dirs {
			if fsx.Within(d, path) || fsx.Within(path, d) {
				ids[t.projectID] = true
			}
		}
		keys := make([]jobKey, 0, len(ids))
		for id := range ids {
			keys = append(keys, jobKey{kind: jobReconcile, projectID: id})
		}
		return keys
	}
	return keysFor(route(dirs, path, opsOf(flags)))
}

// watchWorktree is the input to desiredWatches for one worktree.
type watchWorktree struct {
	path   string
	isMain bool
	admin  string // linked worktree admin dir (<common>/worktrees/<name>); unused for main
}

// desiredWatches returns every known directory of a git project, keyed by path. They
// need not exist: refs/remotes/origin appears at the first fetch and worktrees/ at the
// first linked worktree, and routing by path needs nothing added when they do.
func desiredWatches(projectID, mainPath, commonDir string, wts []watchWorktree) map[string]watchTarget {
	out := map[string]watchTarget{
		commonDir:                        {kind: wkCommon, projectID: projectID, wtPath: mainPath},
		filepath.Join(commonDir, "logs"): {kind: wkCommonLogs, projectID: projectID, wtPath: mainPath},
		filepath.Join(commonDir, "refs", "remotes", "origin"): {kind: wkRemoteRefs, projectID: projectID},
		filepath.Join(commonDir, "worktrees"):                 {kind: wkWorktreesDir, projectID: projectID},
	}
	for _, w := range wts {
		out[w.path] = watchTarget{kind: wkRoot, projectID: projectID, wtPath: w.path}
		if w.isMain || w.admin == "" {
			continue
		}
		out[w.admin] = watchTarget{kind: wkLinkedAdmin, projectID: projectID, wtPath: w.path}
		out[filepath.Join(w.admin, "logs")] = watchTarget{kind: wkLinkedLogs, projectID: projectID, wtPath: w.path}
	}
	return out
}

// streamRoots returns the stream's paths: the minimal set of directories, none inside
// another, covering every worktree root and project directory in dirs plus extra (the
// managed worktree root). Sorted, so equal sets compare equal.
func streamRoots(dirs map[string]watchTarget, extra ...string) []string {
	var cand []string
	for d, t := range dirs {
		if t.kind == wkRoot || t.kind == wkPlainRoot {
			cand = append(cand, d)
		}
	}
	for _, e := range extra {
		if e != "" {
			cand = append(cand, e)
		}
	}
	slices.Sort(cand)
	cand = slices.Compact(cand)
	var out []string
	for _, p := range cand {
		if !slices.ContainsFunc(cand, func(q string) bool { return q != p && fsx.Within(q, p) }) {
			out = append(out, p)
		}
	}
	return out
}

// readGitFile returns the admin dir a linked worktree's .git file points to
// ("gitdir: /project/.git/worktrees/name"), resolved against the worktree.
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
