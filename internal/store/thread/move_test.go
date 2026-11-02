package thread

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// moveNamer answers every naming call with a title and, when asked, a branch, and
// records the requests.
type moveNamer struct {
	mu   sync.Mutex
	reqs []NamingRequest
	err  error
	// gate, when set, holds a conversation's naming call until it is closed.
	gate chan struct{}
}

func (n *moveNamer) namer(_ context.Context, req NamingRequest) (Naming, error) {
	n.mu.Lock()
	n.reqs = append(n.reqs, req)
	gate := n.gate
	n.mu.Unlock()
	if gate != nil && req.Conversation != "" {
		<-gate
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.err != nil {
		return Naming{}, n.err
	}
	out := Naming{Title: "Fix the login redirect"}
	if req.Branch != nil {
		out.Branch = "fix/login-redirect"
	}
	return out, nil
}

// requests are the conversation's naming calls (a move's), not a first prompt's.
func (n *moveNamer) requests() []NamingRequest {
	n.mu.Lock()
	defer n.mu.Unlock()
	return slices.DeleteFunc(slices.Clone(n.reqs), func(r NamingRequest) bool { return r.Conversation == "" })
}

// newMoveEnv is a workspace env (repo r1 at e.wt, api r2 at e.wt2, workspace login of
// both) replaying fixture, with moveNamer and worktrees made on disk.
func newMoveEnv(t *testing.T, fixture string, mutate ...func(*Options)) (*wsEnv, *moveNamer) {
	t.Helper()
	n := &moveNamer{}
	e := newWSFixtureEnv(t, fixture, append([]func(*Options){func(o *Options) {
		o.Namer = n.namer
		o.SlugTimeout = 2 * time.Second
		o.RefExists = func(context.Context, string, string) bool { return false }
	}}, mutate...)...)
	return e, n
}

// noProjectThread is a thread without a project that had one turn ("check the slack
// thread"), its transcript in home, and is stopped when stop is set.
func (e *wsEnv) noProjectThread(prompt string, stop bool) (Thread, string) {
	e.t.Helper()
	s := e.create(CreateOptions{NoProject: true, InitialPrompt: prompt})
	e.waitItems(s.ID, "turn end", hasTurnEnd)
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.writeTranscriptIn(e.home, cid, userLine(prompt))
	s = e.waitFor(s.ID, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid && turnOver(s) })
	if stop {
		e.exit(s.ID, 0)
		s = e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
	}
	return s, cid
}

func TestCheckMove(t *testing.T) {
	tests := []struct {
		name string
		s    Thread
		ok   bool
	}{
		{"no project", Thread{ID: "s-1"}, true},
		{"a project", Thread{ID: "s-1", ProjectID: "r1"}, false},
		{"a project set without a primary", Thread{ID: "s-1", ProjectIDs: []string{"r1"}}, false},
		{"a workspace's folder", Thread{ID: "s-1", WorkspaceID: "w-1"}, false},
		{"archived", Thread{ID: "s-1", ArchivedAt: time.Now()}, false},
		{"resident", Thread{ID: "s-1", Kind: KindResident, ResidentName: "ember"}, false},
		{"transcript missing", Thread{ID: "s-1", TranscriptMissing: true}, false},
		{"moving", Thread{ID: "s-1", PendingMove: &MoveTarget{ProjectID: "r1"}}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := CheckMove(tt.s)
			if tt.ok != (err == nil) || (err != nil && !errors.Is(err, ErrFailedPrecondition)) {
				t.Errorf("CheckMove = %v, want ok %v", err, tt.ok)
			}
		})
	}
}

// A stopped thread moves into a new worktree: Claude starts in home with --resume and
// the destination's add-dirs, set_cwd takes it to the worktree on the branch named
// from the conversation, the row is a worktree-mode thread of the project named from
// the conversation, the timeline says so, and the process has no start grace.
func TestMoveStoppedIntoNewWorktree(t *testing.T) {
	var hooked []string
	e, n := newMoveEnv(t, "text-table", func(o *Options) {
		o.WorktreeCreated = func(_, pid, path string) { hooked = append(hooked, pid+" "+path) }
	})
	s, cid := e.noProjectThread("check the slack thread", true)
	var report CreateReport
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "repo", NewWorktree: &NewWorktree{BaseRef: "main"}, Report: &report})
	if err != nil {
		t.Fatal(err)
	}
	wt := filepath.Join(e.projects.WorktreeRoot, "_local", "repo", "fix-login-redirect")
	if got.ProjectID != "r1" || !slices.Equal(got.ProjectIDs, []string{"r1"}) || got.WorktreePath != wt || got.CheckoutPaths["r1"] != wt ||
		got.Branch != "fix/login-redirect" || !got.CreatedWorktree || got.BaseRef != "main" || got.WorkspaceID != "" ||
		got.Name != "Fix the login redirect" || !got.AutoNamed || got.PendingMove != nil || got.PendingWorktreePath != "" || got.Naming {
		t.Fatalf("moved = %+v", got)
	}
	if !report.MadeWorktree || !report.MadeBranch {
		t.Errorf("report = %+v", report)
	}
	spec := e.spec(s.ID)
	if !samePath(spec.Cwd, e.home) || argOf(spec.Argv, "--resume") != cid {
		t.Errorf("start cwd %s argv %q, want home and --resume %s", spec.Cwd, spec.Argv, cid)
	}
	if !e.sentSetCwd(wt) {
		t.Error("no set_cwd to the worktree")
	}
	reqs := n.requests()
	if len(reqs) != 1 || reqs[0].Branch == nil || !strings.Contains(reqs[0].Conversation, "User: check the slack thread") {
		t.Errorf("naming requests = %+v", reqs)
	}
	e.waitItems(s.ID, "the move note", hasNote("Moved this thread to repo (new worktree on fix/login-redirect)."))
	if len(hooked) != 1 || hooked[0] != "r1 "+wt {
		t.Errorf("worktree-created hooks = %q", hooked)
	}
	// No start grace: at the cache expiry it stops.
	if h := e.idleHold(s.ID, time.Now().Add(3*time.Hour)); h != "" {
		t.Errorf("idle hold after the move = %q, want none", h)
	}
	after := e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
	if after.WorktreePath != wt || after.ProjectID != "r1" {
		t.Errorf("after the stop = %+v", after)
	}
	// It is the project's thread now: the next start is there.
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if spec := e.spec(s.ID); !samePath(spec.Cwd, wt) || argOf(spec.Argv, "--resume") != cid {
		t.Errorf("next start cwd %s argv %q", spec.Cwd, spec.Argv)
	}
}

// A live thread at its prompt moves into the project's folder at once (no restart for a
// lone project); the name comes from the conversation, the branch is not asked.
func TestMoveLiveIntoProjectFolder(t *testing.T) {
	e, n := newMoveEnv(t, "text-table")
	s, _ := e.noProjectThread("check the slack thread", false)
	pid := e.pid(s.ID)
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", CheckoutMode: true})
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != "r1" || got.WorktreePath != e.wt || got.CreatedWorktree || got.Branch != "" || got.Name != "Fix the login redirect" {
		t.Fatalf("moved = %+v", got)
	}
	if !e.sentSetCwd(e.wt) {
		t.Error("no set_cwd")
	}
	if reqs := n.requests(); len(reqs) != 1 || reqs[0].Branch != nil || reqs[0].Conversation == "" {
		t.Errorf("naming requests = %+v", reqs)
	}
	e.waitItems(s.ID, "the move note", hasNote("Moved this thread to repo ("+e.wt+")."))
	time.Sleep(300 * time.Millisecond)
	if e.pid(s.ID) != pid {
		t.Error("Claude restarted for a lone project")
	}
}

// Mid-turn the move waits: the call returns with PendingMove, nothing is sent until the
// turn ends, a second move is refused, then set_cwd and the row move.
func TestMoveMidTurnWaitsForTheTurn(t *testing.T) {
	e, _ := newMoveEnv(t, "write-allow")
	s := e.create(CreateOptions{NoProject: true, InitialPrompt: "write"})
	e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", CheckoutMode: true})
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != "" || got.WorktreePath != e.home || got.PendingWorktreePath != e.wt ||
		got.PendingMove == nil || *got.PendingMove != (MoveTarget{ProjectID: "r1", Path: e.wt}) {
		t.Fatalf("queued = %+v (move %+v)", got, got.PendingMove)
	}
	if _, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r2", CheckoutMode: true}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("a second move = %v", err)
	}
	time.Sleep(cdSettle + 200*time.Millisecond)
	if e.sentSetCwd(e.wt) {
		t.Fatal("moved while a request was pending")
	}
	e.answer(s.ID)
	e.waitSent("set_cwd", isSetCwd(e.wt))
	moved := e.waitFor(s.ID, "moved", func(s Thread) bool { return s.ProjectID == "r1" })
	if moved.WorktreePath != e.wt || moved.PendingMove != nil || moved.PendingWorktreePath != "" {
		t.Errorf("moved = %+v", moved)
	}
}

// Into a workspace: its members are the set and its default primary the cwd; Claude
// moves, then restarts (resuming, in the new cwd) with the other member and the
// workspace's folder as --add-dir.
func TestMoveLiveIntoWorkspace(t *testing.T) {
	e, _ := newMoveEnv(t, "text-table")
	s, cid := e.noProjectThread("check the slack thread", false)
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{WorkspaceID: "login", CheckoutMode: true})
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceID != "w-login" || got.ProjectID != "r1" || !slices.Equal(got.ProjectIDs, []string{"r1", "r2"}) || got.WorktreePath != e.wt {
		t.Fatalf("moved = %+v", got)
	}
	argv := e.waitArgv("the restart with the members", func(a []string) bool { return slices.Contains(addDirs(a), e.wt2) })
	if argOf(argv, "--resume") != cid || !slices.Contains(addDirs(argv), e.managed()) {
		t.Errorf("restart argv %q", argv)
	}
	e.waitFor(s.ID, "connected again", func(s Thread) bool { return s.State == StateConnected })
	if spec := e.spec(s.ID); !samePath(spec.Cwd, e.wt) {
		t.Errorf("restart cwd = %s, want %s", spec.Cwd, e.wt)
	}
	e.waitItems(s.ID, "the move note", hasNote("Moved this thread to workspace login ("+e.wt+")."))
}

// A stopped thread into a workspace's folder: the start in home already has every
// member as --add-dir.
func TestMoveStoppedIntoWorkspaceFolder(t *testing.T) {
	e, _ := newMoveEnv(t, "text-table")
	s, _ := e.noProjectThread("check the slack thread", true)
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{WorkspaceID: "w-login", ProjectID: "workspace", CheckoutMode: true})
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceID != "w-login" || got.ProjectID != "" || got.WorktreePath != e.managed() {
		t.Fatalf("moved = %+v", got)
	}
	spec := e.spec(s.ID)
	if dirs := addDirs(spec.Argv); !samePath(spec.Cwd, e.home) || !slices.Contains(dirs, e.wt) || !slices.Contains(dirs, e.wt2) {
		t.Errorf("start cwd %s add-dirs %q", spec.Cwd, dirs)
	}
}

// An existing branch is checked out in a new worktree: the base is ignored and the
// naming call asks only for the title.
func TestMoveOntoExistingBranch(t *testing.T) {
	e, n := newMoveEnv(t, "text-table", func(o *Options) {
		o.RefExists = func(_ context.Context, _, ref string) bool { return ref == "refs/heads/feat/x" }
	})
	s, _ := e.noProjectThread("check the slack thread", true)
	var report CreateReport
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: "feat/x", BaseRef: "main"}, Report: &report})
	if err != nil {
		t.Fatal(err)
	}
	if got.Branch != "feat/x" || !strings.HasSuffix(got.WorktreePath, "feat-x") || got.Name != "Fix the login redirect" {
		t.Fatalf("moved = %+v", got)
	}
	if c := e.projects.Creates; len(c) != 1 || c[0].Branch != "feat/x" || c[0].BaseRef != "" {
		t.Errorf("CreateWorktree = %+v", c)
	}
	if !report.MadeWorktree || report.MadeBranch {
		t.Errorf("report = %+v", report)
	}
	if reqs := n.requests(); len(reqs) != 1 || reqs[0].Branch != nil {
		t.Errorf("naming requests = %+v", reqs)
	}
	e.waitItems(s.ID, "the move note", hasNote("Moved this thread to repo (new worktree on existing branch feat/x)."))
}

// Claude refusing set_cwd leaves the thread as it was: no project, home, the worktree the
// move made removed (its new branch too), a note saying why, and the process the move
// started stops.
func TestMoveSetCwdRefusedRollsBack(t *testing.T) {
	e, _ := newMoveEnv(t, "text-table", func(o *Options) {
		o.Env = append(o.Env, "CF_FAKE_CLAUDE_SET_CWD_REFUSE=not a directory Claude can use")
	})
	s, _ := e.noProjectThread("check the slack thread", true)
	name := s.Name
	_, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}})
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "not a directory Claude can use") {
		t.Fatalf("Move = %v", err)
	}
	got := e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected && s.PendingMove == nil })
	if got.ProjectID != "" || len(got.ProjectIDs) != 0 || got.WorktreePath != e.home || got.Name != name || got.CreatedWorktree || got.Branch != "" {
		t.Errorf("after the refusal = %+v", got)
	}
	wt := filepath.Join(e.projects.WorktreeRoot, "_local", "repo", "fix-login-redirect")
	deadline := time.Now().Add(5 * time.Second)
	for !slices.Contains(e.projects.Calls, "RemoveWorktree r1 "+wt) {
		if time.Now().After(deadline) {
			t.Fatalf("worktree not removed: %q", e.projects.Calls)
		}
		time.Sleep(10 * time.Millisecond)
	}
	e.waitItems(s.ID, "the failure note", hasNote("Could not move this thread to repo: not a directory Claude can use. It stays where it was, without a project."))
}

// Refused before anything is made: a thread with a project, no place, an unknown
// project, a placement Create refuses (a main checkout on the branch), an archived
// thread, a missing transcript. The thread is unchanged.
func TestMoveRefusals(t *testing.T) {
	e, _ := newMoveEnv(t, "text-table")
	e.projects.Put(project.Project{ID: "r1", Path: e.wt, Name: "repo", Git: true, Worktrees: []project.Worktree{{ProjectID: "r1", Path: e.wt, IsMain: true, Branch: "feat/busy"}}})
	inProject := e.connected(CreateOptions{ProjectID: "r1"})
	s, cid := e.noProjectThread("check the slack thread", true)
	archived := e.create(CreateOptions{NoProject: true})
	e.waitFor(archived.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
	if _, err := e.m.Archive(e.ctx(), archived.ID, true); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		id      string
		o       MoveOptions
		wantErr error
	}{
		{"has a project", inProject.ID, MoveOptions{ProjectID: "r2", CheckoutMode: true}, ErrFailedPrecondition},
		{"no place", s.ID, MoveOptions{}, ErrInvalidArgument},
		{"both modes", s.ID, MoveOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}, CheckoutMode: true}, ErrInvalidArgument},
		{"unknown project", s.ID, MoveOptions{ProjectID: "nope", CheckoutMode: true}, ErrNotFound},
		{"main checkout on the branch", s.ID, MoveOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: "feat/busy"}}, ErrFailedPrecondition},
		{"archived", archived.ID, MoveOptions{ProjectID: "r1", CheckoutMode: true}, ErrFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := e.m.Move(e.ctx(), tt.id, tt.o); !errors.Is(err, tt.wantErr) {
				t.Errorf("Move = %v, want %v", err, tt.wantErr)
			}
		})
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.ProjectID != "" || got.WorktreePath != e.home || got.PendingMove != nil || got.Naming {
		t.Errorf("after refusals = %+v", got)
	}

	// The transcript is gone: refused before anything is made, and the thread says so.
	if err := os.Remove(filepath.Join(e.paths.projectDir(e.home), cid+".jsonl")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}}); !errors.Is(err, ErrTranscriptMissing) {
		t.Errorf("Move without a transcript = %v", err)
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); !got.TranscriptMissing || got.ProjectID != "" {
		t.Errorf("after the missing transcript = %+v", got)
	}
	if len(e.projects.Creates) != 0 {
		t.Errorf("worktrees made: %+v", e.projects.Creates)
	}
}

// A thread that never had a conversation has nothing to relocate: the row moves at
// once, no Claude starts. threads.default_worktree (new) places it in a new worktree,
// on cf/<id> since there is nothing to name it from.
func TestMoveWithoutConversation(t *testing.T) {
	e, n := newMoveEnv(t, "text-table", func(o *Options) { o.NewWorktreeDefault = func() bool { return true } })
	s := e.connected(CreateOptions{NoProject: true, Name: "scratch"})
	e.exit(s.ID, 0)
	e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	if got.State != StateDisconnected || got.ProjectID != "r1" || got.Branch != "cf/"+s.ID || !got.CreatedWorktree || got.Name != "scratch" {
		t.Fatalf("moved = %+v", got)
	}
	if len(n.requests()) != 0 {
		t.Errorf("naming requests = %+v", n.requests())
	}
	e.waitItems(s.ID, "the move note", hasNote("Moved this thread to repo (new worktree on cf/"+s.ID+")."))
}

// A failing naming model keeps the name and falls back to cf/<id>; the move goes on.
func TestMoveNamingFails(t *testing.T) {
	e, n := newMoveEnv(t, "text-table")
	n.err = errors.New("model unavailable")
	s, _ := e.noProjectThread("check the slack thread", true)
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}})
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != "r1" || got.Branch != "cf/"+s.ID || got.Name != s.Name || got.Naming {
		t.Fatalf("moved = %+v (was %q)", got, s.Name)
	}
}

// A queued move whose Claude stops first (an archive, a crash) does not happen: Claude
// never relocated the transcript. The worktree it made goes and the timeline says why.
func TestMoveQueuedLostWhenClaudeStops(t *testing.T) {
	e, _ := newMoveEnv(t, "write-allow")
	s := e.create(CreateOptions{NoProject: true, InitialPrompt: "write"})
	e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}})
	if err != nil || got.PendingMove == nil {
		t.Fatalf("queued = %+v, %v", got, err)
	}
	wt := got.PendingMove.Path
	e.exit(s.ID, 0)
	after := e.waitFor(s.ID, "stopped, not moved", func(s Thread) bool { return s.State == StateDisconnected && s.PendingMove == nil })
	if after.ProjectID != "" || after.WorktreePath != e.home || after.PendingWorktreePath != "" {
		t.Errorf("after the stop = %+v", after)
	}
	e.waitItems(s.ID, "the failure note", hasNote("Could not move this thread to repo: Claude stopped before the thread could move."))
	deadline := time.Now().Add(5 * time.Second)
	for !slices.Contains(e.projects.Calls, "RemoveWorktree r1 "+wt) {
		if time.Now().After(deadline) {
			t.Fatalf("worktree not removed: %q", e.projects.Calls)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if e.sentSetCwd(wt) {
		t.Error("set_cwd sent")
	}
}

// A running Claude reads folder trust at start, so a folder trusted for the move after it
// started answers needs_trust: Claude restarts (resuming, in home, with the destination's
// folders), the move is tried once more and goes through, without a second restart.
func TestMoveLiveRestartsForTrust(t *testing.T) {
	flag := filepath.Join(t.TempDir(), "trusted")
	e, _ := newMoveEnv(t, "text-table", func(o *Options) {
		o.Env = append(o.Env, "CF_FAKE_CLAUDE_SET_CWD_TRUST_ONCE="+flag)
	})
	s, cid := e.noProjectThread("check the slack thread", false)
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{WorkspaceID: "login", CheckoutMode: true})
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceID != "w-login" || got.ProjectID != "r1" || got.WorktreePath != e.wt {
		t.Fatalf("moved = %+v", got)
	}
	argv := e.argvOf()
	if argOf(argv, "--resume") != cid || !slices.Contains(addDirs(argv), e.wt2) {
		t.Errorf("restart argv %q, want --resume %s and the api checkout", argv, cid)
	}
	pid := e.pid(s.ID)
	time.Sleep(300 * time.Millisecond)
	if e.pid(s.ID) != pid {
		t.Error("restarted again after the move")
	}
	e.waitItems(s.ID, "the move note", hasNote("Moved this thread to workspace login"))
}

// turnEnds counts the timeline's turn ends.
func turnEnds(items []Item) int {
	n := 0
	for _, it := range items {
		if it.Kind == KindTurnEnd {
			n++
		}
	}
	return n
}

// Claude writes an empty result (no turn ran) right after a set_cwd it accepted. A move
// and a Run in both drop it: no turn end in the timeline, and a thread that was at its
// prompt stays there instead of becoming "finished" (which would fire wakes and settle
// thread wait).
func TestSetCwdEmptyResultIsNotATurn(t *testing.T) {
	knob := func(o *Options) { o.Env = append(o.Env, "CF_FAKE_CLAUDE_SET_CWD_RESULT=1") }
	tests := []struct {
		name string
		// run moves the thread and returns its id once it moved.
		run func(t *testing.T) (*wsEnv, string)
	}{
		{"move", func(t *testing.T) (*wsEnv, string) {
			e, _ := newMoveEnv(t, "text-table", knob)
			s, _ := e.noProjectThread("check the slack thread", true)
			if _, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", CheckoutMode: true}); err != nil {
				t.Fatal(err)
			}
			e.waitItems(s.ID, "the move note", hasNote("Moved this thread to repo"))
			return e, s.ID
		}},
		{"run in", func(t *testing.T) (*wsEnv, string) {
			e := newWSFixtureEnv(t, "write-allow", knob)
			s := e.create(CreateOptions{WorkspaceID: "login", InitialPrompt: "write"})
			e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
			e.answer(s.ID)
			e.waitItems(s.ID, "turn end", hasTurnEnd)
			unwatch := openViewer(t, e.env, s.ID) // seen
			e.waitFor(s.ID, "at prompt", isIdleStatus)
			unwatch()
			time.Sleep(settle) // no viewer acknowledges the empty result
			if _, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "r2"}); err != nil {
				t.Fatal(err)
			}
			e.waitFor(s.ID, "moved", func(s Thread) bool { return s.WorktreePath == e.wt2 })
			return e, s.ID
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, id := tt.run(t)
			time.Sleep(settle)
			got, _ := e.m.Get(e.ctx(), id)
			if !isIdleStatus(got) {
				t.Errorf("status after set_cwd = %s %q, want idle at prompt", got.Status, got.StatusReason)
			}
			if n := turnEnds(e.items(id).Items); n != 1 {
				t.Errorf("turn ends = %d, want the first turn's only", n)
			}
		})
	}
}

// A thread archived while its move waits for the name never moves and never starts
// (stopped or running when the archive came): the move fails with the usual rollback.
func TestMoveArchivedWhileNaming(t *testing.T) {
	for _, stop := range []bool{true, false} {
		t.Run(map[bool]string{true: "stopped", false: "running"}[stop], func(t *testing.T) {
			e, n := newMoveEnv(t, "text-table")
			n.gate = make(chan struct{})
			s, _ := e.noProjectThread("check the slack thread", stop)
			errc := make(chan error, 1)
			go func() {
				_, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", NewWorktree: &NewWorktree{}})
				errc <- err
			}()
			e.waitFor(s.ID, "naming", func(s Thread) bool { return s.Naming })
			if _, err := e.m.Archive(e.ctx(), s.ID, true); err != nil {
				t.Fatal(err)
			}
			e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
			spawns := e.spawnCount()
			close(n.gate)
			if err := <-errc; !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "archived while moving") {
				t.Fatalf("Move = %v", err)
			}
			got := e.waitFor(s.ID, "move over", func(s Thread) bool { return s.PendingMove == nil })
			if got.ProjectID != "" || got.WorktreePath != e.home || got.State != StateDisconnected || got.Naming {
				t.Errorf("after = %+v", got)
			}
			if e.spawnCount() != spawns {
				t.Error("Claude started for an archived thread")
			}
			wt := filepath.Join(e.projects.WorktreeRoot, "_local", "repo", "fix-login-redirect")
			deadline := time.Now().Add(5 * time.Second)
			for !slices.Contains(e.projects.Calls, "RemoveWorktree r1 "+wt) {
				if time.Now().After(deadline) {
					t.Fatalf("worktree not removed: %q", e.projects.Calls)
				}
				time.Sleep(10 * time.Millisecond)
			}
			e.waitItems(s.ID, "the failure note", hasNote("Could not move this thread to repo: the thread was archived while moving."))
		})
	}
}

// moveStopped never writes the row of a thread that started (a send) after runMove saw
// it stopped: it reports not moved, so runMove queues the move on that process.
func TestMoveStoppedSeesAStart(t *testing.T) {
	tests := []struct {
		name  string
		setup func(e *wsEnv, id string) (undo func())
	}{
		{"running", func(*wsEnv, string) func() { return func() {} }},
		{"starting", func(e *wsEnv, id string) func() {
			e.exit(id, 0)
			e.waitFor(id, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
			e.m.mu.Lock()
			e.m.recs[id].reserve()
			e.m.mu.Unlock()
			return func() {
				e.m.mu.Lock()
				e.m.recs[id].release()
				e.m.recs[id].s.State = StateDisconnected
				e.m.mu.Unlock()
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := newMoveEnv(t, "text-table")
			s := e.connected(CreateOptions{NoProject: true, Name: "scratch"})
			defer tt.setup(e, s.ID)()
			job := &moveJob{placed: placedThread{projectID: "r1", projectIDs: []string{"r1"}, path: e.wt}, place: "repo", done: make(chan error, 1)}
			moved, err := e.m.moveStopped(e.ctx(), s.ID, job)
			if moved || err != nil {
				t.Fatalf("moveStopped = %v, %v; want not moved", moved, err)
			}
			if got, _ := e.m.Get(e.ctx(), s.ID); got.ProjectID != "" || got.WorktreePath != e.home {
				t.Errorf("row written: %+v", got)
			}
		})
	}
	// Through Move: a running thread without a conversation moves with set_cwd.
	e, _ := newMoveEnv(t, "text-table")
	s := e.connected(CreateOptions{NoProject: true, Name: "scratch"})
	got, err := e.m.Move(e.ctx(), s.ID, MoveOptions{ProjectID: "r1", CheckoutMode: true})
	if err != nil || got.ProjectID != "r1" || got.WorktreePath != e.wt {
		t.Fatalf("Move = %+v, %v", got, err)
	}
	if !e.sentSetCwd(e.wt) {
		t.Error("no set_cwd")
	}
}

// A set_cwd whose answer is lost (a timeout, a transport error) moved when the
// transcript is under the destination now, and did not when it is still in the old
// cwd: a move is applied or rolled back, a Run in applied or dropped, accordingly.
func TestSetCwdLostAnswer(t *testing.T) {
	tests := []struct {
		name     string
		run      bool // a Run in, else a move
		relocate bool // the transcript moved to the destination
	}{
		{"move, transcript moved", false, true},
		{"move, transcript stayed", false, false},
		{"run in, transcript moved", true, true},
		{"run in, transcript stayed", true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gate := filepath.Join(t.TempDir(), "answer")
			knobs := func(o *Options) {
				o.Env = append(o.Env, "CF_FAKE_CLAUDE_SET_CWD_GATE="+gate, "CF_FAKE_CLAUDE_SET_CWD_ERROR=connection lost")
			}
			var (
				e        *wsEnv
				id, cid  string
				from, to string
			)
			if tt.run {
				e = newWSFixtureEnv(t, "write-allow", knobs)
				s := e.create(CreateOptions{WorkspaceID: "login", InitialPrompt: "write"})
				e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
				id, cid, from, to = s.ID, argOf(e.spec(s.ID).Argv, "--session-id"), e.wt, e.wt2
				e.writeTranscriptIn(from, cid, userLine("write"))
				e.answer(id)
				e.waitItems(id, "turn end", hasTurnEnd)
			} else {
				e, _ = newMoveEnv(t, "text-table", knobs)
				var s Thread
				s, cid = e.noProjectThread("check the slack thread", true)
				id, from, to = s.ID, e.home, e.wt
			}
			errc := make(chan error, 1)
			go func() {
				var err error
				if tt.run {
					_, err = e.m.RunIn(e.ctx(), id, RunInTarget{ProjectID: "r2"})
				} else {
					_, err = e.m.Move(e.ctx(), id, MoveOptions{ProjectID: "r1", CheckoutMode: true})
				}
				errc <- err
			}()
			e.waitSent("set_cwd", isSetCwd(to))
			if tt.relocate {
				dst := e.paths.projectDir(to)
				if err := os.MkdirAll(dst, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(filepath.Join(e.paths.projectDir(from), cid+".jsonl"), filepath.Join(dst, cid+".jsonl")); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(gate, nil, 0o644); err != nil {
				t.Fatal(err)
			}
			err := <-errc
			if !tt.run && tt.relocate != (err == nil) {
				t.Fatalf("Move = %v", err)
			}
			got := e.waitFor(id, "settled", func(s Thread) bool { return s.PendingMove == nil && s.PendingWorktreePath == "" })
			if moved := samePath(got.WorktreePath, to); moved != tt.relocate {
				t.Errorf("cwd = %s, moved %v, want %v (last error %q)", got.WorktreePath, moved, tt.relocate, got.LastError)
			}
			if !tt.relocate && !strings.Contains(got.LastError, "connection lost") {
				t.Errorf("last error = %q", got.LastError)
			}
		})
	}
}
