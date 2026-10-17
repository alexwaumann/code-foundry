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

// recordingRepos records CreateWorktree options and can fail them.
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

// newWorktreeEnv is an env whose repo source records worktree creation and whose
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
	tests := []struct {
		name       string
		o          CreateOptions
		taken      []string
		namer      func(n int, msg string) (string, error) // n counts calls from 1
		wantBranch string                                  // "<id>" stands for cf/<thread id>
		wantName   string
		wantCalls  int
		wantBase   string
	}{
		{name: "title in time names the thread, its slug the branch", o: CreateOptions{ProjectID: "r1", InitialPrompt: "fix the login bug"},
			namer: func(int, string) (string, error) { return "Fix the login bug", nil }, wantBranch: "cf/fix-the-login-bug",
			wantName: "Fix the login bug", wantCalls: 1, wantBase: "origin/main"},
		{name: "a six-word title keeps every word in the branch", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer:      func(int, string) (string, error) { return "Add README usage section for tests", nil },
			wantBranch: "cf/add-readme-usage-section-for-tests", wantName: "Add README usage section for tests", wantCalls: 1,
			wantBase: "origin/main"},
		{name: "a title with nothing to slugify names the thread, the branch is the id", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: func(int, string) (string, error) { return "Добавить тёмную тему", nil }, wantBranch: "<id>",
			wantName: "Добавить тёмную тему", wantCalls: 1, wantBase: "origin/main"},
		{name: "explicit base ref", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{BaseRef: "origin/dev"}},
			namer: func(int, string) (string, error) { return "Do x", nil }, wantBranch: "cf/do-x", wantName: "Do x", wantCalls: 1,
			wantBase: "origin/dev"},
		{name: "taken branch gets a suffix", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			taken: []string{"refs/heads/cf/do-x", "refs/remotes/origin/cf/do-x-2"},
			namer: func(int, string) (string, error) { return "Do x", nil }, wantBranch: "cf/do-x-3", wantName: "Do x", wantCalls: 1,
			wantBase: "origin/main"},
		{name: "namer error uses the id", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: func(int, string) (string, error) { return "", errors.New("exit status 1") }, wantBranch: "<id>", wantCalls: 1,
			wantBase: "origin/main"},
		{name: "rate limit is retried once", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: func(n int, _ string) (string, error) {
				if n == 1 {
					return "", errors.New("claude -p: exit status 1: API Error: 429 rate limit")
				}
				return "After retry", nil
			}, wantBranch: "cf/after-retry", wantName: "After retry", wantCalls: 2, wantBase: "origin/main"},
		{name: "second rate limit gives up", o: CreateOptions{ProjectID: "r1", InitialPrompt: "x"},
			namer: func(int, string) (string, error) { return "", errors.New("Rate limit reached") }, wantBranch: "<id>",
			wantCalls: 2, wantBase: "origin/main"},
		{name: "explicit name is the slug without the namer", o: CreateOptions{ProjectID: "r1", Name: "My Big Feature!", InitialPrompt: "x"},
			wantBranch: "cf/my-big-feature", wantName: "My Big Feature!", wantCalls: 0, wantBase: "origin/main"},
		{name: "no prompt uses the id", o: CreateOptions{ProjectID: "r1"}, wantBranch: "<id>", wantCalls: 0, wantBase: "origin/main"},
		{name: "repo from a worktree path", o: CreateOptions{WorktreePath: "<wt>", InitialPrompt: "x"},
			namer: func(int, string) (string, error) { return "From path", nil }, wantBranch: "cf/from-path", wantName: "From path",
			wantCalls: 1, wantBase: "origin/main"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := newWorktreeEnv(t, tt.taken)
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
			got := rr.created()
			if len(got) != 1 || got[0].Branch != branch || got[0].ProjectID != "r1" || !got[0].Fetch ||
				got[0].BaseRef != o.NewWorktree.BaseRef {
				t.Fatalf("CreateWorktree calls = %+v, want branch %s", got, branch)
			}
			wantPath := rr.WorktreeRoot + "/_local/repo/" + strings.ReplaceAll(branch, "/", "-")
			if !s.CreatedWorktree || s.WorktreePath != wantPath || s.ProjectID != "r1" || s.BaseRef != tt.wantBase ||
				s.Name != tt.wantName || s.AutoNamed != (tt.wantName != "" && tt.o.Name == "") {
				t.Errorf("thread = %+v", s)
			}
			spec := e.spec(s.ID)
			if !samePath(spec.Cwd, wantPath) {
				t.Errorf("spawned in %q", spec.Cwd)
			}
			e.mu.Lock()
			n := len(e.named)
			e.mu.Unlock()
			if n != tt.wantCalls {
				t.Errorf("namer calls = %d, want %d", n, tt.wantCalls)
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

func TestCreateNewWorktreeUsesWorktreePathOption(t *testing.T) {
	dir := t.TempDir()
	e, rr := newWorktreeEnv(t, nil, func(o *Options) {
		o.WorktreePath = func(r project.Project, branch string) string {
			return dir + "/" + r.Name + "/" + strings.ReplaceAll(branch, "/", "-")
		}
	})
	e.namer = func(string) (string, error) { return "Do x", nil }
	s, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{}})
	if err != nil {
		t.Fatal(err)
	}
	want := dir + "/repo/cf-do-x"
	if got := rr.created(); len(got) != 1 || got[0].Path != want || s.WorktreePath != want {
		t.Fatalf("CreateWorktree calls = %+v, thread path %q", got, s.WorktreePath)
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
	if s.Name != "" || s.State != StateStarting {
		t.Fatalf("thread = %+v", s)
	}
	close(release)
	got := e.waitFor(s.ID, "named", func(s Thread) bool { return s.Name == "Slow name" })
	if !got.AutoNamed {
		t.Errorf("thread = %+v", got)
	}
	rows, _ := loadThreads(context.Background(), e.m.opts.DB)
	if len(rows) != 1 || rows[0].Name != "Slow name" || !rows[0].CreatedWorktree || rows[0].BaseRef != "origin/main" {
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
	if got, _ := e.m.Get(e.ctx(), s.ID); got.Name != "mine" || got.AutoNamed {
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
		{"repo store rejects the branch", CreateOptions{ProjectID: "r1"}, fmt.Errorf("%w: bad branch", project.ErrInvalidArgument), ErrInvalidArgument},
		{"unknown repo", CreateOptions{ProjectID: "nope"}, nil, ErrNotFound},
		{"no repo", CreateOptions{}, nil, ErrInvalidArgument},
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
