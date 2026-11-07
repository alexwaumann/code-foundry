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
	"slices"
	"strconv"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"
)

// Comparing any two sources of a checkout (docs/notes/diff-viewer-1.md):
// CompareWorktree lists what differs and counts it, CompareFile reads one file's two
// sides when someone looks at it, so a large comparison never reads every file.
//
// Refs and paths come from callers, the model among them, so this is a boundary. A ref
// is checked (checkRef) and resolved to a sha behind --end-of-options, and only the sha
// reaches any later command. Paths never reach `git diff`: the whole diff is listed and
// matched here (which also keeps a rename whole when one of its paths is asked for).
// A read names its path behind `--literal-pathspecs … --`, or opens it under an os.Root,
// and .git is refused both as a caller writes it and where its links lead.
//
// Every command runs under guarded: what a checkout's config can still start is in
// docs/notes/diff-viewer-1.md.

const (
	// CompareFilesMax caps WorktreeCompare.Files; the totals still count every file.
	CompareFilesMax = 10_000
	// comparePathsMax caps CompareRequest.Paths.
	comparePathsMax = 1000
	// comparePathMax is the longest path taken, in bytes (macOS's PATH_MAX).
	comparePathMax = 1024
	// refMax is the longest ref taken, in bytes.
	refMax = 256
	// untrackedCountMax bounds what one comparison reads to count untracked files' lines.
	// Files past it are listed with no counts.
	untrackedCountMax = 64 << 20
	// submoduleMode is a gitlink's mode, in `git diff --raw` and `git ls-files -s`.
	submoduleMode = "160000"
	// objectsMissing is the answer for a partial clone without an object it needs: guarded
	// fetches nothing.
	objectsMissing = "this comparison needs objects that are not on this machine: this is a partial clone, and a comparison does not fetch"
)

// DiffSourceKind is what a comparison's side is.
type DiffSourceKind int

const (
	// SourceMergeBase is the merge base GetWorktreeDetail uses: HEAD without a base or
	// without one in common, the empty tree on an unborn branch.
	SourceMergeBase DiffSourceKind = iota
	// SourceWorkingTree is the files on disk, untracked ones included.
	SourceWorkingTree
	// SourceStaged is the index.
	SourceStaged
	// SourceRef is the commit DiffSource.Ref names.
	SourceRef
)

// DiffSource is one side of a comparison.
type DiffSource struct {
	Kind DiffSourceKind
	// Ref is set with SourceRef, and only then (checkRef).
	Ref string
}

// ResolvedSource is a DiffSource as a comparison resolved it.
type ResolvedSource struct {
	Kind DiffSourceKind
	// Label is what to call it: the base ref, "HEAD", the ref as given, "Working tree",
	// "Staged".
	Label string
	// SHA is the commit or tree; empty for SourceWorkingTree and SourceStaged.
	SHA string
}

// CompareRequest names two sources of a worktree.
type CompareRequest struct {
	ProjectID string
	Path      string // the worktree
	Base      DiffSource
	Head      DiffSource
	// Paths limits the list to these worktree-relative files and directories.
	Paths []string
}

// CompareFileRequest names one file of a comparison.
type CompareFileRequest struct {
	ProjectID string
	Path      string // the worktree
	Base      DiffSource
	Head      DiffSource
	// File is the worktree-relative path on the head side; OldPath, on the base side (a
	// rename's source), defaults to File.
	File, OldPath string
}

// CompareChange is one file of a comparison, base to head.
type CompareChange struct {
	// Path is as git names it: an embedded repository (Submodule, not yet added) ends in /.
	Path    string
	OldPath string // renames and copies
	// Status is a git letter (A M D R C T), U for an unmerged path, ? for an untracked
	// file (D with the working tree as base).
	Status         string
	Added, Deleted int
	Binary         bool
	Submodule      bool
}

// WorktreeCompare is what differs between two sources.
type WorktreeCompare struct {
	Files     []CompareChange // sorted by path, at most CompareFilesMax
	Truncated bool
	// TotalFiles, TotalAdded and TotalDeleted count every file, listed or not.
	TotalFiles, TotalAdded, TotalDeleted int
	// SkippedNames counts the files left out of all of the above: a name that is not UTF-8,
	// possible in a tree, cannot travel in a response.
	SkippedNames int
	Base, Head   ResolvedSource
	// BaseRef and MergeBase are as in WorktreeDetail.
	BaseRef, MergeBase string
	// Error says why a source could not be resolved; the list is then empty.
	Error string
}

// CompareSides is both sides of one file of a comparison.
type CompareSides struct {
	Old, New FileVersion
	Status   string // see diffStatus
	Error    string // as WorktreeCompare.Error
}

// checkRef refuses what cannot be a single revision: an option, a range, a path in a
// tree (HEAD:file, :/text), or anything no ref may hold. What is left goes to rev-parse
// and is only ever a question about this repository.
func checkRef(ref string) error {
	refuse := func(why string) error {
		return fmt.Errorf("%w: ref %q %s", ErrInvalidArgument, ref, why)
	}
	switch {
	case ref == "":
		return fmt.Errorf("%w: a ref source needs a ref", ErrInvalidArgument)
	case len(ref) > refMax:
		return fmt.Errorf("%w: ref is %d bytes, at most %d", ErrInvalidArgument, len(ref), refMax)
	case strings.HasPrefix(ref, "-"):
		return refuse("cannot start with -")
	case strings.HasPrefix(ref, "^"): // an exclusion: rev-parse echoes it, ^ and all
		return refuse("cannot start with ^")
	case strings.Contains(ref, ".."):
		return refuse("cannot be a range")
	case strings.ContainsAny(ref, ":?*[\\"):
		return refuse(`cannot hold any of : ? * [ \`)
	case strings.IndexFunc(ref, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0:
		return refuse("cannot hold whitespace or control characters")
	}
	return nil
}

func checkSource(s DiffSource) error {
	if s.Kind == SourceRef {
		return checkRef(s.Ref)
	}
	if s.Ref != "" {
		return fmt.Errorf("%w: ref %q given for a source that is not a ref", ErrInvalidArgument, s.Ref)
	}
	return nil
}

// insideGit reports whether a slash-separated path is .git or below one, in any case as
// APFS has it.
func insideGit(p string) bool {
	for part := range strings.SplitSeq(p, "/") {
		if strings.EqualFold(part, ".git") {
			return true
		}
	}
	return false
}

// comparePath validates a worktree-relative path as worktreeRelative does and refuses
// .git: the repository's own files are never a side. That is the path as written;
// readWorktreeFile refuses one that gets there through a link.
func comparePath(p string) (string, error) {
	if len(p) > comparePathMax {
		return "", fmt.Errorf("%w: path is %d bytes, at most %d", ErrInvalidArgument, len(p), comparePathMax)
	}
	if strings.IndexByte(p, 0) >= 0 {
		return "", fmt.Errorf("%w: file %q holds a NUL", ErrInvalidArgument, p)
	}
	c, err := worktreeRelative(p)
	if err != nil {
		return "", err
	}
	if insideGit(c) {
		return "", fmt.Errorf("%w: file %q is inside .git", ErrInvalidArgument, p)
	}
	return c, nil
}

// comparison is two sources resolved in one worktree.
type comparison struct {
	dir        string
	run        func(args ...string) ([]byte, error)
	base, head ResolvedSource
	baseRef    string
	mergeBase  string
	err        string // a source that names nothing; see WorktreeCompare.Error
}

// openCompare checks both sources and resolves them in the worktree.
func (g *Git) openCompare(ctx context.Context, projectID, path string, base, head DiffSource) (*comparison, error) {
	if err := checkSource(base); err != nil {
		return nil, err
	}
	if err := checkSource(head); err != nil {
		return nil, err
	}
	st, slot, dir, err := g.gitWorktree(projectID, path)
	if err != nil {
		return nil, err
	}
	run := func(args ...string) ([]byte, error) { return g.runner.Run(ctx, dir, args...) }
	b, err := g.currentBase(ctx, st, slot, projectID, dir, run)
	if err != nil {
		return nil, err
	}
	c := &comparison{dir: dir, run: run, baseRef: b.baseRef, mergeBase: b.mergeBase}
	// Both, even when the first names nothing: a caller shows each side's label either way.
	var headWhy string
	if c.base, c.err, err = c.resolve(base, b); err != nil {
		return nil, err
	}
	if c.head, headWhy, err = c.resolve(head, b); err != nil {
		return nil, err
	}
	c.err = cmp.Or(c.err, headWhy)
	return c, nil
}

// resolve turns a source into a sha. A ref that names no commit is not an error: it was
// fine when the tab opened, and has since been deleted; why says so.
func (c *comparison) resolve(s DiffSource, b currentBase) (_ ResolvedSource, why string, _ error) {
	r := ResolvedSource{Kind: s.Kind}
	switch s.Kind {
	case SourceWorkingTree:
		r.Label = "Working tree"
	case SourceStaged:
		r.Label = "Staged"
	case SourceRef:
		r.Label = s.Ref
		// The sha, not the ref, is what every later command gets.
		out, err := c.run("rev-parse", "--verify", "--quiet", "--end-of-options", s.Ref+"^{commit}")
		switch {
		case noSuchCommit(err):
			return r, fmt.Sprintf("%s does not name a commit in this checkout", s.Ref), nil
		case err != nil:
			return r, "", err
		}
		// A bare sha or nothing: what comes back goes on every later command line.
		if r.SHA = string(trimNL(out)); !isSHA(r.SHA) {
			r.SHA = ""
			return r, fmt.Sprintf("%s does not name a commit in this checkout", s.Ref), nil
		}
	default:
		r.Label = "HEAD"
		if b.mergeBase != "" {
			r.Label = b.baseRef
		}
		r.SHA = cmp.Or(b.mergeBase, b.head, emptyTree)
	}
	return r, "", nil
}

// isSHA reports whether s is a full object name, SHA-1 or SHA-256.
func isSHA(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	return strings.IndexFunc(s, func(r rune) bool { return !('0' <= r && r <= '9' || 'a' <= r && r <= 'f') }) < 0
}

// noSuchCommit reports `rev-parse --verify --quiet` answering that nothing is there: exit
// 1, or 128 and silence for a reflog entry past the end (HEAD@{99}). A repository that
// cannot be read is 128 too, and says why.
func noSuchCommit(err error) bool {
	var ge *GitError
	return errors.As(err, &ge) && (ge.ExitCode == 1 || ge.ExitCode == 128 && strings.TrimSpace(ge.Stderr) == "")
}

// isMissingObject reports git stopping at an object a partial clone does not have.
// `ls-tree --long` does not stop; parseLsTree has that case.
func isMissingObject(err error) bool {
	var ge *GitError
	if !errors.As(err, &ge) {
		return false
	}
	msg := strings.TrimSpace(ge.Stderr)
	return strings.Contains(msg, "from promisor remote") || strings.HasSuffix(msg, ": bad file") ||
		strings.Contains(msg, "could not get object info")
}

// compareArgs is the `git diff` between two sources, whichever way round. Git has no
// form with the working tree or index as the old side, so those are reversed (-R).
func compareArgs(base, head ResolvedSource) []string {
	args := []string{"--raw", "--numstat", "--no-abbrev", "--no-textconv", "--ignore-submodules=none"}
	switch {
	case base.SHA != "" && head.SHA != "":
		args = append(args, base.SHA, head.SHA)
	case base.SHA != "" && head.Kind == SourceWorkingTree:
		args = append(args, base.SHA)
	case base.SHA != "":
		args = append(args, "--cached", base.SHA)
	case head.SHA != "" && base.Kind == SourceWorkingTree:
		args = append(args, "-R", head.SHA)
	case head.SHA != "":
		args = append(args, "-R", "--cached", head.SHA)
	case base.Kind == SourceWorkingTree: // to the index
		args = append(args, "-R")
	}
	return gitDiff(append(args, "--")...)
}

// sameSource: the two sides are one thing, so nothing differs.
func sameSource(a, b ResolvedSource) bool { return a.Kind == b.Kind && a.SHA == b.SHA }

// parseCompareZ parses `git diff --raw --numstat -z`: raw records
// (":<mode> <mode> <oid> <oid> <status>\0<path>\0", renames and copies with "<old>\0<new>\0"),
// then numstat records (parseNumstatZ's). During a merge the index-side diffs list an
// unmerged path twice: U, then M. It stays U, with the counts that are not zero.
func parseCompareZ(out []byte) []CompareChange {
	toks := splitZ(out)
	byPath := map[string]*CompareChange{}
	var order []*CompareChange
	for i := 0; i < len(toks); {
		t := toks[i]
		if strings.HasPrefix(t, ":") {
			f := strings.Fields(t)
			if len(f) != 5 || f[4] == "" || i+1 >= len(toks) {
				i++
				continue
			}
			c := CompareChange{Status: f[4][:1], Path: toks[i+1], Submodule: f[0] == ":"+submoduleMode || f[1] == submoduleMode}
			i += 2
			if (c.Status == "R" || c.Status == "C") && i < len(toks) {
				c.OldPath, c.Path = c.Path, toks[i]
				i++
			}
			if prev := byPath[c.Path]; prev != nil {
				prev.Submodule = prev.Submodule || c.Submodule
				continue
			}
			byPath[c.Path] = &c
			order = append(order, &c)
			continue
		}
		i++
		fields := strings.SplitN(t, "\t", 3)
		if len(fields) != 3 {
			continue
		}
		path := fields[2]
		if path == "" { // rename: old, new follow
			if i+1 >= len(toks) {
				break
			}
			path = toks[i+1]
			i += 2
		}
		c := byPath[path]
		if c == nil {
			continue
		}
		if fields[0] == "-" && fields[1] == "-" {
			c.Binary = true
			continue
		}
		added, _ := strconv.Atoi(fields[0])
		deleted, _ := strconv.Atoi(fields[1])
		c.Added, c.Deleted = max(c.Added, added), max(c.Deleted, deleted)
	}
	res := make([]CompareChange, len(order))
	for i, c := range order {
		res[i] = *c
	}
	return res
}

// parseUnmergedZ parses `git ls-files --unmerged -z` ("<mode> <oid> <stage>\t<path>\0",
// up to three per path) into its paths.
func parseUnmergedZ(out []byte) []string {
	var paths []string
	for _, rec := range splitZ(out) {
		// A path's stages are adjacent: the index is sorted by path, then stage.
		if _, p, ok := strings.Cut(rec, "\t"); ok && (len(paths) == 0 || paths[len(paths)-1] != p) {
			paths = append(paths, p)
		}
	}
	return paths
}

// changes lists what differs between the two sources, unsorted and unfiltered.
func (c *comparison) changes() ([]CompareChange, error) {
	if sameSource(c.base, c.head) {
		return nil, nil
	}
	out, err := c.run(compareArgs(c.base, c.head)...)
	if err != nil {
		return nil, err
	}
	list := parseCompareZ(out)
	touchesIndex := c.base.SHA == "" || c.head.SHA == "" // the working tree reads through it too
	if touchesIndex {
		if out, err = c.run("ls-files", "--unmerged", "-z"); err != nil {
			return nil, err
		}
		list = markUnmerged(list, parseUnmergedZ(out))
	}
	if c.base.Kind != SourceWorkingTree && c.head.Kind != SourceWorkingTree {
		return list, nil
	}
	if out, err = c.run("ls-files", "--others", "--exclude-standard", "-z"); err != nil {
		return nil, err
	}
	return addUntracked(c.dir, list, splitZ(out), c.base.Kind == SourceWorkingTree), nil
}

// markUnmerged makes each path U, adding one the diff left out: `git diff <commit>` lists
// an unmerged path as M, or not at all when the working tree matches the commit.
func markUnmerged(list []CompareChange, unmerged []string) []CompareChange {
	for _, p := range unmerged {
		if i := slices.IndexFunc(list, func(c CompareChange) bool { return c.Path == p }); i >= 0 {
			list[i].Status = "U"
			continue
		}
		list = append(list, CompareChange{Path: p, Status: "U"})
	}
	return list
}

// addUntracked adds the untracked files, counting their lines up to untrackedCountMax in
// all: added on the head side, deleted with the working tree as base (reversed). One the
// diff already lists (`git rm --cached` leaves D and the file on disk) is on both sides.
// An embedded repository comes as "dir/" and stays so, as the detail lists it: a row with
// nothing to count.
func addUntracked(dir string, list []CompareChange, untracked []string, reversed bool) []CompareChange {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return list
	}
	defer func() { _ = root.Close() }()
	listed := make(map[string]int, len(list))
	for i, c := range list {
		listed[c.Path] = i
	}
	budget := int64(untrackedCountMax)
	for _, p := range untracked {
		if i, ok := listed[strings.TrimSuffix(p, "/")]; ok {
			list[i].Status, list[i].Added, list[i].Deleted = "M", 0, 0
			continue
		}
		c := CompareChange{Path: p, Status: "?", Submodule: strings.HasSuffix(p, "/")}
		if !c.Submodule {
			lines, binary, read := countRootLines(root, p, budget)
			budget -= read
			c.Added, c.Binary = lines, binary
		}
		if reversed {
			c.Status, c.Added, c.Deleted = "D", 0, c.Added
		}
		list = append(list, c)
	}
	return list
}

// countRootLines counts an untracked file's lines as countLines does, reading at most
// limit bytes and never through a link: a symlink is the one line git would store.
func countRootLines(root *os.Root, file string, limit int64) (lines int, binary bool, read int64) {
	if limit <= 0 {
		return 0, false, 0
	}
	fi, err := root.Lstat(file)
	if err != nil {
		return 0, false, 0
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return 1, false, 0
	}
	f, err := openRegular(root, file)
	if err != nil || f == nil {
		return 0, false, 0
	}
	defer func() { _ = f.Close() }()
	lines, binary, read = countReader(f, min(limit, untrackedReadMax))
	return lines, binary, read
}

// openRegular opens a regular file under root. Nothing else opens: not a link swapped in
// since the caller looked, not a FIFO, which would otherwise block for good. Nil and no
// error when something else is there.
func openRegular(root *os.Root, file string) (*os.File, error) {
	f, err := root.OpenFile(file, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return nil, err
		}
		return nil, nil
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// matchesPath reports whether file is one of paths, or below one.
func matchesPath(file string, paths []string) bool {
	return slices.ContainsFunc(paths, func(p string) bool {
		return p == "." || file == p || strings.HasPrefix(file, p+"/")
	})
}

// CompareWorktree implements Store.
func (g *Git) CompareWorktree(ctx context.Context, req CompareRequest) (WorktreeCompare, error) {
	ctx = guarded(ctx)
	if len(req.Paths) > comparePathsMax {
		return WorktreeCompare{}, fmt.Errorf("%w: %d paths, at most %d", ErrInvalidArgument, len(req.Paths), comparePathsMax)
	}
	paths := make([]string, len(req.Paths))
	for i, p := range req.Paths {
		c, err := comparePath(p)
		if err != nil {
			return WorktreeCompare{}, err
		}
		paths[i] = c
	}
	c, err := g.openCompare(ctx, req.ProjectID, req.Path, req.Base, req.Head)
	if err != nil {
		return WorktreeCompare{}, err
	}
	res := WorktreeCompare{Base: c.base, Head: c.head, BaseRef: c.baseRef, MergeBase: c.mergeBase, Error: c.err}
	if c.err != "" {
		return res, nil
	}
	list, err := c.changes()
	if isMissingObject(err) {
		res.Error = objectsMissing
		return res, nil
	}
	if err != nil {
		return WorktreeCompare{}, err
	}
	res.fill(list, paths, CompareFilesMax)
	return res, nil
}

// fill keeps what paths ask for (all of it without any), sorted, totals every file and
// lists at most limit. A rename stays when either of its paths is asked for. A name that
// is not UTF-8 is counted apart (SkippedNames): one would fail the whole response.
func (w *WorktreeCompare) fill(list []CompareChange, paths []string, limit int) {
	if len(paths) > 0 {
		list = slices.DeleteFunc(list, func(f CompareChange) bool {
			return !matchesPath(f.Path, paths) && (f.OldPath == "" || !matchesPath(f.OldPath, paths))
		})
	}
	list = slices.DeleteFunc(list, func(f CompareChange) bool {
		skip := !utf8.ValidString(f.Path) || !utf8.ValidString(f.OldPath)
		if skip {
			w.SkippedNames++
		}
		return skip
	})
	slices.SortFunc(list, func(a, b CompareChange) int { return cmp.Compare(a.Path, b.Path) })
	w.TotalFiles = len(list)
	for _, f := range list {
		w.TotalAdded += f.Added
		w.TotalDeleted += f.Deleted
	}
	if len(list) > limit {
		list, w.Truncated = list[:limit], true
	}
	w.Files = list
}

// CompareFile implements Store.
func (g *Git) CompareFile(ctx context.Context, req CompareFileRequest) (CompareSides, error) {
	ctx = guarded(ctx)
	file, err := comparePath(req.File)
	if err != nil {
		return CompareSides{}, err
	}
	oldPath := file
	if req.OldPath != "" {
		if oldPath, err = comparePath(req.OldPath); err != nil {
			return CompareSides{}, err
		}
	}
	c, err := g.openCompare(ctx, req.ProjectID, req.Path, req.Base, req.Head)
	if err != nil {
		return CompareSides{}, err
	}
	if c.err != "" {
		return CompareSides{Error: c.err}, nil
	}
	var res CompareSides
	if res.Old, err = g.readSide(ctx, c, c.base, oldPath); err == nil {
		res.New, err = g.readSide(ctx, c, c.head, file)
	}
	if isMissingObject(err) {
		return CompareSides{Error: objectsMissing}, nil
	}
	if err != nil {
		return CompareSides{}, err
	}
	res.Status = diffStatus(res.Old, res.New, oldPath != file)
	return res, nil
}

func (g *Git) readSide(ctx context.Context, c *comparison, s ResolvedSource, file string) (FileVersion, error) {
	switch s.Kind {
	case SourceWorkingTree:
		return g.readWorkingSide(ctx, c.dir, file)
	case SourceStaged:
		e, ok, err := g.indexEntry(ctx, c.dir, file)
		if err != nil || !ok {
			return FileVersion{}, err
		}
		if e.mode == submoduleMode {
			return submoduleVersion(e.oid), nil
		}
		out, err := g.runner.Run(ctx, c.dir, "cat-file", "-s", e.oid)
		if err != nil {
			return FileVersion{}, err
		}
		size, err := strconv.ParseInt(string(trimNL(out)), 10, 64)
		if err != nil {
			return FileVersion{}, fmt.Errorf("project: size of %s: %w", e.oid, err)
		}
		return g.readObject(ctx, c.dir, e.oid, size)
	}
	return g.readRevSide(ctx, c.dir, s.SHA, file)
}

// readRevSide is readBlob, with a submodule at the path as the commit it points at.
func (g *Git) readRevSide(ctx context.Context, dir, rev, file string) (FileVersion, error) {
	out, err := g.runner.Run(ctx, dir, "--literal-pathspecs", "ls-tree", "-z", "--long", "--full-tree", rev, "--", file)
	if err != nil {
		return FileVersion{}, err
	}
	if e, ok := parseLsTree(out, file); ok {
		switch e.kind {
		case "blob":
			return g.readObject(ctx, dir, e.oid, e.size)
		case "commit":
			return submoduleVersion(e.oid), nil
		}
	}
	return FileVersion{}, nil
}

// readWorkingSide is readWorktreeFile, with a directory that is a repository, a submodule
// in the index or one embedded and not yet added, as the commit it has checked out: with
// git's "-dirty" for a submodule with changes of its own, the only difference a dirty
// submodule may have.
func (g *Git) readWorkingSide(ctx context.Context, dir, file string) (FileVersion, error) {
	v, err := readWorktreeFile(dir, file)
	if err != nil || v.Present {
		return v, err
	}
	e, tracked, err := g.indexEntry(ctx, dir, file)
	if err != nil || tracked && e.mode != submoduleMode {
		return FileVersion{}, err
	}
	if !hasGitDir(dir, file) {
		if tracked { // not initialized: git counts it as unchanged
			return submoduleVersion(e.oid), nil
		}
		return FileVersion{}, nil
	}
	head := cmp.Or(e.oid, "(no commits)")
	if out, err := g.runner.Run(ctx, dir+"/"+file, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"); err == nil {
		head = string(trimNL(out))
	}
	if !tracked {
		return submoduleVersion(head), nil
	}
	out, err := g.runner.Run(ctx, dir, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-color", "--no-textconv", "--ignore-submodules=none", "--", file)
	if err != nil {
		return FileVersion{}, err
	}
	if bytes.Contains(out, []byte("-dirty\n")) {
		head += "-dirty"
	}
	return submoduleVersion(head), nil
}

// hasGitDir reports whether file under dir is a real directory holding .git. Without one
// git would walk up and answer for the worktree around it.
func hasGitDir(dir, file string) bool {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return false
	}
	defer func() { _ = root.Close() }()
	fi, err := root.Lstat(file)
	if err != nil || !fi.IsDir() {
		return false
	}
	_, err = root.Lstat(file + "/.git")
	return err == nil
}

// submoduleVersion is a submodule as `git diff` shows one.
func submoduleVersion(oid string) FileVersion {
	return FileVersion{Present: true, Submodule: true, Contents: []byte("Subproject commit " + oid + "\n")}
}

type indexRecord struct{ mode, oid string }

// indexEntry finds file in the index. An unmerged path has up to three stages: ours (2)
// is what the checkout had, then theirs (3), then the ancestor (1).
func (g *Git) indexEntry(ctx context.Context, dir, file string) (indexRecord, bool, error) {
	out, err := g.runner.Run(ctx, dir, "--literal-pathspecs", "ls-files", "--stage", "-z", "--", file)
	if err != nil {
		return indexRecord{}, false, err
	}
	stages := map[string]indexRecord{}
	for _, rec := range splitZ(out) {
		meta, path, ok := strings.Cut(rec, "\t")
		f := strings.Fields(meta)
		if ok && path == file && len(f) == 3 {
			stages[f[2]] = indexRecord{mode: f[0], oid: f[1]}
		}
	}
	for _, stage := range []string{"0", "2", "3", "1"} {
		if e, ok := stages[stage]; ok {
			return e, true, nil
		}
	}
	return indexRecord{}, false, nil
}

// countReader counts r's lines, reading at most limit bytes: countLines' body. A NUL in
// the first binarySniff bytes means binary.
func countReader(r io.Reader, limit int64) (lines int, binary bool, read int64) {
	buf := make([]byte, 64<<10)
	last := byte('\n')
	for read < limit {
		n, err := r.Read(buf[:min(int64(len(buf)), limit-read)])
		if n > 0 {
			chunk := buf[:n]
			if read < binarySniff && bytes.IndexByte(chunk[:min(int64(n), binarySniff-read)], 0) >= 0 {
				return 0, true, read + int64(n)
			}
			lines += bytes.Count(chunk, []byte{'\n'})
			last = chunk[n-1]
			read += int64(n)
		}
		if err != nil {
			break
		}
	}
	if read > 0 && last != '\n' {
		lines++
	}
	return lines, false, read
}
