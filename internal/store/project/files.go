package project

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsevents"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// Per-file change events (docs/notes/gh-events-2-worktree-files.md).
//
// onEvents hands every tree hit of a live worktree (SetLiveWorktrees) to the files
// collector, keyed by the worktree's jobFiles key, and triggers that key on treeDeb: the
// same 1 s window as the worktree's status job. When the window closes the files job
// takes what was collected, decides each path's op from its events and what is on disk
// now, leaves out paths that came and went within the window unseen (save temp files),
// drops gitignored paths with one `git check-ignore --stdin -z`, and publishes one
// WorktreeFilesChanged. Idle worktrees collect nothing; their status jobs run as before.

// FileOp is what happened to a path within one window, judged by what is there when the
// window closes.
type FileOp uint8

const (
	// FileCreated: the path exists and is new (a create event, not reported before).
	FileCreated FileOp = iota + 1
	// FileModified: the path exists and was there before (written, replaced, touched).
	FileModified
	// FileRemoved: the path is gone (removed, or renamed away) and was there before the
	// window, or was reported as existing.
	FileRemoved
	// FileRenamed: the path exists and was renamed onto (mv), not reported before.
	FileRenamed
)

func (o FileOp) String() string {
	switch o {
	case FileCreated:
		return "created"
	case FileModified:
		return "modified"
	case FileRemoved:
		return "removed"
	case FileRenamed:
		return "renamed"
	}
	return "FileOp(?)"
}

// ChangedFile is one path of a WorktreeFilesChanged.
type ChangedFile struct {
	// Path is worktree-relative with forward slashes. A directory ends in "/" and is
	// listed only when removed or renamed (its files have their own events otherwise,
	// and a directory renamed in or out has none).
	Path string
	Op   FileOp
}

// WorktreeFilesChanged is published (on the project.Event topic) at most once per tree
// window per live worktree, listing the non-ignored paths that changed in it. It is not
// part of the Snapshot.
type WorktreeFilesChanged struct {
	ProjectID string
	Path      string // the worktree's root
	// Files is sorted by path, at most MaxChangedFiles.
	Files []ChangedFile
	// Truncated: more paths changed than Files lists (run `git status` yourself).
	Truncated bool
}

func (WorktreeFilesChanged) isProjectEvent() {}

const (
	// MaxChangedFiles caps WorktreeFilesChanged.Files.
	MaxChangedFiles = 500
	// maxPendingFiles bounds what one worktree collects in a window (an rm -rf of a
	// large tree); paths beyond it are not kept and the flush is truncated.
	maxPendingFiles = 10_000
	// seenTTL is how long a path reported as existing is remembered, so a later edit
	// whose cumulative FSEvents flags still carry ItemCreated is reported as modified.
	seenTTL = 10 * time.Minute
	// maxSeen bounds that memory per worktree; past it the memory starts over.
	maxSeen = 20_000
	// bornSlack is how long before a path's first event in the window its file may have
	// been born and still count as created (event delivery lags creation).
	bornSlack = time.Second
	// checkIgnoreRetries bounds re-running check-ignore after it refused a path (inside a
	// submodule, beyond a symlink).
	checkIgnoreRetries = 4
)

type pendingFile struct {
	ops   op
	dir   bool
	first time.Time // the path's first event in the window
}

type pendingFiles struct {
	paths    map[string]*pendingFile // worktree-relative, forward slashes
	overflow bool
}

// fileCollector is the paths collected per worktree (keyed by its jobFiles key) and the
// paths each worktree reported as existing.
type fileCollector struct {
	mu      sync.Mutex
	pending map[jobKey]*pendingFiles
	// seen is written only by the key's files job.
	seen map[jobKey]map[string]time.Time
}

// add records an event on rel (worktree-relative) for k, received at now.
func (c *fileCollector) add(k jobKey, rel string, flags fsevents.EventFlags, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pending == nil {
		c.pending = map[jobKey]*pendingFiles{}
	}
	p := c.pending[k]
	if p == nil {
		p = &pendingFiles{paths: map[string]*pendingFile{}}
		c.pending[k] = p
	}
	f := p.paths[rel]
	if f == nil {
		if len(p.paths) >= maxPendingFiles {
			p.overflow = true
			return
		}
		f = &pendingFile{first: now}
		p.paths[rel] = f
	}
	f.ops |= opsOf(flags)
	f.dir = flags&fsevents.ItemIsDir != 0
}

// take removes and returns what k collected (nil if nothing).
func (c *fileCollector) take(k jobKey) *pendingFiles {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.pending[k]
	delete(c.pending, k)
	return p
}

// forget drops k's memory (its worktree is gone).
func (c *fileCollector) forget(k jobKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.seen, k)
	delete(c.pending, k)
}

// seenOf returns k's memory, pruned of entries older than seenTTL at now.
func (c *fileCollector) seenOf(k jobKey, now time.Time) map[string]time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen == nil {
		c.seen = map[jobKey]map[string]time.Time{}
	}
	s := c.seen[k]
	if s == nil || len(s) > maxSeen {
		s = map[string]time.Time{}
		c.seen[k] = s
	}
	for p, at := range s {
		if now.Sub(at) > seenTTL {
			delete(s, p)
		}
	}
	return s
}

// treeFile is the worktree-relative path of an event at path in the worktree at root,
// and false for one the files event leaves out: the root itself, and anything under a
// .git directory or file (a nested repository's or submodule's git dir; the worktree's
// own is routed to its git-dir kind and never reaches here).
func treeFile(root, path string) (string, bool) {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	rel = filepath.ToSlash(rel)
	if slices.Contains(strings.Split(rel, "/"), ".git") {
		return "", false
	}
	return rel, true
}

// fileOpFor decides a file's op from the ops its events carried in the window, whether
// it exists when the window closes, whether this worktree reported it as existing
// recently (seen), and whether the file there now is new (fresh: born at about its
// first event, or with a birth time equal to its mtime, which is what an extracted or
// copied file whose mtime was set into the past has). 0 leaves the path out: it was
// created and is gone again, and was never reported, so no consumer saw it exist (the
// temp file of an atomic save, `sed -i` or an untar, renamed onto the real name).
//
// FSEvents item flags are cumulative: an edit of a file created half a minute ago still
// carries ItemCreated. So a seen path is modified whatever its flags say, and a create
// flag counts only for a fresh file. A file created that long ago, never reported
// (the worktree went live since) and removed now is left out too: gone, it has no
// birth time to tell.
func fileOpFor(o op, exists, seen, fresh bool) FileOp {
	switch {
	case !exists && !seen && o.has(opCreate):
		return 0
	case !exists:
		return FileRemoved
	case seen:
		return FileModified
	case o.has(opCreate) && fresh:
		return FileCreated
	case o.has(opRename):
		return FileRenamed
	}
	return FileModified
}

// dirOpFor is fileOpFor for a directory: only one removed or renamed in is listed. A
// directory is never reported as existing, so resolveFiles leaves out one created and
// gone (transient) only when nothing under it is listed either.
func dirOpFor(o op, exists bool) (FileOp, bool) {
	switch {
	case !exists:
		return FileRemoved, true
	case o.has(opRename):
		return FileRenamed, true
	}
	return 0, false
}

// fileStat is what resolveFiles needs to know about a path on disk.
type fileStat struct {
	exists, dir  bool
	birth, mtime time.Time
}

// lstatFile stats path without following a final symlink.
func lstatFile(path string) fileStat {
	fi, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return fileStat{}
	}
	st := fileStat{exists: true}
	if err != nil {
		return st // exists as far as we can tell
	}
	st.dir = fi.IsDir()
	if sys, ok := fi.Sys().(*syscall.Stat_t); ok {
		st.birth = time.Unix(sys.Birthtimespec.Unix())
		st.mtime = time.Unix(sys.Mtimespec.Unix())
	}
	return st
}

// resolveFiles turns what a window collected into changes, sorted by path, and updates
// seen (paths reported existing are remembered at now, gone ones forgotten). stat
// reports a worktree-relative path's state on disk.
func resolveFiles(p *pendingFiles, seen map[string]time.Time, now time.Time, stat func(rel string) fileStat) []ChangedFile {
	out := make([]ChangedFile, 0, len(p.paths))
	transient := map[string]bool{} // directories created and gone ("x/")
	for rel, f := range p.paths {
		st := stat(rel)
		dir := st.dir
		if !st.exists {
			dir = f.dir
		}
		if dir {
			if op, ok := dirOpFor(f.ops, st.exists); ok {
				out = append(out, ChangedFile{Path: rel + "/", Op: op})
				if !st.exists && f.ops.has(opCreate) {
					transient[rel+"/"] = true
				}
			}
			continue
		}
		_, known := seen[rel]
		fresh := !st.birth.IsZero() && (!st.birth.Before(f.first.Add(-bornSlack)) || st.birth.Equal(st.mtime))
		op := fileOpFor(f.ops, st.exists, known, fresh)
		if op == 0 || op == FileRemoved {
			delete(seen, rel)
		} else {
			seen[rel] = now
		}
		if op != 0 {
			out = append(out, ChangedFile{Path: rel, Op: op})
		}
	}
	slices.SortFunc(out, func(a, b ChangedFile) int { return strings.Compare(a.Path, b.Path) })
	if len(transient) == 0 {
		return out
	}
	// Sorted, a directory's entries follow it: walking back, a transient one stays only
	// when the entry kept after it is under it.
	kept := make([]ChangedFile, 0, len(out))
	for _, c := range slices.Backward(out) {
		if transient[c.Path] && (len(kept) == 0 || !strings.HasPrefix(kept[len(kept)-1].Path, c.Path)) {
			continue
		}
		kept = append(kept, c)
	}
	slices.Reverse(kept)
	return kept
}

// capFiles cuts files to MaxChangedFiles; truncated is true when it cut or overflow.
func capFiles(files []ChangedFile, overflow bool) ([]ChangedFile, bool) {
	if len(files) > MaxChangedFiles {
		return files[:MaxChangedFiles], true
	}
	return files, overflow
}

// filesJob is the files job's key for the worktree at path.
func filesJob(projectID, path string) jobKey {
	return jobKey{kind: jobFiles, projectID: projectID, path: path}
}

// flushFiles is the files job: it publishes what the worktree's window collected.
func (g *Git) flushFiles(ctx context.Context, k jobKey) {
	p := g.files.take(k)
	if g.slot(k.projectID, k.path) == nil {
		g.files.forget(k) // the worktree is gone
		return
	}
	if p == nil {
		return
	}
	now := g.now()
	seen := g.files.seenOf(k, now)
	files := resolveFiles(p, seen, now, func(rel string) fileStat {
		return lstatFile(filepath.Join(k.path, filepath.FromSlash(rel)))
	})
	n := len(files)
	start := time.Now()
	files, err := g.dropIgnored(ctx, k.path, files)
	if err != nil {
		if ctx.Err() == nil {
			g.log.Warn("check-ignore failed; file changes dropped", "project", k.projectID, "worktree", k.path,
				"files", n, "err", err)
		}
		return
	}
	files, truncated := capFiles(files, p.overflow)
	g.log.Debug("worktree files changed", "project", k.projectID, "worktree", k.path, "collected", len(p.paths),
		"kept", len(files), "truncated", truncated, "check_ignore", time.Since(start).Round(time.Microsecond))
	if len(files) == 0 && !truncated {
		return // every path was ignored
	}
	g.pubMu.Lock() // ordered with the snapshot events
	defer g.pubMu.Unlock()
	bus.Publish[Event](g.bus, WorktreeFilesChanged{ProjectID: k.projectID, Path: k.path, Files: files, Truncated: truncated})
}

// refusedPath matches check-ignore's fatal error for a path it will not check.
var refusedPath = regexp.MustCompile(`[Pp]athspec '([^']*)' is (in submodule '([^']*)'|beyond a symbolic link)`)

// dropIgnored returns files without the paths gitignored in the worktree at dir, with
// one `git check-ignore --stdin -z` (the index counts: a tracked file is never
// ignored). A path git refuses to check (inside a submodule: every path in that
// submodule; beyond a symlink: that path) is dropped and the rest checked again.
func (g *Git) dropIgnored(ctx context.Context, dir string, files []ChangedFile) ([]ChangedFile, error) {
	for range checkIgnoreRetries + 1 {
		if len(files) == 0 {
			return files, nil
		}
		var in bytes.Buffer
		for _, f := range files {
			in.WriteString(f.Path)
			in.WriteByte(0)
		}
		out, err := runInput(ctx, g.runner, dir, in.Bytes(), "check-ignore", "--stdin", "-z")
		var ge *GitError
		switch {
		case err == nil:
		case errors.As(err, &ge) && ge.ExitCode == 1:
			return files, nil // nothing ignored
		case errors.As(err, &ge) && ge.ExitCode == 128:
			m := refusedPath.FindStringSubmatch(ge.Stderr)
			if m == nil {
				return nil, err
			}
			bad, sub := m[1], m[3]
			files = slices.DeleteFunc(files, func(f ChangedFile) bool {
				return f.Path == bad || (sub != "" && (f.Path == sub || f.Path == sub+"/" || strings.HasPrefix(f.Path, sub+"/")))
			})
			continue
		default:
			return nil, err
		}
		ignored := map[string]bool{}
		for p := range bytes.SplitSeq(out, []byte{0}) {
			if len(p) > 0 {
				ignored[string(p)] = true
			}
		}
		return slices.DeleteFunc(files, func(f ChangedFile) bool { return ignored[f.Path] }), nil
	}
	return nil, errors.New("check-ignore refused too many paths")
}
