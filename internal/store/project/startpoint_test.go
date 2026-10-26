package project

import (
	"cmp"
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
)

func TestClassifyBase(t *testing.T) {
	remotes := []string{"origin", "upstream"}
	refs := map[string]bool{
		"refs/heads/main": true, "refs/heads/v2": true, "refs/tags/v1": true, "refs/tags/v2": true,
		"abc1234^{commit}": true,
	}
	has := func(ref string) bool { return refs[ref] }
	tests := []struct {
		base string
		want baseKind
	}{
		{"main", baseBranch},
		{"release/2.3", baseBranch}, // on no remote-tracking ref yet: origin may have it
		{"origin/main", baseRemote},
		{"upstream/dev", baseRemote},
		{"v1", baseAsTyped},      // a tag
		{"v2", baseBranch},       // a local branch wins over the tag
		{"abc1234", baseAsTyped}, // a commit
		{"deadbeef", baseBranch}, // hex, but no such commit: a branch origin may have
		{"HEAD", baseAsTyped},    // expressions and full refs
		{"HEAD~2", baseAsTyped},  //
		{"main^", baseAsTyped},   //
		{"@{u}", baseAsTyped},    //
		{"refs/heads/main", baseAsTyped},
		{"a..b", baseAsTyped},
	}
	for _, tt := range tests {
		t.Run(tt.base, func(t *testing.T) {
			if got := classifyBase(tt.base, remotes, has); got != tt.want {
				t.Fatalf("classifyBase(%q) = %d, want %d", tt.base, got, tt.want)
			}
		})
	}
}

func TestRefsDefault(t *testing.T) {
	r := Refs{DefaultRef: "origin/main", DefaultBranch: "main"}
	if got := r.Default(true); got != "origin/main" {
		t.Errorf("Default(true) = %q", got)
	}
	if got := r.Default(false); got != "main" {
		t.Errorf("Default(false) = %q", got)
	}
	if got := (Refs{DefaultRef: "main"}).Default(false); got != "main" {
		t.Errorf("Default(false) without DefaultBranch = %q", got)
	}
}

// TestStartPoint runs projects.base_from_origin on and off against a scratch origin
// whose main is one commit ahead of the clone's origin/main and main (setup may move
// the clone's main level with or ahead of it).
func TestStartPoint(t *testing.T) {
	type want struct {
		head       string // sha the new worktree must be at
		startPoint string // Worktree.StartPoint
		fetches    int
		info       string // substring of an Info line; "" means no "base resolved" line
	}
	tests := []struct {
		name   string
		on     bool
		base   string
		setup  func(t *testing.T, f fixture, shas map[string]string)
		expect func(shas map[string]string) want
	}{
		{
			name: "on, no base: fetched origin/main", on: true,
			expect: func(s map[string]string) want { return want{s["tip"], "origin/main", 1, ""} },
		},
		{
			name: "on, bare main: fetched origin/main", on: true, base: "main",
			expect: func(s map[string]string) want {
				return want{s["tip"], "origin/main", 1, `msg="base resolved to origin's branch"`}
			},
		},
		{
			name: "on, bare name only on origin: fetched", on: true, base: "release/2.3",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.other, "checkout", "-q", "-b", "release/2.3")
				s["release"] = pushCommit(t, f.other, "r")
			},
			expect: func(s map[string]string) want {
				return want{s["release"], "origin/release/2.3", 1, "start_point=origin/release/2.3"}
			},
		},
		{
			name: "on, bare name not on origin: local branch", on: true, base: "wip",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.project, "branch", "wip")
			},
			expect: func(s map[string]string) want { return want{s["local"], "wip", 1, ""} },
		},
		{
			name: "on, origin/main: fetched, as typed", on: true, base: "origin/main",
			expect: func(s map[string]string) want { return want{s["tip"], "origin/main", 1, ""} },
		},
		{
			name: "on, another remote's branch: fetched, as typed", on: true, base: "upstream/main",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.project, "remote", "add", "upstream", f.origin)
			},
			expect: func(s map[string]string) want { return want{s["tip"], "upstream/main", 1, ""} },
		},
		{
			name: "on, tag: as typed, no fetch", on: true, base: "v1",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.project, "tag", "v1")
			},
			expect: func(s map[string]string) want { return want{s["local"], "v1", 0, ""} },
		},
		{
			name: "on, sha: as typed, no fetch", on: true,
			setup: func(t *testing.T, f fixture, s map[string]string) {
				s["base"] = s["local"][:10]
			},
			expect: func(s map[string]string) want { return want{s["local"], s["local"][:10], 0, ""} },
		},
		{
			name:   "off, no base: local main, no fetch",
			expect: func(s map[string]string) want { return want{s["local"], "main", 0, ""} },
		},
		{
			name: "off, bare main: local main, no fetch", base: "main",
			expect: func(s map[string]string) want { return want{s["local"], "main", 0, ""} },
		},
		{
			name: "off, origin/main: the stale ref, no fetch", base: "origin/main",
			expect: func(s map[string]string) want { return want{s["local"], "origin/main", 0, ""} },
		},
		// thread new --base <branch> --base-from-origin no|yes, for a lead's branch whose
		// newer commits are not pushed yet (docs/notes/thread-new-base-origin.md).
		{
			name: "on, local branch ahead of origin's older copy: the local one, fetched", on: true, base: "feat/lead",
			setup: leadBranch,
			expect: func(s map[string]string) want {
				return want{s["lead"], "feat/lead", 1, "start_point=feat/lead ahead=1"}
			},
		},
		// The rule: origin's copy unless the local branch is ahead of it
		// (docs/notes/base-origin-rule.md).
		{
			name: "on, no base, local main ahead of origin's: local main, fetched", on: true,
			setup: localAhead,
			expect: func(s map[string]string) want {
				return want{s["ahead"], "main", 1, "base=main start_point=main ahead=1"}
			},
		},
		{
			// thread new --base main --base-from-origin yes: the rule, not "always origin".
			name: "on (--base-from-origin yes), bare main ahead of origin's: local main", on: true, base: "main",
			setup: localAhead,
			expect: func(s map[string]string) want {
				return want{s["ahead"], "main", 1, "base=main start_point=main ahead=1"}
			},
		},
		{
			name: "on, no base, local main equal to origin's: origin/main", on: true,
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.project, "pull", "-q", "--ff-only", "origin", "main")
			},
			expect: func(s map[string]string) want { return want{s["tip"], "origin/main", 1, ""} },
		},
		{
			name: "on, bare main equal to origin's: origin/main", on: true, base: "main",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.project, "pull", "-q", "--ff-only", "origin", "main")
			},
			expect: func(s map[string]string) want { return want{s["tip"], "origin/main", 1, "start_point=origin/main"} },
		},
		{
			name: "on, bare main diverged from origin's: local main", on: true, base: "main",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				s["diverged"] = localCommit(t, f.project, "mine")
			},
			expect: func(s map[string]string) want {
				return want{s["diverged"], "main", 1, "start_point=main ahead=1"}
			},
		},
		{
			name: "on, no remote: local main, no fetch", on: true, base: "main",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.project, "remote", "remove", "origin")
			},
			expect: func(s map[string]string) want { return want{s["local"], "main", 0, ""} },
		},
		{
			name: "off, local main ahead: local main, no fetch", base: "main",
			setup: localAhead,
			expect: func(s map[string]string) want { return want{s["ahead"], "main", 0, ""} },
		},
		{
			name: "off, local branch origin has an older copy of: the local one, no fetch", base: "feat/lead",
			setup:  leadBranch,
			expect: func(s map[string]string) want { return want{s["lead"], "feat/lead", 0, ""} },
		},
		{
			name: "off, unpushed local branch: as typed, no fetch", base: "feat/lead",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.project, "branch", "feat/lead")
			},
			expect: func(s map[string]string) want { return want{s["local"], "feat/lead", 0, ""} },
		},
		{
			name: "off, tag: as typed", base: "v1",
			setup: func(t *testing.T, f fixture, s map[string]string) {
				git(t, f.project, "tag", "v1")
			},
			expect: func(s map[string]string) want { return want{s["local"], "v1", 0, ""} },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			shas := map[string]string{"local": git(t, f.project, "rev-parse", "main")}
			// origin's main moves on; the clone has not fetched it.
			shas["tip"] = pushCommit(t, f.other, "ahead")
			base := tt.base
			if tt.setup != nil {
				tt.setup(t, f, shas)
			}
			if base == "" {
				base = shas["base"]
			}
			logs := &syncBuffer{}
			cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
			h := startHarness(t, "", Options{
				Runner:       cr,
				WorktreeRoot: filepath.Join(f.base, "wt"),
				Log:          slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelInfo})),
			})
			ctx := context.Background()
			r, err := h.store.Register(ctx, f.project)
			if err != nil {
				t.Fatal(err)
			}
			before := cr.count("fetch")
			w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{
				ProjectID: r.ID, Branch: "cf/new", BaseRef: base, Fetch: true, BaseFromOrigin: tt.on,
			})
			if err != nil {
				t.Fatal(err)
			}
			wt := tt.expect(shas)
			if got := cr.count("fetch") - before; got != wt.fetches {
				t.Errorf("fetches = %d, want %d", got, wt.fetches)
			}
			if w.Head != wt.head {
				t.Errorf("head = %s, want %s", w.Head, wt.head)
			}
			if w.StartPoint != wt.startPoint {
				t.Errorf("StartPoint = %q, want %q", w.StartPoint, wt.startPoint)
			}
			// --no-track: branching from origin/main must not make it the upstream.
			if w.Status.Upstream != "" {
				t.Errorf("upstream = %q, want none", w.Status.Upstream)
			}
			if out, err := cr.next.Run(ctx, w.Path, "config", "--get", "branch.cf/new.merge"); err == nil {
				t.Errorf("branch.cf/new.merge = %q, want unset", strings.TrimSpace(string(out)))
			}
			log := logs.String()
			if strings.Contains(log, "level=WARN") {
				t.Errorf("unexpected warning: %s", log)
			}
			resolved := strings.Contains(log, "base resolved to")
			switch {
			case wt.info == "" && resolved:
				t.Errorf("unexpected resolution line: %s", log)
			case wt.info != "" && !strings.Contains(log, wt.info):
				t.Errorf("log = %s, want a line containing %s", log, wt.info)
			}
		})
	}
}

// localAhead brings the project's main up to origin's tip, then commits once more
// without pushing (s["ahead"]): local main is ahead of origin's, not behind.
func localAhead(t *testing.T, f fixture, s map[string]string) {
	t.Helper()
	git(t, f.project, "pull", "-q", "--ff-only", "origin", "main")
	s["ahead"] = localCommit(t, f.project, "unpushed")
}

// localCommit commits a new file in dir without pushing it and returns the sha.
func localCommit(t *testing.T, dir, name string) string {
	t.Helper()
	writeFile(t, filepath.Join(dir, name), name+"\n")
	git(t, dir, "add", name)
	git(t, dir, "commit", "-q", "-m", name)
	return git(t, dir, "rev-parse", "HEAD")
}

// leadBranch is a lead's branch feat/lead: pushed once (s["pushed"]), then a commit
// more in the project that origin does not have (s["lead"]).
func leadBranch(t *testing.T, f fixture, s map[string]string) {
	t.Helper()
	git(t, f.other, "checkout", "-q", "-b", "feat/lead")
	s["pushed"] = pushCommit(t, f.other, "pushed")
	git(t, f.project, "fetch", "-q", "origin", "feat/lead:refs/remotes/origin/feat/lead")
	git(t, f.project, "branch", "feat/lead", "origin/feat/lead")
	s["lead"] = git(t, f.project, "commit-tree", "-p", "feat/lead", "-m", "unpushed", "feat/lead^{tree}")
	git(t, f.project, "update-ref", "refs/heads/feat/lead", s["lead"])
}

// With the setting off nothing reaches origin: an unreachable origin is never tried
// and no warning is logged.
func TestStartPointOffNeverFetches(t *testing.T) {
	f := newFixture(t)
	local := git(t, f.project, "rev-parse", "main")
	git(t, f.project, "remote", "set-url", "origin", filepath.Join(f.base, "gone.git"))
	logs := &syncBuffer{}
	h := startHarness(t, "", Options{
		WorktreeRoot: filepath.Join(f.base, "wt"),
		Log:          slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelWarn})),
	})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	for _, base := range []string{"", "main", "origin/main"} {
		w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{
			ProjectID: r.ID, Branch: "cf/off-" + strings.ReplaceAll(cmp.Or(base, "default"), "/", "-"), BaseRef: base, Fetch: true,
		})
		if err != nil {
			t.Fatalf("base %q: %v", base, err)
		}
		if w.Head != local {
			t.Errorf("base %q: head = %s, want %s", base, w.Head, local)
		}
	}
	if log := logs.String(); strings.Contains(log, "fetch") {
		t.Errorf("a fetch was tried: %s", log)
	}
}
