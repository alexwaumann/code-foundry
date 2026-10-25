package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// A caller that gives up on an Invoke ends the command: the GUI aborts a page's call when
// the page cancels it or its frame goes, and thread.wait and action.wait (which can block
// for hours) stop with it (docs/notes/bridge-fix-floor.md).
func TestInvokeCancelReachesTheCommand(t *testing.T) {
	started, ended := make(chan struct{}), make(chan error, 1)
	r := command.NewRegistry()
	if err := r.Register(command.Command{
		Name: "fake.wait", Title: "Wait", Category: "Fake", ReadOnly: true,
		Run: func(ctx context.Context, _ command.Context, _ command.Args) (command.Result, error) {
			close(started)
			<-ctx.Done()
			ended <- ctx.Err()
			return command.Result{}, ctx.Err()
		},
	}); err != nil {
		t.Fatal(err)
	}
	route := NewCommand(r).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := codefoundryv1connect.NewCommandServiceClient(srv.Client(), srv.URL)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := client.Invoke(ctx, connect.NewRequest(&v1.InvokeCommandRequest{Name: "fake.wait"}))
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the command never started")
	}
	cancel()
	select {
	case err := <-ended:
		if err == nil {
			t.Error("the command's context ended without an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelling the call did not reach the command")
	}
	if err := <-done; connect.CodeOf(err) != connect.CodeCanceled {
		t.Errorf("client error = %v, want canceled", err)
	}
}
