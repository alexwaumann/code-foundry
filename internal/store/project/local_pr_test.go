package project

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setGitHubOrigin(t *testing.T, repoDir, slug string) {
	t.Helper()
	url := "https://github.com/" + slug + ".git"
	if _, err := (ExecRunner{}).Run(context.Background(), repoDir, "remote", "set-url", "origin", url); err != nil {
		git(t, repoDir, "remote", "add", "origin", url)
	}
}

func headSHAOf(t *testing.T, dir string) string {
	t.Helper()
	out, err := (ExecRunner{}).Run(context.Background(), dir, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func TestLocalDiff(t *testing.T) {
	ctx := ctx20(t)
	f := newFixture(t)
	writeFile(t, filepath.Join(f.project, "keep.txt"), "one\ntwo\nthree\n")
	writeFile(t, filepath.Join(f.project, "old-name.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n")
	writeFile(t, filepath.Join(f.project, "gone.txt"), "gone\n")
	writeFile(t, filepath.Join(f.project, "base-only.txt"), "v1\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "common base")

	// Branch work diverges from common base.
	git(t, f.project, "checkout", "-q", "-b", "feat/pr")
	writeFile(t, filepath.Join(f.project, "keep.txt"), "one\nTWO\nthree\n")
	git(t, f.project, "mv", "old-name.txt", "new-name.txt")
	git(t, f.project, "rm", "-q", "gone.txt")
	writeFile(t, filepath.Join(f.project, "added.txt"), "brand new\n")
	writeFile(t, filepath.Join(f.project, "logo.bin"), "\x89PNG\x00\x01\x02")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "pr changes")
	prHead := headSHAOf(t, f.project)

	// Advance main after branching to verify three-dot merge-base diff (base-only.txt must NOT show up).
	git(t, f.project, "checkout", "-q", "main")
	writeFile(t, filepath.Join(f.project, "base-only.txt"), "v2 on main\n")
	git(t, f.project, "add", "base-only.txt")
	git(t, f.project, "commit", "-q", "-m", "main advanced")
	baseHead := headSHAOf(t, f.project)

	// Orphan commit for unrelated-histories fallback check.
	git(t, f.project, "checkout", "-q", "--orphan", "orphan-branch")
	git(t, f.project, "rm", "-rfq", ".")
	writeFile(t, filepath.Join(f.project, "orphan.txt"), "alone\n")
	git(t, f.project, "add", "orphan.txt")
	git(t, f.project, "commit", "-q", "-m", "orphan")
	orphanHead := headSHAOf(t, f.project)
	git(t, f.project, "checkout", "-q", "main")

	// Hostile/non-default user diff config must not break GitHub parity.
	git(t, f.project, "config", "diff.noprefix", "true")
	git(t, f.project, "config", "diff.mnemonicPrefix", "true")
	git(t, f.project, "config", "diff.renames", "false")
	git(t, f.project, "config", "diff.context", "10")
	git(t, f.project, "config", "diff.external", "/bin/false")
	git(t, f.project, "config", "color.diff", "always")

	setGitHubOrigin(t, f.project, "Acme/Widget")

	h := startHarness(t, "", Options{})
	if _, err := h.store.Register(ctx, f.project); err != nil {
		t.Fatal(err)
	}

	diff, trunc, ok := h.store.LocalDiff(ctx, "acme/widget", baseHead, prHead, 4<<20)
	if !ok || trunc {
		t.Fatalf("LocalDiff ok=%v trunc=%v, want ok=true trunc=false", ok, trunc)
	}
	s := string(diff)
	for _, want := range []string{
		"diff --git a/keep.txt b/keep.txt\n",
		"-two\n+TWO\n",
		"diff --git a/old-name.txt b/new-name.txt\n",
		"rename from old-name.txt\nrename to new-name.txt\n",
		"diff --git a/gone.txt b/gone.txt\ndeleted file mode",
		"diff --git a/added.txt b/added.txt\nnew file mode",
		"Binary files /dev/null and b/logo.bin differ\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("diff missing %q\nfull diff:\n%s", want, s)
		}
	}
	if strings.Contains(s, "base-only.txt") {
		t.Errorf("three-dot diff must not include commits only on base:\n%s", s)
	}
	if strings.Contains(s, "\x1b[") {
		t.Errorf("diff must not contain ANSI color escapes")
	}

	// Truncation cuts on a whole line boundary and stays within maxBytes.
	const limit = 120
	tdiff, ttrunc, tok := h.store.LocalDiff(ctx, "ACME/WIDGET", baseHead, prHead, limit)
	if !tok || !ttrunc {
		t.Fatalf("truncated LocalDiff ok=%v trunc=%v, want true/true", tok, ttrunc)
	}
	if len(tdiff) == 0 || len(tdiff) > limit || tdiff[len(tdiff)-1] != '\n' {
		t.Errorf("truncated diff len=%d last=%q, want <=%d ending in newline", len(tdiff), tdiff[len(tdiff)-1], limit)
	}

	// Fallback cases must all report ok=false.
	missingSHA := strings.Repeat("f", 40)
	cases := []struct {
		name, slug, base, head string
		maxBytes               int
	}{
		{"unregistered slug", "other/repo", baseHead, prHead, 4 << 20},
		{"missing head commit", "acme/widget", baseHead, missingSHA, 4 << 20},
		{"missing base commit", "acme/widget", missingSHA, prHead, 4 << 20},
		{"unrelated histories", "acme/widget", baseHead, orphanHead, 4 << 20},
		{"invalid sha", "acme/widget", "main", prHead, 4 << 20},
		{"range injection", "acme/widget", baseHead + ".." + prHead, prHead, 4 << 20},
		{"zero maxBytes", "acme/widget", baseHead, prHead, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, ok := h.store.LocalDiff(ctx, tc.slug, tc.base, tc.head, tc.maxBytes); ok {
				t.Errorf("LocalDiff(%q) = ok=true, want ok=false", tc.name)
			}
		})
	}
}

func TestLocalDiffMultipleClones(t *testing.T) {
	ctx := ctx20(t)
	f1 := newFixture(t)
	f2 := newFixture(t)
	setGitHubOrigin(t, f1.project, "acme/multi")
	setGitHubOrigin(t, f2.project, "acme/multi")

	writeFile(t, filepath.Join(f2.project, "only-in-two.txt"), "v1\n")
	git(t, f2.project, "add", ".")
	git(t, f2.project, "commit", "-q", "-m", "base")
	base := headSHAOf(t, f2.project)
	writeFile(t, filepath.Join(f2.project, "only-in-two.txt"), "v2\n")
	git(t, f2.project, "add", ".")
	git(t, f2.project, "commit", "-q", "-m", "head")
	head := headSHAOf(t, f2.project)

	h := startHarness(t, "", Options{})
	if _, err := h.store.Register(ctx, f1.project); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.Register(ctx, f2.project); err != nil {
		t.Fatal(err)
	}

	diff, trunc, ok := h.store.LocalDiff(ctx, "acme/multi", base, head, 4<<20)
	if !ok || trunc || !strings.Contains(string(diff), "+v2\n") {
		t.Fatalf("LocalDiff across two clones: ok=%v trunc=%v diff=%q", ok, trunc, diff)
	}
}

func TestLocalCommitFile(t *testing.T) {
	ctx := ctx20(t)
	f := newFixture(t)
	writeFile(t, filepath.Join(f.project, "README.md"), "# hello\n")
	if err := os.MkdirAll(filepath.Join(f.project, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.project, "dir", "with space.txt"), "spaced\n")
	writeFile(t, filepath.Join(f.project, "logo.png"), "\x89PNG\x00\x01")
	big := strings.Repeat("x", 2048)
	writeFile(t, filepath.Join(f.project, "big.txt"), big)
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "files")
	sha := headSHAOf(t, f.project)
	setGitHubOrigin(t, f.project, "acme/files")

	h := startHarness(t, "", Options{})
	if _, err := h.store.Register(ctx, f.project); err != nil {
		t.Fatal(err)
	}

	runChecks := func(t *testing.T) {
		t.Helper()
		tests := []struct {
			name     string
			slug     string
			ref      string
			path     string
			maxBytes int
			wantData []byte
			wantTr   bool
			wantBin  bool
			wantNF   bool
			wantOK   bool
		}{
			{"text", "acme/files", sha, "README.md", 1 << 20, []byte("# hello\n"), false, false, false, true},
			{"space in path", "Acme/Files", strings.ToUpper(sha), "dir/with space.txt", 1 << 20, []byte("spaced\n"), false, false, false, true},
			{"binary", "acme/files", sha, "logo.png", 1 << 20, []byte("\x89PNG\x00\x01"), false, true, false, true},
			{"truncated", "acme/files", sha, "big.txt", 512, []byte(big[:512]), true, false, false, true},
			{"directory is notFound", "acme/files", sha, "dir", 1 << 20, nil, false, false, true, true},
			{"missing path in verified commit is notFound", "acme/files", sha, "nope.txt", 1 << 20, nil, false, false, true, true},
			{"missing commit falls back", "acme/files", strings.Repeat("e", 40), "README.md", 1 << 20, nil, false, false, false, false},
			{"unregistered slug falls back", "other/repo", sha, "README.md", 1 << 20, nil, false, false, false, false},
			{"invalid path traversal", "acme/files", sha, "../secret", 1 << 20, nil, false, false, false, false},
			{"empty path", "acme/files", sha, "", 1 << 20, nil, false, false, false, false},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				got, tr, bin, nf, ok := h.store.LocalCommitFile(ctx, tt.slug, tt.ref, tt.path, tt.maxBytes)
				if ok != tt.wantOK || tr != tt.wantTr || bin != tt.wantBin || nf != tt.wantNF || !bytes.Equal(got, tt.wantData) {
					t.Errorf("got (%q, tr=%v, bin=%v, nf=%v, ok=%v), want (%q, tr=%v, bin=%v, nf=%v, ok=%v)",
						got, tr, bin, nf, ok, tt.wantData, tt.wantTr, tt.wantBin, tt.wantNF, tt.wantOK)
				}
			})
		}
	}

	t.Run("catfile_pool", runChecks)
	t.Run("ls_tree_fallback", func(t *testing.T) {
		h.store.catFiles.disabled.Store(true)
		runChecks(t)
	})
}

func TestLocalPRPartialCloneFallback(t *testing.T) {
	ctx := ctx20(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(root, "src")
	dst := filepath.Join(root, "partial")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, src, "init", "-q", "-b", "main")
	git(t, src, "config", "user.name", "t")
	git(t, src, "config", "user.email", "t@t")
	git(t, src, "config", "uploadpack.allowFilter", "true")
	writeFile(t, filepath.Join(src, "a.txt"), "v1\n")
	git(t, src, "add", ".")
	git(t, src, "commit", "-q", "-m", "c1")
	base := headSHAOf(t, src)
	writeFile(t, filepath.Join(src, "a.txt"), "v2\n")
	git(t, src, "add", ".")
	git(t, src, "commit", "-q", "-m", "c2")
	head := headSHAOf(t, src)

	git(t, root, "clone", "-q", "--filter=blob:none", "--no-checkout", "file://"+src, dst)
	setGitHubOrigin(t, dst, "acme/partial")

	h := startHarness(t, "", Options{AllowedRoot: root})
	if _, err := h.store.Register(ctx, dst); err != nil {
		t.Fatal(err)
	}

	// Missing promisor blobs must NOT trigger lazy fetch and must return ok=false.
	if _, _, ok := h.store.LocalDiff(ctx, "acme/partial", base, head, 4<<20); ok {
		t.Error("LocalDiff on partial clone with missing blobs returned ok=true, want ok=false")
	}
	if _, _, _, nf, ok := h.store.LocalCommitFile(ctx, "acme/partial", head, "a.txt", 1<<20); ok || nf {
		t.Errorf("LocalCommitFile on missing promisor blob returned (nf=%v, ok=%v), want (false, false)", nf, ok)
	}
	if _, _, _, nf, ok := h.store.LocalCommitFile(ctx, "acme/partial", head, "really-absent.txt", 1<<20); ok || nf {
		t.Errorf("LocalCommitFile on absent path in partial clone returned (nf=%v, ok=%v), want (false, false)", nf, ok)
	}
}

func TestLocalPRShallowCloneFallback(t *testing.T) {
	ctx := ctx20(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(root, "src")
	dst := filepath.Join(root, "shallow")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, src, "init", "-q", "-b", "main")
	git(t, src, "config", "user.name", "t")
	git(t, src, "config", "user.email", "t@t")
	for i := range 3 {
		writeFile(t, filepath.Join(src, "f.txt"), fmt.Sprintf("v%d\n", i))
		git(t, src, "add", ".")
		git(t, src, "commit", "-q", "-m", fmt.Sprintf("c%d", i))
	}
	oldBase := strings.TrimSpace(string(mustRun(t, src, "rev-parse", "HEAD~2")))
	head := headSHAOf(t, src)

	git(t, root, "clone", "-q", "--depth=1", "file://"+src, dst)
	setGitHubOrigin(t, dst, "acme/shallow")

	h := startHarness(t, "", Options{AllowedRoot: root})
	if _, err := h.store.Register(ctx, dst); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := h.store.LocalDiff(ctx, "acme/shallow", oldBase, head, 4<<20); ok {
		t.Error("LocalDiff past shallow boundary returned ok=true, want ok=false")
	}
	// Even when both SHAs exist inside a shallow clone (merge-base would exit 0),
	// LocalDiff must return ok=false so shallow history cannot produce a wrong merge-base diff.
	if _, _, ok := h.store.LocalDiff(ctx, "acme/shallow", head, head, 4<<20); ok {
		t.Error("LocalDiff in shallow repo returned ok=true, want ok=false")
	}
}

func TestLocalPRDiffIgnoresGitAttributesMinusDiff(t *testing.T) {
	ctx := ctx20(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(root, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, repo, "init", "-q", "-b", "main")
	git(t, repo, "config", "user.name", "t")
	git(t, repo, "config", "user.email", "t@t")
	setGitHubOrigin(t, repo, "acme/attrs")

	// Mark generated files as `-diff` in .gitattributes (like internal/pagelib/dist/**).
	if err := os.MkdirAll(filepath.Join(repo, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(repo, ".gitattributes"), "dist/** -diff\n")
	writeFile(t, filepath.Join(repo, "dist/bundle.js"), "console.log('v1');\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "base")
	base := headSHAOf(t, repo)

	writeFile(t, filepath.Join(repo, "dist/bundle.js"), "console.log('v2');\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "update bundle")
	head := headSHAOf(t, repo)

	h := startHarness(t, "", Options{AllowedRoot: root})
	if _, err := h.store.Register(ctx, repo); err != nil {
		t.Fatal(err)
	}
	diff, truncated, ok := h.store.LocalDiff(ctx, "acme/attrs", base, head, 4<<20)
	if !ok || truncated {
		t.Fatalf("LocalDiff = (ok=%v, truncated=%v), want (true, false)", ok, truncated)
	}
	got := string(diff)
	if strings.Contains(got, "Binary files") {
		t.Fatalf("LocalDiff honored .gitattributes -diff instead of matching GitHub:\n%s", got)
	}
	if !strings.Contains(got, "-console.log('v1');") || !strings.Contains(got, "+console.log('v2');") {
		t.Fatalf("LocalDiff missing text hunk for dist/bundle.js:\n%s", got)
	}
}

func mustRun(t *testing.T, dir string, args ...string) []byte {
	t.Helper()
	out, err := (ExecRunner{}).Run(context.Background(), dir, args...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return out
}
