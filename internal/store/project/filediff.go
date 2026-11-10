package project

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// One file of a worktree, both sides, for the file viewer's diff (GetWorktreeFileDiff).
// Computed on every call through the runner; the base and merge base are the detail's
// (detailBase, mergeBaseOf), so the diff agrees with the detail's file list.

const (
	// FileDiffMax caps each side's contents.
	FileDiffMax = 1 << 20
	// blobReadMax is the largest blob read at all: the runner buffers a command's
	// whole output, so a larger one is reported truncated with no contents.
	blobReadMax = 32 << 20
)

// DiffScope is what WorktreeFileDiff compares.
type DiffScope int

const (
	// DiffWorking compares the merge base with the file on disk.
	DiffWorking DiffScope = iota
	// DiffBranch compares the merge base with HEAD.
	DiffBranch
)

// FileDiffRequest names one file of a worktree.
type FileDiffRequest struct {
	ProjectID string
	Path      string // the worktree
	// File is the worktree-relative path of the new side; OldPath, of the old side
	// (a rename's source), defaults to File.
	File, OldPath string
	Scope         DiffScope
}

// FileVersion is one side of a file diff.
type FileVersion struct {
	Present   bool
	Contents  []byte // at most FileDiffMax
	Truncated bool
	Binary    bool
	// Submodule: a submodule at the path, in a comparison (compare.go); Contents is then
	// "Subproject commit <sha>\n". WorktreeFileDiff calls it absent.
	Submodule bool
}

// WorktreeFileDiff is both sides of one file.
type WorktreeFileDiff struct {
	// BaseRef, MergeBase and Head are as in WorktreeDetail (Head resolved now).
	BaseRef, MergeBase, Head string
	Old, New                 FileVersion
	// Status is A, D, M, R, or "" (unchanged or absent on both sides); see diffStatus.
	Status string
	// Error says why the scope cannot be compared (DiffBranch without a merge base).
	Error string
}

// WorktreeFileDiff implements Store.
func (g *Git) WorktreeFileDiff(ctx context.Context, req FileDiffRequest) (WorktreeFileDiff, error) {
	file, err := comparePath(req.File)
	if err != nil {
		return WorktreeFileDiff{}, err
	}
	oldPath := file
	if req.OldPath != "" {
		if oldPath, err = comparePath(req.OldPath); err != nil {
			return WorktreeFileDiff{}, err
		}
	}
	st, slot, path, err := g.gitWorktree(req.ProjectID, req.Path)
	if err != nil {
		return WorktreeFileDiff{}, err
	}
	run := func(args ...string) ([]byte, error) { return g.runner.Run(ctx, path, args...) }
	b, err := g.currentBase(ctx, st, slot, req.ProjectID, path, run)
	if err != nil {
		return WorktreeFileDiff{}, err
	}
	d := WorktreeFileDiff{Head: b.head, BaseRef: b.baseRef, MergeBase: b.mergeBase}

	var oldRev string
	switch req.Scope {
	case DiffBranch:
		switch {
		case d.Head == "":
			d.Error = "the branch has no commits yet"
		case d.BaseRef == "":
			d.Error = "the worktree has no base branch to compare with"
		case d.MergeBase == "":
			d.Error = fmt.Sprintf("HEAD has no merge base with %s", d.BaseRef)
		}
		if d.Error != "" {
			return d, nil
		}
		oldRev = d.MergeBase
		if d.New, err = g.readBlob(ctx, path, d.Head, file); err != nil {
			return WorktreeFileDiff{}, err
		}
	default:
		oldRev = cmp.Or(d.MergeBase, d.Head) // no base: the detail lists changes against HEAD
		if d.New, err = readWorktreeFile(path, file); err != nil {
			return WorktreeFileDiff{}, err
		}
	}
	if oldRev != "" { // an unborn branch's old side is the empty tree
		if d.Old, err = g.readBlob(ctx, path, oldRev, oldPath); err != nil {
			return WorktreeFileDiff{}, err
		}
	}
	d.Status = diffStatus(d.Old, d.New, oldPath != file)
	return d, nil
}

// gitWorktree finds the git worktree at path, symlinks resolved: its project, its slot
// and its real path. NotFound for an unknown worktree, or one of another project.
func (g *Git) gitWorktree(projectID, path string) (*projectState, *wtSlot, string, error) {
	path = filepath.Clean(path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	st, slot := g.project(projectID), g.slot(projectID, path)
	if st == nil || slot == nil {
		return nil, nil, "", fmt.Errorf("%w: worktree %q in project %q", ErrNotFound, path, projectID)
	}
	if err := requireGit(st.meta.Load()); err != nil {
		return nil, nil, "", err
	}
	return st, slot, path, nil
}

// currentBase is a worktree's HEAD and base as they are now.
type currentBase struct{ head, baseRef, mergeBase string }

// currentBase reads them: HEAD now, not the snapshot's, as a commit the status job has
// not seen yet would otherwise pair a fresh working tree with a stale merge base. The
// base and merge base are the detail's (detailBase, mergeBaseOf).
func (g *Git) currentBase(ctx context.Context, st *projectState, slot *wtSlot, projectID, path string, run func(...string) ([]byte, error)) (currentBase, error) {
	wt := *slot.cur.Load()
	out, err := run("rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	switch {
	case err == nil:
		wt.Head = string(trimNL(out))
	case isExit(err, 1): // unborn branch
		wt.Head = ""
	default:
		return currentBase{}, err
	}
	b := currentBase{head: wt.Head}
	var baseSHA string
	b.baseRef, baseSHA = g.detailBase(ctx, st, wt)
	if b.mergeBase, err = g.mergeBaseOf(wtKey{projectID, path}, headKey{head: wt.Head, baseRef: b.baseRef, baseSHA: baseSHA}, run); err != nil {
		return currentBase{}, err
	}
	return b, nil
}

// mergeBaseOf returns key's merge base: the worktree's cached head part's when its key
// matches (the detail computed it), else `git merge-base`. No base, or no merge base,
// is "".
func (g *Git) mergeBaseOf(k wtKey, key headKey, run func(...string) ([]byte, error)) (string, error) {
	if key.head == "" || key.baseSHA == "" {
		return "", nil
	}
	g.details.mu.Lock()
	hp := g.details.heads[k]
	g.details.mu.Unlock()
	if hp != nil && hp.key == key {
		return hp.mergeBase, nil
	}
	return runMergeBase(key, run)
}

// runMergeBase runs `git merge-base <head> <base>`. Exit 1 (unrelated histories, or
// beyond a shallow boundary) is no merge base: "" and no error.
func runMergeBase(key headKey, run func(...string) ([]byte, error)) (string, error) {
	out, err := run("merge-base", key.head, key.baseSHA)
	switch {
	case err == nil:
		return string(trimNL(out)), nil
	case isExit(err, 1):
		return "", nil
	default:
		return "", err
	}
}

// worktreeRelative validates a worktree-relative path and returns it cleaned, with
// forward slashes.
func worktreeRelative(p string) (string, error) {
	c := filepath.Clean(filepath.FromSlash(p))
	if p == "" || !filepath.IsLocal(c) {
		return "", fmt.Errorf("%w: file %q must be a path inside the worktree", ErrInvalidArgument, p)
	}
	return filepath.ToSlash(c), nil
}

// readBlob reads file at rev: `ls-tree` for its type and size (exit 0 with no output
// when the path is not there), then `cat-file blob`. A tree or submodule at the path
// is not present.
func (g *Git) readBlob(ctx context.Context, dir, rev, file string) (FileVersion, error) {
	out, err := g.runner.Run(ctx, dir, "--literal-pathspecs", "ls-tree", "-z", "--long", "--full-tree", rev, "--", file)
	if err != nil {
		return FileVersion{}, err
	}
	e, ok := parseLsTree(out, file)
	if !ok || e.kind != "blob" {
		return FileVersion{}, nil
	}
	return g.readObject(ctx, dir, e.oid, e.size)
}

// readObject reads a blob of the given size, up to FileDiffMax of it.
func (g *Git) readObject(ctx context.Context, dir, oid string, size int64) (FileVersion, error) {
	v := FileVersion{Present: true, Truncated: size > FileDiffMax}
	if size > blobReadMax {
		return v, nil
	}
	b, err := g.runner.Run(ctx, dir, "cat-file", "blob", oid)
	if err != nil {
		return FileVersion{}, err
	}
	if len(b) > FileDiffMax {
		b, v.Truncated = b[:FileDiffMax], true
	}
	v.Contents, v.Binary = b, fsx.LooksBinary(b)
	return v, nil
}

// lsTreeEntry is one record of `git ls-tree --long`.
type lsTreeEntry struct {
	kind, oid string // kind: blob, tree, commit
	size      int64  // a blob's
}

// parseLsTree finds file's entry in `git ls-tree -z --long` output ("<mode> <type> <oid>
// <size>\t<path>\0", the size "-" for all but a blob, "BAD" for a blob a partial clone
// lacks and may not fetch; that entry has no size, and reading it says what is wrong).
func parseLsTree(out []byte, file string) (lsTreeEntry, bool) {
	for _, rec := range splitZ(out) {
		meta, path, found := strings.Cut(rec, "\t")
		if !found || path != file {
			continue
		}
		f := strings.Fields(meta)
		if len(f) != 4 {
			return lsTreeEntry{}, false
		}
		e := lsTreeEntry{kind: f[1], oid: f[2]}
		if e.kind == "blob" && f[3] != "BAD" {
			n, err := strconv.ParseInt(f[3], 10, 64)
			if err != nil {
				return lsTreeEntry{}, false
			}
			e.size = n
		}
		return e, true
	}
	return lsTreeEntry{}, false
}

// maxLinkHops is how many links one path may pass through (macOS's MAXSYMLINKS).
const maxLinkHops = 32

// followParents follows the links in file's directories under root, as an open would, and
// returns where that lands, with no link left but perhaps the last part, which a read
// takes as its target. ok is false for a path that does not lead anywhere: gone, under a
// file, through a link that leaves root, or through too many.
func followParents(root *os.Root, file string) (rel string, ok bool, err error) {
	var done []string
	todo := strings.Split(file, "/")
	for hops := 0; len(todo) > 0; {
		part := todo[0]
		todo = todo[1:]
		switch part {
		case "", ".":
			continue
		case "..":
			if len(done) == 0 {
				return "", false, nil
			}
			done = done[:len(done)-1]
			continue
		}
		done = append(done, part)
		here := path.Join(done...)
		if len(todo) == 0 {
			return here, true, nil
		}
		fi, err := root.Lstat(filepath.FromSlash(here))
		switch {
		case errors.Is(err, fs.ErrPermission):
			return "", false, err
		case err != nil:
			return "", false, nil
		case fi.Mode()&fs.ModeSymlink == 0:
			continue
		}
		target, err := root.Readlink(filepath.FromSlash(here))
		if hops++; err != nil || hops > maxLinkHops || filepath.IsAbs(target) {
			return "", false, nil
		}
		done = done[:len(done)-1]
		todo = append(strings.Split(filepath.ToSlash(target), "/"), todo...)
	}
	return "", false, nil
}

// readWorktreeFile reads file from the worktree at dir as git would store it: a regular
// file's contents, a symlink's target. Missing, a directory, or beyond a link that leaves
// the worktree: not present. Beyond a link into .git, which comparePath cannot see in the
// path as written: refused. os.Root would follow that one, since it stays inside.
// Everything goes through an os.Root at the worktree, which no link leaves, and the file
// is opened as what it was seen to be (openRegular), so nothing here can block.
func readWorktreeFile(dir, file string) (FileVersion, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return FileVersion{}, fmt.Errorf("project: read %s: %w", dir, err)
	}
	defer func() { _ = root.Close() }()
	real, ok, err := followParents(root, file)
	switch {
	case err != nil:
		return FileVersion{}, fmt.Errorf("project: read %s: %w", file, err)
	case !ok:
		return FileVersion{}, nil
	case insideGit(real):
		return FileVersion{}, fmt.Errorf("%w: file %q is inside .git", ErrInvalidArgument, file)
	}
	rel := filepath.FromSlash(real)
	fi, err := root.Lstat(rel)
	switch {
	case errors.Is(err, fs.ErrPermission):
		return FileVersion{}, fmt.Errorf("project: read %s: %w", file, err)
	case err != nil: // gone, under a file, or beyond a link that leaves
		return FileVersion{}, nil
	case fi.Mode()&fs.ModeSymlink != 0:
		target, err := root.Readlink(rel)
		if err != nil {
			return FileVersion{}, fmt.Errorf("project: read %s: %w", file, err)
		}
		return FileVersion{Present: true, Contents: []byte(target)}, nil
	case !fi.Mode().IsRegular():
		return FileVersion{}, nil
	}
	f, err := openRegular(root, rel)
	if err != nil {
		return FileVersion{}, fmt.Errorf("project: read %s: %w", file, err)
	}
	if f == nil {
		return FileVersion{}, nil
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, FileDiffMax+1))
	if err != nil {
		return FileVersion{}, fmt.Errorf("project: read %s: %w", file, err)
	}
	v := FileVersion{Present: true}
	if len(b) > FileDiffMax {
		b, v.Truncated = b[:FileDiffMax], true
	}
	v.Contents, v.Binary = b, fsx.LooksBinary(b)
	return v, nil
}

// diffStatus is one letter for the pair: A (new only), D (old only), R (both, renamed),
// M (both, different or not fully read), "" (equal, or neither).
func diffStatus(old, new FileVersion, renamed bool) string {
	switch {
	case !old.Present && !new.Present:
		return ""
	case !old.Present:
		return "A"
	case !new.Present:
		return "D"
	case renamed:
		return "R"
	case old.Truncated || new.Truncated || !bytes.Equal(old.Contents, new.Contents):
		return "M"
	}
	return ""
}
