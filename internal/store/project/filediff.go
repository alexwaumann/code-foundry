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
	"path/filepath"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// One file of a worktree, both sides, for the file viewer's diff (GetWorktreeFileDiff).
// Computed on every call through the runner; the base and merge base are the detail's
// (detailBase, mergeBaseOf), so the diff agrees with the worktree panel's file list.

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
	file, err := worktreeRelative(req.File)
	if err != nil {
		return WorktreeFileDiff{}, err
	}
	oldPath := file
	if req.OldPath != "" {
		if oldPath, err = worktreeRelative(req.OldPath); err != nil {
			return WorktreeFileDiff{}, err
		}
	}
	path := filepath.Clean(req.Path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	st, slot := g.project(req.ProjectID), g.slot(req.ProjectID, path)
	if st == nil || slot == nil {
		return WorktreeFileDiff{}, fmt.Errorf("%w: worktree %q in project %q", ErrNotFound, path, req.ProjectID)
	}
	if err := requireGit(st.meta.Load()); err != nil {
		return WorktreeFileDiff{}, err
	}
	run := func(args ...string) ([]byte, error) { return g.runner.Run(ctx, path, args...) }

	// HEAD now, not the snapshot's: a commit the status job has not seen yet would
	// otherwise pair a fresh working tree with a stale merge base.
	wt := *slot.cur.Load()
	out, err := run("rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	switch {
	case err == nil:
		wt.Head = string(trimNL(out))
	case isExit(err, 1): // unborn branch
		wt.Head = ""
	default:
		return WorktreeFileDiff{}, err
	}
	d := WorktreeFileDiff{Head: wt.Head}
	var baseSHA string
	d.BaseRef, baseSHA = g.detailBase(ctx, st, wt)
	if d.MergeBase, err = g.mergeBaseOf(wtKey{req.ProjectID, path}, headKey{head: wt.Head, baseRef: d.BaseRef, baseSHA: baseSHA}, run); err != nil {
		return WorktreeFileDiff{}, err
	}

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
	oid, size, ok := parseLsTreeBlob(out, file)
	if !ok {
		return FileVersion{}, nil
	}
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

// parseLsTreeBlob finds file's entry in `git ls-tree -z --long` output ("<mode> <type>
// <oid> <size>\t<path>\0") and returns its oid and size when it is a blob.
func parseLsTreeBlob(out []byte, file string) (oid string, size int64, ok bool) {
	for _, rec := range splitZ(out) {
		meta, path, found := strings.Cut(rec, "\t")
		if !found || path != file {
			continue
		}
		f := strings.Fields(meta)
		if len(f) != 4 || f[1] != "blob" {
			return "", 0, false
		}
		n, err := strconv.ParseInt(f[3], 10, 64)
		if err != nil {
			return "", 0, false
		}
		return f[2], n, true
	}
	return "", 0, false
}

// readWorktreeFile reads file from the worktree at dir as git would store it: a
// regular file's contents, a symlink's target. Missing, a directory, or under a
// symlinked directory that leaves the worktree: not present.
func readWorktreeFile(dir, file string) (FileVersion, error) {
	full := filepath.Join(dir, filepath.FromSlash(file))
	parent, err := filepath.EvalSymlinks(filepath.Dir(full))
	if errors.Is(err, fs.ErrNotExist) {
		return FileVersion{}, nil
	}
	if err != nil {
		return FileVersion{}, fmt.Errorf("project: read %s: %w", full, err)
	}
	if !fsx.Within(dir, parent) {
		return FileVersion{}, nil // git does not follow a symlinked directory either
	}
	full = filepath.Join(parent, filepath.Base(full))
	fi, err := os.Lstat(full)
	if errors.Is(err, fs.ErrNotExist) {
		return FileVersion{}, nil
	}
	if err != nil {
		return FileVersion{}, fmt.Errorf("project: read %s: %w", full, err)
	}
	switch {
	case fi.Mode()&fs.ModeSymlink != 0:
		target, err := os.Readlink(full)
		if err != nil {
			return FileVersion{}, fmt.Errorf("project: read %s: %w", full, err)
		}
		return FileVersion{Present: true, Contents: []byte(target)}, nil
	case !fi.Mode().IsRegular():
		return FileVersion{}, nil
	}
	f, err := os.Open(full)
	if errors.Is(err, fs.ErrNotExist) {
		return FileVersion{}, nil
	}
	if err != nil {
		return FileVersion{}, fmt.Errorf("project: read %s: %w", full, err)
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, FileDiffMax+1))
	if err != nil {
		return FileVersion{}, fmt.Errorf("project: read %s: %w", full, err)
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
