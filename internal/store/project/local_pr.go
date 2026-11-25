package project

import (
	"bytes"
	"cmp"
	"context"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// LocalDiff computes a GitHub-compatible three-dot unified diff (`git diff
// <merge-base(baseSHA, headSHA)> <headSHA>`) from a locally registered git clone matching
// slug, bounded to maxBytes (trimmed to a whole line boundary when truncated).
//
// Returns ok=false whenever no matching local git repository exists, either commit is not
// present locally, merge-base fails (unrelated histories or shallow boundary), or a
// partial clone lacks required objects. All git commands run guarded (no fsmonitor, no
// index refresh, GIT_NO_LAZY_FETCH=1).
func (g *Git) LocalDiff(ctx context.Context, slug, baseSHA, headSHA string, maxBytes int) (diff []byte, truncated bool, ok bool) {
	baseSHA = strings.ToLower(strings.TrimSpace(baseSHA))
	headSHA = strings.ToLower(strings.TrimSpace(headSHA))
	if slug == "" || maxBytes <= 0 || !isSHA(baseSHA) || !isSHA(headSHA) {
		return nil, false, false
	}
	repos := g.matchingGitProjects(slug)
	if len(repos) == 0 {
		return nil, false, false
	}
	ctx = guarded(ctx)
	for _, r := range repos {
		if ctx.Err() != nil {
			return nil, false, false
		}
		if d, trunc, hit := g.localDiffIn(ctx, r, baseSHA, headSHA, maxBytes); hit {
			return d, trunc, true
		}
	}
	return nil, false, false
}

// LocalCommitFile reads one file at commitSHA from a locally registered git clone
// matching slug, respecting maxBytes and matching GitHub raw-file semantics (directories
// and submodules report notFound=true; missing paths report notFound=true only when
// commitSHA is verified present locally and the repository is not a partial clone).
func (g *Git) LocalCommitFile(ctx context.Context, slug, commitSHA, filePath string, maxBytes int) (contents []byte, truncated, binary, notFound, ok bool) {
	commitSHA = strings.ToLower(strings.TrimSpace(commitSHA))
	if slug == "" || maxBytes <= 0 || !isSHA(commitSHA) {
		return nil, false, false, false, false
	}
	clean, valid := cleanRepoPath(filePath)
	if !valid {
		return nil, false, false, false, false
	}
	repos := g.matchingGitProjects(slug)
	if len(repos) == 0 {
		return nil, false, false, false, false
	}
	ctx = guarded(ctx)
	for _, r := range repos {
		if ctx.Err() != nil {
			return nil, false, false, false, false
		}
		if c, trunc, bin, nf, hit := g.localCommitFileIn(ctx, r, commitSHA, clean, maxBytes); hit {
			return c, trunc, bin, nf, true
		}
	}
	return nil, false, false, false, false
}

type localRepo struct {
	repoDir   string
	commonDir string
}

func (g *Git) matchingGitProjects(slug string) []localRepo {
	g.mu.RLock()
	defer g.mu.RUnlock()
	var repos []localRepo
	for _, st := range g.projects {
		m := st.meta.Load()
		if m != nil && m.Git && m.Path != "" && strings.EqualFold(m.GitHubSlug, slug) {
			repos = append(repos, localRepo{repoDir: m.Path, commonDir: m.commonDir()})
		}
	}
	slices.SortFunc(repos, func(a, b localRepo) int { return cmp.Compare(a.repoDir, b.repoDir) })
	return repos
}

// isShallowRepo reports whether the repository has a non-empty shallow file. In a
// shallow clone `git merge-base` can still exit 0 with an older ancestor instead of the
// true merge base, producing a wrong diff, so LocalDiff falls back to GitHub REST.
func isShallowRepo(commonDir string) bool {
	if commonDir == "" {
		return false
	}
	fi, err := os.Stat(filepath.Join(commonDir, "shallow"))
	return err == nil && fi.Size() > 0
}

func (g *Git) localDiffIn(ctx context.Context, r localRepo, baseSHA, headSHA string, maxBytes int) ([]byte, bool, bool) {
	if isShallowRepo(r.commonDir) {
		return nil, false, false
	}
	if !g.commitsPresent(ctx, r, baseSHA, headSHA) {
		return nil, false, false
	}
	out, err := g.runner.Run(ctx, r.repoDir, "merge-base", baseSHA, headSHA)
	if err != nil {
		return nil, false, false
	}
	mergeBase := string(trimNL(out))
	if !isSHA(mergeBase) {
		return nil, false, false
	}
	// Pin diff config and evaluate attributes against the empty tree (--attr-source, git >= 2.40)
	// so repo .gitattributes (e.g. `-diff` on generated dist files) and user ~/.gitconfig
	// settings never diverge from GitHub's v3.diff output.
	args := []string{
		"--attr-source=" + emptyTree,
		"-c", "diff.renames=true",
		"-c", "diff.renameLimit=0",
		"-c", "diff.interHunkContext=0",
		"-c", "diff.suppressBlankEmpty=false",
		"-c", "diff.indentHeuristic=true",
		"-c", "core.quotePath=true",
		"diff",
		"-O", os.DevNull,
		"--no-ext-diff",
		"--no-color",
		"--no-textconv",
		"--diff-algorithm=myers",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		"-M",
		"-U3",
		"--full-index",
		"--submodule=short",
		"--ignore-submodules=none",
		mergeBase,
		headSHA,
		"--",
	}
	if sr, ok := g.runner.(StreamRunner); ok {
		diffCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		w := &limitedDiffWriter{max: maxBytes, cancel: cancel}
		err := sr.RunStream(diffCtx, r.repoDir, w, args...)
		if ctx.Err() != nil {
			return nil, false, false
		}
		if w.truncated {
			return trimWholeLines(w.buf.Bytes()), true, true
		}
		if err != nil {
			return nil, false, false
		}
		return w.buf.Bytes(), false, true
	}
	raw, err := g.runner.Run(ctx, r.repoDir, args...)
	if err != nil {
		return nil, false, false
	}
	if len(raw) > maxBytes {
		return trimWholeLines(raw[:maxBytes]), true, true
	}
	return raw, false, true
}

func (g *Git) commitsPresent(ctx context.Context, r localRepo, shas ...string) bool {
	if g.catFiles != nil {
		present, fallback, err := g.catFiles.commitsExist(ctx, r.repoDir, r.commonDir, shas...)
		if err != nil {
			return false
		}
		if !fallback {
			return present
		}
	}
	for _, sha := range shas {
		out, err := g.runner.Run(ctx, r.repoDir, "rev-parse", "--verify", "--quiet", "--end-of-options", sha+"^{commit}")
		if err != nil || !strings.EqualFold(string(trimNL(out)), sha) {
			return false
		}
	}
	return true
}

func (g *Git) localCommitFileIn(ctx context.Context, r localRepo, commitSHA, cleanPath string, maxBytes int) ([]byte, bool, bool, bool, bool) {
	if g.catFiles != nil {
		contents, truncated, binary, notFound, ok, fallback, err := g.catFiles.readCommitFile(ctx, r.repoDir, r.commonDir, commitSHA, cleanPath, maxBytes)
		if err != nil {
			return nil, false, false, false, false
		}
		if !fallback {
			return contents, truncated, binary, notFound, ok
		}
	}
	// Fallback when catFilePool is disabled or a custom test Runner is injected.
	out, err := g.runner.Run(ctx, r.repoDir, "rev-parse", "--verify", "--quiet", "--end-of-options", commitSHA+"^{commit}")
	if err != nil || !strings.EqualFold(string(trimNL(out)), commitSHA) {
		return nil, false, false, false, false
	}
	lsOut, err := g.runner.Run(ctx, r.repoDir, "--literal-pathspecs", "ls-tree", "-z", "--long", "--full-tree", commitSHA, "--", cleanPath)
	if err != nil {
		return nil, false, false, false, false
	}
	e, found := parseLsTree(lsOut, cleanPath)
	if !found {
		if isPartialClone(r.commonDir) {
			return nil, false, false, false, false
		}
		return nil, false, false, true, true
	}
	if e.kind != "blob" {
		// Directory (tree) or submodule (commit): matches GitHub raw-file NotFound.
		return nil, false, false, true, true
	}
	if e.size > blobReadMax {
		return nil, true, false, false, true
	}
	b, err := g.runner.Run(ctx, r.repoDir, "cat-file", "blob", e.oid)
	if err != nil {
		return nil, false, false, false, false
	}
	truncated := len(b) > maxBytes
	if truncated {
		b = b[:maxBytes]
	}
	return b, truncated, fsx.LooksBinary(b), false, true
}

func cleanRepoPath(filePath string) (string, bool) {
	if filePath == "" || strings.IndexByte(filePath, 0) >= 0 {
		return "", false
	}
	clean := path.Clean(filePath)
	if strings.HasPrefix(clean, "/") || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return clean, true
}

func trimWholeLines(b []byte) []byte {
	if i := bytes.LastIndexByte(b, '\n'); i >= 0 {
		return b[:i+1]
	}
	return b
}

// limitedDiffWriter keeps up to max bytes from a streaming `git diff` and cancels the
// command's context as soon as output exceeds max so huge diffs stop immediately.
type limitedDiffWriter struct {
	buf       bytes.Buffer
	max       int
	truncated bool
	cancel    context.CancelFunc
}

func (w *limitedDiffWriter) Write(p []byte) (int, error) {
	if w.truncated {
		return len(p), nil
	}
	rem := w.max - w.buf.Len()
	if len(p) <= rem {
		w.buf.Write(p)
		return len(p), nil
	}
	if rem > 0 {
		w.buf.Write(p[:rem])
	}
	w.truncated = true
	if w.cancel != nil {
		w.cancel()
	}
	return len(p), nil
}
