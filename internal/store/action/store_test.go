package action

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

// harness is a Manager over a real database, the repo fake with two projects ("web",
// with a second worktree "feat", and "api") whose rows exist in the repos table (the
// actions table references it), and the terminal fake.
type harness struct {
	t     *testing.T
	db    *sql.DB
	bus   *bus.Bus
	repos *repotest.Fake
	terms *terminaltest.Fake
	m     *Manager
	// web, feat and api are real directories: background runs start in them.
	web, feat, api string
	// sessions are the threads Options.Session knows.
	mu       sync.Mutex
	sessions map[string]Owner
}

func newHarness(t *testing.T, mut ...func(*Options)) *harness {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(ctx, filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	b := bus.New()
	h := &harness{t: t, bus: b, repos: repotest.New(b), terms: terminaltest.New(b), sessions: map[string]Owner{}}
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	h.web, h.feat, h.api = filepath.Join(root, "web"), filepath.Join(root, "web-feat"), filepath.Join(root, "api")
	for _, dir := range []string{h.web, h.feat, h.api} {
		if err := mkdir(dir); err != nil {
			t.Fatal(err)
		}
	}
	h.repos.Put(repo.Repo{ID: "web", Path: h.web, Name: "web", Git: true, Worktrees: []repo.Worktree{
		{RepoID: "web", Path: h.web, IsMain: true}, {RepoID: "web", Path: h.feat},
	}})
	h.repos.Put(repo.Repo{ID: "api", Path: h.api, Name: "api", Git: true, Worktrees: []repo.Worktree{{RepoID: "api", Path: h.api, IsMain: true}}})
	for _, r := range h.repos.Snapshot().Repos {
		if _, err := d.ExecContext(ctx, `INSERT INTO repos (id, path, name, registered_at) VALUES (?, ?, ?, 0)`, r.ID, r.Path, r.Name); err != nil {
			t.Fatal(err)
		}
	}
	h.sessions["s1"] = Owner{RepoID: "web", Worktree: h.feat}
	h.sessions["home"] = Owner{Worktree: root}
	opts := Options{
		DB: d, Repos: h.repos, Terminals: h.terms, Bus: b, Log: discard, Shell: "/bin/sh",
		Session: func(id string) (Owner, bool) {
			h.mu.Lock()
			defer h.mu.Unlock()
			o, ok := h.sessions[id]
			return o, ok
		},
	}
	for _, f := range mut {
		f(&opts)
	}
	h.m, err = New(ctx, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = h.m.Close(ctx)
	})
	h.db = d
	return h
}

func (h *harness) create(o CreateOptions) Action {
	h.t.Helper()
	a, err := h.m.Create(context.Background(), o)
	if err != nil {
		h.t.Fatal(err)
	}
	return a
}

func (h *harness) wait(id string) Run {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.m.Wait(ctx, id)
	if err != nil {
		h.t.Fatal(err)
	}
	return r
}

func names(as []Action) []string {
	out := make([]string, len(as))
	for i, a := range as {
		out[i] = a.Name
	}
	return out
}

func TestCreateUpdateDelete(t *testing.T) {
	ptr := func(s string) *string { return &s }
	tests := []struct {
		name    string
		run     func(h *harness) error
		wantErr error
		// want is web's action names in order afterwards.
		want []string
	}{
		{name: "create appends", run: func(h *harness) error {
			h.create(CreateOptions{RepoID: "web", Name: "Lint", Command: "make lint"})
			return nil
		},
			want: []string{"Test", "Build", "Lint"}},
		{name: "a name is unique ignoring case", run: func(h *harness) error {
			_, err := h.m.Create(context.Background(), CreateOptions{RepoID: "web", Name: "  test ", Command: "x"})
			return err
		}, wantErr: ErrFailedPrecondition, want: []string{"Test", "Build"}},
		{name: "the same name in another project is fine", run: func(h *harness) error {
			_, err := h.m.Create(context.Background(), CreateOptions{RepoID: "api", Name: "Test", Command: "x"})
			return err
		}, want: []string{"Test", "Build"}},
		{name: "unknown icon", run: func(h *harness) error {
			_, err := h.m.Create(context.Background(), CreateOptions{RepoID: "web", Name: "X", Command: "x", Icon: "rocket"})
			return err
		}, wantErr: ErrInvalidArgument, want: []string{"Test", "Build"}},
		{name: "blank command", run: func(h *harness) error {
			_, err := h.m.Create(context.Background(), CreateOptions{RepoID: "web", Name: "X", Command: " \n"})
			return err
		}, wantErr: ErrInvalidArgument, want: []string{"Test", "Build"}},
		{name: "multi-line name", run: func(h *harness) error {
			_, err := h.m.Create(context.Background(), CreateOptions{RepoID: "web", Name: "a\nb", Command: "x"})
			return err
		}, wantErr: ErrInvalidArgument, want: []string{"Test", "Build"}},
		{name: "unregistered project", run: func(h *harness) error {
			_, err := h.m.Create(context.Background(), CreateOptions{RepoID: "nope", Name: "X", Command: "x"})
			return err
		}, wantErr: ErrNotFound, want: []string{"Test", "Build"}},
		{name: "rename onto another's name", run: func(h *harness) error {
			_, err := h.m.Update(context.Background(), UpdateOptions{ID: h.id("Build"), Name: ptr("TEST")})
			return err
		}, wantErr: ErrFailedPrecondition, want: []string{"Test", "Build"}},
		{name: "rename changing only case", run: func(h *harness) error {
			_, err := h.m.Update(context.Background(), UpdateOptions{ID: h.id("Test"), Name: ptr("test")})
			return err
		}, want: []string{"test", "Build"}},
		{name: "move to the front", run: func(h *harness) error {
			p := 0
			_, err := h.m.Update(context.Background(), UpdateOptions{ID: h.id("Build"), Position: &p})
			return err
		}, want: []string{"Build", "Test"}},
		{name: "a position past the end clamps", run: func(h *harness) error {
			p := 99
			_, err := h.m.Update(context.Background(), UpdateOptions{ID: h.id("Test"), Position: &p})
			return err
		}, want: []string{"Build", "Test"}},
		{name: "update an unknown id", run: func(h *harness) error {
			_, err := h.m.Update(context.Background(), UpdateOptions{ID: "a-nope", Name: ptr("x")})
			return err
		}, wantErr: ErrNotFound, want: []string{"Test", "Build"}},
		{name: "delete closes the gap", run: func(h *harness) error { return h.m.Delete(context.Background(), h.id("Test")) },
			want: []string{"Build"}},
		{name: "delete an unknown id", run: func(h *harness) error { return h.m.Delete(context.Background(), "a-nope") },
			wantErr: ErrNotFound, want: []string{"Test", "Build"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.create(CreateOptions{RepoID: "web", Name: "Test", Command: "go test ./...", Icon: IconTest, InTerminal: true})
			h.create(CreateOptions{RepoID: "web", Name: "Build", Command: "make build"})
			err := tt.run(h)
			if tt.wantErr == nil && err != nil || tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if got := names(h.m.Snapshot().ForRepo("web")); !slices.Equal(got, tt.want) {
				t.Errorf("web's actions = %q, want %q", got, tt.want)
			}
			for i, a := range h.m.Snapshot().ForRepo("web") {
				if a.Position != i {
					t.Errorf("%s at position %d, want %d", a.Name, a.Position, i)
				}
			}
			// The database agrees: a new Manager loads the same list.
			m2, err := New(context.Background(), Options{DB: h.m.opts.DB, Repos: h.repos, Log: discard})
			if err != nil {
				t.Fatal(err)
			}
			if got := names(m2.Snapshot().ForRepo("web")); !slices.Equal(got, tt.want) {
				t.Errorf("reloaded = %q, want %q", got, tt.want)
			}
		})
	}
}

func (h *harness) id(name string) string {
	for _, a := range h.m.Snapshot().Actions {
		if a.Name == name {
			return a.ID
		}
	}
	h.t.Fatalf("no action %q", name)
	return ""
}

func TestCreateDefaultsAndFields(t *testing.T) {
	h := newHarness(t)
	a := h.create(CreateOptions{RepoID: "web", Name: " Dev server ", Command: "pnpm dev\r\n", InTerminal: true, OnWorktreeCreate: true})
	if a.Name != "Dev server" || a.Command != "pnpm dev" || a.Icon != IconPlay || !a.InTerminal || !a.OnWorktreeCreate ||
		a.Position != 0 || !strings.HasPrefix(a.ID, "a-") || a.CreatedAt.IsZero() {
		t.Errorf("created %+v", a)
	}
	f := false
	icon := "BUILD"
	u, err := h.m.Update(context.Background(), UpdateOptions{ID: a.ID, Icon: &icon, InTerminal: &f})
	if err != nil {
		t.Fatal(err)
	}
	if u.Icon != IconBuild || u.InTerminal || !u.OnWorktreeCreate || u.Name != "Dev server" {
		t.Errorf("updated %+v", u)
	}
}

func TestRepoRemovedForgetsActionsAndRuns(t *testing.T) {
	h := newHarness(t)
	web := h.create(CreateOptions{RepoID: "web", Name: "Sleep", Command: "sleep 30"})
	api := h.create(CreateOptions{RepoID: "api", Name: "Sleep", Command: "sleep 30"})
	sub := bus.Subscribe[Event](h.bus, 64)
	defer sub.Close()
	run, err := h.m.Run(context.Background(), RunOptions{Action: "sleep", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	h.m.mu.Lock()
	rec := h.m.runs[run.ID]
	h.m.mu.Unlock()
	// Unregistering cascades in the database.
	if _, err := h.db.ExecContext(context.Background(), `DELETE FROM repos WHERE id = 'web'`); err != nil {
		t.Fatal(err)
	}
	h.m.RepoRemoved(context.Background(), "web")
	snap := h.m.Snapshot()
	if _, ok := snap.Action(web.ID); ok {
		t.Error("web's action is still in the snapshot")
	}
	if _, ok := snap.Action(api.ID); !ok {
		t.Error("api's action is gone")
	}
	if _, ok := snap.Run(run.ID); ok {
		t.Error("web's run is still in the snapshot")
	}
	// The run was killed (SIGTERM).
	select {
	case <-rec.done:
	case <-time.After(10 * time.Second):
		t.Fatal("the run was not killed")
	}
	h.m.mu.Lock()
	code := rec.run.ExitCode
	h.m.mu.Unlock()
	if code != 128+15 {
		t.Errorf("killed run exit = %d, want 143", code)
	}
	var removed, runRemoved bool
	for len(sub.C()) > 0 {
		switch e := (<-sub.C()).(type) {
		case Removed:
			removed = removed || e.ID == web.ID
		case RunRemoved:
			runRemoved = runRemoved || e.ID == run.ID
		}
	}
	if !removed || !runRemoved {
		t.Errorf("events: Removed %v RunRemoved %v", removed, runRemoved)
	}
	m2, err := New(context.Background(), Options{DB: h.m.opts.DB, Repos: h.repos, Log: discard})
	if err != nil {
		t.Fatal(err)
	}
	if got := names(m2.Snapshot().Actions); !slices.Equal(got, []string{"Sleep"}) || m2.Snapshot().Actions[0].RepoID != "api" {
		t.Errorf("reloaded = %+v", m2.Snapshot().Actions)
	}
}

func mkdir(dir string) error { return os.MkdirAll(dir, 0o755) }

func TestRunOwnerAndAction(t *testing.T) {
	tests := []struct {
		name      string
		opts      RunOptions
		wantErr   error
		wantMsg   string
		wantOwner Owner
		wantName  string
	}{
		{name: "a thread owns it and names the project", opts: RunOptions{Action: "echo", SessionID: "s1"},
			wantOwner: Owner{SessionID: "s1", RepoID: "web", Worktree: "%feat"}, wantName: "Echo"},
		{name: "a worktree owns it", opts: RunOptions{Action: "ECHO", Worktree: "%web"},
			wantOwner: Owner{RepoID: "web", Worktree: "%web"}, wantName: "Echo"},
		{name: "by id", opts: RunOptions{Action: "#apiEcho", Worktree: "%api"},
			wantOwner: Owner{RepoID: "api", Worktree: "%api"}, wantName: "Echo"},
		{name: "the thread wins over a worktree", opts: RunOptions{Action: "echo", SessionID: "s1", Worktree: "%api"},
			wantOwner: Owner{SessionID: "s1", RepoID: "web", Worktree: "%feat"}, wantName: "Echo"},
		{name: "unknown thread", opts: RunOptions{Action: "echo", SessionID: "s9"}, wantErr: ErrNotFound, wantMsg: "thread s9"},
		{name: "a thread without a project", opts: RunOptions{Action: "echo", SessionID: "home"}, wantErr: ErrFailedPrecondition,
			wantMsg: "has no project"},
		{name: "the thread is in another project than --repo", opts: RunOptions{Action: "echo", SessionID: "s1", RepoID: "api"},
			wantErr: ErrInvalidArgument},
		{name: "an unregistered worktree", opts: RunOptions{Action: "echo", Worktree: "/nowhere"}, wantErr: ErrInvalidArgument,
			wantMsg: "/nowhere is not a worktree of a registered project"},
		{name: "no owner", opts: RunOptions{Action: "echo"}, wantErr: ErrInvalidArgument, wantMsg: "needs a thread or a worktree"},
		{name: "a name the project does not have", opts: RunOptions{Action: "deploy", Worktree: "%web"}, wantErr: ErrNotFound,
			wantMsg: `no action "deploy"`},
		{name: "another project's action by id", opts: RunOptions{Action: "#apiEcho", Worktree: "%web"}, wantErr: ErrFailedPrecondition,
			wantMsg: "belongs to another project"},
		{name: "no action", opts: RunOptions{Worktree: "%web"}, wantErr: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.create(CreateOptions{RepoID: "web", Name: "Echo", Command: "true"})
			apiEcho := h.create(CreateOptions{RepoID: "api", Name: "Echo", Command: "true"})
			sub := func(s string) string {
				return strings.NewReplacer("%feat", h.feat, "%web", h.web, "%api", h.api, "#apiEcho", apiEcho.ID).Replace(s)
			}
			o := tt.opts
			o.Action, o.Worktree = sub(o.Action), sub(o.Worktree)
			r, err := h.m.Run(context.Background(), o)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := tt.wantOwner
			want.Worktree = sub(want.Worktree)
			if got := (Owner{SessionID: r.SessionID, RepoID: r.RepoID, Worktree: r.Worktree}); got != want || r.ActionName != tt.wantName {
				t.Errorf("run owner %+v %q, want %+v %q", got, r.ActionName, want, tt.wantName)
			}
			if r.Mode != ModeBackground || r.Trigger != TriggerUser {
				t.Errorf("mode %v trigger %v", r.Mode, r.Trigger)
			}
			h.wait(r.ID)
		})
	}
}

func TestBackgroundRun(t *testing.T) {
	tests := []struct {
		name    string
		command string
		session bool
		limit   int
		want    func(h *harness) string // the whole output
		wantRe  bool
		code    int
		trunc   bool
	}{
		{name: "exit 0 with output", command: "echo out; echo err >&2", want: func(*harness) string { return "out\nerr\n" }},
		{name: "a failing command's code and output", command: "echo boom; exit 3", want: func(*harness) string { return "boom\n" }, code: 3},
		{name: "runs in the worktree with the project variables", command: `pwd; echo "$` + paths.EnvProjectRoot + `"; echo "$` + paths.EnvWorktree + `"; echo "[$` + paths.EnvSession + `]"`,
			want: func(h *harness) string { return h.web + "\n" + h.web + "\n" + h.web + "\n[]\n" }},
		{name: "a thread's run also gets its session", command: `pwd; echo "$` + paths.EnvProjectRoot + `"; echo "$` + paths.EnvSession + `"`, session: true,
			want: func(h *harness) string { return h.feat + "\n" + h.web + "\ns1\n" }},
		{name: "only the tail is kept", command: "printf 'aaaaa'; printf 'bbbbb'; printf 'ccc'", limit: 4,
			want: func(*harness) string { return "bccc" }, trunc: true},
		{name: "a multi-line command is a script", command: "x=4\necho $((x * 2))", want: func(*harness) string { return "8\n" }},
		{name: "signalled", command: "kill -TERM $$", want: func(*harness) string { return "" }, code: 128 + 15},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, func(o *Options) {
				if tt.limit > 0 {
					o.OutputLimit = tt.limit
				}
			})
			sub := bus.Subscribe[Event](h.bus, 64)
			defer sub.Close()
			a := h.create(CreateOptions{RepoID: "web", Name: "Run", Command: tt.command, InTerminal: true})
			o := RunOptions{Action: "run", Worktree: h.web, Mode: ModeBackground}
			if tt.session {
				o = RunOptions{Action: "run", SessionID: "s1", Mode: ModeBackground}
			}
			started, err := h.m.Run(context.Background(), o)
			if err != nil {
				t.Fatal(err)
			}
			if started.Mode != ModeBackground || started.TerminalID != "" || !strings.HasPrefix(started.ID, "r-") {
				t.Errorf("started %+v", started)
			}
			r := h.wait(started.ID)
			if r.State != RunExited || r.ExitCode != tt.code || r.Output != tt.want(h) || r.Truncated != tt.trunc || r.FinishedAt.IsZero() {
				t.Errorf("run = state %v exit %d output %q truncated %v; want exit %d output %q truncated %v",
					r.State, r.ExitCode, r.Output, r.Truncated, tt.code, tt.want(h), tt.trunc)
			}
			// Snapshots never carry output; GetRun does.
			if s, ok := h.m.Snapshot().Run(r.ID); !ok || s.Output != "" || s.State != RunExited {
				t.Errorf("snapshot run %+v %v", s, ok)
			}
			if g, err := h.m.GetRun(context.Background(), r.ID); err != nil || g.Output != tt.want(h) {
				t.Errorf("GetRun = %q, %v", g.Output, err)
			}
			var finished []RunFinished
			for len(sub.C()) > 0 {
				if e, ok := (<-sub.C()).(RunFinished); ok {
					finished = append(finished, e)
				}
			}
			want := RunFinished{RunID: r.ID, ActionID: a.ID, ActionName: "Run", RepoID: "web", SessionID: r.SessionID,
				Mode: ModeBackground, Trigger: TriggerUser, ExitCode: tt.code}
			if len(finished) != 1 || finished[0] != want {
				t.Errorf("RunFinished = %+v, want one %+v", finished, want)
			}
		})
	}
}

func TestTerminalRun(t *testing.T) {
	h := newHarness(t)
	a := h.create(CreateOptions{RepoID: "web", Name: "Dev", Command: "pnpm dev", InTerminal: true})
	sub := bus.Subscribe[Event](h.bus, 64)
	defer sub.Close()
	r, err := h.m.Run(context.Background(), RunOptions{Action: "dev", SessionID: "s1"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Mode != ModeTerminal || r.TerminalID == "" || r.State != RunRunning {
		t.Fatalf("run %+v", r)
	}
	spec, ok := h.terms.Spec(r.TerminalID)
	if !ok {
		t.Fatal("no terminal")
	}
	wantLabels := map[string]string{
		termlabel.Kind: termlabel.KindAction, termlabel.Session: "s1", termlabel.Repo: "web", termlabel.Worktree: h.feat,
		termlabel.Action: a.ID, termlabel.ActionName: "Dev",
	}
	if !slices.Equal(spec.Argv, []string{"/bin/sh", "-lc", "pnpm dev"}) || spec.Cwd != h.feat || !maps.Equal(spec.Labels, wantLabels) {
		t.Errorf("terminal spec argv %q cwd %q labels %v", spec.Argv, spec.Cwd, spec.Labels)
	}
	wantEnv := []string{paths.EnvProjectRoot + "=" + h.web, paths.EnvWorktree + "=" + h.feat, paths.EnvSession + "=s1"}
	if !slices.Equal(spec.Env, wantEnv) {
		t.Errorf("env = %q, want %q", spec.Env, wantEnv)
	}
	if !termlabel.IsAction(spec.Labels) || !termlabel.IsPanel(spec.Labels) || termlabel.IsShell(spec.Labels) {
		t.Error("label predicates")
	}
	// Forcing the background runner ignores in_terminal.
	bg, err := h.m.Run(context.Background(), RunOptions{Action: "dev", Worktree: h.web, Mode: ModeBackground})
	if err != nil || bg.Mode != ModeBackground {
		t.Fatalf("forced background: %+v %v", bg, err)
	}
	h.m.KillRuns(func(r Run) bool { return r.ID == bg.ID })
	h.wait(bg.ID)

	if err := h.terms.Exit(r.TerminalID, 2); err != nil {
		t.Fatal(err)
	}
	got := h.wait(r.ID)
	if got.State != RunExited || got.ExitCode != 2 || got.Output != "" {
		t.Errorf("finished %+v", got)
	}
	var finished *RunFinished
	deadline := time.After(5 * time.Second)
	for finished == nil {
		select {
		case ev := <-sub.C():
			if e, ok := ev.(RunFinished); ok && e.RunID == r.ID {
				finished = &e
			}
		case <-deadline:
			t.Fatal("no RunFinished")
		}
	}
	if finished.TerminalID != r.TerminalID || finished.ExitCode != 2 || finished.Mode != ModeTerminal || finished.SessionID != "s1" {
		t.Errorf("RunFinished %+v", finished)
	}
	// The terminal stays (EXITED) for the user to read; the store never removes it.
	if term, err := h.terms.Get(context.Background(), r.TerminalID); err != nil || term.State != terminal.StateExited {
		t.Errorf("terminal %+v %v", term, err)
	}
}

// lossyTerminals is a terminal store whose terminals never report their exit to an
// observer, like a terminal the real store force-removed.
type lossyTerminals struct{ *terminaltest.Fake }

func (l lossyTerminals) Create(ctx context.Context, spec terminal.Spec) (terminal.Terminal, error) {
	spec.Observer = nil
	return l.Fake.Create(ctx, spec)
}

func TestTerminalRunGoneWithoutExit(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Terminals = lossyTerminals{o.Terminals.(*terminaltest.Fake)} })
	h.create(CreateOptions{RepoID: "web", Name: "Dev", Command: "pnpm dev", InTerminal: true})
	r, err := h.m.Run(context.Background(), RunOptions{Action: "dev", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	_ = h.terms.Exit(r.TerminalID, 0)
	if err := h.terms.Remove(context.Background(), r.TerminalID); err != nil {
		t.Fatal(err)
	}
	if got := h.wait(r.ID); got.ExitCode != ExitUnknown || got.State != RunExited {
		t.Errorf("run = %+v, want exited %d", got, ExitUnknown)
	}
}

func TestRunHistoryCap(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.RunHistory = 2 })
	h.create(CreateOptions{RepoID: "web", Name: "Quick", Command: "true"})
	h.create(CreateOptions{RepoID: "web", Name: "Slow", Command: "sleep 30"})
	h.create(CreateOptions{RepoID: "api", Name: "Quick", Command: "true"})
	slow, err := h.m.Run(context.Background(), RunOptions{Action: "slow", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	var quick []string
	for range 3 {
		r, err := h.m.Run(context.Background(), RunOptions{Action: "quick", Worktree: h.web})
		if err != nil {
			t.Fatal(err)
		}
		h.wait(r.ID)
		quick = append(quick, r.ID)
		time.Sleep(2 * time.Millisecond) // distinct start times
	}
	apiRun, err := h.m.Run(context.Background(), RunOptions{Action: "quick", Worktree: h.api})
	if err != nil {
		t.Fatal(err)
	}
	h.wait(apiRun.ID)
	var got []string
	for _, r := range h.m.Snapshot().Runs {
		got = append(got, r.ID)
	}
	// web keeps the running one and the newest finished one; api is counted apart.
	want := []string{apiRun.ID, quick[2], slow.ID}
	if !slices.Equal(got, want) {
		t.Errorf("runs = %q, want %q", got, want)
	}
	h.m.KillRuns(func(r Run) bool { return r.ID == slow.ID })
	h.wait(slow.ID)
}

func TestWorktreeCreated(t *testing.T) {
	h := newHarness(t)
	h.create(CreateOptions{RepoID: "web", Name: "Install", Command: "echo one >> setup.log", OnWorktreeCreate: true})
	h.create(CreateOptions{RepoID: "web", Name: "Manual", Command: "echo manual >> setup.log", InTerminal: true})
	h.create(CreateOptions{RepoID: "web", Name: "Env", Command: `cat setup.log; echo "$` + paths.EnvSession + `"; exit 4`, OnWorktreeCreate: true, InTerminal: true})
	h.create(CreateOptions{RepoID: "api", Name: "Other", Command: "echo api >> setup.log", OnWorktreeCreate: true})
	sub := bus.Subscribe[Event](h.bus, 64)
	defer sub.Close()
	h.m.WorktreeCreated("s1", "web", h.feat)
	var finished []RunFinished
	deadline := time.After(20 * time.Second)
	for len(finished) < 2 {
		select {
		case ev := <-sub.C():
			if e, ok := ev.(RunFinished); ok {
				finished = append(finished, e)
			}
		case <-deadline:
			t.Fatalf("finished = %+v", finished)
		}
	}
	// In order, in the background (even an in-terminal action), for the thread.
	if finished[0].ActionName != "Install" || finished[1].ActionName != "Env" || finished[1].ExitCode != 4 {
		t.Errorf("finished = %+v", finished)
	}
	for _, f := range finished {
		if f.Mode != ModeBackground || f.Trigger != TriggerWorktreeCreate || f.SessionID != "s1" {
			t.Errorf("finished %+v", f)
		}
	}
	r, err := h.m.GetRun(context.Background(), finished[1].RunID)
	if err != nil || r.Output != "one\ns1\n" || r.Worktree != h.feat {
		t.Errorf("Env run = %q in %s, %v", r.Output, r.Worktree, err)
	}
	// A project without such actions: nothing runs.
	h.m.WorktreeCreated("s1", "nope", h.feat)
}

func TestCloseKillsBackgroundRuns(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.KillGrace = 200 * time.Millisecond })
	// Ignores SIGTERM: SIGKILL after the grace period.
	h.create(CreateOptions{RepoID: "web", Name: "Stubborn", Command: "trap '' TERM; sleep 30 & wait"})
	r, err := h.m.Run(context.Background(), RunOptions{Action: "stubborn", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond) // let the trap be set
	h.m.mu.Lock()
	rec := h.m.runs[r.ID]
	h.m.mu.Unlock()
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.m.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 8*time.Second {
		t.Errorf("Close took %s", took)
	}
	select {
	case <-rec.done:
	default:
		t.Fatal("the run is still running after Close")
	}
	if _, err := h.m.Run(context.Background(), RunOptions{Action: "stubborn", Worktree: h.web}); !errors.Is(err, ErrClosed) {
		t.Errorf("Run after Close: %v", err)
	}
}
