package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func newSessionServer(t *testing.T) (*threadtest.Fake, codefoundryv1connect.SessionServiceClient) {
	t.Helper()
	b := bus.New()
	fake := threadtest.New(b)
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
	pinned, err := c.Pin(ctx, connect.NewRequest(&v1.PinSessionRequest{Id: "s-1", Pinned: true}))
	if err != nil || !pinned.Msg.GetSession().GetPinned() {
		t.Fatalf("Pin = %v, %v", pinned, err)
	}
	if _, err := c.Pin(ctx, connect.NewRequest(&v1.PinSessionRequest{Id: "nope", Pinned: true})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Pin unknown: %v", err)
	}
	archived, err := c.Archive(ctx, connect.NewRequest(&v1.ArchiveSessionRequest{Id: "s-1", Archived: true}))
	if a := archived.Msg.GetSession(); err != nil || a.GetArchivedAt() == nil || a.GetPinned() {
		t.Fatalf("Archive = %v, %v; want archived_at set, unpinned", archived, err)
	}
	unarchived, err := c.Archive(ctx, connect.NewRequest(&v1.ArchiveSessionRequest{Id: "s-1"}))
	if err != nil || unarchived.Msg.GetSession().GetArchivedAt() != nil {
		t.Fatalf("Unarchive = %v, %v; want archived_at unset", unarchived, err)
	}
	if _, err := c.Archive(ctx, connect.NewRequest(&v1.ArchiveSessionRequest{Id: "nope", Archived: true})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Archive unknown: %v", err)
	}
	list, err := c.List(ctx, connect.NewRequest(&v1.ListSessionsRequest{}))
	if err != nil || len(list.Msg.GetSessions()) != 1 {
		t.Fatalf("List = %v, %v", list, err)
	}
	fake.Put(thread.Session{ID: "s-9", Status: thread.StatusNeedsAttention, StatusReason: "finished", State: thread.StateConnected, CreatedAt: time.Unix(9, 0)})
	got, _ = c.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: "s-9"}))
	if got.Msg.GetSession().GetStatus() != v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION ||
		got.Msg.GetSession().GetState() != v1.SessionState_SESSION_STATE_CONNECTED ||
		got.Msg.GetSession().GetStatusReason() != "finished" {
		t.Errorf("enum mapping = %v", got.Msg.GetSession())
	}
	if got.Msg.GetSession().GetStatusChangedAt() != nil {
		t.Errorf("zero StatusChangedAt mapped to %v", got.Msg.GetSession().GetStatusChangedAt())
	}
	changed := time.Date(2026, 10, 10, 9, 30, 0, 0, time.UTC)
	fake.Put(thread.Session{ID: "s-11", Status: thread.StatusError, StatusReason: thread.ReasonInterrupted,
		StatusChangedAt: changed, State: thread.StateDisconnected})
	got, _ = c.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: "s-11"}))
	if p := got.Msg.GetSession(); p.GetStatus() != v1.SessionStatus_SESSION_STATUS_ERROR || p.GetStatusReason() != "interrupted" ||
		!p.GetStatusChangedAt().AsTime().Equal(changed) {
		t.Errorf("error status mapping = %v", p)
	}
	linkedAt := time.Date(2026, 10, 9, 18, 24, 11, 0, time.UTC)
	fake.Put(thread.Session{ID: "s-10", State: thread.StateDisconnected, LinkedPullRequests: []thread.LinkedPullRequest{
		{Slug: "o/r", Number: 5, URL: "https://github.com/o/r/pull/5", LinkedAt: linkedAt},
		{Slug: "o/r", Number: 6, URL: "https://github.com/o/r/pull/6"},
	}})
	got, _ = c.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: "s-10"}))
	links := got.Msg.GetSession().GetLinkedPullRequests()
	if len(links) != 2 || links[0].GetSlug() != "o/r" || links[0].GetNumber() != 5 || links[0].GetUrl() != "https://github.com/o/r/pull/5" ||
		!links[0].GetLinkedAt().AsTime().Equal(linkedAt) || links[1].GetNumber() != 6 || links[1].GetLinkedAt() != nil {
		t.Errorf("linked pull requests = %v", links)
	}
}

func TestSessionCreateNewThreadFields(t *testing.T) {
	fake, c := newSessionServer(t)
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateSessionRequest{
		RepoId: "r1", InitialPrompt: "fix it", ComposerPrompt: "fix [it](cf-file://r1/it)", PermissionMode: v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS,
		NewWorktree: &v1.NewWorktree{BaseRef: "origin/dev"}, Attachments: []string{"/a/1.png", "/a/2.png"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	s := res.Msg.GetSession()
	if s.GetPermissionMode() != v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS || !s.GetCreatedWorktree() ||
		s.GetBaseRef() != "origin/dev" || s.GetWorktreePath() != "/worktrees/cf-1" {
		t.Fatalf("Create = %v", s)
	}
	want := "Create r1    perm=2 new-worktree=origin/dev prompt=fix it composer=fix [it](cf-file://r1/it) attachments=/a/1.png,/a/2.png"
	if calls := fake.Calls(); len(calls) != 1 || calls[0] != want {
		t.Errorf("calls = %q, want %q", calls, want)
	}
	// Without new_worktree nothing is created.
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateSessionRequest{RepoId: "r1"})); err != nil {
		t.Fatal(err)
	}
	if calls := fake.Calls(); calls[1] != "Create r1   " {
		t.Errorf("calls = %q", calls)
	}
}

func TestSessionCreateWorkspaceFields(t *testing.T) {
	fake, c := newSessionServer(t)
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateSessionRequest{WorkspaceId: "login", RepoId: "api"}))
	if err != nil || res.Msg.GetSession().GetWorkspaceId() != "login" {
		t.Fatalf("Create in workspace = %v, %v", res, err)
	}
	res, err = c.Create(ctx, connect.NewRequest(&v1.CreateSessionRequest{
		RepoId: "api", NewWorkspace: &v1.NewWorkspace{Repos: []string{"web", "api"}, BaseRef: "origin/dev", Name: "login"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetSession(); s.GetWorkspaceId() != "w-new" || s.GetWorktreePath() != "/worktrees/api" || !s.GetCreatedWorktree() {
		t.Errorf("Create new workspace = %v", s)
	}
	want := []string{"Create api    workspace=login", "Create api    new-workspace=web,api"}
	if calls := fake.Calls(); !slices.Equal(calls, want) {
		t.Errorf("calls = %q, want %q", calls, want)
	}
}

func TestSessionCreateNoProject(t *testing.T) {
	fake, c := newSessionServer(t)
	res, err := c.Create(context.Background(), connect.NewRequest(&v1.CreateSessionRequest{NoProject: true, Model: "haiku"}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetSession(); s.GetRepoId() != "" || s.GetWorkspaceId() != "" || s.GetWorktreePath() != "/home" {
		t.Errorf("Create without a project = %v", s)
	}
	if want := []string{"Create   haiku  no-project"}; !slices.Equal(fake.Calls(), want) {
		t.Errorf("calls = %q, want %q", fake.Calls(), want)
	}
}

func TestSessionRunIn(t *testing.T) {
	fake, c := newSessionServer(t)
	ctx := context.Background()
	fake.Put(thread.Session{ID: "s-1", WorkspaceID: "w-1", WorktreePath: "/wt/web", State: thread.StateConnected})
	fake.Put(thread.Session{ID: "s-2", WorktreePath: "/src/app", State: thread.StateConnected})
	res, err := c.RunIn(ctx, connect.NewRequest(&v1.RunInSessionRequest{Id: "s-1", RepoId: "api"}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetSession(); s.GetPendingWorktreePath() != "/worktrees/api" || s.GetWorktreePath() != "/wt/web" || s.GetWorkspaceId() != "w-1" {
		t.Errorf("RunIn = %v", s)
	}
	if _, err := c.RunIn(ctx, connect.NewRequest(&v1.RunInSessionRequest{Id: "s-2", RepoId: "api"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("RunIn on a project thread = %v", err)
	}
}

func TestSessionStageAttachment(t *testing.T) {
	fake, c := newSessionServer(t)
	ctx := context.Background()
	res, err := c.StageAttachment(ctx, connect.NewRequest(&v1.StageAttachmentRequest{Name: "shot.png", MimeType: "image/png", Data: []byte("abc")}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetPath() != "/attachments/1-shot.png" {
		t.Errorf("path = %q", res.Msg.GetPath())
	}
	if calls := fake.Calls(); len(calls) != 1 || calls[0] != "StageAttachment shot.png image/png 3" {
		t.Errorf("calls = %q", calls)
	}
	fake.Err = fmt.Errorf("%w: attachment type", thread.ErrInvalidArgument)
	if _, err := c.StageAttachment(ctx, connect.NewRequest(&v1.StageAttachmentRequest{MimeType: "text/plain"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("rejected attachment: %v", err)
	}
}

func TestSessionReadAttachment(t *testing.T) {
	fake, c := newSessionServer(t)
	res, err := c.ReadAttachment(context.Background(), connect.NewRequest(&v1.ReadAttachmentRequest{Path: "/attachments/1-shot.png"}))
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Msg.GetData()) != "data:/attachments/1-shot.png" || res.Msg.GetMimeType() != "image/png" {
		t.Errorf("= %q %q", res.Msg.GetData(), res.Msg.GetMimeType())
	}
	if calls := fake.Calls(); len(calls) != 1 || calls[0] != "ReadAttachment /attachments/1-shot.png" {
		t.Errorf("calls = %q", calls)
	}
}

func TestSessionWatchSendsSnapshotThenEvents(t *testing.T) {
	fake, c := newSessionServer(t)
	fake.Put(thread.Session{ID: "s-a", Name: "a", CreatedAt: time.Unix(1, 0)})
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
	fake.Put(thread.Session{ID: "s-a", Name: "renamed", CreatedAt: time.Unix(1, 0)})
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

func TestSessionSnooze(t *testing.T) {
	now := time.Date(2026, 10, 14, 15, 4, 5, 0, time.UTC)
	until := now.Add(90 * time.Minute)
	tests := []struct {
		name      string
		id        string
		until     *timestamppb.Timestamp
		wantCode  connect.Code
		wantUntil time.Time // zero: snoozed_until unset
		wantCall  string    // "" when the store is not called
	}{
		{name: "snooze maps the time both ways", id: "s-1", until: timestamppb.New(until),
			wantUntil: until, wantCall: "Snooze s-1 2026-10-14T16:34:05.000Z"},
		{name: "unset until unsnoozes", id: "s-1", wantCall: "Snooze s-1 -"},
		{name: "a past time is invalid", id: "s-1", until: timestamppb.New(now.Add(-time.Minute)),
			wantCode: connect.CodeInvalidArgument, wantCall: "Snooze s-1 2026-10-14T15:03:05.000Z"},
		{name: "a malformed timestamp is invalid", id: "s-1", until: &timestamppb.Timestamp{Seconds: until.Unix(), Nanos: -1},
			wantCode: connect.CodeInvalidArgument},
		{name: "unknown thread", id: "nope", until: timestamppb.New(until), wantCode: connect.CodeNotFound,
			wantCall: "Snooze nope 2026-10-14T16:34:05.000Z"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newSessionServer(t)
			fake.Now = func() time.Time { return now }
			fake.Put(thread.Session{ID: "s-1", State: thread.StateConnected, Pinned: true, ArchivedAt: now.Add(-time.Hour),
				SnoozedUntil: now.Add(time.Hour), CreatedAt: now})
			res, err := c.Snooze(context.Background(), connect.NewRequest(&v1.SnoozeSessionRequest{Id: tt.id, Until: tt.until}))
			if connect.CodeOf(err) != tt.wantCode && (tt.wantCode != 0 || err != nil) {
				t.Fatalf("Snooze = %v, want code %v", err, tt.wantCode)
			}
			var calls []string
			if tt.wantCall != "" {
				calls = []string{tt.wantCall}
			}
			if got := fake.Calls(); !slices.Equal(got, calls) {
				t.Errorf("calls = %q, want %q", got, calls)
			}
			if tt.wantCode != 0 {
				return
			}
			s := res.Msg.GetSession()
			if tt.wantUntil.IsZero() {
				if s.GetSnoozedUntil() != nil {
					t.Errorf("snoozed_until = %v, want unset", s.GetSnoozedUntil())
				}
				return
			}
			if !s.GetSnoozedUntil().AsTime().Equal(tt.wantUntil) || s.GetArchivedAt() != nil || s.GetPinned() ||
				s.GetState() != v1.SessionState_SESSION_STATE_DISCONNECTED {
				t.Errorf("snoozed = %v; want snoozed_until %v, not archived, unpinned, disconnected", s, tt.wantUntil)
			}
		})
	}
}
