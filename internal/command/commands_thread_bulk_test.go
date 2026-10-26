package command_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// newBulkRegistry is the thread commands with their id lister over threads.
func newBulkRegistry(t *testing.T, threads ...*v1.Thread) (*command.Registry, *commandtest.Thread) {
	t.Helper()
	reg := command.NewRegistry()
	b := &commandtest.Thread{Others: threads}
	if err := command.RegisterThreadLifecycle(reg, b, &commandtest.Emitter{Delivered: 1, OpenWindows: 1}); err != nil {
		t.Fatal(err)
	}
	if err := command.RegisterThread(reg, b); err != nil {
		t.Fatal(err)
	}
	return reg, b
}

// idle is a thread at its prompt.
func idle(id, name string) *v1.Thread {
	return &v1.Thread{Id: id, Name: name, State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_IDLE}
}

func TestThreadRemoveIDs(t *testing.T) {
	a, b, c := idle("s-aaaa11112222", "one"), idle("s-bbbb33334444", "two"), idle("s-cccc55556666", "three")
	notFound := connect.NewError(connect.CodeNotFound, errors.New("thread s-bbbb33334444 not found"))
	tests := []struct {
		name      string
		ctx       command.Context
		args      map[string]string
		fail      map[string]error
		wantErr   error
		wantCode  connect.Code
		wantMsg   string
		wantExit  int
		wantIDs   []string // the Remove requests, in order
		wantJSON  *command.ThreadsResult
		wantAsked bool
	}{
		{name: "one id as before", args: map[string]string{"id": "s-aaaa11112222"},
			wantMsg: "removed thread s-aaaa11112222", wantIDs: []string{"s-aaaa11112222"}},
		{name: "ids resolve suffixes, drop blanks and repeats", args: map[string]string{"ids": "11112222, ,s-bbbb33334444,33334444"},
			wantMsg: "removed 2 threads: s-aaaa11112222, s-bbbb33334444", wantIDs: []string{"s-aaaa11112222", "s-bbbb33334444"},
			wantJSON: &command.ThreadsResult{Done: []string{"s-aaaa11112222", "s-bbbb33334444"}, Failed: []command.ThreadFailure{}}},
		// In a thread id defaults to the caller's own thread; ids replaces it.
		{name: "ids ignore the context thread", ctx: command.Context{ActiveThreadID: "s-cccc55556666"}, args: map[string]string{"ids": "11112222"},
			wantMsg: "removed 1 thread: s-aaaa11112222", wantIDs: []string{"s-aaaa11112222"}},
		{name: "a failure does not stop the rest", args: map[string]string{"ids": "11112222,33334444,55556666"},
			fail:     map[string]error{"s-bbbb33334444": notFound},
			wantMsg:  "removed 2 threads: s-aaaa11112222, s-cccc55556666\nfailed on 1 thread:\n  s-bbbb33334444: not_found: thread s-bbbb33334444 not found",
			wantExit: 1, wantIDs: []string{"s-aaaa11112222", "s-bbbb33334444", "s-cccc55556666"},
			wantJSON: &command.ThreadsResult{Done: []string{"s-aaaa11112222", "s-cccc55556666"},
				Failed: []command.ThreadFailure{{ID: "s-bbbb33334444", Error: "not_found: thread s-bbbb33334444 not found"}}}},
		{name: "every one failing", args: map[string]string{"ids": "s-aaaa11112222"}, fail: map[string]error{"s-aaaa11112222": errors.New("boom")},
			wantMsg: "failed on 1 thread:\n  s-aaaa11112222: boom", wantExit: 1, wantIDs: []string{"s-aaaa11112222"}},
		// One entry that does not resolve acts on none.
		{name: "an unknown suffix removes nothing", args: map[string]string{"ids": "11112222,ffff"}, wantCode: connect.CodeNotFound},
		{name: "an ambiguous suffix removes nothing", args: map[string]string{"ids": "11112222,2222,4444"}, wantErr: command.ErrInvalidArgs},
		{name: "neither id nor ids", wantErr: command.ErrInvalidArgs},
		// A list built from nothing ("$(... | join(","))" with no children) is an error,
		// not the context thread, the caller's own.
		{name: "ids of only blanks", ctx: command.Context{ActiveThreadID: "s-cccc55556666"}, args: map[string]string{"ids": " , "},
			wantErr: command.ErrInvalidArgs},
		// The CLI in a thread removes its own thread only when --id names it.
		{name: "the CLI does not remove the thread it runs in by default", ctx: command.Context{ActiveThreadID: "s-cccc55556666"},
			wantErr: command.ErrInvalidArgs},
		{name: "the CLI removes the thread it runs in given --id", ctx: command.Context{ActiveThreadID: "s-cccc55556666"},
			args: map[string]string{"id": "55556666"}, wantMsg: "removed thread s-cccc55556666", wantIDs: []string{"s-cccc55556666"}},
		{name: "the GUI removes the thread in view", ctx: command.Context{ActiveThreadID: "s-cccc55556666", ActiveView: "thread"},
			wantMsg: "removed thread s-cccc55556666", wantIDs: []string{"s-cccc55556666"}},
		{name: "the GUI still needs a thread", ctx: command.Context{ActiveView: "dashboard"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newBulkRegistry(t, a, b, c)
			fake.FailIDs = tt.fail
			// The second one with the same suffix makes "2222" ambiguous.
			fake.Others = append(fake.Others, idle("s-dddd77772222", "four"))
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.remove", tt.args, command.Confirmed(true))
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case err != nil:
				t.Fatal(err)
			}
			var removed []string
			for _, r := range fake.Requests() {
				if r, ok := r.(*v1.RemoveThreadRequest); ok {
					removed = append(removed, r.GetId())
				}
			}
			if fmt.Sprint(removed) != fmt.Sprint(tt.wantIDs) {
				t.Errorf("removed %v, want %v", removed, tt.wantIDs)
			}
			if err != nil {
				return
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message =\n%s\nwant\n%s", res.Message, tt.wantMsg)
			}
			if res.ExitCode != tt.wantExit {
				t.Errorf("exit = %d, want %d", res.ExitCode, tt.wantExit)
			}
			if tt.wantJSON != nil && fmt.Sprintf("%+v", res.JSON) != fmt.Sprintf("%+v", *tt.wantJSON) {
				t.Errorf("JSON = %+v, want %+v", res.JSON, *tt.wantJSON)
			}
		})
	}
}

func TestThreadRemoveIDsConfirm(t *testing.T) {
	var threads []*v1.Thread
	var ids []string
	for i := range 12 {
		id := fmt.Sprintf("s-%012d", i+1)
		threads = append(threads, idle(id, ""))
		ids = append(ids, id)
	}
	// s-000000000013 is in a worktree Code Foundry made; s-000000000014 was made in an
	// existing checkout (created_worktree, no branch: nothing derived).
	made, noBranch := idle("s-000000000013", ""), idle("s-000000000014", "")
	made.CreatedWorktree, made.Branch = true, "feat/x"
	noBranch.CreatedWorktree = true
	threads = append(threads, made, noBranch)
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		wantAsk string
	}{
		{name: "one id", args: map[string]string{"id": ids[0]},
			wantAsk: "Remove thread s-000000000001? Claude stops if it runs, and the thread is forgotten."},
		{name: "one entry in ids, not the context thread", ctx: command.Context{ActiveThreadID: ids[5]}, args: map[string]string{"ids": ids[0]},
			wantAsk: "Remove thread s-000000000001? Claude stops if it runs, and the thread is forgotten."},
		{name: "three", args: map[string]string{"ids": strings.Join(ids[:3], ",")},
			wantAsk: "Remove 3 threads? Claude stops in each that runs, and they are forgotten: s-000000000001, s-000000000002, s-000000000003."},
		{name: "twelve list ten and the count of the rest", args: map[string]string{"ids": strings.Join(ids, ",")},
			wantAsk: "Remove 12 threads? Claude stops in each that runs, and they are forgotten: " +
				strings.Join(ids[:10], ", ") + " and 2 more."},
		{name: "one in a made worktree", args: map[string]string{"id": made.Id},
			wantAsk: "Remove thread s-000000000013? Claude stops if it runs, and the thread is forgotten. Its clean worktrees are removed; branches stay."},
		{name: "created_worktree without a branch says nothing extra", args: map[string]string{"id": noBranch.Id},
			wantAsk: "Remove thread s-000000000014? Claude stops if it runs, and the thread is forgotten."},
		{name: "several, one in a made worktree", args: map[string]string{"ids": ids[0] + "," + made.Id},
			wantAsk: "Remove 2 threads? Claude stops in each that runs, and they are forgotten: s-000000000001, s-000000000013. " +
				"Their clean worktrees are removed; branches stay."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newBulkRegistry(t, threads...)
			_, err := reg.Invoke(context.Background(), tt.ctx, "thread.remove", tt.args)
			var ce *command.ConfirmError
			if !errors.As(err, &ce) {
				t.Fatalf("err = %v, want a confirmation", err)
			}
			if ce.Message != tt.wantAsk {
				t.Errorf("asked\n%s\nwant\n%s", ce.Message, tt.wantAsk)
			}
			for _, r := range fake.Requests() {
				if _, ok := r.(*v1.RemoveThreadRequest); ok {
					t.Fatal("removed before confirming")
				}
			}
		})
	}
}

func TestThreadArchiveIDs(t *testing.T) {
	busy := &v1.Thread{Id: "s-bbbb33334444", Name: "two", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	shells := &v1.Thread{Id: "s-cccc55556666", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_IDLE,
		BackgroundShellsRunning: 2}
	quiet := []*v1.Thread{idle("s-aaaa11112222", "one"), idle("s-eeee99990000", "five")}
	tests := []struct {
		name      string
		threads   []*v1.Thread
		args      map[string]string
		confirmed bool
		fail      map[string]error
		wantAsk   string
		wantMsg   string
		wantExit  int
		wantReqs  []proto.Message // the Archive requests
	}{
		{name: "idle threads archive without asking", threads: quiet, args: map[string]string{"ids": "11112222,99990000"},
			wantMsg:  "archived 2 threads: s-aaaa11112222, s-eeee99990000",
			wantReqs: []proto.Message{&v1.ArchiveThreadRequest{Id: "s-aaaa11112222", Archived: true}, &v1.ArchiveThreadRequest{Id: "s-eeee99990000", Archived: true}}},
		{name: "archived=false unarchives each without asking", threads: append([]*v1.Thread{busy}, quiet...),
			args: map[string]string{"ids": "11112222,33334444", "archived": "false"}, wantMsg: "unarchived 2 threads: s-aaaa11112222, s-bbbb33334444",
			wantReqs: []proto.Message{&v1.ArchiveThreadRequest{Id: "s-aaaa11112222"}, &v1.ArchiveThreadRequest{Id: "s-bbbb33334444"}}},
		{name: "one busy among several asks, naming it", threads: append([]*v1.Thread{busy}, quiet...), args: map[string]string{"ids": "11112222,33334444,99990000"},
			wantAsk: "Archive 3 threads? 1 of them is busy: two (Claude is still working). Archiving ends its turn or stops its background work."},
		{name: "two busy", threads: append([]*v1.Thread{busy, shells}, quiet...), args: map[string]string{"ids": "11112222,33334444,55556666"},
			wantAsk: "Archive 3 threads? 2 of them are busy: two (Claude is still working), s-cccc55556666 (2 background shells are running). " +
				"Archiving ends their turns and stops their background work."},
		{name: "one busy entry asks as for one thread", threads: []*v1.Thread{busy}, args: map[string]string{"ids": "33334444"},
			wantAsk: "Archive thread two? Claude is still working; archiving ends the turn."},
		{name: "confirmed, a failure does not stop the rest", threads: append([]*v1.Thread{busy}, quiet...), confirmed: true,
			args: map[string]string{"ids": "11112222,33334444,99990000"}, fail: map[string]error{"s-aaaa11112222": errors.New("boom")},
			wantMsg: "archived 2 threads: s-bbbb33334444, s-eeee99990000\nfailed on 1 thread:\n  s-aaaa11112222: boom", wantExit: 1,
			wantReqs: []proto.Message{&v1.ArchiveThreadRequest{Id: "s-aaaa11112222", Archived: true},
				&v1.ArchiveThreadRequest{Id: "s-bbbb33334444", Archived: true}, &v1.ArchiveThreadRequest{Id: "s-eeee99990000", Archived: true}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newBulkRegistry(t, tt.threads...)
			fake.FailIDs = tt.fail
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.archive", tt.args, command.Confirmed(tt.confirmed))
			var archives []proto.Message
			for _, r := range fake.Requests() {
				if r, ok := r.(*v1.ArchiveThreadRequest); ok {
					archives = append(archives, r)
				}
			}
			if tt.wantAsk != "" {
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk {
					t.Fatalf("err = %v, want the confirmation\n%s", err, tt.wantAsk)
				}
				if len(archives) > 0 {
					t.Fatal("archived before confirming")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg || res.ExitCode != tt.wantExit {
				t.Errorf("result = %q (exit %d), want %q (exit %d)", res.Message, res.ExitCode, tt.wantMsg, tt.wantExit)
			}
			if len(archives) != len(tt.wantReqs) {
				t.Fatalf("archive requests = %v, want %v", archives, tt.wantReqs)
			}
			for i := range archives {
				if !proto.Equal(archives[i], tt.wantReqs[i]) {
					t.Errorf("request %d = %v, want %v", i, archives[i], tt.wantReqs[i])
				}
			}
		})
	}
}

// An id list must be of a known id kind and not context-bound.
func TestIDListSpec(t *testing.T) {
	for _, spec := range []command.ArgSpec{
		{Name: "ids", Type: command.String, IDList: true},
		{Name: "ids", Type: command.String, IDList: true, ID: command.ThreadID, Context: command.ContextThread},
	} {
		reg := command.NewRegistry()
		err := reg.Register(command.Command{Name: "x.y", Title: "X", Category: "X", Args: []command.ArgSpec{spec},
			Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
				return command.Result{}, nil
			}})
		if !errors.Is(err, command.ErrInvalidCommand) {
			t.Errorf("Register(%+v) = %v, want ErrInvalidCommand", spec, err)
		}
	}
}
