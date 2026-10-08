package repo

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Worktree detail (Phase 3a): the files changed and commits on a worktree against its
// base, computed by git on demand. A worktree someone asked about within DetailWatch is
// recomputed after each of its status refreshes (fs events, the 30s poll, Refresh), so
// the overview page stays live; others cost nothing.

// Detail limits.
const (
	// DetailWatch is how long after a GetWorktreeDetail call status refreshes also
	// recompute the detail.
	DetailWatch = 10 * time.Minute
	// DetailLogMax caps WorktreeDetail.Log.
	DetailLogMax = 100
	// DetailFilesMax caps WorktreeDetail.Files.
	DetailFilesMax = 2000
	// untrackedReadMax bounds how much of an untracked file is read to count lines.
	untrackedReadMax = 8 << 20
	// binarySniff is how many leading bytes are checked for NUL (git uses 8000).
	binarySniff = 8000
	// emptyTree is git's well-known empty tree, the base of an unborn branch.
	emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
)

// FileChange is one changed path in a worktree.
type FileChange struct {
	Path    string
	OldPath string // renames and copies
	// Status is one git status letter (A M D R C T U), or "?" for untracked. A path
	// changed both on the branch and in the working tree has the working tree's.
	Status string
	// Added and Deleted count lines from the merge base to the working tree; for an
	// untracked file, its lines. Zero when Binary.
	Added, Deleted int
	Binary         bool
	// Uncommitted is set for working tree and index changes.
	Uncommitted bool
	// IsDir marks an untracked directory reported as one entry ("dir/").
	IsDir bool
}

// LogEntry is one commit.
type LogEntry struct {
	SHA, ShortSHA, Subject  string
	AuthorName, AuthorEmail string
	AuthoredAt              time.Time
}

// WorktreeDetail is a worktree compared with its base.
type WorktreeDetail struct {
	RepoID string
	Path   string
	// BaseRef is "origin/<default>" (Status.BaseRef) or, without it, the local default
	// branch when the worktree is on another branch. Empty means no base: Files holds
	// only uncommitted changes.
	BaseRef        string
	MergeBase      string
	Head           string
	Files          []FileChange
	FilesTruncated bool
	Log            []LogEntry // newest first, at most DetailLogMax
	LogTotal       int
	ComputedAt     time.Time
	Error          string // last computation error; other fields are from the last success
}

// WorktreeDetailUpdated is published (on the repo.Event topic) when a recomputed
// detail differs from the previous one.
type WorktreeDetailUpdated struct {
	RepoID, Path string
	ComputedAt   time.Time
}

func (WorktreeDetailUpdated) isRepoEvent() {}

type wtKey struct{ repoID, path string }

// detailState is the Git store's detail cache. Zero value is ready to use.
type detailState struct {
	mu        sync.Mutex
	requested map[wtKey]time.Time
	cache     map[wtKey]WorktreeDetail
}

// WorktreeDetail implements Store.
func (g *Git) WorktreeDetail(ctx context.Context, repoID, path string) (WorktreeDetail, error) {
	path = filepath.Clean(path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	if _, ok := g.Snapshot().Worktree(repoID, path); !ok {
		return WorktreeDetail{}, fmt.Errorf("%w: worktree %q in repo %q", ErrNotFound, path, repoID)
	}
	k := wtKey{repoID, path}
	now := g.now()
	ds := &g.details
	ds.mu.Lock()
	if ds.requested == nil {
		ds.requested, ds.cache = map[wtKey]time.Time{}, map[wtKey]WorktreeDetail{}
	}
	last, watched := ds.requested[k]
	ds.requested[k] = now
	d, cached := ds.cache[k]
	ds.mu.Unlock()
	if cached && watched && now.Sub(last) <= DetailWatch {
		return d, nil // kept fresh by status refreshes
	}
	if err := g.sched.wait(ctx, jobKey{kind: jobDetail, repoID: repoID, path: path}); err != nil {
		return WorktreeDetail{}, err
	}
	ds.mu.Lock()
	d, cached = ds.cache[k]
	ds.mu.Unlock()
	if !cached {
		return WorktreeDetail{}, fmt.Errorf("%w: worktree %q in repo %q", ErrNotFound, path, repoID)
	}
	return d, nil
}

// detailAfterStatus schedules a detail recomputation after a status refresh of a
// worktree someone looked at recently.
func (g *Git) detailAfterStatus(repoID, path string) {
	ds := &g.details
	ds.mu.Lock()
	at, ok := ds.requested[wtKey{repoID, path}]
	if ok && g.now().Sub(at) > DetailWatch {
		delete(ds.requested, wtKey{repoID, path})
		ok = false
	}
	ds.mu.Unlock()
	if ok {
		g.sched.request(jobKey{kind: jobDetail, repoID: repoID, path: path})
	}
}

// detail is the jobDetail body: the only writer of a worktree's cached detail.
func (g *Git) detail(ctx context.Context, repoID, path string) {
	k := wtKey{repoID, path}
	ds := &g.details
	st, slot := g.repo(repoID), g.slot(repoID, path)
	if st == nil || slot == nil {
		ds.mu.Lock()
		delete(ds.cache, k)
		delete(ds.requested, k)
		ds.mu.Unlock()
		return
	}
	wt := *slot.cur.Load()
	d := WorktreeDetail{RepoID: repoID, Path: path, Head: wt.Head}
	d.BaseRef = g.detailBase(ctx, st.meta.Load(), wt)
	err := g.fillDetail(ctx, &d)
	if ctx.Err() != nil {
		return
	}
	ds.mu.Lock()
	prev, had := ds.cache[k]
	if err != nil {
		g.log.Debug("worktree detail failed", "repo", repoID, "path", path, "err", err)
		d = prev
		d.RepoID, d.Path, d.Error = repoID, path, err.Error()
	}
	d.ComputedAt = g.now()
	if ds.cache == nil {
		ds.requested, ds.cache = map[wtKey]time.Time{}, map[wtKey]WorktreeDetail{}
	}
	ds.cache[k] = d
	ds.mu.Unlock()
	if had && sameDetail(prev, d) {
		return
	}
	g.commit(func(*Snapshot) []Event {
		return []Event{WorktreeDetailUpdated{RepoID: repoID, Path: path, ComputedAt: d.ComputedAt}}
	})
}

// detailBase picks the ref to compare against: origin/<default> when status found it,
// else the local default branch if the worktree is on another branch.
func (g *Git) detailBase(ctx context.Context, m *repoMeta, wt Worktree) string {
	if wt.Status.BaseRef != "" {
		return wt.Status.BaseRef
	}
	def := m.DefaultBranch
	if def == "" || wt.Branch == def || wt.Head == "" {
		return ""
	}
	if g.refExists(ctx, wt.Path, "refs/heads/"+def) {
		return def
	}
	return ""
}

// gitDiff builds `git diff` arguments that stay machine-readable regardless of user
// config (external diff drivers, color).
func gitDiff(extra ...string) []string {
	args := []string{"diff", "--no-ext-diff", "--no-color", "-M", "-z"}
	return append(args, extra...)
}

// fillDetail runs git and fills d's files and log. d.BaseRef and d.Head are set.
func (g *Git) fillDetail(ctx context.Context, d *WorktreeDetail) error {
	dir := d.Path
	from := "HEAD"
	if d.Head == "" {
		from, d.BaseRef = emptyTree, ""
	}
	var committed []nameStatus
	if d.BaseRef != "" {
		out, err := g.runner.Run(ctx, dir, "merge-base", "HEAD", d.BaseRef)
		if err == nil {
			d.MergeBase = string(trimNL(out))
		}
		// No merge base (unrelated histories) leaves the comparison to uncommitted
		// changes, like having no base.
	}
	if d.MergeBase != "" {
		from = d.MergeBase
		out, err := g.runner.Run(ctx, dir, gitDiff("--name-status", d.MergeBase, "HEAD")...)
		if err != nil {
			return err
		}
		committed = parseNameStatusZ(out)
		if out, err = g.runner.Run(ctx, dir, "log", "-n", strconv.Itoa(DetailLogMax), "--no-color",
			"--format="+logFormat, d.BaseRef+"..HEAD"); err != nil {
			return err
		}
		d.Log = parseLog(out)
		if out, err = g.runner.Run(ctx, dir, "rev-list", "--count", d.BaseRef+"..HEAD"); err != nil {
			return err
		}
		d.LogTotal, _ = strconv.Atoi(string(trimNL(out)))
	}
	ref := "HEAD"
	if d.Head == "" {
		ref = emptyTree
	}
	out, err := g.runner.Run(ctx, dir, gitDiff("--name-status", ref)...)
	if err != nil {
		return err
	}
	uncommitted := parseNameStatusZ(out)
	if out, err = g.runner.Run(ctx, dir, gitDiff("--numstat", from)...); err != nil {
		return err
	}
	counts := parseNumstatZ(out)
	if out, err = g.runner.Run(ctx, dir, "ls-files", "--others", "--exclude-standard", "--directory",
		"--no-empty-directory", "-z"); err != nil {
		return err
	}
	untracked := splitZ(out)
	d.Files, d.FilesTruncated = mergeFiles(committed, uncommitted, counts, untracked)
	for i := range d.Files {
		f := &d.Files[i]
		if f.Status == "?" && !f.IsDir {
			f.Added, f.Binary = countLines(filepath.Join(dir, f.Path))
		}
	}
	return nil
}

// mergeFiles combines branch and working tree changes into one sorted, capped list.
func mergeFiles(committed, uncommitted []nameStatus, counts map[string]numstat, untracked []string) ([]FileChange, bool) {
	byPath := map[string]*FileChange{}
	put := func(ns nameStatus, unc bool) {
		f := byPath[ns.path]
		if f == nil {
			f = &FileChange{Path: ns.path}
			byPath[ns.path] = f
		}
		f.Status, f.Uncommitted = ns.status, unc
		if ns.oldPath != "" || !unc {
			f.OldPath = ns.oldPath
		}
	}
	for _, ns := range committed {
		put(ns, false)
	}
	for _, ns := range uncommitted {
		put(ns, true)
	}
	for _, p := range untracked {
		if _, ok := byPath[p]; !ok {
			byPath[p] = &FileChange{Path: p, Status: "?", Uncommitted: true, IsDir: strings.HasSuffix(p, "/")}
		}
	}
	out := make([]FileChange, 0, len(byPath))
	for _, f := range byPath {
		if c, ok := counts[f.Path]; ok {
			f.Added, f.Deleted, f.Binary = c.added, c.deleted, c.binary
		}
		out = append(out, *f)
	}
	slices.SortFunc(out, func(a, b FileChange) int { return cmp.Compare(a.Path, b.Path) })
	if len(out) > DetailFilesMax {
		return out[:DetailFilesMax], true
	}
	return out, false
}

// countLines counts newlines in an untracked file (plus a final unterminated line),
// reading at most untrackedReadMax. A NUL in the first binarySniff bytes means binary.
func countLines(path string) (lines int, binary bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, 64<<10)
	var read int
	last := byte('\n')
	for read < untrackedReadMax {
		n, err := f.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if read < binarySniff && bytes.IndexByte(chunk[:min(n, binarySniff-read)], 0) >= 0 {
				return 0, true
			}
			lines += bytes.Count(chunk, []byte{'\n'})
			last = chunk[n-1]
			read += n
		}
		if errors.Is(err, io.EOF) || err != nil {
			break
		}
	}
	if read > 0 && last != '\n' {
		lines++
	}
	return lines, false
}

func sameDetail(a, b WorktreeDetail) bool {
	return a.BaseRef == b.BaseRef && a.MergeBase == b.MergeBase && a.Head == b.Head && a.Error == b.Error &&
		a.FilesTruncated == b.FilesTruncated && a.LogTotal == b.LogTotal &&
		slices.Equal(a.Files, b.Files) && slices.Equal(a.Log, b.Log)
}

// ---- parsers ---------------------------------------------------------------------

type nameStatus struct {
	status, path, oldPath string
}

// splitZ splits NUL-terminated output, dropping the empty tail.
func splitZ(out []byte) []string {
	parts := strings.Split(string(out), "\x00")
	if n := len(parts); n > 0 && parts[n-1] == "" {
		parts = parts[:n-1]
	}
	return parts
}

// parseNameStatusZ parses `git diff --name-status -z`: "<status>\0<path>\0", with
// renames and copies as "R<score>\0<old>\0<new>\0".
func parseNameStatusZ(out []byte) []nameStatus {
	toks := splitZ(out)
	var res []nameStatus
	for i := 0; i < len(toks); i++ {
		st := toks[i]
		if st == "" {
			continue
		}
		letter := st[:1]
		if (letter == "R" || letter == "C") && i+2 < len(toks) {
			res = append(res, nameStatus{status: letter, oldPath: toks[i+1], path: toks[i+2]})
			i += 2
			continue
		}
		if i+1 < len(toks) {
			res = append(res, nameStatus{status: letter, path: toks[i+1]})
			i++
		}
	}
	return res
}

type numstat struct {
	added, deleted int
	binary         bool
}

// parseNumstatZ parses `git diff --numstat -z`: "<added>\t<deleted>\t<path>\0", with
// renames as "<added>\t<deleted>\t\0<old>\0<new>\0" and binary files as "-\t-\t".
// Keys are the new paths.
func parseNumstatZ(out []byte) map[string]numstat {
	toks := splitZ(out)
	res := map[string]numstat{}
	for i := 0; i < len(toks); i++ {
		fields := strings.SplitN(toks[i], "\t", 3)
		if len(fields) != 3 {
			continue
		}
		var n numstat
		if fields[0] == "-" && fields[1] == "-" {
			n.binary = true
		} else {
			n.added, _ = strconv.Atoi(fields[0])
			n.deleted, _ = strconv.Atoi(fields[1])
		}
		path := fields[2]
		if path == "" && i+2 < len(toks) { // rename: old, new follow
			path = toks[i+2]
			i += 2
		}
		res[path] = n
	}
	return res
}

// logFormat separates fields with US (0x1f) and records with RS (0x1e).
const logFormat = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1e"

func parseLog(out []byte) []LogEntry {
	var res []LogEntry
	for rec := range strings.SplitSeq(string(out), "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\x1f", 6)
		if len(f) != 6 {
			continue
		}
		e := LogEntry{SHA: f[0], ShortSHA: f[1], AuthorName: f[2], AuthorEmail: f[3], Subject: f[5]}
		if sec, err := strconv.ParseInt(f[4], 10, 64); err == nil {
			e.AuthoredAt = time.Unix(sec, 0)
		}
		res = append(res, e)
	}
	return res
}
