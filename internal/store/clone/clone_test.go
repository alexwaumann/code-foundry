package clone

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// fakeRunner plays gh repo clone: it emits lines, optionally creates the destination
// (its last argument before "--"), and returns err. block makes it wait for ctx.
type fakeRunner struct {
	mu     sync.Mutex
	calls  [][]string
	dirs   []string
	lines  []Progress
	create bool // create the destination with a .git directory
	err    error
	block  bool
}

func (f *fakeRunner) Run(ctx context.Context, dir, name string, args []string, line func(Progress)) error {
	f.mu.Lock()
	f.calls = append(f.calls, append([]string{name}, args...))
	f.dirs = append(f.dirs, dir)
	f.mu.Unlock()
	for _, l := range f.lines {
		line(l)
	}
	if f.create && len(args) >= 4 {
		if err := os.MkdirAll(filepath.Join(args[3], ".git"), 0o755); err != nil {
			return err
		}
	}
	if f.block {
		<-ctx.Done()
		return &ExitError{ExitCode: -1, Err: ctx.Err()}
	}
	return f.err
}

func (f *fakeRunner) ncalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

type fakeRepos struct {
	mu    sync.Mutex
	paths []string
	err   error
}

func (r *fakeRepos) Register(_ context.Context, path string) (repo.Repo, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return repo.Repo{}, r.err
	}
	r.paths = append(r.paths, path)
	return repo.Repo{ID: "id-" + filepath.Base(path), Path: path, Name: filepath.Base(path), Git: true}, nil
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func TestClone(t *testing.T) {
	progress := []Progress{
		{Line: "Cloning into '/x'..."},
		{Line: "Receiving objects:  50% (1/2)", Transient: true},
		{Line: "Receiving objects: 100% (2/2), done."},
	}
	tests := []struct {
		name        string
		owner, repo string
		setup       func(t *testing.T, root string) // before the clone
		runner      *fakeRunner
		repos       *fakeRepos
		allowed     func(home, root string) string
		timeout     time.Duration
		wantErr     error  // errors.Is
		wantMsg     string // substring of the error
		wantRun     bool
		wantDest    bool // the destination exists afterwards
		wantOwner   bool // the owner directory exists afterwards
		wantRegistr bool
	}{
		{
			name: "clones, streams and registers", owner: "Octo", repo: "hello.world",
			runner: &fakeRunner{lines: progress, create: true}, wantRun: true, wantDest: true, wantOwner: true, wantRegistr: true,
		},
		{
			name: "destination exists: refused before gh runs", owner: "octo", repo: "taken",
			setup: func(t *testing.T, root string) {
				if err := os.MkdirAll(filepath.Join(root, "octo", "taken"), 0o755); err != nil {
					t.Fatal(err)
				}
			},
			wantErr: ErrExists, wantMsg: "taken already exists", wantDest: true, wantOwner: true,
		},
		{
			name: "invalid owner/repo: refused before anything", owner: "-bad", repo: "x",
			wantErr: ErrInvalidArgument,
		},
		{
			name: "path traversal in the name: refused", owner: "octo", repo: "..",
			wantErr: ErrInvalidArgument,
		},
		{
			name: "missing repository: not found, owner dir removed again", owner: "octo", repo: "nope",
			runner:  &fakeRunner{err: &ExitError{ExitCode: 1, Tail: []string{"GraphQL: Could not resolve to a Repository with the name 'octo/nope'. (repository)"}}},
			wantErr: ErrNotFound, wantMsg: "Could not resolve", wantRun: true,
		},
		{
			name: "gh fails midway: partial clone removed, existing owner dir kept", owner: "octo", repo: "flaky",
			setup: func(t *testing.T, root string) {
				if err := os.MkdirAll(filepath.Join(root, "octo", "other"), 0o755); err != nil {
					t.Fatal(err)
				}
			},
			runner:  &fakeRunner{create: true, err: &ExitError{ExitCode: 128, Tail: []string{"error: RPC failed", "fatal: early EOF"}}},
			wantErr: ErrFailed, wantMsg: "error: RPC failed\nfatal: early EOF", wantRun: true, wantOwner: true,
		},
		{
			name: "timeout: killed and removed", owner: "octo", repo: "huge",
			runner: &fakeRunner{create: true, block: true}, timeout: 30 * time.Millisecond,
			wantErr: context.DeadlineExceeded, wantMsg: "longer than 30ms", wantRun: true,
		},
		{
			name: "registration fails: the clone stays", owner: "octo", repo: "kept",
			runner: &fakeRunner{create: true}, repos: &fakeRepos{err: errors.New("database is locked")},
			wantMsg: "but could not add it as a project: database is locked", wantRun: true, wantDest: true, wantOwner: true,
		},
		{
			name: "projects directory outside home: refused before gh runs", owner: "octo", repo: "far",
			allowed: func(home, _ string) string { return filepath.Join(home, "elsewhere") },
			wantErr: ErrOutsideRoot,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.runner == nil {
				tt.runner = &fakeRunner{}
			}
			if tt.repos == nil {
				tt.repos = &fakeRepos{}
			}
			home := t.TempDir()
			home, _ = filepath.EvalSymlinks(home)
			root := filepath.Join(home, ".code-foundry", "projects")
			if tt.setup != nil {
				tt.setup(t, root)
			}
			allowed := home
			if tt.allowed != nil {
				allowed = tt.allowed(home, root)
			}
			c, err := New(Options{Root: root, AllowedRoot: allowed, Repos: tt.repos, Runner: tt.runner, Timeout: tt.timeout})
			if err != nil {
				t.Fatal(err)
			}
			var got []Progress
			r, err := c.Clone(context.Background(), tt.owner, tt.repo, func(p Progress) { got = append(got, p) })
			dest := filepath.Join(root, tt.owner, tt.repo)
			switch {
			case tt.wantErr != nil || tt.wantMsg != "":
				if err == nil || (tt.wantErr != nil && !errors.Is(err, tt.wantErr)) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
				}
			case err != nil:
				t.Fatal(err)
			default:
				if r.Path != dest || !reflect.DeepEqual(got, progress) {
					t.Fatalf("repo %+v, progress %+v", r, got)
				}
			}
			if ran := tt.runner.ncalls() > 0; ran != tt.wantRun {
				t.Fatalf("gh ran = %t, want %t", ran, tt.wantRun)
			}
			if tt.wantRun {
				want := []string{"gh", "repo", "clone", tt.owner + "/" + tt.repo, dest, "--", "--progress"}
				if !reflect.DeepEqual(tt.runner.calls[0], want) || tt.runner.dirs[0] != filepath.Dir(dest) {
					t.Errorf("ran %v in %s, want %v in %s", tt.runner.calls[0], tt.runner.dirs[0], want, filepath.Dir(dest))
				}
			}
			if exists(dest) != tt.wantDest {
				t.Errorf("destination exists = %t, want %t", exists(dest), tt.wantDest)
			}
			if tt.wantErr != ErrInvalidArgument && exists(filepath.Dir(dest)) != tt.wantOwner {
				t.Errorf("owner dir exists = %t, want %t", exists(filepath.Dir(dest)), tt.wantOwner)
			}
			if registered := len(tt.repos.paths) > 0; registered != tt.wantRegistr {
				t.Errorf("registered = %t, want %t", registered, tt.wantRegistr)
			}
			if tt.wantRun && tt.setup == nil {
				if fi, err := os.Stat(root); err != nil || fi.Mode().Perm() != 0o700 {
					t.Errorf("projects dir: %v, %v (want 0700)", fi, err)
				}
			}
		})
	}
}

func TestCloneBusyAndCancel(t *testing.T) {
	home, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(home, "projects")
	run := &fakeRunner{create: true, block: true}
	c, err := New(Options{Root: root, AllowedRoot: home, Repos: &fakeRepos{}, Runner: run})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := c.Clone(ctx, "octo", "slow", nil)
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for run.ncalls() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := c.Clone(context.Background(), "OCTO", "Slow", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("second clone: err = %v, want ErrBusy", err)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "clone cancelled") {
		t.Fatalf("cancelled clone: err = %v", err)
	}
	if exists(filepath.Join(root, "octo", "slow")) {
		t.Error("cancelled clone left its destination")
	}
	path, there := c.Destination("octo", "slow")
	if path != filepath.Join(root, "octo", "slow") || there {
		t.Errorf("Destination = %s, %t", path, there)
	}
}

func TestNewValidates(t *testing.T) {
	for _, o := range []Options{{Root: "rel", Repos: &fakeRepos{}}, {Root: "/abs"}} {
		if _, err := New(o); err == nil {
			t.Errorf("New(%+v): want error", o)
		}
	}
}

func TestLineWriter(t *testing.T) {
	tests := []struct {
		name   string
		chunks []string
		want   []Progress
		tail   []string
	}{
		{"newlines", []string{"a\nb\n"}, []Progress{{Line: "a"}, {Line: "b"}}, []string{"a", "b"}},
		{"split across writes", []string{"Clon", "ing\n"}, []Progress{{Line: "Cloning"}}, []string{"Cloning"}},
		{
			"carriage returns are transient", []string{"Receiving:  1%\rReceiving: 50%\rReceiving: 100%, done.\n"},
			[]Progress{{Line: "Receiving:  1%", Transient: true}, {Line: "Receiving: 50%", Transient: true}, {Line: "Receiving: 100%, done."}},
			[]string{"Receiving: 100%, done."},
		},
		{"CRLF finalizes the transient line", []string{"x 10%\r", "\n"}, []Progress{{Line: "x 10%", Transient: true}, {Line: "x 10%"}}, []string{"x 10%"}},
		{"blank lines and trailing spaces dropped", []string{"\n  \nkeep   \n"}, []Progress{{Line: "keep"}}, []string{"keep"}},
		{"unterminated last line flushed", []string{"fatal: oops"}, []Progress{{Line: "fatal: oops"}}, []string{"fatal: oops"}},
		{"a transient line nothing replaced is in the tail", []string{"err\nwait 3%\r"}, []Progress{{Line: "err"}, {Line: "wait 3%", Transient: true}}, []string{"err", "wait 3%"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []Progress
			w := &lineWriter{emit: func(p Progress) { got = append(got, p) }}
			for _, c := range tt.chunks {
				if _, err := w.Write([]byte(c)); err != nil {
					t.Fatal(err)
				}
			}
			w.flush()
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("progress = %+v, want %+v", got, tt.want)
			}
			if tail := w.tail(); !reflect.DeepEqual(tail, tt.tail) {
				t.Errorf("tail = %q, want %q", tail, tt.tail)
			}
		})
	}
	t.Run("tail keeps the last lines", func(t *testing.T) {
		w := &lineWriter{}
		for i := range 20 {
			_, _ = fmt.Fprintf(w, "line %d\n", i)
		}
		if tail := w.tail(); len(tail) != tailLines || tail[len(tail)-1] != "line 19" {
			t.Errorf("tail = %q", tail)
		}
	})
}

func TestExecRunner(t *testing.T) {
	var got []Progress
	err := ExecRunner{}.Run(context.Background(), t.TempDir(), "sh",
		[]string{"-c", `printf 'out\n'; printf 'a 1%%\ra 100%%, done.\n' >&2; printf 'fatal: nope\n' >&2; exit 3`},
		func(p Progress) { got = append(got, p) })
	var ee *ExitError
	if !errors.As(err, &ee) || ee.ExitCode != 3 || ee.Error() != "out\na 100%, done.\nfatal: nope" {
		t.Fatalf("err = %#v", err)
	}
	if len(got) != 4 || !got[1].Transient {
		t.Fatalf("progress = %+v", got)
	}
	if err := (ExecRunner{}).Run(context.Background(), t.TempDir(), "/nonexistent/gh", nil, func(Progress) {}); err == nil {
		t.Fatal("missing binary: want error")
	}
}
