package thread

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// recordingProjects records CreateWorktree options and can fail them.
type recordingProjects struct {
	*projecttest.Fake
	mu   sync.Mutex
	opts []project.CreateWorktreeOptions
	err  error
}

func (r *recordingProjects) CreateWorktree(ctx context.Context, o project.CreateWorktreeOptions) (project.Worktree, error) {
	r.mu.Lock()
	r.opts = append(r.opts, o)
	err := r.err
	r.mu.Unlock()
	if err != nil {
		return project.Worktree{}, err
	}
	wt, err := r.Fake.CreateWorktree(ctx, o)
	wt.Status.BaseRef = "origin/main"
	return wt, err
}

func (r *recordingProjects) created() []project.CreateWorktreeOptions {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.opts)
}

// newWorktreeEnv is an env whose project source records worktree creation and whose
// RefExists reports the refs in taken.
func newWorktreeEnv(t *testing.T, taken []string, mutate ...func(*Options)) (*env, *recordingProjects) {
	t.Helper()
	var rr *recordingProjects
	e := newEnv(t, append([]func(*Options){func(o *Options) {
		rr = &recordingProjects{Fake: o.Projects.(*projecttest.Fake)}
		rr.WorktreeRoot = t.TempDir()
		o.Projects = rr
		o.SlugTimeout = 300 * time.Millisecond
		o.NamingRetryDelay = 10 * time.Millisecond
		o.RefExists = func(_ context.Context, dir, ref string) bool { return slices.Contains(taken, ref) }
	}}, mutate...)...)
	return e, rr
}

func TestCreateNewWorktree(t *testing.T) {
	fixDoX := func(int, string) (string, error) { return "Title: Do x\nBranch: fix/do-x", nil }
	prefix := &BranchNaming{Mode: BranchModePrefix, Prefix: "cf"}
	off := func(int, string) (string, error) { return "", fmt.Errorf("%w in settings", ErrNamingOff) }
	tests := []struct {
		name       string
		o          CreateOptions
		cfg        *BranchNaming // default DefaultBranchNaming (semantic)
		taken      []string
		namer      func(n int, msg string) (string, error) // n counts calls from 1
		wantBranch string                                  // "<id>" stands for cf/<thread id>
		wantName   string
		// wantProvisional: the name is the prompt's provisional one (the namer failed).
		wantProvisional bool
		wantCalls       int
		wantBase        string
		// baseIgnored: the branch exists, so CreateWorktree gets no base.
		baseIgnored bool
		// wantHint is the first naming request's branch hint; "-" when it asks no branch.
		wantHint string
	}{
		{name: "title and branch in time name the thread and the branch", o: CreateOptions{ProjectID: "r1", InitialPrompt: "fix the login bug"},
			namer:      func(int, string) (string, error) { return "Title: Fix the login bug\nBranch: fix/login-bug", nil },
			wantBranch: "fix/login-bug", wantName: "Fix the login bug", wantCalls: 1, wantBase: "origin/main"},
		{name: "a reply without a branch slugs the title, type chore", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer:      func(int, string) (string, error) { return "Add README usage section for tests", nil },
			wantBranch: "chore/add-readme-usage-section-for-tests", wantName: "Add README usage section for tests", wantCalls: 1,
			wantBase: "origin/main"},
		{name: "a type outside the list is chore", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer:      func(int, string) (string, error) { return "Title: Do x\nBranch: feature/do-x", nil },
			wantBranch: "chore/do-x", wantName: "Do x", wantCalls: 1, wantBase: "origin/main"},
		{name: "a title with nothing to slugify names the thread, the branch is the id", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: func(int, string) (string, error) { return "Добавить тёмную тему", nil }, wantBranch: "<id>",
			wantName: "Добавить тёмную тему", wantCalls: 1, wantBase: "origin/main"},
		{name: "project by name", o: CreateOptions{ProjectID: "repo", InitialPrompt: "x"},
			namer: fixDoX, wantBranch: "fix/do-x", wantName: "Do x", wantCalls: 1, wantBase: "origin/main"},
		{name: "explicit base ref", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{BaseRef: "origin/dev"}},
			namer: fixDoX, wantBranch: "fix/do-x", wantName: "Do x", wantCalls: 1, wantBase: "origin/dev"},
		{name: "taken branch gets a suffix", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			taken: []string{"refs/heads/fix/do-x", "refs/remotes/origin/fix/do-x-2"},
			namer: fixDoX, wantBranch: "fix/do-x-3", wantName: "Do x", wantCalls: 1, wantBase: "origin/main"},
		{name: "namer error uses the id, never the provisional name", o: CreateOptions{ProjectID: "r1", InitialPrompt: "fix the login bug"},
			namer: func(int, string) (string, error) { return "", errors.New("exit status 1") }, wantBranch: "<id>", wantCalls: 1,
			wantName: "fix the login bug", wantProvisional: true,
			wantBase: "origin/main"},
		{name: "rate limit is retried once", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: func(n int, _ string) (string, error) {
				if n == 1 {
					return "", errors.New("claude -p: exit status 1: API Error: 429 rate limit")
				}
				return "Title: After retry\nBranch: fix/after-retry", nil
			}, wantBranch: "fix/after-retry", wantName: "After retry", wantCalls: 2, wantBase: "origin/main"},
		{name: "second rate limit gives up", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: func(int, string) (string, error) { return "", errors.New("Rate limit reached") }, wantBranch: "<id>",
			wantName: "x", wantProvisional: true,
			wantCalls: 2, wantBase: "origin/main"},
		{name: "explicit name: the namer still names the branch, its title is ignored", o: CreateOptions{ProjectID: "r1", Name: "My Big Feature!", InitialPrompt: "x"},
			namer:      func(int, string) (string, error) { return "Title: Something else\nBranch: feat/big-feature", nil },
			wantBranch: "feat/big-feature", wantName: "My Big Feature!", wantCalls: 1, wantBase: "origin/main"},
		{name: "no prompt uses the id", o: CreateOptions{ProjectID: "r1"}, wantBranch: "<id>", wantCalls: 0, wantBase: "origin/main"},
		{name: "project from a worktree path", o: CreateOptions{WorktreePath: "<wt>", InitialPrompt: "x"},
			namer: fixDoX, wantBranch: "fix/do-x", wantName: "Do x", wantCalls: 1, wantBase: "origin/main"},
		{name: "prefix mode", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"}, cfg: prefix,
			namer:      func(int, string) (string, error) { return "Title: Do x\nBranch: do-x", nil },
			wantBranch: "cf/do-x", wantName: "Do x", wantCalls: 1, wantBase: "origin/main"},
		{name: "prefix mode without a prefix is a bare slug", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			cfg:        &BranchNaming{Mode: BranchModePrefix},
			namer:      func(int, string) (string, error) { return "Title: Do x\nBranch: do-x", nil },
			wantBranch: "do-x", wantName: "Do x", wantCalls: 1, wantBase: "origin/main"},
		{name: "custom mode takes the model's branch, spaces made dashes", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			cfg:        &BranchNaming{Mode: BranchModeCustom, Instructions: "ab/<ticket>-<slug>"},
			namer:      func(int, string) (string, error) { return "Title: Do x\nBranch: `ab/T-1 do x`", nil },
			wantBranch: "ab/T-1-do-x", wantName: "Do x", wantCalls: 1, wantBase: "origin/main"},
		{name: "custom mode: a branch git refuses is the id", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			cfg:        &BranchNaming{Mode: BranchModeCustom, Instructions: "anything"},
			namer:      func(int, string) (string, error) { return "Title: Do x\nBranch: ab/..do~x", nil },
			wantBranch: "<id>", wantName: "Do x", wantCalls: 1, wantBase: "origin/main"},
		{name: "--branch slug: the model picks only the type", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{Branch: "Add Filter"}},
			namer:      func(int, string) (string, error) { return "Title: Add a filter\nBranch: feat/something-else", nil },
			wantBranch: "feat/add-filter", wantName: "Add a filter", wantCalls: 1, wantBase: "origin/main", wantHint: "add-filter"},
		{name: "--branch slug that exists is checked out, not suffixed; the base is ignored",
			o:     CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{Branch: "add-filter", BaseRef: "origin/dev"}},
			taken: []string{"refs/remotes/origin/feat/add-filter"},
			namer: func(int, string) (string, error) { return "Title: Add a filter\nBranch: feat/add-filter", nil },
			wantBranch: "feat/add-filter", wantName: "Add a filter", wantCalls: 1, wantBase: "origin/main", baseIgnored: true, wantHint: "add-filter"},
		{name: "--branch slug survives a failed namer", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{Branch: "add-filter"}},
			namer:      func(int, string) (string, error) { return "", errors.New("exit status 1") },
			wantBranch: "chore/add-filter", wantName: "x", wantProvisional: true, wantCalls: 1, wantBase: "origin/main"},
		{name: "--branch slug in prefix mode with a name needs no model", cfg: prefix,
			o:          CreateOptions{ProjectID: "r1", Name: "Mine", InitialPrompt: "x", NewWorktree: &NewWorktree{Branch: "add-filter"}},
			wantBranch: "cf/add-filter", wantName: "Mine", wantCalls: 0, wantBase: "origin/main"},
		{name: "--branch with a slash is verbatim; the namer only titles", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{Branch: "alex/JIRA-1"}},
			namer:      func(int, string) (string, error) { return "Do x", nil },
			wantBranch: "alex/JIRA-1", wantName: "Do x", wantCalls: 1, wantBase: "origin/main", wantHint: "-"},
		{name: "--branch with a slash that exists is checked out; the base is ignored",
			o:     CreateOptions{ProjectID: "r1", Name: "Mine", NewWorktree: &NewWorktree{Branch: "alex/JIRA-1", BaseRef: "origin/dev"}},
			taken: []string{"refs/heads/alex/JIRA-1"}, wantBranch: "alex/JIRA-1", wantName: "Mine", wantCalls: 0, wantBase: "origin/main", baseIgnored: true},
		{name: "auto-naming off, semantic: the id", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: off, wantBranch: "<id>", wantName: "x", wantProvisional: true, wantCalls: 1, wantBase: "origin/main"},
		{name: "auto-naming off, prefix: the explicit name's slug", cfg: prefix, o: CreateOptions{ProjectID: "r1", Name: "My Big Feature!", InitialPrompt: "x"},
			namer: off, wantBranch: "cf/my-big-feature", wantName: "My Big Feature!", wantCalls: 1, wantBase: "origin/main"},
		{name: "auto-naming off, prefix, no name: the id", cfg: prefix, o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: off, wantBranch: "<id>", wantName: "x", wantProvisional: true, wantCalls: 1, wantBase: "origin/main"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := newWorktreeEnv(t, tt.taken, func(o *Options) {
				if tt.cfg != nil {
					o.BranchNaming = func() BranchNaming { return *tt.cfg }
				}
			})
			calls := 0
			e.namer = func(msg string) (string, error) {
				calls++
				if tt.namer == nil {
					return "", errors.New("unexpected namer call")
				}
				return tt.namer(calls, msg)
			}
			o := tt.o
			if o.NewWorktree == nil {
				o.NewWorktree = &NewWorktree{}
			}
			if o.WorktreePath == "<wt>" {
				o.WorktreePath = e.wt
			}
			s, err := e.m.Create(e.ctx(), o)
			if err != nil {
				t.Fatal(err)
			}
			branch := strings.ReplaceAll(tt.wantBranch, "<id>", "cf/"+s.ID)
			wantBase := o.NewWorktree.BaseRef
			if tt.baseIgnored {
				wantBase = ""
			}
			got := rr.created()
			if len(got) != 1 || got[0].Branch != branch || got[0].ProjectID != "r1" || !got[0].Fetch ||
				got[0].BaseRef != wantBase {
				t.Fatalf("CreateWorktree calls = %+v, want branch %s base %q", got, branch, wantBase)
			}
			wantPath := rr.WorktreeRoot + "/_local/repo/" + strings.ReplaceAll(branch, "/", "-")
			if !s.CreatedWorktree || s.WorktreePath != wantPath || s.ProjectID != "r1" || s.BaseRef != tt.wantBase ||
				s.Name != tt.wantName || s.AutoNamed != (tt.wantName != "" && tt.o.Name == "" && !tt.wantProvisional) ||
				s.NameProvisional != tt.wantProvisional || s.Branch != branch {
				t.Errorf("thread = %+v", s)
			}
			spec := e.spec(s.ID)
			if !samePath(spec.Cwd, wantPath) {
				t.Errorf("spawned in %q", spec.Cwd)
			}
			e.mu.Lock()
			n := len(e.named)
			reqs := slices.Clone(e.namingReqs)
			e.mu.Unlock()
			if n != tt.wantCalls {
				t.Errorf("namer calls = %d, want %d", n, tt.wantCalls)
			}
			if n > 0 && reqs[0].Name != tt.o.Name {
				t.Errorf("naming request name = %q, want %q", reqs[0].Name, tt.o.Name)
			}
			switch {
			case tt.wantHint == "-":
				if reqs[0].Branch != nil {
					t.Errorf("naming request asks a branch: %+v", reqs[0].Branch)
				}
			case tt.wantHint != "":
				if reqs[0].Branch == nil || reqs[0].Branch.Hint != tt.wantHint {
					t.Errorf("naming request branch = %+v, want hint %q", reqs[0].Branch, tt.wantHint)
				}
			}
			// The transcript's first message does not trigger a second naming call.
			cid := argOf(spec.Argv, "--session-id")
			e.wt = s.WorktreePath
			e.writeTranscript(cid, userLine("x"))
			e.waitFor(s.ID, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid })
			time.Sleep(50 * time.Millisecond)
			e.mu.Lock()
			n2 := len(e.named)
			e.mu.Unlock()
			if want := tt.wantCalls; tt.wantCalls == 0 && tt.o.Name == "" {
				// Nothing named the thread yet, so the transcript path may name it.
				if n2 > 1 {
					t.Errorf("namer calls after transcript = %d", n2)
				}
			} else if n2 != want {
				t.Errorf("namer calls after transcript = %d, want %d", n2, want)
			}
		})
	}
}

func TestCreateNewWorktreeSlugTimeoutNamesLater(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	release := make(chan struct{})
	e.namer = func(string) (string, error) {
		<-release
		return "Slow name", nil
	}
	start := time.Now()
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{}})
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("Create took %v", took)
	}
	if got := rr.created(); len(got) != 1 || got[0].Branch != "cf/"+s.ID {
		t.Fatalf("CreateWorktree calls = %+v", got)
	}
	// The provisional name shows meanwhile; the branch never takes it.
	if s.Name != "x" || !s.NameProvisional || s.AutoNamed || s.State != StateStarting {
		t.Fatalf("thread = %+v", s)
	}
	close(release)
	got := e.waitFor(s.ID, "named", func(s Thread) bool { return s.Name == "Slow name" })
	if !got.AutoNamed || got.NameProvisional {
		t.Errorf("thread = %+v", got)
	}
	rows, _ := loadThreads(context.Background(), e.m.opts.DB)
	if len(rows) != 1 || rows[0].Name != "Slow name" || rows[0].NameProvisional || !rows[0].CreatedWorktree || rows[0].BaseRef != "origin/main" {
		t.Errorf("rows = %+v", rows)
	}
}

func TestCreateNewWorktreeSlugTimeoutKeepsRename(t *testing.T) {
	e, _ := newWorktreeEnv(t, nil)
	release := make(chan struct{})
	e.namer = func(string) (string, error) {
		<-release
		return "Slow name", nil
	}
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Rename(e.ctx(), s.ID, "mine"); err != nil {
		t.Fatal(err)
	}
	close(release)
	time.Sleep(100 * time.Millisecond)
	if got, _ := e.m.Get(e.ctx(), s.ID); got.Name != "mine" || got.AutoNamed || got.NameProvisional {
		t.Errorf("late name overwrote the rename: %+v", got)
	}
}

func TestCreateNewWorktreeFailures(t *testing.T) {
	tests := []struct {
		name       string
		o          CreateOptions
		projectErr error
		wantErr    error
	}{
		{"worktree creation fails", CreateOptions{ProjectID: "r1"}, fmt.Errorf("%w: git: fatal: invalid reference", project.ErrFailedPrecondition), ErrFailedPrecondition},
		{"project store rejects the branch", CreateOptions{ProjectID: "r1"}, fmt.Errorf("%w: bad branch", project.ErrInvalidArgument), ErrInvalidArgument},
		{"unknown project", CreateOptions{ProjectID: "nope"}, nil, ErrNotFound},
		{"no project", CreateOptions{}, nil, ErrInvalidArgument},
		{"base ref like a flag", CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{BaseRef: "--upload-pack=x"}}, nil, ErrInvalidArgument},
		{"base ref with a space", CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{BaseRef: "a b"}}, nil, ErrInvalidArgument},
		{"bad permission mode", CreateOptions{ProjectID: "r1", PermissionMode: PermissionMode(7)}, nil, ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := newWorktreeEnv(t, nil)
			rr.err = tt.projectErr
			o := tt.o
			if o.NewWorktree == nil {
				o.NewWorktree = &NewWorktree{}
			}
			_, err := e.m.Create(e.ctx(), o)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if n := len(e.m.Snapshot().Threads); n != 0 {
				t.Errorf("failed create left %d threads", n)
			}
			if rows, _ := loadThreads(context.Background(), e.m.opts.DB); len(rows) != 0 {
				t.Errorf("failed create persisted %+v", rows)
			}
		})
	}
}

// A project without git has only its current checkout: a new worktree is refused
// before the namer runs, and a plain thread there still starts.
func TestCreateNewWorktreeInProjectWithoutGit(t *testing.T) {
	e, rr := newWorktreeEnv(t, nil)
	dir := t.TempDir()
	rr.Put(project.Project{ID: "plain", Path: dir, Name: "notes", Worktrees: []project.Worktree{{ProjectID: "plain", Path: dir, IsMain: true}}})
	_, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "plain", NewWorktree: &NewWorktree{}, InitialPrompt: "fix it"})
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "notes is not a git repository") {
		t.Fatalf("err = %v", err)
	}
	if len(rr.created()) != 0 {
		t.Fatalf("worktrees created: %+v", rr.created())
	}
	e.mu.Lock()
	named := slices.Clone(e.named)
	e.mu.Unlock()
	if len(named) != 0 {
		t.Fatalf("namer called: %v", named)
	}
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "plain"})
	if err != nil || s.WorktreePath != dir {
		t.Fatalf("thread in the checkout = %+v, %v", s, err)
	}
}

func TestCreateNewWorktreeNeedsProjectStore(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.Projects = nil })
	if _, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}}); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("err = %v", err)
	}
}

func TestIsRateLimit(t *testing.T) {
	tests := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{errors.New("claude -p: exit status 1: API Error: 429 {\"type\":\"error\"}"), true},
		{errors.New("Rate limit reached for requests"), true},
		{errors.New(`{"type":"rate_limit_error"}`), true},
		{errors.New("claude -p: exit status 1: overloaded"), false},
		{context.DeadlineExceeded, false},
	}
	for _, tt := range tests {
		if got := isRateLimit(tt.err); got != tt.want {
			t.Errorf("isRateLimit(%v) = %v, want %v", tt.err, got, tt.want)
		}
	}
}

func TestValidateRef(t *testing.T) {
	tests := map[string]bool{
		"":                       true,
		"main":                   true,
		"origin/main":            true,
		"v1.2.3":                 true,
		"HEAD~2":                 true,
		"-x":                     false,
		"--upload-pack=x":        false,
		"a b":                    false,
		"a\nb":                   false,
		"a\x00b":                 false,
		strings.Repeat("a", 251): false,
	}
	for ref, ok := range tests {
		if err := validateRef(ref); (err == nil) != ok {
			t.Errorf("validateRef(%q) = %v, want ok=%v", ref, err, ok)
		}
	}
}

func TestBuildPrompt(t *testing.T) {
	tests := []struct {
		name        string
		text        string
		attachments []attachment
		want        string
	}{
		{"empty", "", nil, ""},
		{"whitespace only", " \n\t", nil, ""},
		{"text", " fix it \n", nil, "fix it"},
		{"text and images", "fix it", []attachment{{path: "/a/1.png"}, {path: "/a/2.jpg"}}, "fix it\n\nAttached image: /a/1.png\nAttached image: /a/2.jpg"},
		{"images only", "", []attachment{{path: "/a/1.png"}}, "Attached image: /a/1.png"},
		{"short pdf", "read", []attachment{{path: "/a/1.pdf", pdf: true, pages: 2, exact: true}}, "read\n\nAttached PDF: /a/1.pdf (2 pages)"},
		{"one page", "", []attachment{{path: "/a/1.pdf", pdf: true, pages: 1, exact: true}}, "Attached PDF: /a/1.pdf (1 page)"},
		{"ten pages inline", "", []attachment{{path: "/a/1.pdf", pdf: true, pages: 10, exact: true}}, "Attached PDF: /a/1.pdf (10 pages)"},
		{"estimated", "", []attachment{{path: "/a/1.pdf", pdf: true, pages: 3}}, "Attached PDF: /a/1.pdf (about 3 pages)"},
		{"long pdf", "", []attachment{{path: "/a/1.pdf", pdf: true, pages: 30, exact: true}},
			"Attached PDF: /a/1.pdf (30 pages, not sent inline); read it with the Read tool's pages parameter, at most 20 pages per call"},
		{"long estimate", "", []attachment{{path: "/a/1.pdf", pdf: true, pages: 11}},
			"Attached PDF: /a/1.pdf (about 11 pages, not sent inline); read it with the Read tool's pages parameter, at most 20 pages per call"},
		{"image and pdf", "x", []attachment{{path: "/a/1.png"}, {path: "/a/2.pdf", pdf: true, pages: 4, exact: true}}, "x\n\nAttached image: /a/1.png\nAttached PDF: /a/2.pdf (4 pages)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := buildPrompt(tt.text, tt.attachments); got != tt.want {
				t.Errorf("buildPrompt = %q, want %q", got, tt.want)
			}
		})
	}
}
