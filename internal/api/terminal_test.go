package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
)

func newTerminalClient(t *testing.T) (codefoundryv1connect.TerminalServiceClient, *terminaltest.Fake) {
	t.Helper()
	fake := terminaltest.New(nil)
	mux := http.NewServeMux()
	r := NewTerminal(fake).Route()
	mux.Handle(r.Path, r.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return codefoundryv1connect.NewTerminalServiceClient(srv.Client(), srv.URL), fake
}

func TestTerminalServiceAttach(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, fake := newTerminalClient(t)

	created, err := c.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{
		Argv: []string{"/bin/zsh", "-il"}, Cols: 100, Rows: 30, Labels: map[string]string{"session": "s1"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	pt := created.Msg.GetTerminal()
	if pt.GetState() != v1.TerminalState_TERMINAL_STATE_RUNNING || pt.GetCols() != 100 ||
		pt.GetLabels()["session"] != "s1" || pt.GetStartedAt() == nil {
		t.Fatalf("Create = %v", pt)
	}
	id := pt.GetId()
	if spec, _ := fake.Spec(id); len(spec.Argv) != 2 || spec.Rows != 30 {
		t.Fatalf("store got spec %+v", spec)
	}
	_ = fake.Emit(id, []byte("prompt$ "))

	stream, err := c.Attach(ctx, connect.NewRequest(&v1.AttachRequest{Id: id}))
	if err != nil {
		t.Fatal(err)
	}
	recv := func() *v1.AttachEvent {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg()
	}
	if snap := recv().GetSnapshot(); string(snap.GetData()) != "prompt$ " || snap.GetCols() != 100 {
		t.Fatalf("snapshot = %v", snap)
	}

	if _, err := c.Write(ctx, connect.NewRequest(&v1.WriteTerminalRequest{Id: id, Data: []byte("ls\r")})); err != nil {
		t.Fatal(err)
	}
	if got := string(fake.Written(id)); got != "ls\r" {
		t.Fatalf("written = %q", got)
	}
	_ = fake.Emit(id, []byte("ls\r\n"))
	if out := recv().GetOutput(); string(out.GetData()) != "ls\r\n" {
		t.Fatalf("output = %v", out)
	}
	if _, err := c.Resize(ctx, connect.NewRequest(&v1.ResizeTerminalRequest{Id: id, Cols: 120, Rows: 40})); err != nil {
		t.Fatal(err)
	}
	if rs := recv().GetResized(); rs.GetCols() != 120 || rs.GetRows() != 40 {
		t.Fatalf("resized = %v", rs)
	}
	if _, err := c.Kill(ctx, connect.NewRequest(&v1.KillTerminalRequest{Id: id})); err != nil {
		t.Fatal(err)
	}
	if ex := recv().GetExited(); ex.GetExitCode() != 129 {
		t.Fatalf("exited = %v", ex)
	}
	got, err := c.Get(ctx, connect.NewRequest(&v1.GetTerminalRequest{Id: id}))
	if err != nil {
		t.Fatal(err)
	}
	if g := got.Msg.GetTerminal(); g.GetState() != v1.TerminalState_TERMINAL_STATE_EXITED || g.GetExitCode() != 129 || g.GetExitedAt() == nil {
		t.Fatalf("Get after kill = %v", g)
	}

	// Remove ends the attach stream cleanly.
	if _, err := c.Remove(ctx, connect.NewRequest(&v1.RemoveTerminalRequest{Id: id})); err != nil {
		t.Fatal(err)
	}
	if stream.Receive() {
		t.Fatalf("unexpected event after remove: %v", stream.Msg())
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("stream err after remove = %v, want clean end", err)
	}
}

func TestTerminalServiceErrors(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, fake := newTerminalClient(t)
	running, _ := fake.Create(ctx, terminal.Spec{Argv: []string{"cat"}})

	tests := []struct {
		name string
		call func() error
		want connect.Code
	}{
		{"get missing", func() error {
			_, err := c.Get(ctx, connect.NewRequest(&v1.GetTerminalRequest{Id: "nope"}))
			return err
		}, connect.CodeNotFound},
		{"create empty argv", func() error {
			_, err := c.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{}))
			return err
		}, connect.CodeInvalidArgument},
		{"resize out of range", func() error {
			_, err := c.Resize(ctx, connect.NewRequest(&v1.ResizeTerminalRequest{Id: running.ID, Cols: 1 << 20, Rows: 10}))
			return err
		}, connect.CodeInvalidArgument},
		{"remove running", func() error {
			_, err := c.Remove(ctx, connect.NewRequest(&v1.RemoveTerminalRequest{Id: running.ID}))
			return err
		}, connect.CodeFailedPrecondition},
		{"attach missing", func() error {
			s, err := c.Attach(ctx, connect.NewRequest(&v1.AttachRequest{Id: "nope"}))
			if err != nil {
				return err
			}
			for s.Receive() {
			}
			return s.Err()
		}, connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			var ce *connect.Error
			if !errors.As(err, &ce) || ce.Code() != tt.want {
				t.Fatalf("err = %v, want code %v", err, tt.want)
			}
		})
	}
}

func TestTerminalServiceWatchReplaysThenStreams(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, fake := newTerminalClient(t)
	existing, _ := fake.Create(ctx, terminal.Spec{Argv: []string{"sh"}})

	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchTerminalsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || stream.Msg().GetUpdated().GetId() != existing.ID {
		t.Fatalf("first watch event = %v (%v)", stream.Msg(), stream.Err())
	}
	_ = fake.SetTitle(existing.ID, "vim")
	_ = fake.Exit(existing.ID, 0)
	_ = fake.Remove(ctx, existing.ID)
	var sawTitle, sawRemove bool
	for !sawRemove && stream.Receive() {
		ev := stream.Msg()
		sawTitle = sawTitle || ev.GetUpdated().GetTitle() == "vim"
		sawRemove = ev.GetRemovedId() == existing.ID
	}
	if !sawTitle || !sawRemove {
		t.Fatalf("title=%v remove=%v err=%v", sawTitle, sawRemove, stream.Err())
	}
}
