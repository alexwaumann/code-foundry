package command_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/ember"
)

// fakeEmber is an EmberBackend over a slice of tasks: ids t-00000001, t-00000002, …
// unless the caller gives one.
type fakeEmber struct {
	mu       sync.Mutex
	threadID string
	tasks    []ember.Task
	// afterCheck runs after CheckTask, before the worker starts (the caller going away
	// meanwhile).
	afterCheck func()
}

var _ command.EmberBackend = (*fakeEmber)(nil)

func (f *fakeEmber) Snapshot() *ember.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &ember.Snapshot{Status: ember.Status{Enabled: true, ThreadID: f.threadID}, Tasks: slices.Clone(f.tasks)}
}
func (f *fakeEmber) Dir() string       { return "/ember" }
func (f *fakeEmber) TaskIDs() []string { return nil }
func (f *fakeEmber) CheckTask(n ember.NewTask) error {
	if f.afterCheck != nil {
		defer f.afterCheck()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.TrimSpace(n.Title) == "" {
		return fmt.Errorf("%w: a task needs a title", ember.ErrInvalidArgument)
	}
	if n.ParentID != "" && !slices.ContainsFunc(f.tasks, func(t ember.Task) bool { return t.ID == n.ParentID }) {
		return fmt.Errorf("%w: no task %s", ember.ErrNotFound, n.ParentID)
	}
	return nil
}
func (f *fakeEmber) AddTask(ctx context.Context, n ember.NewTask) (ember.Task, error) {
	if err := ctx.Err(); err != nil {
		return ember.Task{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	id := n.ID
	if id == "" {
		id = fmt.Sprintf("t-%08d", len(f.tasks)+1)
	}
	t := ember.Task{ID: id, Title: n.Title, Detail: n.Detail, ParentID: n.ParentID, ThreadID: n.ThreadID, State: n.State}
	f.tasks = append(f.tasks, t)
	return t, nil
}
func (f *fakeEmber) UpdateTask(ctx context.Context, id string, u ember.TaskUpdate) (ember.Task, error) {
	if err := ctx.Err(); err != nil {
		return ember.Task{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	i := slices.IndexFunc(f.tasks, func(t ember.Task) bool { return t.ID == id })
	if i < 0 {
		return ember.Task{}, fmt.Errorf("%w: no task %s", ember.ErrNotFound, id)
	}
	t := &f.tasks[i]
	if u.State != nil {
		t.State = *u.State
	}
	if u.ThreadID != nil {
		t.ThreadID = *u.ThreadID
	}
	if u.Outcome != nil {
		t.Outcome = *u.Outcome
	}
	if u.Branch != nil {
		t.Branch = *u.Branch
	}
	return *t, nil
}
func (f *fakeEmber) Remember(string) (string, error)              { return "", nil }
func (f *fakeEmber) Reseed(context.Context) (ember.Status, error) { return ember.Status{}, nil }
func (f *fakeEmber) Await(context.Context, func(*ember.Snapshot) bool) (*ember.Snapshot, error) {
	return f.Snapshot(), nil
}

func TestEmberTaskStart(t *testing.T) {
	const newID = "t-0000abcd" // the id a new task gets
	planned := []ember.Task{
		{ID: "t-00000009", Title: "Batch", State: ember.StateTodo},
		{ID: "t-0000000a", Title: "Second piece", Detail: "after the first", ParentID: "t-00000009", State: ember.StateTodo,
			Outcome: "its worker never started (the app restarted at 01:42)"},
		{ID: "t-0000000b", Title: "Third piece", ParentID: "t-00000009", State: ember.StateDoing, ThreadID: "s-old"},
		{ID: "t-0000000c", Title: "Retry", State: ember.StateBlocked, ThreadID: "s-failed", Outcome: "tests fail"},
	}
	with := func(i int, change func(*ember.Task)) []ember.Task {
		out := slices.Clone(planned)
		change(&out[i])
		return out
	}
	tests := []struct {
		name      string
		emberID   string // Ember's thread
		tasks     []ember.Task
		args      map[string]string
		modelDflt string // the settings' thread.new model default
		createErr error
		cancel    bool  // the request's ctx ends while the worker starts
		wantErr   error // errors.Is, or an *ArgError for command.ErrInvalidArgs
		wantMsg   string
		check     func(t *testing.T, req *v1.CreateThreadRequest)
		wantTasks []ember.Task // the board after the call (nil: tasks unchanged)
	}{
		{
			name: "Ember's worker in a new worktree", emberID: "s-ember",
			args:    map[string]string{"title": " Add install section ", "project": "p-1", "prompt": "Write it, push, report.", "brief": "README install"},
			wantMsg: "started task " + newID + " with thread s1 in /worktrees/s1",
			check: func(t *testing.T, req *v1.CreateThreadRequest) {
				if req.GetNewWorktree() == nil || req.GetNewWorktree().GetBaseRef() != "" || req.GetProjectId() != "p-1" || req.GetName() != "Add install section" ||
					req.GetInitialPrompt() != "Write it, push, report." || req.GetBrief() != "README install" || req.GetCreatedBy() != "s-ember" ||
					!req.GetNotify() || req.GetRequestId() != newID || !slices.Equal(req.GetLabels(), []string{"ember", newID}) ||
					req.GetModel() != "" || req.GetEffort() != "" || req.GetBudgetUsd() != 0 {
					t.Errorf("create = %v", req)
				}
			},
			wantTasks: []ember.Task{{ID: newID, Title: "Add install section", State: ember.StateDoing, ThreadID: "s1"}},
		},
		{
			name: "every option, the creator from the thread env", emberID: "s-ember", tasks: planned[:1],
			args: map[string]string{"title": "Second piece", "project": "notes", "prompt": "Go.", "created-by": "s-lead", "labels": "docs, ember",
				"budget": "$2.50", "base": "origin/cf/first", "parent": "t-00000009", "detail": "after the first"},
			wantMsg: "started task " + newID + " with thread s1 in /worktrees/s1",
			check: func(t *testing.T, req *v1.CreateThreadRequest) {
				if req.GetCreatedBy() != "s-lead" || !slices.Equal(req.GetLabels(), []string{"ember", newID, "docs"}) || req.GetBudgetUsd() != 2.5 ||
					req.GetNewWorktree().GetBaseRef() != "origin/cf/first" {
					t.Errorf("create = %v", req)
				}
			},
			wantTasks: []ember.Task{planned[0], {ID: newID, Title: "Second piece", Detail: "after the first", ParentID: "t-00000009", State: ember.StateDoing, ThreadID: "s1"}},
		},
		{
			name: "the settings' model stays a default, for the worker-model hook", emberID: "s-ember", modelDflt: "claude-sonnet-5[1m]",
			args:    map[string]string{"title": "x", "project": "p-1", "prompt": "Go."},
			wantMsg: "started task " + newID + " with thread s1",
			check: func(t *testing.T, req *v1.CreateThreadRequest) {
				if req.GetModel() != "claude-sonnet-5[1m]" || !req.GetModelDefaulted() {
					t.Errorf("model = %q, defaulted %v", req.GetModel(), req.GetModelDefaulted())
				}
			},
			wantTasks: []ember.Task{{ID: newID, Title: "x", State: ember.StateDoing, ThreadID: "s1"}},
		},
		{
			name: "a lead in the project's checkout", emberID: "s-ember",
			args:    map[string]string{"title": "Lead: validation", "project": "p-1", "prompt": "You are a lead.", "new-worktree": "false"},
			wantMsg: "started task " + newID + " with thread s1 in ",
			check: func(t *testing.T, req *v1.CreateThreadRequest) {
				if req.GetNewWorktree() != nil {
					t.Errorf("create = %v", req)
				}
			},
			wantTasks: []ember.Task{{ID: newID, Title: "Lead: validation", State: ember.StateDoing, ThreadID: "s1"}},
		},
		{
			name: "the worker does not start: no task is added", emberID: "s-ember", createErr: connect.NewError(connect.CodeNotFound, errors.New("no project p-9")),
			args:    map[string]string{"title": "x", "project": "p-9", "prompt": "Go."},
			wantErr: errors.New("the worker did not start, so no task was added: not_found: no project p-9"),
		},
		{
			name: "--task starts a planned todo piece: its title names the worker, the outcome goes", emberID: "s-ember", tasks: planned,
			args:    map[string]string{"task": "t-0000000a", "project": "p-1", "prompt": "Go.", "base": "origin/cf/first"},
			wantMsg: "started task t-0000000a with thread s1 in /worktrees/s1",
			check: func(t *testing.T, req *v1.CreateThreadRequest) {
				if req.GetName() != "Second piece" || req.GetRequestId() != "t-0000000a" || !slices.Equal(req.GetLabels(), []string{"ember", "t-0000000a"}) ||
					req.GetNewWorktree().GetBaseRef() != "origin/cf/first" || req.GetCreatedBy() != "s-ember" {
					t.Errorf("create = %v", req)
				}
			},
			wantTasks: with(1, func(t *ember.Task) { t.State, t.ThreadID, t.Outcome = ember.StateDoing, "s1", "" }),
		},
		{
			name: "--task restarts a blocked task with a new worker", emberID: "s-ember", tasks: planned,
			args:      map[string]string{"task": "t-0000000c", "project": "p-1", "prompt": "Again."},
			wantMsg:   "started task t-0000000c with thread s1",
			wantTasks: with(3, func(t *ember.Task) { t.State, t.ThreadID, t.Outcome = ember.StateDoing, "s1", "" }),
		},
		{
			name: "--task: the worker does not start, the task stays todo", emberID: "s-ember", tasks: planned, createErr: errors.New("no project p-9"),
			args:    map[string]string{"task": "t-0000000a", "project": "p-9", "prompt": "Go."},
			wantErr: errors.New("the worker did not start; task t-0000000a stays todo"),
		},
		{name: "--task on a doing task", emberID: "s-ember", tasks: planned, args: map[string]string{"task": "t-0000000b", "project": "p-1", "prompt": "Go."},
			wantErr: command.ErrInvalidArgs},
		{name: "--task on a parent", emberID: "s-ember", tasks: planned, args: map[string]string{"task": "t-00000009", "project": "p-1", "prompt": "Go."},
			wantErr: command.ErrInvalidArgs},
		{name: "--task with a title", emberID: "s-ember", tasks: planned, args: map[string]string{"task": "t-0000000a", "title": "x", "project": "p-1", "prompt": "Go."},
			wantErr: command.ErrInvalidArgs},
		{name: "--task with a parent", emberID: "s-ember", tasks: planned, args: map[string]string{"task": "t-0000000a", "parent": "t-00000009", "project": "p-1", "prompt": "Go."},
			wantErr: command.ErrInvalidArgs},
		{name: "--task: no such task", emberID: "s-ember", tasks: planned, args: map[string]string{"task": "t-ffffffff", "project": "p-1", "prompt": "Go."},
			wantErr: errors.New("no task t-ffffffff")},
		{
			name: "the caller goes away while the worker starts: the task is still written", emberID: "s-ember", cancel: true,
			args:      map[string]string{"title": "x", "project": "p-1", "prompt": "Go."},
			wantMsg:   "started task " + newID + " with thread s1",
			wantTasks: []ember.Task{{ID: newID, Title: "x", State: ember.StateDoing, ThreadID: "s1"}},
		},
		{name: "neither a title nor --task", emberID: "s-ember", args: map[string]string{"project": "p-1", "prompt": "Go."}, wantErr: command.ErrInvalidArgs},
		{name: "an unknown parent: refused before the worker", emberID: "s-ember", args: map[string]string{"title": "x", "parent": "t-00000009", "project": "p-1", "prompt": "Go."},
			wantErr: errors.New("no task t-00000009")},
		{name: "no Ember thread and no creator", args: map[string]string{"title": "x", "project": "p-1", "prompt": "Go."}, wantErr: command.ErrInvalidArgs},
		{name: "a bad budget", emberID: "s-ember", args: map[string]string{"title": "x", "project": "p-1", "prompt": "Go.", "budget": "lots"}, wantErr: command.ErrInvalidArgs},
		{name: "base without a new worktree", emberID: "s-ember", args: map[string]string{"title": "x", "project": "p-1", "prompt": "Go.", "base": "main", "new-worktree": "false"},
			wantErr: command.ErrInvalidArgs},
		{name: "the prompt is required", emberID: "s-ember", args: map[string]string{"title": "x", "project": "p-1"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			threads := &commandtest.Thread{Err: tt.createErr}
			fe := &fakeEmber{threadID: tt.emberID, tasks: slices.Clone(tt.tasks)}
			if err := errors.Join(command.RegisterThreadLifecycle(reg, threads, &commandtest.Emitter{}),
				command.RegisterEmber(reg, command.EmberDeps{Ember: fe, Thread: threads, NewTaskID: func() (string, error) { return newID, nil }})); err != nil {
				t.Fatal(err)
			}
			if tt.modelDflt != "" {
				reg.SetOverrides(command.Overrides{ArgDefaults: map[string]map[string]string{"thread.new": {"model": tt.modelDflt}}})
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tt.cancel {
				fe.afterCheck = cancel
			}
			res, err := reg.Invoke(ctx, command.Context{}, "ember.task.start", tt.args)
			switch {
			case tt.wantErr == nil && err != nil:
				t.Fatalf("err = %v", err)
			case errors.Is(tt.wantErr, command.ErrInvalidArgs) && !errors.Is(err, command.ErrInvalidArgs):
				t.Fatalf("err = %v, want invalid args", err)
			case tt.wantErr != nil && !errors.Is(tt.wantErr, command.ErrInvalidArgs) && (err == nil || !strings.Contains(err.Error(), tt.wantErr.Error())):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantErr == nil && !strings.HasPrefix(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want %q…", res.Message, tt.wantMsg)
			}
			var creates []*v1.CreateThreadRequest
			for _, m := range threads.Requests() {
				if c, ok := m.(*v1.CreateThreadRequest); ok {
					creates = append(creates, c)
				}
			}
			if tt.check != nil {
				if len(creates) != 1 {
					t.Fatalf("creates = %v", creates)
				}
				tt.check(t, creates[0])
			}
			want := tt.wantTasks
			if want == nil {
				want = tt.tasks // unchanged
			}
			if got := fe.Snapshot().Tasks; !slices.Equal(got, want) {
				t.Errorf("tasks = %+v\nwant    %+v", got, want)
			}
			if tt.wantErr != nil && errors.Is(tt.wantErr, command.ErrInvalidArgs) && len(creates) != 0 {
				t.Errorf("a refused start created %v", creates)
			}
			if v, ok := res.JSON.(command.EmberStartView); err == nil && (!ok || v.ThreadID != "s1" || v.Task.ThreadID != "s1") {
				t.Errorf("JSON = %+v", res.JSON)
			}
		})
	}
}

func TestEmberTaskDoneBranch(t *testing.T) {
	tests := []struct {
		name     string
		task     ember.Task
		branch   string
		remote   map[string]bool // "<worktree> <branch>" → exists
		gitErr   error
		wantCode connect.Code // 0: done
		wantArg  bool
		wantFail bool // the command's own failure (command.IsFailed)
		wantGit  string
	}{
		{name: "pushed", task: ember.Task{ID: "t-00000001", ThreadID: "s-w", State: ember.StateDoing}, branch: "cf/readme",
			remote: map[string]bool{"/worktrees/w cf/readme": true}, wantGit: "/worktrees/w cf/readme"},
		{name: "origin/ is optional", task: ember.Task{ID: "t-00000001", ThreadID: "s-w", State: ember.StateDoing}, branch: "origin/cf/readme",
			remote: map[string]bool{"/worktrees/w cf/readme": true}, wantGit: "/worktrees/w cf/readme"},
		{name: "not pushed", task: ember.Task{ID: "t-00000001", ThreadID: "s-w", State: ember.StateDoing}, branch: "cf/readme",
			wantCode: connect.CodeFailedPrecondition, wantGit: "/worktrees/w cf/readme"},
		{name: "git fails", task: ember.Task{ID: "t-00000001", ThreadID: "s-w", State: ember.StateDoing}, branch: "cf/readme", gitErr: errors.New("not a git repository"),
			wantFail: true, wantGit: "/worktrees/w cf/readme"},
		{name: "no worker", task: ember.Task{ID: "t-00000001", State: ember.StateDoing}, branch: "cf/readme", wantArg: true},
		{name: "no task", task: ember.Task{ID: "t-00000002"}, branch: "cf/readme", wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			threads := &commandtest.Thread{Current: &v1.Thread{WorktreePath: "/worktrees/w"}}
			fe := &fakeEmber{tasks: []ember.Task{tt.task}}
			var gitCalls []string
			remote := func(_ context.Context, wt, branch string) (bool, error) {
				gitCalls = append(gitCalls, wt+" "+branch)
				return tt.remote[wt+" "+branch], tt.gitErr
			}
			if err := command.RegisterEmber(reg, command.EmberDeps{Ember: fe, Thread: threads, RemoteBranch: remote}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, "ember.task.done", map[string]string{"id": "t-00000001", "outcome": "pushed", "branch": tt.branch})
			var ae *command.ArgError
			switch {
			case tt.wantArg:
				if !errors.As(err, &ae) {
					t.Fatalf("err = %v, want an ArgError", err)
				}
			case tt.wantFail:
				if !command.IsFailed(err) {
					t.Fatalf("err = %v, want a failure", err)
				}
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want %v", err, tt.wantCode)
				}
			case err != nil || !strings.HasPrefix(res.Message, "done: t-00000001 [done]"):
				t.Fatalf("done = %q, %v", res.Message, err)
			}
			if tt.wantGit != "" && !slices.Equal(gitCalls, []string{tt.wantGit}) {
				t.Errorf("git calls = %q, want %q", gitCalls, tt.wantGit)
			}
			if done := fe.Snapshot().Tasks[0].State == ember.StateDone; done != (err == nil) {
				t.Errorf("task state = %v after err %v", fe.Snapshot().Tasks[0].State, err)
			}
			// The branch is recorded, without origin/, only when it was found.
			wantBranch := ""
			if err == nil {
				wantBranch = "cf/readme"
			}
			if got := fe.Snapshot().Tasks[0].Branch; got != wantBranch {
				t.Errorf("branch = %q, want %q", got, wantBranch)
			}
			if err == nil && !strings.Contains(res.Message, "· branch cf/readme — pushed") {
				t.Errorf("message = %q", res.Message)
			}
			if err != nil {
				return
			}
			show, err := reg.Invoke(context.Background(), command.Context{}, "ember.task.show", map[string]string{"id": "t-00000001"})
			if err != nil || !strings.Contains(show.Message, "\nbranch: cf/readme") || show.JSON.(command.EmberTaskView).Branch != "cf/readme" {
				t.Errorf("show = %q, %v", show.Message, err)
			}
			list, err := reg.Invoke(context.Background(), command.Context{}, "ember.task.list", map[string]string{"all": "true"})
			if err != nil || !strings.Contains(list.Message, "· branch cf/readme") {
				t.Errorf("list = %q, %v", list.Message, err)
			}
		})
	}
}
