package project

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// mainCheckoutFixture is a registered project's own checkout, where .git is a directory.
func mainCheckoutFixture(t *testing.T) compareFixture {
	t.Helper()
	f := newFixture(t)
	writeFile(t, filepath.Join(f.project, "keep.txt"), "one\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "base files")
	git(t, f.project, "push", "-q")
	h := startHarness(t, "", Options{})
	r, err := h.store.Register(ctx20(t), f.project)
	if err != nil {
		t.Fatal(err)
	}
	p, err := filepath.EvalSymlinks(f.project)
	if err != nil {
		t.Fatal(err)
	}
	return compareFixture{h: h, id: r.ID, path: p, fixture: f}
}

// gitStdin is git with stdin.
func gitStdin(t *testing.T, dir, stdin string, args ...string) string {
	t.Helper()
	out, err := ExecRunner{}.RunInput(context.Background(), dir, []byte(stdin), args...)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func link(t *testing.T, target, name string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, name); err != nil {
		t.Fatal(err)
	}
}

// TestCompareRefusesLinksIntoGit: .git is refused where a path leads, not only as it is
// written, and by both RPCs. os.Root follows these, since they stay inside the checkout.
// A linked worktree's .git is a file with nothing under it, and is refused all the same.
func TestCompareRefusesLinksIntoGit(t *testing.T) {
	const token = "TOKEN123"
	checkouts := []struct {
		name string
		make func(*testing.T) compareFixture
	}{
		{"main checkout", mainCheckoutFixture},
		{"linked worktree", newCompareFixture},
	}
	for _, co := range checkouts {
		t.Run(co.name, func(t *testing.T) {
			f := co.make(t)
			ctx := ctx20(t)
			git(t, f.path, "config", "remote.origin.pushurl", "https://user:"+token+"@example.com/x.git")
			link(t, ".git", filepath.Join(f.path, "x"))
			link(t, "x", filepath.Join(f.path, "y"))
			link(t, ".GIT", filepath.Join(f.path, "folded"))
			link(t, "../.git", filepath.Join(f.path, "deep", "up"))
			link(t, ".", filepath.Join(f.path, "here"))
			for _, file := range []string{"x/config", "y/config", "folded/config", "deep/up/config", "here/x/config", "here/here/y/config", "here/.git/config", ".git/config"} {
				for _, kind := range []string{"head", "base"} {
					req := CompareFileRequest{ProjectID: f.id, Path: f.path, Base: sourceRef("HEAD"), Head: sourceWorking, File: file}
					if kind == "base" {
						req.Base, req.Head = sourceWorking, sourceRef("HEAD")
					}
					d, err := f.h.store.CompareFile(ctx, req)
					if !errors.Is(err, ErrInvalidArgument) {
						t.Errorf("CompareFile %s on the %s: err = %v, %+v", file, kind, err, d)
					}
					if bytes.Contains(d.New.Contents, []byte(token)) || bytes.Contains(d.Old.Contents, []byte(token)) {
						t.Errorf("CompareFile %s gave the token", file)
					}
				}
				d, err := f.h.store.WorktreeFileDiff(ctx, FileDiffRequest{ProjectID: f.id, Path: f.path, File: file})
				if !errors.Is(err, ErrInvalidArgument) {
					t.Errorf("WorktreeFileDiff %s: err = %v, %+v", file, err, d)
				}
			}
			if _, err := f.h.store.WorktreeFileDiff(ctx, FileDiffRequest{ProjectID: f.id, Path: f.path, File: "keep.txt", OldPath: ".git/config"}); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("WorktreeFileDiff old path: err = %v", err)
			}
			if _, err := f.h.store.WorktreeFileDiff(ctx, FileDiffRequest{ProjectID: f.id, Path: f.path, File: ".git/config", Scope: DiffBranch}); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("WorktreeFileDiff, no side on disk: err = %v", err)
			}
		})
	}
}

// TestCompareLinksThatStayOutOfGit: what the refusal must leave alone. A link at the path
// is its target, a link to a directory reads through, and one that leads nowhere is absent.
func TestCompareLinksThatStayOutOfGit(t *testing.T) {
	f := mainCheckoutFixture(t)
	if err := os.MkdirAll(filepath.Join(f.path, "real"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.path, "real", "file.txt"), "real\n")
	writeFile(t, filepath.Join(f.path, "real", "dot.gitignore"), "ignored\n")
	link(t, "real", filepath.Join(f.path, "alias"))
	link(t, "../real", filepath.Join(f.path, "sub", "up"))
	link(t, ".git", filepath.Join(f.path, "x"))
	link(t, "b", filepath.Join(f.path, "a"))
	link(t, "a", filepath.Join(f.path, "b"))
	link(t, "../..", filepath.Join(f.path, "out"))
	link(t, "/etc", filepath.Join(f.path, "abs"))
	tests := []struct {
		file    string
		present bool
		want    string
	}{
		{"alias/file.txt", true, "real\n"},
		{"sub/up/file.txt", true, "real\n"},
		{"alias/dot.gitignore", true, "ignored\n"},
		{"x", true, ".git"},
		{"a/file.txt", false, ""},
		{"out/etc/hosts", false, ""},
		{"abs/hosts", false, ""},
		{"alias/missing/file.txt", false, ""},
		{"keep.txt/under", false, ""},
	}
	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			d := f.sides(t, sourceRef("HEAD"), sourceWorking, tt.file, "")
			if d.New.Present != tt.present || string(d.New.Contents) != tt.want {
				t.Errorf("new = %+v, want present %v %q", d.New, tt.present, tt.want)
			}
		})
	}
}

// TestResolveKeepsOnlyABareSHA: whatever rev-parse answers, only a full object name goes on
// to a later command. checkRef refuses the known way in; this holds for an unknown one.
func TestResolveKeepsOnlyABareSHA(t *testing.T) {
	sha1 := strings.Repeat("a", 40)
	sha256 := strings.Repeat("b", 64)
	tests := []struct {
		name, out, want string
	}{
		{"sha-1", sha1 + "\n", sha1},
		{"sha-256", sha256 + "\n", sha256},
		{"an exclusion", "^" + sha1 + "\n", ""},
		{"two lines", sha1 + "\n" + sha1 + "\n", ""},
		{"short", sha1[:12] + "\n", ""},
		{"upper case", strings.ToUpper(sha1) + "\n", ""},
		{"an option", "--output=x\n", ""},
		{"nothing", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &comparison{run: func(...string) ([]byte, error) { return []byte(tt.out), nil }}
			r, why, err := c.resolve(sourceRef("x"), currentBase{})
			if err != nil {
				t.Fatal(err)
			}
			if r.SHA != tt.want || (why == "") != (tt.want != "") {
				t.Errorf("sha %q why %q, want %q", r.SHA, why, tt.want)
			}
		})
	}
}

// TestCompareRevisionSuffixes: forms of a revision that pass checkRef and name no commit
// are answers, with no sha to go wrong.
func TestCompareRevisionSuffixes(t *testing.T) {
	f := newCompareFixture(t)
	for _, ref := range []string{"HEAD^!", "HEAD^@", "HEAD^-", "HEAD^{tree}", "HEAD^{blob}"} {
		t.Run(ref, func(t *testing.T) {
			c := f.compare(t, sourceRef(ref), sourceWorking)
			if c.Error == "" || c.Base.SHA != "" || len(c.Files) != 0 {
				t.Errorf("error %q, base %+v, files %v", c.Error, c.Base, rows(c.Files))
			}
		})
	}
}

// TestCompareNameNotUTF8: a tree may hold what no response can carry. The rest of the list
// stands, and the count says what is missing.
func TestCompareNameNotUTF8(t *testing.T) {
	f := newCompareFixture(t)
	blob := strings.TrimSpace(gitStdin(t, f.path, "bad\n", "hash-object", "-w", "--stdin"))
	listing := git(t, f.path, "ls-tree", "HEAD") + "100644 blob " + blob + "\tcaf\xe9.txt\n"
	tree := strings.TrimSpace(gitStdin(t, f.path, listing, "mktree"))
	commit := strings.TrimSpace(git(t, f.path, "commit-tree", tree, "-p", "HEAD", "-m", "latin1"))

	c := f.compare(t, sourceRef("HEAD"), sourceRef(commit))
	if c.SkippedNames != 1 || len(c.Files) != 0 || c.TotalFiles != 0 {
		t.Fatalf("skipped %d, files %q", c.SkippedNames, rows(c.Files))
	}
	// A rename from a bad name is one row, so it goes whole, and what else differs stays.
	var w WorktreeCompare
	w.fill([]CompareChange{
		{Path: "good.txt", Status: "M", Added: 2},
		{Path: "new.txt", OldPath: "caf\xe9.txt", Status: "R", Added: 5},
		{Path: "caf\xe9.txt", Status: "A", Added: 7},
	}, nil, CompareFilesMax)
	if got := rows(w.Files); !slices.Equal(got, []string{"M good.txt +2 -0"}) || w.SkippedNames != 2 || w.TotalFiles != 1 || w.TotalAdded != 2 {
		t.Errorf("rows %v, skipped %d, totals %d +%d", got, w.SkippedNames, w.TotalFiles, w.TotalAdded)
	}
}

// TestCompareListsWhatDetailLists: an embedded repository and a dirty submodule are in the
// detail, and so in the info card's count; a comparison that left them out said "No
// changes" beside it.
func TestCompareListsWhatDetailLists(t *testing.T) {
	f := mainCheckoutFixture(t)
	lib := filepath.Join(f.base, "lib")
	git(t, f.base, "init", "-q", "-b", "main", lib)
	writeFile(t, filepath.Join(lib, "lib.txt"), "v1\n")
	git(t, lib, "add", ".")
	git(t, lib, "commit", "-q", "-m", "one")
	sha := strings.TrimSpace(git(t, lib, "rev-parse", "HEAD"))
	git(t, f.path, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", lib, "vendor/lib")
	git(t, f.path, "commit", "-q", "-m", "submodule")
	git(t, f.path, "push", "-q")
	writeFile(t, filepath.Join(f.path, "vendor", "lib", "lib.txt"), "v1 and more\n")

	emb := filepath.Join(f.path, "emb")
	git(t, f.path, "init", "-q", "-b", "main", emb)
	writeFile(t, filepath.Join(emb, "e.txt"), "e\n")
	git(t, emb, "add", ".")
	git(t, emb, "commit", "-q", "-m", "e")
	embSHA := strings.TrimSpace(git(t, emb, "rev-parse", "HEAD"))
	git(t, f.path, "init", "-q", "-b", "main", filepath.Join(f.path, "empty"))

	ctx := ctx20(t)
	if err := f.h.store.Refresh(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	d, err := f.h.store.WorktreeDetail(ctx, f.id, f.path)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Files) != 3 {
		t.Fatalf("detail lists %+v", d.Files)
	}
	c := f.compare(t, DiffSource{}, sourceWorking)
	var want, got []string
	for _, x := range d.Files {
		want = append(want, x.Path)
	}
	for _, x := range c.Files {
		got = append(got, x.Path)
	}
	if !slices.Equal(got, want) {
		t.Errorf("compare lists %v, detail %v", got, want)
	}
	byPath := func(p string) string {
		for _, x := range c.Files {
			if x.Path == p {
				return row(x)
			}
		}
		return ""
	}
	for path, want := range map[string]string{
		"vendor/lib": "M vendor/lib +0 -0 submodule",
		"emb/":       "? emb/ +0 -0 submodule",
		"empty/":     "? empty/ +0 -0 submodule",
	} {
		if got := byPath(path); got != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}

	// Each row opens to something, not to two absent sides.
	s := f.sides(t, sourceRef("HEAD"), sourceWorking, "vendor/lib", "")
	if s.Status != "M" || string(s.Old.Contents) != "Subproject commit "+sha+"\n" || string(s.New.Contents) != "Subproject commit "+sha+"-dirty\n" {
		t.Errorf("dirty submodule: status %q, %q to %q", s.Status, s.Old.Contents, s.New.Contents)
	}
	s = f.sides(t, sourceRef("HEAD"), sourceWorking, "emb/", "")
	if s.Status != "A" || !s.New.Submodule || string(s.New.Contents) != "Subproject commit "+embSHA+"\n" {
		t.Errorf("embedded: status %q, %+v", s.Status, s.New)
	}
	s = f.sides(t, sourceRef("HEAD"), sourceWorking, "empty/", "")
	if s.Status != "A" || !strings.Contains(string(s.New.Contents), "no commits") {
		t.Errorf("embedded with no commits: status %q, %+v", s.Status, s.New)
	}
	// With the working tree as base it is what goes away.
	r := f.compare(t, sourceWorking, sourceRef("HEAD"), "emb")
	if got := rows(r.Files); !slices.Equal(got, []string{"D emb/ +0 -0 submodule"}) {
		t.Errorf("reversed: %v", got)
	}
	// A plain directory is still nothing.
	if err := os.MkdirAll(filepath.Join(f.path, "plain"), 0o755); err != nil {
		t.Fatal(err)
	}
	if s = f.sides(t, sourceRef("HEAD"), sourceWorking, "plain", ""); s.New.Present {
		t.Errorf("a directory read as %+v", s.New)
	}
	// `git rm --cached` on a submodule leaves its directory: on both sides, one row.
	git(t, f.path, "rm", "-q", "--cached", "vendor/lib")
	c = f.compare(t, sourceRef("HEAD"), sourceWorking, "vendor/lib")
	if got := rows(c.Files); !slices.Equal(got, []string{"M vendor/lib +0 -0 submodule"}) {
		t.Errorf("removed from the index: %v", got)
	}
}

// hostileScript writes an executable that appends what ran it to canary, unless that was
// the background `git status`, which runs repository config whatever a comparison does
// (the note says so). It fails, as a hook may.
func hostileScript(t *testing.T, dir, canary string) string {
	t.Helper()
	p := filepath.Join(dir, "evil")
	body := "#!/bin/sh\nparent=$(ps -o args= -p $PPID)\ncase \"$parent\" in\n*' status '*) ;;\n*) echo \"$parent\" >> " + canary + " ;;\nesac\nexit 1\n"
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestCompareRunsNoFsmonitor: core.fsmonitor in a checkout's config is a command, and git
// runs it for any command that looks at the index.
func TestCompareRunsNoFsmonitor(t *testing.T) {
	f := newCompareFixture(t)
	canary := filepath.Join(f.base, "canary")
	git(t, f.path, "config", "core.fsmonitor", hostileScript(t, f.base, canary))
	sources := []DiffSource{{}, sourceWorking, sourceStaged, sourceRef("HEAD")}
	for _, a := range sources {
		for _, b := range sources {
			f.compare(t, a, b)
			f.sides(t, a, b, "keep.txt", "")
			f.sides(t, a, b, "new-name.txt", "old-name.txt")
		}
	}
	if got, err := os.ReadFile(canary); err == nil {
		t.Errorf("core.fsmonitor ran:\n%s", got)
	}
}

// TestCompareRunsNoSubmoduleFsmonitor: listing a dirty submodule has git look inside it, in
// a process of its own, under the submodule's own config.
func TestCompareRunsNoSubmoduleFsmonitor(t *testing.T) {
	f := newCompareFixture(t)
	lib := filepath.Join(f.base, "lib")
	git(t, f.base, "init", "-q", "-b", "main", lib)
	writeFile(t, filepath.Join(lib, "lib.txt"), "v1\n")
	git(t, lib, "add", ".")
	git(t, lib, "commit", "-q", "-m", "one")
	git(t, f.path, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", lib, "lib")
	git(t, f.path, "commit", "-q", "-m", "submodule")
	sub := filepath.Join(f.path, "lib")
	writeFile(t, filepath.Join(sub, "lib.txt"), "v2\n")
	// The git in the submodule is a `status` too, so this one logs whatever ran it.
	canary := filepath.Join(f.base, "canary")
	evil := filepath.Join(f.base, "evil")
	if err := os.WriteFile(evil, []byte("#!/bin/sh\necho ran >> "+canary+"\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, sub, "config", "core.fsmonitor", evil)
	_ = os.Remove(canary)
	req := CompareRequest{ProjectID: f.id, Path: f.path, Base: sourceRef("HEAD"), Head: sourceWorking}
	c, err := f.h.store.CompareWorktree(ctx20(t), req)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(c.Files, func(x CompareChange) bool { return x.Path == "lib" }) {
		t.Errorf("dirty submodule not listed: %v", rows(c.Files))
	}
	if got, err := os.ReadFile(canary); err == nil {
		t.Errorf("the submodule's core.fsmonitor ran:\n%s", got)
	}
}

// TestCompareNoLazyFetch: in a partial clone a read of a missing object is a fetch, and a
// fetch is core.sshCommand. A comparison asks for neither, and says what is missing.
func TestCompareNoLazyFetch(t *testing.T) {
	f := newFixture(t)
	writeFile(t, filepath.Join(f.project, "a.txt"), "one\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "one")
	writeFile(t, filepath.Join(f.project, "a.txt"), "two\n")
	git(t, f.project, "commit", "-q", "-am", "two")
	git(t, f.project, "push", "-q")
	origin := strings.TrimSpace(git(t, f.project, "remote", "get-url", "origin"))
	git(t, origin, "config", "uploadpack.allowFilter", "true")
	git(t, origin, "config", "uploadpack.allowAnySHA1InWant", "true")
	clone := filepath.Join(f.base, "partial")
	git(t, f.base, "-c", "protocol.file.allow=always", "clone", "-q", "--filter=blob:none", "file://"+origin, clone)

	h := startHarness(t, "", Options{})
	ctx := ctx20(t)
	r, err := h.store.Register(ctx, clone)
	if err != nil {
		t.Fatal(err)
	}
	p, err := filepath.EvalSymlinks(clone)
	if err != nil {
		t.Fatal(err)
	}
	canary := filepath.Join(f.base, "canary")
	evil := filepath.Join(f.base, "evil")
	if err := os.WriteFile(evil, []byte("#!/bin/sh\necho \"$*\" >> "+canary+"\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, p, "config", "remote.origin.url", "ssh://git@127.0.0.1:1/x.git")
	git(t, p, "config", "core.sshCommand", evil)

	c, err := h.store.CompareWorktree(ctx, CompareRequest{ProjectID: r.ID, Path: p, Base: sourceRef("HEAD~1"), Head: sourceRef("HEAD")})
	if err != nil {
		t.Fatal(err)
	}
	if c.Error != objectsMissing || len(c.Files) != 0 {
		t.Errorf("list: error %q, files %v", c.Error, rows(c.Files))
	}
	d, err := h.store.CompareFile(ctx, CompareFileRequest{ProjectID: r.ID, Path: p, Base: sourceRef("HEAD~1"), Head: sourceRef("HEAD"), File: "a.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Error != objectsMissing {
		t.Errorf("read: %+v", d)
	}
	if got, err := os.ReadFile(canary); err == nil {
		t.Errorf("core.sshCommand ran: %s", got)
	}
	// What the clone has still compares.
	c, err = h.store.CompareWorktree(ctx, CompareRequest{ProjectID: r.ID, Path: p, Base: sourceRef("HEAD"), Head: sourceWorking})
	if err != nil || c.Error != "" {
		t.Errorf("err %v, error %q", err, c.Error)
	}
}

// TestCompareCleanFilterStays: why filters are not turned off. A working tree holds what a
// clean filter turns into the stored bytes (LFS, git-crypt), so without it every such file
// would differ from its own commit.
func TestCompareCleanFilterStays(t *testing.T) {
	f := newCompareFixture(t)
	git(t, f.path, "config", "filter.up.clean", "tr a-z A-Z")
	writeFile(t, filepath.Join(f.path, ".gitattributes"), "*.up filter=up\n")
	writeFile(t, filepath.Join(f.path, "a.up"), "hello\n")
	git(t, f.path, "add", ".gitattributes", "a.up")
	git(t, f.path, "commit", "-q", "-m", "filtered")
	if got := git(t, f.path, "show", "HEAD:a.up"); strings.TrimSpace(got) != "HELLO" {
		t.Fatalf("stored %q", got)
	}
	c := f.compare(t, sourceRef("HEAD"), sourceWorking, "a.up")
	if len(c.Files) != 0 {
		t.Errorf("a filtered file differs from its commit: %v", rows(c.Files))
	}
}

// auditRunner notes any command of a compare that is not guarded.
type auditRunner struct {
	ExecRunner
	mu        sync.Mutex
	seen      int
	unguarded []string
}

type auditKey struct{}

func (r *auditRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if ctx.Value(auditKey{}) != nil {
		r.mu.Lock()
		r.seen++
		if ctx.Value(guardedKey{}) == nil {
			r.unguarded = append(r.unguarded, strings.Join(args, " "))
		}
		r.mu.Unlock()
	}
	return r.ExecRunner.Run(ctx, dir, args...)
}

// TestCompareEveryCommandGuarded: every git command of the compare path, from the base
// lookup to a submodule's HEAD, runs guarded.
func TestCompareEveryCommandGuarded(t *testing.T) {
	audit := &auditRunner{}
	f := newCompareFixtureWith(t, Options{Runner: audit})
	lib := filepath.Join(f.base, "lib")
	git(t, f.base, "init", "-q", "-b", "main", lib)
	writeFile(t, filepath.Join(lib, "lib.txt"), "v1\n")
	git(t, lib, "add", ".")
	git(t, lib, "commit", "-q", "-m", "one")
	git(t, f.path, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", lib, "lib")
	ctx := context.WithValue(ctx20(t), auditKey{}, true)
	sources := []DiffSource{{}, sourceWorking, sourceStaged, sourceRef("HEAD")}
	for _, a := range sources {
		for _, b := range sources {
			if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{ProjectID: f.id, Path: f.path, Base: a, Head: b}); err != nil {
				t.Fatal(err)
			}
			for _, file := range []string{"keep.txt", "lib", "stage.txt", "new.txt"} {
				if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{ProjectID: f.id, Path: f.path, Base: a, Head: b, File: file}); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	audit.mu.Lock()
	defer audit.mu.Unlock()
	if audit.seen == 0 || len(audit.unguarded) != 0 {
		t.Errorf("%d commands, unguarded: %q", audit.seen, audit.unguarded)
	}
}

// TestGuardedCommand: what guarded does to a command, seen from the git it starts.
func TestGuardedCommand(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "git")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\necho \"lazy=$GIT_NO_LAZY_FETCH\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := ExecRunner{Git: fake}
	tests := []struct {
		name string
		ctx  context.Context
		want string
	}{
		{"plain", context.Background(), "lazy= diff\n"},
		{"guarded", guarded(context.Background()), "lazy=1 -c core.fsmonitor=false diff\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, err := r.Run(tt.ctx, t.TempDir(), "diff")
			if err != nil {
				t.Fatal(err)
			}
			if string(out) != tt.want {
				t.Errorf("ran %q, want %q", out, tt.want)
			}
		})
	}
}
