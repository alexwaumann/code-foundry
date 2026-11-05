package api

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadUnaryAndErrorCodes(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/w", Model: "opus", Effort: "high", Name: "n"}))
	if err != nil {
		t.Fatal(err)
	}
	s := res.Msg.GetThread()
	if s.GetId() != "s-1" || s.GetWorktreePath() != "/w" || s.GetModel() != "opus" || s.GetEffort() != "high" ||
		s.GetState() != v1.ThreadState_THREAD_STATE_STARTING || s.GetCreatedAt() == nil || s.GetName() != "n" {
		t.Fatalf("Create = %v", s)
	}
	if calls := fake.Calls(); len(calls) != 1 || calls[0] != "Create r1 /w opus high" {
		t.Errorf("calls = %q", calls)
	}
	if _, err := c.Reconnect(ctx, connect.NewRequest(&v1.ReconnectThreadRequest{Id: "s-1"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("Reconnect while starting: %v", err)
	}
	if _, err := c.Close(ctx, connect.NewRequest(&v1.CloseThreadRequest{Id: "s-1"})); err != nil {
		t.Fatal(err)
	}
	got, err := c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "s-1"}))
	if err != nil || got.Msg.GetThread().GetState() != v1.ThreadState_THREAD_STATE_DISCONNECTED || got.Msg.GetThread().GetDisconnectReason() != "closed" {
		t.Fatalf("Get after close = %v, %v", got, err)
	}
	if _, err := c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Get unknown: %v", err)
	}
	if _, err := c.Rename(ctx, connect.NewRequest(&v1.RenameThreadRequest{Id: "s-1", Name: " "})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("Rename empty: %v", err)
	}
	pinned, err := c.Pin(ctx, connect.NewRequest(&v1.PinThreadRequest{Id: "s-1", Pinned: true}))
	if err != nil || !pinned.Msg.GetThread().GetPinned() {
		t.Fatalf("Pin = %v, %v", pinned, err)
	}
	if _, err := c.Pin(ctx, connect.NewRequest(&v1.PinThreadRequest{Id: "nope", Pinned: true})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Pin unknown: %v", err)
	}
	archived, err := c.Archive(ctx, connect.NewRequest(&v1.ArchiveThreadRequest{Id: "s-1", Archived: true}))
	if a := archived.Msg.GetThread(); err != nil || a.GetArchivedAt() == nil || a.GetPinned() {
		t.Fatalf("Archive = %v, %v; want archived_at set, unpinned", archived, err)
	}
	unarchived, err := c.Archive(ctx, connect.NewRequest(&v1.ArchiveThreadRequest{Id: "s-1"}))
	if err != nil || unarchived.Msg.GetThread().GetArchivedAt() != nil {
		t.Fatalf("Unarchive = %v, %v; want archived_at unset", unarchived, err)
	}
	if _, err := c.Archive(ctx, connect.NewRequest(&v1.ArchiveThreadRequest{Id: "nope", Archived: true})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Archive unknown: %v", err)
	}
	list, err := c.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{}))
	if err != nil || len(list.Msg.GetThreads()) != 1 {
		t.Fatalf("List = %v, %v", list, err)
	}
	fake.Put(thread.Thread{ID: "s-9", Status: thread.StatusNeedsAttention, StatusReason: "finished", State: thread.StateConnected, CreatedAt: time.Unix(9, 0)})
	got, _ = c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "s-9"}))
	if got.Msg.GetThread().GetStatus() != v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION ||
		got.Msg.GetThread().GetState() != v1.ThreadState_THREAD_STATE_CONNECTED ||
		got.Msg.GetThread().GetStatusReason() != "finished" {
		t.Errorf("enum mapping = %v", got.Msg.GetThread())
	}
	if got.Msg.GetThread().GetStatusChangedAt() != nil {
		t.Errorf("zero StatusChangedAt mapped to %v", got.Msg.GetThread().GetStatusChangedAt())
	}
	changed := time.Date(2026, 10, 10, 9, 30, 0, 0, time.UTC)
	fake.Put(thread.Thread{ID: "s-11", Status: thread.StatusError, StatusReason: thread.ReasonInterrupted,
		StatusChangedAt: changed, State: thread.StateDisconnected})
	got, _ = c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "s-11"}))
	if p := got.Msg.GetThread(); p.GetStatus() != v1.ThreadStatus_THREAD_STATUS_ERROR || p.GetStatusReason() != "interrupted" ||
		!p.GetStatusChangedAt().AsTime().Equal(changed) {
		t.Errorf("error status mapping = %v", p)
	}
	linkedAt := time.Date(2026, 10, 9, 18, 24, 11, 0, time.UTC)
	fake.Put(thread.Thread{ID: "s-10", State: thread.StateDisconnected, LinkedPullRequests: []thread.LinkedPullRequest{
		{Slug: "o/r", Number: 5, URL: "https://github.com/o/r/pull/5", LinkedAt: linkedAt},
		{Slug: "o/r", Number: 6, URL: "https://github.com/o/r/pull/6"},
	}})
	got, _ = c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "s-10"}))
	links := got.Msg.GetThread().GetLinkedPullRequests()
	if len(links) != 2 || links[0].GetSlug() != "o/r" || links[0].GetNumber() != 5 || links[0].GetUrl() != "https://github.com/o/r/pull/5" ||
		!links[0].GetLinkedAt().AsTime().Equal(linkedAt) || links[1].GetNumber() != 6 || links[1].GetLinkedAt() != nil {
		t.Errorf("linked pull requests = %v", links)
	}
}

func TestThreadCreateNewThreadFields(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{
		ProjectId: "r1", InitialPrompt: "fix it", ComposerPrompt: "fix [it](cf-file://r1/it)", PermissionMode: v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS,
		NewWorktree: &v1.NewWorktree{BaseRef: "origin/dev"}, Attachments: []string{"/a/1.png", "/a/2.png"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	s := res.Msg.GetThread()
	if s.GetPermissionMode() != v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS || !s.GetCreatedWorktree() ||
		s.GetBaseRef() != "origin/dev" || s.GetWorktreePath() != "/worktrees/cf-1" {
		t.Fatalf("Create = %v", s)
	}
	want := "Create r1    perm=2 new-worktree=origin/dev prompt=fix it composer=fix [it](cf-file://r1/it) attachments=/a/1.png,/a/2.png"
	if calls := fake.Calls(); len(calls) != 1 || calls[0] != want {
		t.Errorf("calls = %q, want %q", calls, want)
	}
	// Without new_worktree nothing is created.
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{ProjectId: "r1"})); err != nil {
		t.Fatal(err)
	}
	if calls := fake.Calls(); calls[1] != "Create r1   " {
		t.Errorf("calls = %q", calls)
	}
}

func TestThreadCreateWorkspaceFields(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{WorkspaceId: "login", ProjectId: "api"}))
	if err != nil || res.Msg.GetThread().GetWorkspaceId() != "login" {
		t.Fatalf("Create in workspace = %v, %v", res, err)
	}
	res, err = c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{
		ProjectId: "api", ProjectIds: []string{"web", "api"}, LikeThreadId: "s-0", NewBranch: true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetThread(); !slices.Equal(s.GetProjectIds(), []string{"api", "web"}) {
		t.Errorf("Create with projects = %v", s)
	}
	want := []string{"Create api    workspace=login", "Create api    projects=web,api like=s-0 new-branch"}
	if calls := fake.Calls(); !slices.Equal(calls, want) {
		t.Errorf("calls = %q, want %q", calls, want)
	}
}

func TestThreadCreateNoProject(t *testing.T) {
	fake, c := newThreadServer(t)
	res, err := c.Create(context.Background(), connect.NewRequest(&v1.CreateThreadRequest{NoProject: true, Model: "haiku"}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetThread(); s.GetProjectId() != "" || s.GetWorkspaceId() != "" || s.GetWorktreePath() != "/home" {
		t.Errorf("Create without a project = %v", s)
	}
	if want := []string{"Create   haiku  no-project"}; !slices.Equal(fake.Calls(), want) {
		t.Errorf("calls = %q, want %q", fake.Calls(), want)
	}
}

func TestThreadRunIn(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-1", WorkspaceID: "w-1", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: "/wt/web", State: thread.StateConnected})
	fake.Put(thread.Thread{ID: "s-2", WorktreePath: "/src/app", State: thread.StateConnected})
	res, err := c.RunIn(ctx, connect.NewRequest(&v1.RunInThreadRequest{Id: "s-1", ProjectId: "api"}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetThread(); s.GetPendingWorktreePath() != "/worktrees/api" || s.GetWorktreePath() != "/wt/web" || s.GetWorkspaceId() != "w-1" {
		t.Errorf("RunIn = %v", s)
	}
	if _, err := c.RunIn(ctx, connect.NewRequest(&v1.RunInThreadRequest{Id: "s-2", ProjectId: "api"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("RunIn on a thread without a project = %v", err)
	}
}

// Move maps the placement fields onto MoveOptions (thread new's names), answers the
// moved thread, refuses a thread with a project as FAILED_PRECONDITION, and a thread's
// pending move reaches the proto.
func TestThreadMove(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-1", WorktreePath: "/home", State: thread.StateDisconnected})
	fake.Put(thread.Thread{ID: "s-2", ProjectID: "web", WorktreePath: "/src/web", State: thread.StateConnected})
	res, err := c.Move(ctx, connect.NewRequest(&v1.MoveThreadRequest{Id: "s-1", ProjectId: "web", NewWorktree: &v1.NewWorktree{BaseRef: "develop", Branch: "feat/x"}}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetThread(); s.GetProjectId() != "web" || s.GetBranch() != "feat/x" || s.GetWorktreePath() != "/worktrees/feat-x" || s.GetPendingMove() != nil {
		t.Errorf("Move = %v", s)
	}
	if _, err := c.Move(ctx, connect.NewRequest(&v1.MoveThreadRequest{Id: "s-2", WorkspaceId: "plat", CheckoutMode: true})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("Move of a project's thread = %v", err)
	}
	if want := []string{"Move s-1 web   new-worktree=develop branch=feat/x", "Move s-2  plat  checkout"}; !slices.Equal(fake.Calls(), want) {
		t.Errorf("calls = %q, want %q", fake.Calls(), want)
	}
	moving := threadToProto(thread.Thread{ID: "s-3", PendingMove: &thread.MoveTarget{ProjectID: "web", Path: "/wt/x", Branch: "fix/y"}})
	if m := moving.GetPendingMove(); m.GetProjectId() != "web" || m.GetWorktreePath() != "/wt/x" || m.GetBranch() != "fix/y" || m.GetWorkspaceId() != "" {
		t.Errorf("pending move = %v", m)
	}
}

func TestThreadStageAttachment(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	res, err := c.StageAttachment(ctx, connect.NewRequest(&v1.StageAttachmentRequest{Name: "shot.png", MimeType: "image/png", Data: []byte("abc")}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetPath() != "/attachments/1-shot.png" {
		t.Errorf("path = %q", res.Msg.GetPath())
	}
	// A PDF's page hint reaches the store.
	if _, err := c.StageAttachment(ctx, connect.NewRequest(&v1.StageAttachmentRequest{Name: "doc.pdf", MimeType: "application/pdf", Data: []byte("abcd"), Pages: 12})); err != nil {
		t.Fatal(err)
	}
	if calls := fake.Calls(); len(calls) != 2 || calls[0] != "StageAttachment shot.png image/png 3" || calls[1] != "StageAttachment doc.pdf application/pdf 4 pages=12" {
		t.Errorf("calls = %q", calls)
	}
	fake.Err = fmt.Errorf("%w: attachment type", thread.ErrInvalidArgument)
	if _, err := c.StageAttachment(ctx, connect.NewRequest(&v1.StageAttachmentRequest{MimeType: "text/plain"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("rejected attachment: %v", err)
	}
}

// TestThreadStageAttachmentPath: a path goes to StageAttachmentFile with the declared
// type and the hint, data and path together are refused, and store errors keep their
// codes.
func TestThreadStageAttachmentPath(t *testing.T) {
	tests := []struct {
		name     string
		req      *v1.StageAttachmentRequest
		storeErr error
		wantCode connect.Code // 0: success
		wantCall string
		wantPath string
	}{
		{name: "path", req: &v1.StageAttachmentRequest{Path: "/Users/me/Desktop/shot.png"}, wantCall: "StageAttachmentFile /Users/me/Desktop/shot.png ", wantPath: "/attachments/1-shot.png"},
		{name: "path with type and hint", req: &v1.StageAttachmentRequest{Path: "/tmp/doc.pdf", MimeType: "application/pdf", Pages: 3}, wantCall: "StageAttachmentFile /tmp/doc.pdf application/pdf pages=3", wantPath: "/attachments/1-doc.pdf"},
		{name: "data and path", req: &v1.StageAttachmentRequest{Path: "/tmp/a.png", Data: []byte("abc")}, wantCode: connect.CodeInvalidArgument},
		{name: "missing", req: &v1.StageAttachmentRequest{Path: "/tmp/gone.png"}, storeErr: fmt.Errorf("%w: attachment does not exist", thread.ErrNotFound), wantCode: connect.CodeNotFound},
		{name: "unsupported", req: &v1.StageAttachmentRequest{Path: "/tmp/a.txt"}, storeErr: fmt.Errorf("%w: attachment type", thread.ErrInvalidArgument), wantCode: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newThreadServer(t)
			fake.Err = tt.storeErr
			res, err := c.StageAttachment(context.Background(), connect.NewRequest(tt.req))
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want %v", err, tt.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Msg.GetPath() != tt.wantPath {
				t.Errorf("path = %q, want %q", res.Msg.GetPath(), tt.wantPath)
			}
			if calls := fake.Calls(); len(calls) != 1 || calls[0] != tt.wantCall {
				t.Errorf("calls = %q, want %q", calls, tt.wantCall)
			}
		})
	}
}

func TestThreadReadAttachment(t *testing.T) {
	fake, c := newThreadServer(t)
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

func TestThreadWatchSendsSnapshotThenEvents(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s-a", Name: "a", CreatedAt: time.Unix(1, 0)})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchThreadsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() {
		t.Fatal(stream.Err())
	}
	snap := stream.Msg().GetSnapshot()
	if snap == nil || len(snap.GetThreads()) != 1 || snap.GetThreads()[0].GetId() != "s-a" {
		t.Fatalf("first event = %v", stream.Msg())
	}
	fake.Put(thread.Thread{ID: "s-a", Name: "renamed", CreatedAt: time.Unix(1, 0)})
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

// A request is a thread's own put-away only when by_thread_id is the thread: the store
// then decides whether it waits for the turn's end.
func TestThreadPutAwaySelf(t *testing.T) {
	until := timestamppb.New(time.Now().Add(time.Hour))
	archive := func(c codefoundryv1connect.ThreadServiceClient, by string, archived bool) (bool, error) {
		res, err := c.Archive(context.Background(), connect.NewRequest(&v1.ArchiveThreadRequest{Id: "s-1", Archived: archived, ByThreadId: by}))
		if err != nil {
			return false, err
		}
		return res.Msg.GetDeferred(), nil
	}
	snooze := func(r *v1.SnoozeThreadRequest) func(codefoundryv1connect.ThreadServiceClient, string, bool) (bool, error) {
		return func(c codefoundryv1connect.ThreadServiceClient, by string, _ bool) (bool, error) {
			req := proto.CloneOf(r)
			req.Id, req.ByThreadId = "s-1", by
			res, err := c.Snooze(context.Background(), connect.NewRequest(req))
			if err != nil {
				return false, err
			}
			return res.Msg.GetDeferred(), nil
		}
	}
	tests := []struct {
		name         string
		do           func(codefoundryv1connect.ThreadServiceClient, string, bool) (bool, error)
		archived     bool
		by           string
		status       thread.Status
		wantCall     string
		wantDeferred bool
	}{
		{name: "archive, by itself, mid-turn", do: archive, archived: true, by: "s-1", status: thread.StatusBusy, wantCall: "PutAwaySelf s-1 archive", wantDeferred: true},
		{name: "archive, by itself, at the prompt", do: archive, archived: true, by: "s-1", status: thread.StatusIdle, wantCall: "PutAwaySelf s-1 archive"},
		{name: "archive, by another thread", do: archive, archived: true, by: "s-2", status: thread.StatusBusy, wantCall: "Archive s-1 true"},
		{name: "archive, by the user", do: archive, archived: true, status: thread.StatusBusy, wantCall: "Archive s-1 true"},
		{name: "unarchive, by itself", do: archive, by: "s-1", status: thread.StatusBusy, wantCall: "Archive s-1 false"},
		{name: "snooze, by itself, mid-turn", do: snooze(&v1.SnoozeThreadRequest{Until: until}), by: "s-1", status: thread.StatusBusy, wantCall: "PutAwaySelf s-1 snooze", wantDeferred: true},
		{name: "snooze, by the user", do: snooze(&v1.SnoozeThreadRequest{Until: until}), status: thread.StatusBusy, wantCall: "Snooze s-1 "},
		{name: "save, by itself, mid-turn", do: snooze(&v1.SnoozeThreadRequest{Save: true}), by: "s-1", status: thread.StatusBusy, wantCall: "PutAwaySelf s-1 save", wantDeferred: true},
		{name: "save, by the user", do: snooze(&v1.SnoozeThreadRequest{Save: true}), status: thread.StatusBusy, wantCall: "SaveForLater s-1"},
		{name: "unsnooze, by itself", do: snooze(&v1.SnoozeThreadRequest{}), by: "s-1", status: thread.StatusBusy, wantCall: "Snooze s-1 -"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newThreadServer(t)
			fake.Put(thread.Thread{ID: "s-1", Status: tt.status})
			deferred, err := tt.do(c, tt.by, tt.archived)
			if err != nil {
				t.Fatal(err)
			}
			if deferred != tt.wantDeferred {
				t.Errorf("deferred = %v, want %v", deferred, tt.wantDeferred)
			}
			if calls := fake.Calls(); len(calls) == 0 || !strings.HasPrefix(calls[0], tt.wantCall) {
				t.Errorf("calls = %v, want first %q", calls, tt.wantCall)
			}
		})
	}
}

// An empty id is not "the thread itself" for an empty by_thread_id.
func TestThreadArchiveEmptyIDIsNotSelf(t *testing.T) {
	fake, c := newThreadServer(t)
	_, _ = c.Archive(context.Background(), connect.NewRequest(&v1.ArchiveThreadRequest{Archived: true}))
	if calls := fake.Calls(); len(calls) != 1 || strings.HasPrefix(calls[0], "PutAwaySelf") {
		t.Errorf("calls = %v, want the plain archive", calls)
	}
}

func TestThreadSnoozeSave(t *testing.T) {
	now := time.Date(2026, 10, 14, 15, 4, 5, 0, time.UTC)
	tests := []struct {
		name     string
		id       string
		until    *timestamppb.Timestamp
		wantCode connect.Code
		wantCall string // "" when the store is not called
	}{
		{name: "save has no wake time", id: "s-1", wantCall: "SaveForLater s-1"},
		{name: "save with until is invalid", id: "s-1", until: timestamppb.New(now.Add(time.Hour)), wantCode: connect.CodeInvalidArgument},
		{name: "unknown thread", id: "nope", wantCode: connect.CodeNotFound, wantCall: "SaveForLater nope"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newThreadServer(t)
			fake.Now = func() time.Time { return now }
			fake.Put(thread.Thread{ID: "s-1", State: thread.StateConnected, Pinned: true, ArchivedAt: now.Add(-time.Hour),
				SnoozedUntil: now.Add(time.Hour), CreatedAt: now})
			res, err := c.Snooze(context.Background(), connect.NewRequest(&v1.SnoozeThreadRequest{Id: tt.id, Until: tt.until, Save: true}))
			if connect.CodeOf(err) != tt.wantCode && (tt.wantCode != 0 || err != nil) {
				t.Fatalf("Snooze = %v, want code %v", err, tt.wantCode)
			}
			if tt.wantCall == "" && slices.ContainsFunc(fake.Calls(), func(c string) bool { return strings.HasPrefix(c, "SaveForLater") }) {
				t.Errorf("calls = %v, want no save", fake.Calls())
			}
			if tt.wantCall != "" && !slices.Contains(fake.Calls(), tt.wantCall) {
				t.Errorf("calls = %v, want %q", fake.Calls(), tt.wantCall)
			}
			if tt.wantCode != 0 || err != nil {
				return
			}
			s := res.Msg.GetThread()
			if !s.GetSavedAt().AsTime().Equal(now) || s.GetSnoozedUntil() != nil || s.GetArchivedAt() != nil || s.GetPinned() ||
				s.GetState() != v1.ThreadState_THREAD_STATE_DISCONNECTED {
				t.Errorf("saved = %v; want saved_at %v, no snoozed_until, not archived, unpinned, disconnected", s, now)
			}
		})
	}
}

func TestThreadSnooze(t *testing.T) {
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
			fake, c := newThreadServer(t)
			fake.Now = func() time.Time { return now }
			fake.Put(thread.Thread{ID: "s-1", State: thread.StateConnected, Pinned: true, ArchivedAt: now.Add(-time.Hour),
				SnoozedUntil: now.Add(time.Hour), CreatedAt: now})
			res, err := c.Snooze(context.Background(), connect.NewRequest(&v1.SnoozeThreadRequest{Id: tt.id, Until: tt.until}))
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
			s := res.Msg.GetThread()
			if tt.wantUntil.IsZero() {
				if s.GetSnoozedUntil() != nil {
					t.Errorf("snoozed_until = %v, want unset", s.GetSnoozedUntil())
				}
				return
			}
			if !s.GetSnoozedUntil().AsTime().Equal(tt.wantUntil) || s.GetArchivedAt() != nil || s.GetPinned() ||
				s.GetState() != v1.ThreadState_THREAD_STATE_DISCONNECTED {
				t.Errorf("snoozed = %v; want snoozed_until %v, not archived, unpinned, disconnected", s, tt.wantUntil)
			}
		})
	}
}

// A background setup that runs in a checkout has its place at once, so its hints go out as a
// blocking create's do; one that makes worktrees has none yet.
func TestCreateHintsOfABackgroundSetup(t *testing.T) {
	for _, tt := range []struct {
		name       string
		background bool
		path       string
		want       int
	}{
		{"blocking", false, "/w", 1},
		{"background in a checkout", true, "/w", 1},
		{"background making worktrees", true, "", 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newThreadServer(t)
			fake.SetHints("r1 @ main is also open in other")
			res, err := c.Create(context.Background(), connect.NewRequest(&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: tt.path, BackgroundSetup: tt.background}))
			if err != nil {
				t.Fatal(err)
			}
			if got := len(res.Msg.GetHints()); got != tt.want {
				t.Errorf("hints = %v, want %d", res.Msg.GetHints(), tt.want)
			}
		})
	}
}
