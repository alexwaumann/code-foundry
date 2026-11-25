package project

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestParseGitConfig(t *testing.T) {
	tests := []struct {
		name           string
		input          string
		wantOK         bool
		wantRemotes    []string
		wantOriginURL  string
		wantExtractOK  bool
		wantInclude    bool
		wantURLRewrite bool
		wantWorktree   bool
		wantRefStorage string
	}{
		{
			name: "standard repo with comments and mixed case",
			input: "# leading comment\n" +
				"; semicolon comment\n" +
				"[core]\n\trepositoryformatversion = 0\n" +
				"[REMOTE \"origin\"]\n" +
				"\tURL = https://github.com/acme/web.git # trailing comment\n" +
				"\tfetch = +refs/heads/*:refs/remotes/origin/*\n" +
				"[remote \"upstream\"]\n" +
				"\turl = git@github.com:org/web.git ; another comment\n",
			wantOK:        true,
			wantRemotes:   []string{"origin", "upstream"},
			wantOriginURL: "https://github.com/acme/web.git",
			wantExtractOK: true,
		},
		{
			name:          "UTF-8 BOM and CRLF and same-line kv",
			input:         "\xef\xbb\xbf[remote \"origin\"] url = https://github.com/acme/bom.git\r\n",
			wantOK:        true,
			wantRemotes:   []string{"origin"},
			wantOriginURL: "https://github.com/acme/bom.git",
			wantExtractOK: true,
		},
		{
			name: "quoted value with hash semicolon spaces and multiline continuation",
			input: "[remote \"origin\"]\n" +
				"\turl = \"https://github.com/acme/\"\\\n" +
				"\"repo#1;2.git\"   # trailing comment\n",
			wantOK:        true,
			wantRemotes:   []string{"origin"},
			wantOriginURL: "https://github.com/acme/repo#1;2.git",
			wantExtractOK: true,
		},
		{
			name: "escaped quotes and backslashes in remote name and case-sensitive remote name",
			input: "[remote \"Origin\"]\n\turl = https://example.com/upper.git\n" +
				"[remote \"a\\\"b\\\\c\"]\n\turl = https://example.com/esc.git\n",
			wantOK:        true,
			wantRemotes:   []string{"Origin", `a"b\c`},
			wantOriginURL: "",
			wantExtractOK: true,
		},
		{
			name: "empty remote section and bare remote section without subsection are ignored",
			input: "[remote]\n\tpushDefault = origin\n" +
				"[remote \"empty\"]\n" +
				"[remote \"origin\"]\n\turl = https://github.com/acme/a.git\n",
			wantOK:        true,
			wantRemotes:   []string{"origin"},
			wantOriginURL: "https://github.com/acme/a.git",
			wantExtractOK: true,
		},
		{
			name: "multiple urls in origin triggers fallback",
			input: "[remote \"origin\"]\n" +
				"\turl = https://github.com/acme/first.git\n" +
				"\turl = https://github.com/acme/second.git\n",
			wantOK:        true,
			wantExtractOK: false,
		},
		{
			name: "origin without url triggers fallback",
			input: "[remote \"origin\"]\n" +
				"\tfetch = +refs/heads/*:refs/remotes/origin/*\n",
			wantOK:        true,
			wantExtractOK: false,
		},
		{
			name: "origin with empty url triggers fallback",
			input: "[remote \"origin\"]\n" +
				"\turl = \n",
			wantOK:        true,
			wantExtractOK: false,
		},
		{
			name: "remote name with whitespace triggers fallback",
			input: "[remote \"my remote\"]\n" +
				"\turl = https://example.com/a.git\n",
			wantOK:        true,
			wantExtractOK: false,
		},
		{
			name:        "include section sets hasInclude",
			input:       "[include]\n\tpath = extra.cfg\n",
			wantOK:      true,
			wantInclude: true,
		},
		{
			name:        "includeIf section sets hasInclude",
			input:       "[includeIf \"gitdir:~/work/\"]\n\tpath = work.cfg\n",
			wantOK:      true,
			wantInclude: true,
		},
		{
			name:           "url insteadOf sets hasURLRewrite",
			input:          "[url \"git@github.com:\"]\n\tinsteadOf = https://github.com/\n",
			wantOK:         true,
			wantURLRewrite: true,
		},
		{
			name:           "pushInsteadOf sets hasURLRewrite",
			input:          "[url \"ssh://git@github.com/\"]\n\tpushInsteadOf = https://github.com/\n",
			wantOK:         true,
			wantURLRewrite: true,
		},
		{
			name:           "extensions worktreeConfig and refStorage",
			input:          "[extensions]\n\tworktreeConfig = true\n\trefStorage = reftable\n",
			wantOK:         true,
			wantWorktree:   true,
			wantRefStorage: "reftable",
		},
		{
			name:   "deprecated dot subsection falls back",
			input:  "[remote.origin]\n\turl = https://example.com/a.git\n",
			wantOK: false,
		},
		{
			name:   "unclosed quote falls back",
			input:  "[remote \"origin\"]\n\turl = \"https://example.com/a.git\n",
			wantOK: false,
		},
		{
			name:   "unknown escape falls back",
			input:  "[remote \"origin\"]\n\turl = https://example.com/\\x.git\n",
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, ok := parseGitConfig([]byte(tt.input))
			if ok != tt.wantOK {
				t.Fatalf("parseGitConfig ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if cfg.hasInclude != tt.wantInclude {
				t.Errorf("hasInclude = %v, want %v", cfg.hasInclude, tt.wantInclude)
			}
			if cfg.hasURLRewrite != tt.wantURLRewrite {
				t.Errorf("hasURLRewrite = %v, want %v", cfg.hasURLRewrite, tt.wantURLRewrite)
			}
			if cfg.hasWorktreeCfg != tt.wantWorktree {
				t.Errorf("hasWorktreeCfg = %v, want %v", cfg.hasWorktreeCfg, tt.wantWorktree)
			}
			if cfg.refStorage != tt.wantRefStorage {
				t.Errorf("refStorage = %q, want %q", cfg.refStorage, tt.wantRefStorage)
			}
			if tt.wantInclude || tt.wantURLRewrite || tt.wantWorktree {
				return
			}
			remotes, originURL, extractOK := extractRemotesAndOrigin(cfg)
			if extractOK != tt.wantExtractOK {
				t.Fatalf("extractRemotesAndOrigin ok = %v, want %v (remotes=%v, url=%q)", extractOK, tt.wantExtractOK, remotes, originURL)
			}
			if !extractOK {
				return
			}
			if !slices.Equal(remotes, tt.wantRemotes) {
				t.Errorf("remotes = %q, want %q", remotes, tt.wantRemotes)
			}
			if originURL != tt.wantOriginURL {
				t.Errorf("originURL = %q, want %q", originURL, tt.wantOriginURL)
			}
		})
	}
}

// TestDirectGitMetaParityWithGit verifies that direct .git/config and ref reading
// produces 100% identical remotes, originURL, and defaultBranch to git subprocesses
// across normal repos, linked worktrees, separate-git-dir/submodule .git files,
// packed-refs, detached HEAD, unborn repos, no-origin repos, custom origin/HEAD symrefs,
// and cleanly falls back on include, includeIf, insteadOf, pushInsteadOf, multi-URL
// origin, worktreeConfig, global overrides, and reftable.
func TestDirectGitMetaParityWithGit(t *testing.T) {
	type setupResult struct {
		dir               string
		wantDirectRemotes bool
		wantDirectBranch  bool
	}

	initRepo := func(t *testing.T, base, name, branch string, commit bool) string {
		t.Helper()
		dir := filepath.Join(base, name)
		git(t, base, "init", "-q", "-b", branch, dir)
		if commit {
			writeFile(t, filepath.Join(dir, "README.md"), "hi\n")
			git(t, dir, "add", ".")
			git(t, dir, "commit", "-q", "-m", "init")
		}
		return dir
	}

	tests := []struct {
		name  string
		setup func(t *testing.T, base string) setupResult
	}{
		{
			name: "standard repo with origin and origin/HEAD",
			setup: func(t *testing.T, base string) setupResult {
				f := newFixture(t)
				git(t, f.project, "remote", "set-url", "origin", "git@github.com:acme/proj.git")
				return setupResult{dir: f.project, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "multiple remotes sorted with origin",
			setup: func(t *testing.T, base string) setupResult {
				f := newFixture(t)
				git(t, f.project, "remote", "set-url", "origin", "https://github.com/acme/proj.git")
				git(t, f.project, "remote", "add", "upstream", "https://github.com/org/proj.git")
				git(t, f.project, "remote", "add", "fork", "git@github.com:me/proj.git")
				return setupResult{dir: f.project, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "custom origin/HEAD symref",
			setup: func(t *testing.T, base string) setupResult {
				bare := filepath.Join(base, "bare.git")
				git(t, base, "init", "-q", "--bare", "-b", "trunk", bare)
				dir := initRepo(t, base, "repo", "trunk", true)
				git(t, dir, "remote", "add", "origin", bare)
				git(t, dir, "push", "-q", "-u", "origin", "trunk")
				git(t, dir, "remote", "set-head", "origin", "trunk")
				git(t, dir, "checkout", "-q", "-b", "feature")
				return setupResult{dir: dir, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "linked worktree with .git file and commondir",
			setup: func(t *testing.T, base string) setupResult {
				f := newFixture(t)
				wt := filepath.Join(base, "linked-wt")
				git(t, f.project, "worktree", "add", "-q", "-b", "feat/wt", wt)
				return setupResult{dir: wt, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "separate gitdir / submodule style .git file without commondir",
			setup: func(t *testing.T, base string) setupResult {
				gitDir := filepath.Join(base, "modules", "sub")
				if err := os.MkdirAll(filepath.Dir(gitDir), 0o755); err != nil {
					t.Fatal(err)
				}
				wt := filepath.Join(base, "sub-wt")
				git(t, base, "init", "-q", "-b", "main", "--separate-git-dir", gitDir, wt)
				writeFile(t, filepath.Join(wt, "f.txt"), "x\n")
				git(t, wt, "add", ".")
				git(t, wt, "commit", "-q", "-m", "init")
				git(t, wt, "remote", "add", "origin", "https://github.com/acme/sub.git")
				return setupResult{dir: wt, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "no-origin repo on custom branch",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "local", "develop", true)
				git(t, dir, "remote", "add", "upstream", "https://github.com/acme/local.git")
				return setupResult{dir: dir, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "unborn repo without origin",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "unborn", "trunk", false)
				return setupResult{dir: dir, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "unborn repo with origin",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "unborn-origin", "main", false)
				git(t, dir, "remote", "add", "origin", "git@github.com:acme/unborn.git")
				return setupResult{dir: dir, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "detached HEAD without origin falls back to master in loose refs",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "detached", "master", true)
				git(t, dir, "checkout", "-q", "--detach", "HEAD")
				return setupResult{dir: dir, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "packed-refs without origin/HEAD",
			setup: func(t *testing.T, base string) setupResult {
				f := newFixture(t)
				git(t, f.project, "remote", "set-head", "origin", "--delete")
				git(t, f.project, "pack-refs", "--all", "--prune")
				return setupResult{dir: f.project, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "packed-refs detached HEAD without origin",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "packed-detached", "master", true)
				git(t, dir, "checkout", "-q", "--detach", "HEAD")
				git(t, dir, "pack-refs", "--all", "--prune")
				return setupResult{dir: dir, wantDirectRemotes: true, wantDirectBranch: true}
			},
		},
		{
			name: "repo config with [include] falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "inc", "main", true)
				incFile := filepath.Join(base, "extra.gitconfig")
				writeFile(t, incFile, "[remote \"origin\"]\n\turl = https://github.com/acme/included.git\n")
				cfgPath := filepath.Join(dir, ".git", "config")
				b, err := os.ReadFile(cfgPath)
				if err != nil {
					t.Fatal(err)
				}
				writeFile(t, cfgPath, string(b)+fmt.Sprintf("\n[include]\n\tpath = %s\n", incFile))
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "repo config with [includeIf] falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "incif", "main", true)
				incFile := filepath.Join(base, "cond.gitconfig")
				writeFile(t, incFile, "[remote \"origin\"]\n\turl = https://github.com/acme/cond.git\n")
				cfgPath := filepath.Join(dir, ".git", "config")
				b, err := os.ReadFile(cfgPath)
				if err != nil {
					t.Fatal(err)
				}
				writeFile(t, cfgPath, string(b)+fmt.Sprintf("\n[includeIf \"gitdir:%s/\"]\n\tpath = %s\n", base, incFile))
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "repo config with url insteadOf falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "insteadof", "main", true)
				git(t, dir, "remote", "add", "origin", "gh:acme/rewritten.git")
				git(t, dir, "config", "url.https://github.com/.insteadOf", "gh:")
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "global config with url insteadOf falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "global-insteadof", "main", true)
				git(t, dir, "remote", "add", "origin", "gh:acme/global.git")
				gcfg := filepath.Join(t.TempDir(), "global.gitconfig")
				writeFile(t, gcfg, "[url \"https://github.com/\"]\n\tinsteadOf = gh:\n")
				t.Setenv("GIT_CONFIG_GLOBAL", gcfg)
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "multiple urls on origin falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "multiurl", "main", true)
				git(t, dir, "remote", "add", "origin", "https://github.com/acme/first.git")
				git(t, dir, "remote", "set-url", "--add", "origin", "https://github.com/acme/second.git")
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "worktreeConfig extension falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "wtcfg", "main", true)
				git(t, dir, "remote", "add", "origin", "https://github.com/acme/wtcfg.git")
				git(t, dir, "config", "extensions.worktreeConfig", "true")
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "repo config with pushInsteadOf falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "pushinsteadof", "main", true)
				git(t, dir, "remote", "add", "origin", "https://github.com/acme/push.git")
				git(t, dir, "config", "url.git@github.com:.pushInsteadOf", "https://github.com/")
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "origin with empty url falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "emptyurl", "main", true)
				git(t, dir, "config", "remote.origin.url", "")
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "origin with only fetch (no url) falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "fetchonly", "main", true)
				git(t, dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "legacy .git/remotes directory falls back cleanly",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "legacy-remotes", "main", true)
				remDir := filepath.Join(dir, ".git", "remotes")
				if err := os.MkdirAll(remDir, 0o755); err != nil {
					t.Fatal(err)
				}
				writeFile(t, filepath.Join(remDir, "origin"), "URL: https://github.com/acme/legacy.git\n")
				return setupResult{dir: dir, wantDirectRemotes: false, wantDirectBranch: false}
			},
		},
		{
			name: "reftable directory falls back cleanly for defaultBranch",
			setup: func(t *testing.T, base string) setupResult {
				dir := initRepo(t, base, "reftable-sim", "main", true)
				git(t, dir, "remote", "add", "origin", "https://github.com/acme/reftable.git")
				if err := os.MkdirAll(filepath.Join(dir, ".git", "reftable"), 0o755); err != nil {
					t.Fatal(err)
				}
				return setupResult{dir: dir, wantDirectRemotes: true, wantDirectBranch: false}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isolateGit(t)
			base, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			sr := tt.setup(t, base)
			ctx := context.Background()

			// Ground truth from real git CLI via a Git instance with directMeta disabled.
			refStore := &Git{runner: ExecRunner{}}
			refOut, err := refStore.runner.Run(ctx, sr.dir, "remote")
			if err != nil {
				t.Fatalf("git remote: %v", err)
			}
			wantRemotes := parseRemotes(refOut)
			var wantOriginURL string
			if slices.Contains(wantRemotes, "origin") {
				if out, err := refStore.runner.Run(ctx, sr.dir, "remote", "get-url", "origin"); err == nil {
					wantOriginURL = string(trimNL(out))
				}
			}
			mainBranch := ""
			if out, err := refStore.runner.Run(ctx, sr.dir, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
				mainBranch = string(trimNL(out))
			}
			wantDefaultBranch := refStore.defaultBranchFromGit(ctx, sr.dir, mainBranch, slices.Contains(wantRemotes, "origin"))

			// Direct reader check.
			dm := &directGitMeta{}
			res := dm.readRepoMeta(sr.dir, mainBranch)
			if res.remotesOK != sr.wantDirectRemotes {
				t.Fatalf("remotesOK = %v, want %v", res.remotesOK, sr.wantDirectRemotes)
			}
			if res.branchOK != sr.wantDirectBranch {
				t.Fatalf("branchOK = %v, want %v", res.branchOK, sr.wantDirectBranch)
			}
			if res.remotesOK {
				if !slices.Equal(res.remotes, wantRemotes) {
					t.Errorf("direct remotes = %q, git = %q", res.remotes, wantRemotes)
				}
				if res.originURL != wantOriginURL {
					t.Errorf("direct originURL = %q, git = %q", res.originURL, wantOriginURL)
				}
			}
			if res.branchOK {
				if res.defaultBranch != wantDefaultBranch {
					t.Errorf("direct defaultBranch = %q, git = %q", res.defaultBranch, wantDefaultBranch)
				}
			}

			// Full inspectRepoMeta parity (whether direct or fallback).
			directStore := &Git{runner: ExecRunner{}, directMeta: dm}
			gotMeta := &projectMeta{Path: sr.dir}
			directStore.inspectRepoMeta(ctx, gotMeta, mainBranch)
			if !slices.Equal(gotMeta.Remotes, wantRemotes) {
				t.Errorf("inspectRepoMeta Remotes = %q, want %q", gotMeta.Remotes, wantRemotes)
			}
			if gotMeta.OriginURL != wantOriginURL {
				t.Errorf("inspectRepoMeta OriginURL = %q, want %q", gotMeta.OriginURL, wantOriginURL)
			}
			if gotMeta.GitHubSlug != parseGitHubSlug(wantOriginURL) {
				t.Errorf("inspectRepoMeta GitHubSlug = %q, want %q", gotMeta.GitHubSlug, parseGitHubSlug(wantOriginURL))
			}
			if gotMeta.DefaultBranch != wantDefaultBranch {
				t.Errorf("inspectRepoMeta DefaultBranch = %q, want %q", gotMeta.DefaultBranch, wantDefaultBranch)
			}
		})
	}
}

// TestDirectGitMetaRealReftable tests an actual git reftable repository when the host git
// supports `--ref-format=reftable` (git >= 2.45).
func TestDirectGitMetaRealReftable(t *testing.T) {
	isolateGit(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "reftable-real")
	cmd := exec.Command("git", "init", "-q", "--ref-format=reftable", "-b", "trunk", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("host git does not support --ref-format=reftable: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	writeFile(t, filepath.Join(dir, "README.md"), "hi\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")
	git(t, dir, "remote", "add", "origin", "https://github.com/acme/reftable.git")

	dm := &directGitMeta{}
	res := dm.readRepoMeta(dir, "trunk")
	if res.branchOK {
		t.Fatalf("expected direct defaultBranch to fall back on real reftable repo, got branchOK=true (%q)", res.defaultBranch)
	}
	if !res.remotesOK || res.originURL != "https://github.com/acme/reftable.git" {
		t.Fatalf("remotes should still read from config: %+v", res)
	}
	g := &Git{runner: ExecRunner{}, directMeta: dm}
	m := &projectMeta{Path: dir}
	g.inspectRepoMeta(context.Background(), m, "trunk")
	if m.DefaultBranch != "trunk" || m.GitHubSlug != "acme/reftable" {
		t.Fatalf("inspectRepoMeta on reftable repo = %+v", m)
	}
}

// TestReconcileZeroMetadataGitSpawns verifies that a normal project's reconcile runs only
// `git worktree list --porcelain -z` and 0 git subprocesses for remotes, origin URL, or
// default branch.
func TestReconcileZeroMetadataGitSpawns(t *testing.T) {
	f := newFixture(t)
	git(t, f.project, "remote", "set-url", "origin", "https://github.com/acme/proj.git")

	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	countFile := filepath.Join(f.base, "spawns.log")
	wrapper := filepath.Join(f.base, "git-wrap.sh")
	script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %q\nexec %q \"$@\"\n", countFile, gitBin)
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	h := startHarness(t, "", Options{
		Runner:       ExecRunner{Git: wrapper},
		WorktreeRoot: filepath.Join(f.base, "wt"),
	})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	if r.GitHubSlug != "acme/proj" || r.DefaultBranch != "main" || !slices.Equal(r.Remotes, []string{"origin"}) {
		t.Fatalf("registered project = %+v", r)
	}
	h.store.sched.close()

	if err := os.WriteFile(countFile, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	h.store.reconcile(ctx, r.ID)

	b, err := os.ReadFile(countFile)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 1 || lines[0] != "worktree list --porcelain -z" {
		t.Fatalf("reconcile git spawns = %q, want only [worktree list --porcelain -z]", lines)
	}
}
