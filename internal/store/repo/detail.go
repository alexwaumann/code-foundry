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

// detailState is the Git store's detail cache. Zero value is ready to use. Each
// worktree's entries in cache and heads are written only by its jobDetail.
type detailState struct {
	mu        sync.Mutex
	requested map[wtKey]time.Time
	cache     map[wtKey]WorktreeDetail
	heads     map[wtKey]*headPart
}

// headKey is what the HEAD-only part of a detail depends on.
type headKey struct {
	head    string // HEAD sha; empty on an unborn branch
	baseRef string // as shown (WorktreeDetail.BaseRef)
	baseSHA string // baseRef resolved
}

// headPart is the part of a detail that is a pure function of its key: the merge
// base, the committed changes and the log (merge-base, diff --name-status <mb> <head>,
// log, rev-list --count), plus, once a clean recompute needed them, the files of a
// clean worktree (diff --numstat <mb> <head>). Immutable once stored.
type headPart struct {
	key       headKey
	mergeBase string
	committed []nameStatus
	log       []LogEntry
	logTotal  int
	// clean is the file list of a clean worktree at key; nil until first needed.
	clean *cleanFiles
}

type cleanFiles struct {
	files     []FileChange
	truncated bool
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
	if st := g.repo(repoID); st != nil {
		if err := requireGit(st.meta.Load()); err != nil {
			return WorktreeDetail{}, err
		}
	}
	k := wtKey{repoID, path}
	now := g.now()
	ds := &g.details
	ds.mu.Lock()
	ds.initLocked()
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

// detail is the jobDetail body: the only writer of a worktree's cached detail and
// head part.
func (g *Git) detail(ctx context.Context, repoID, path string) {
	k := wtKey{repoID, path}
	ds := &g.details
	st, slot := g.repo(repoID), g.slot(repoID, path)
	if st == nil || slot == nil {
		ds.mu.Lock()
		delete(ds.cache, k)
		delete(ds.heads, k)
		delete(ds.requested, k)
		ds.mu.Unlock()
		return
	}
	wt := *slot.cur.Load()
	d := WorktreeDetail{RepoID: repoID, Path: path, Head: wt.Head}
	var baseSHA string
	d.BaseRef, baseSHA = g.detailBase(ctx, st, wt)
	// The status job that triggered this ran just before, so a clean status is current.
	clean := !wt.Status.Dirty && wt.Status.Error == "" && !wt.Status.RefreshedAt.IsZero()
	ds.mu.Lock()
	hp := ds.heads[k]
	ds.mu.Unlock()
	hp, runs, err := g.fillDetail(ctx, &d, baseSHA, clean, hp)
	if ctx.Err() != nil {
		return
	}
	g.log.Debug("worktree detail", "repo", repoID, "path", path, "head", shortSHA(d.Head),
		"base", d.BaseRef, "clean", clean, "git_runs", runs, "err", err)
	ds.mu.Lock()
	ds.initLocked()
	prev, had := ds.cache[k]
	if err != nil {
		d = prev
		d.RepoID, d.Path, d.Error = repoID, path, err.Error()
	} else {
		ds.heads[k] = hp
	}
	d.ComputedAt = g.now()
	ds.cache[k] = d
	ds.mu.Unlock()
	if had && sameDetail(prev, d) {
		return
	}
	g.commit(func(*Snapshot) []Event {
		return []Event{WorktreeDetailUpdated{RepoID: repoID, Path: path, ComputedAt: d.ComputedAt}}
	})
}

// initLocked allocates the maps; ds.mu must be held.
func (ds *detailState) initLocked() {
	if ds.cache == nil {
		ds.requested, ds.cache, ds.heads = map[wtKey]time.Time{}, map[wtKey]WorktreeDetail{}, map[wtKey]*headPart{}
	}
}

// detailBase picks the ref to compare against, and its sha: origin/<default> when the
// repo has it (as resolved by jobBase, the same sha status compared with), else the
// local default branch if the worktree is on another branch. An unborn HEAD has no base.
func (g *Git) detailBase(ctx context.Context, st *repoState, wt Worktree) (ref, sha string) {
	if wt.Head == "" {
		return "", ""
	}
	if b := st.base.Load(); b != nil && b.sha != "" {
		return b.ref, b.sha
	}
	def := st.meta.Load().DefaultBranch
	if def == "" || wt.Branch == def {
		return "", ""
	}
	out, err := g.runner.Run(ctx, wt.Path, "rev-parse", "--verify", "--quiet", "refs/heads/"+def+"^{commit}")
	if err != nil {
		return "", ""
	}
	return def, string(trimNL(out))
}

// gitDiff builds `git diff` arguments that stay machine-readable regardless of user
// config (external diff drivers, color).
func gitDiff(extra ...string) []string {
	args := []string{"diff", "--no-ext-diff", "--no-color", "-M", "-z"}
	return append(args, extra...)
}

// fillDetail fills d's merge base, files, and log, and returns the head part it used
// (hp when its key still matches, else a fresh one) and how many git commands ran.
// d.BaseRef and d.Head are set; baseSHA is d.BaseRef resolved.
//
// Every command names commits by sha, never HEAD or the base ref, so the head part is
// exactly a function of its key even if a ref moves while this runs (the status job
// that sees the move schedules another detail).
//
// A clean worktree (per status) skips the working-tree scans: the uncommitted diff and
// the untracked listing are empty, and counts come from a tree-to-tree diff, which is
// itself cached in the head part. A clean worktree whose key did not change therefore
// runs no git at all.
func (g *Git) fillDetail(ctx context.Context, d *WorktreeDetail, baseSHA string, clean bool, hp *headPart) (*headPart, int, error) {
	dir := d.Path
	runs := 0
	run := func(args ...string) ([]byte, error) {
		runs++
		return g.runner.Run(ctx, dir, args...)
	}
	if d.Head == "" {
		d.BaseRef, baseSHA = "", ""
	}
	key := headKey{head: d.Head, baseRef: d.BaseRef, baseSHA: baseSHA}
	if hp == nil || hp.key != key {
		var err error
		if hp, err = computeHeadPart(key, run); err != nil {
			return nil, runs, err
		}
	}
	d.MergeBase, d.Log, d.LogTotal = hp.mergeBase, hp.log, hp.logTotal

	if clean && d.Head != "" {
		if hp.clean == nil {
			c := &cleanFiles{}
			if hp.mergeBase != "" { // without a base there is nothing to compare
				out, err := run(gitDiff("--numstat", hp.mergeBase, d.Head)...)
				if err != nil {
					return nil, runs, err
				}
				c.files, c.truncated = mergeFiles(hp.committed, nil, parseNumstatZ(out), nil)
			}
			next := *hp
			next.clean = c
			hp = &next
		}
		d.Files, d.FilesTruncated = hp.clean.files, hp.clean.truncated
		return hp, runs, nil
	}

	from := cmp.Or(hp.mergeBase, d.Head, emptyTree)
	out, err := run(gitDiff("--name-status", cmp.Or(d.Head, emptyTree))...)
	if err != nil {
		return nil, runs, err
	}
	uncommitted := parseNameStatusZ(out)
	if out, err = run("ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z"); err != nil {
		return nil, runs, err
	}
	untracked := splitZ(out)
	if out, err = run(gitDiff("--numstat", from)...); err != nil { // merge base to working tree
		return nil, runs, err
	}
	d.Files, d.FilesTruncated = mergeFiles(hp.committed, uncommitted, parseNumstatZ(out), untracked)
	for i := range d.Files {
		f := &d.Files[i]
		if f.Status == "?" && !f.IsDir {
			f.Added, f.Binary = countLines(filepath.Join(dir, f.Path))
		}
	}
	return hp, runs, nil
}

// computeHeadPart runs the HEAD-only commands for key: merge-base, the committed
// name-status, the log, and its total. No base (or no merge base) leaves them empty.
func computeHeadPart(key headKey, run func(...string) ([]byte, error)) (*headPart, error) {
	hp := &headPart{key: key}
	if key.baseSHA == "" {
		return hp, nil
	}
	out, err := run("merge-base", key.head, key.baseSHA)
	switch {
	case err == nil:
		hp.mergeBase = string(trimNL(out))
	case isExit(err, 1):
		// No merge base (unrelated histories, or beyond a shallow boundary): compare
		// only uncommitted changes, like having no base. Exit 1 is git's answer, so it
		// is cached; any other failure is an error and is not.
		return hp, nil
	default:
		return nil, err
	}
	if out, err = run(gitDiff("--name-status", hp.mergeBase, key.head)...); err != nil {
		return nil, err
	}
	hp.committed = parseNameStatusZ(out)
	rng := key.baseSHA + ".." + key.head
	if out, err = run("log", "-n", strconv.Itoa(DetailLogMax), "--no-color", "--format="+logFormat, rng); err != nil {
		return nil, err
	}
	hp.log = parseLog(out)
	if out, err = run("rev-list", "--count", rng); err != nil {
		return nil, err
	}
	hp.logTotal, _ = strconv.Atoi(string(trimNL(out)))
	return hp, nil
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
