package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/store/session"
	"github.com/awaumann/code-foundry/internal/store/session/sessiontest"
)

func newSessionServer(t *testing.T) (*sessiontest.Fake, codefoundryv1connect.SessionServiceClient) {
	t.Helper()
	b := bus.New()
	fake := sessiontest.New(b)
	route := NewSession(fake, b).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewSessionServiceClient(srv.Client(), srv.URL)
}

func TestSessionUnaryAndErrorCodes(t *testing.T) {
	fake, c := newSessionServer(t)
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateSessionRequest{RepoId: "r1", WorktreePath: "/w", Model: "opus", Effort: "high", Name: "n"}))
	if err != nil {
		t.Fatal(err)
	}
	s := res.Msg.GetSession()
	if s.GetId() != "s-1" || s.GetWorktreePath() != "/w" || s.GetModel() != "opus" || s.GetEffort() != "high" ||
		s.GetState() != v1.SessionState_SESSION_STATE_STARTING || s.GetCreatedAt() == nil || s.GetName() != "n" {
		t.Fatalf("Create = %v", s)
	}
	if calls := fake.Calls(); len(calls) != 1 || calls[0] != "Create r1 /w opus high" {
		t.Errorf("calls = %q", calls)
	}
	if _, err := c.Reconnect(ctx, connect.NewRequest(&v1.ReconnectSessionRequest{Id: "s-1"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("Reconnect while starting: %v", err)
	}
	if _, err := c.Close(ctx, connect.NewRequest(&v1.CloseSessionRequest{Id: "s-1"})); err != nil {
		t.Fatal(err)
	}
	got, err := c.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: "s-1"}))
	if err != nil || got.Msg.GetSession().GetState() != v1.SessionState_SESSION_STATE_DISCONNECTED || got.Msg.GetSession().GetDisconnectReason() != "closed" {
		t.Fatalf("Get after close = %v, %v", got, err)
	}
	if _, err := c.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Get unknown: %v", err)
	}
	if _, err := c.Rename(ctx, connect.NewRequest(&v1.RenameSessionRequest{Id: "s-1", Name: " "})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("Rename empty: %v", err)
	}
	list, err := c.List(ctx, connect.NewRequest(&v1.ListSessionsRequest{}))
	if err != nil || len(list.Msg.GetSessions()) != 1 {
		t.Fatalf("List = %v, %v", list, err)
	}
	fake.Put(session.Session{ID: "s-9", Status: session.StatusNeedsAttention, StatusReason: "finished", State: session.StateConnected, CreatedAt: time.Unix(9, 0)})
	got, _ = c.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: "s-9"}))
	if got.Msg.GetSession().GetStatus() != v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION ||
		got.Msg.GetSession().GetState() != v1.SessionState_SESSION_STATE_CONNECTED ||
		got.Msg.GetSession().GetStatusReason() != "finished" {
		t.Errorf("enum mapping = %v", got.Msg.GetSession())
	}
}

func TestSessionWatchSendsSnapshotThenEvents(t *testing.T) {
	fake, c := newSessionServer(t)
	fake.Put(session.Session{ID: "s-a", Name: "a", CreatedAt: time.Unix(1, 0)})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchSessionsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatal(stream.Err())
	}
	snap := stream.Msg().GetSnapshot()
	if snap == nil || len(snap.GetSessions()) != 1 || snap.GetSessions()[0].GetId() != "s-a" {
		t.Fatalf("first event = %v", stream.Msg())
	}
	fake.Put(session.Session{ID: "s-a", Name: "renamed", CreatedAt: time.Unix(1, 0)})
	if !stream.Receive() || stream.Msg().GetUpdated().GetName() != "renamed" {
		t.Fatalf("second event = %v (%v)", stream.Msg(), stream.Err())
	}
	if err := fake.Remove(ctx, "s-a"); err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || stream.Msg().GetRemovedId() != "s-a" {
		t.Fatalf("third event = %v (%v)", stream.Msg(), stream.Err())
	}
}
