package command

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/ember"
)

// ember.task.start: one piece of Ember's work in one call (docs/notes/ember-fixes-1-skill-cli.md).
// It adds the task (doing), starts its worker through thread.new exactly as the
// code-foundry-ember skill prescribes and links the two, where Ember used to need three
// model round trips (task add, thread new, task update).

// EmberStartView is ember.task.start's JSON: the task (linked) and its worker.
type EmberStartView struct {
	Task         EmberTaskView `json:"task"`
	ThreadID     string        `json:"threadId"`
	WorktreePath string        `json:"worktreePath"`
	BaseRef      string        `json:"baseRef,omitempty"`
}

// emberTaskStart is ember.task.start. thread.new runs through r, so its defaults (the
// settings' model and effort, marked defaulted for the worker-model hook), checks and
// message stay its own.
func emberTaskStart(r *Registry, d EmberDeps) Command {
	return Command{
		Name:  "ember.task.start",
		Title: "Ember: Start Task",
		Description: "Add a task (doing) and start its worker thread in one call: thread.new with a new worktree, " +
			"labels ember,<task id>, notify and request id <task id>, linked to the task. The worker gets Ember's worker model.",
		Category:     emberCategory,
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "title", Type: String, Required: true, Positional: true, Description: "The task's title, also the worker's name (one line)"},
			{Name: "project", Type: String, Required: true, Description: "Project id or name the worker runs in"},
			{Name: "prompt", Type: String, Required: true, FileOrStdin: true, Description: "The worker's whole task (@file: from a file, -: stdin)"},
			{Name: "detail", Type: String, FileOrStdin: true, Description: "The task's detail on the board (@file: from a file, -: stdin)"},
			{Name: "parent", Type: String, ID: EmberTaskID, Description: "The top-level task it is part of"},
			{Name: "brief", Type: String, Description: "What the worker is for, at most 500 characters"},
			{Name: "labels", Type: String, Description: "More comma-separated labels (ember and the task id are always set)"},
			{Name: "budget", Type: String, Description: "The worker's spending limit in USD, e.g. 2.00"},
			{Name: "base", Type: String, Description: "Ref the new worktree branches from (default: the default branch; a branch name means origin's copy, fetched, unless projects.base_from_origin is off)"},
			{Name: "new-worktree", Type: Bool, Default: "true", Description: "Start the worker in a new worktree (default on; false: the project's own checkout, for a lead)"},
			{Name: "created-by", Type: String, DefaultToThreadEnv: true, ID: ThreadID,
				Description: "The thread woken when the worker settles (default: the thread this runs in, else Ember's)"},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			creator := strings.TrimSpace(a.String("created-by"))
			if creator == "" {
				creator = d.Ember.Snapshot().Status.ThreadID
			}
			if creator == "" {
				return Result{}, InvalidArg("created-by", "Ember has no thread yet (code-foundry ember enable), and none was given")
			}
			if a.Has("budget") {
				if _, err := parseUSD("budget", a.String("budget")); err != nil {
					return Result{}, err
				}
			}
			if a.String("base") != "" && !a.Bool("new-worktree") {
				return Result{}, InvalidArg("base", "only applies with new-worktree")
			}
			t, err := d.Ember.AddTask(ctx, ember.NewTask{Title: a.String("title"), Detail: a.String("detail"), ParentID: a.String("parent"), State: ember.StateDoing})
			if err != nil {
				return Result{}, emberErr("title", err)
			}
			raw := map[string]string{
				"project": a.String("project"), "name": t.Title, "prompt": a.String("prompt"), "created-by": creator,
				"labels": strings.Join(emberLabels(t.ID, a.String("labels")), ","), "notify": "true", "request-id": t.ID,
			}
			for _, name := range []string{"brief", "budget", "base"} {
				if v := a.String(name); v != "" {
					raw[name] = v
				}
			}
			if a.Bool("new-worktree") {
				raw["new-worktree"] = "true"
			}
			res, err := r.Invoke(ctx, uctx, "thread.new", raw)
			// The task's follow-up is bookkeeping for what already happened: a caller that
			// went away must not leave it doing with no worker.
			bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if err != nil {
				// No worker: the task does not stay doing. Ember starts the piece again.
				why := "the worker did not start: " + err.Error()
				if ce := new(connect.Error); errors.As(err, &ce) {
					why = "the worker did not start: " + ce.Message()
				}
				s := ember.StateCancelled
				if _, cerr := d.Ember.UpdateTask(bctx, t.ID, ember.TaskUpdate{State: &s, Outcome: &why}); cerr != nil {
					err = errors.Join(err, cerr)
				}
				return Result{}, fmt.Errorf("task %s cancelled, its worker did not start: %w", t.ID, err)
			}
			w, ok := res.JSON.(*v1.Thread)
			if !ok || w.GetId() == "" {
				return Result{}, Failed(fmt.Errorf("thread.new answered no thread for task %s", t.ID))
			}
			tid := w.GetId()
			if t, err = d.Ember.UpdateTask(bctx, t.ID, ember.TaskUpdate{ThreadID: &tid}); err != nil {
				return Result{}, fmt.Errorf("thread %s started, but task %s is not linked to it: %w", tid, raw["request-id"], emberErr("", err))
			}
			return Result{
				Message: fmt.Sprintf("started task %s with thread %s in %s", t.ID, tid, w.GetWorktreePath()),
				JSON:    EmberStartView{Task: emberTaskView(t, d.Now()), ThreadID: tid, WorktreePath: w.GetWorktreePath(), BaseRef: w.GetBaseRef()},
			}, nil
		},
	}
}

// emberLabels are a worker's labels: ember, the task id, then extra (comma-separated),
// without repeats.
func emberLabels(taskID, extra string) []string {
	out := []string{"ember", taskID}
	for _, l := range splitList(extra) {
		if !slices.Contains(out, l) {
			out = append(out, l)
		}
	}
	return out
}

// checkTaskBranch is ember.task.done's branch check: origin/<branch> exists in the
// worktree of task id's worker (its push updated it there).
func checkTaskBranch(ctx context.Context, d EmberDeps, id, branch string) error {
	branch = strings.TrimPrefix(strings.TrimSpace(branch), "origin/")
	if branch == "" {
		return InvalidArg("branch", "an empty branch")
	}
	t, ok := d.Ember.Snapshot().Task(id)
	if !ok {
		return emberErr("id", fmt.Errorf("%w: no task %s", ember.ErrNotFound, id))
	}
	if t.ThreadID == "" {
		return InvalidArg("branch", "task %s has no worker thread whose worktree to check", t.ID)
	}
	if d.Thread == nil {
		return connect.NewError(connect.CodeUnimplemented, errors.New("no thread store to find the worker's worktree"))
	}
	res, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: t.ThreadID}))
	if err != nil {
		return fmt.Errorf("the worker %s of task %s: %w", t.ThreadID, t.ID, err)
	}
	wt := res.Msg.GetThread().GetWorktreePath()
	if wt == "" {
		return InvalidArg("branch", "the worker %s of task %s has no worktree", t.ThreadID, t.ID)
	}
	found, err := d.RemoteBranch(ctx, wt, branch)
	if err != nil {
		return Failed(fmt.Errorf("check origin/%s in %s: %w", branch, wt, err))
	}
	if !found {
		return connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("origin/%s does not exist in %s: the worker has not pushed it (git -C %s fetch, then check again)", branch, wt, wt))
	}
	return nil
}

// gitRemoteBranch reports whether refs/remotes/origin/<branch> exists in worktree.
func gitRemoteBranch(ctx context.Context, worktree, branch string) (bool, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+branch).CombinedOutput()
	var ee *exec.ExitError
	switch {
	case err == nil:
		return true, nil
	case errors.As(err, &ee) && ee.ExitCode() == 1 && len(strings.TrimSpace(string(out))) == 0:
		return false, nil
	}
	return false, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
}
