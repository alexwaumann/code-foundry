// Package sessiontest provides an in-memory session.Store for tests of code that
// consumes sessions (API handlers, commands, the events stream). No processes are
// involved: tests drive state changes with Put.
package sessiontest

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

// Fake implements session.Store. Every mutation publishes the same events as the real
// store on its bus.
type Fake struct {
	bus *bus.Bus
	// Now is the clock used for CreatedAt.
	Now func() time.Time
	// Err, when set, is returned by every mutating method.
	Err error

	mu      sync.Mutex
	next    int
	staged  int
	byID    map[string]session.Session
	snap    *session.Snapshot
	calls   []string
	retired []session.UsageBucket
	items   map[string]*session.ItemsSnapshot
	// Watchers counts WatchItems calls whose ctx has not ended, by session.
	watchers map[string]int
	mcpErrs  map[string]string
}

var _ session.Store = (*Fake)(nil)

// New returns an empty fake publishing on b (a private bus if nil).
func New(b *bus.Bus) *Fake {
	if b == nil {
		b = bus.New()
	}
	return &Fake{bus: b, Now: time.Now, byID: map[string]session.Session{}, snap: &session.Snapshot{},
		items: map[string]*session.ItemsSnapshot{}, watchers: map[string]int{}}
}

// Bus returns the bus the fake publishes on.
func (f *Fake) Bus() *bus.Bus { return f.bus }

// Calls returns the recorded method calls, e.g. "Create /w opus high", "Close s-1".
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// Put inserts or replaces a session and publishes Updated.
func (f *Fake) Put(s session.Session) {
	f.mu.Lock()
	f.byID[s.ID] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[session.Event](f.bus, session.Updated{Session: s})
}

func (f *Fake) rebuild() {
	out := make([]session.Session, 0, len(f.byID))
	for _, s := range f.byID {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b session.Session) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	f.snap = &session.Snapshot{Sessions: out, RetiredUsage: f.retired}
}

func (f *Fake) record(call string) error {
	f.calls = append(f.calls, call)
	return f.Err
}

func (f *Fake) get(id string) (session.Session, error) {
	s, ok := f.byID[id]
	if !ok {
		return session.Session{}, fmt.Errorf("%w: %s", session.ErrNotFound, id)
	}
	return s, nil
}

// mutate applies fn to session id under the lock and publishes the result.
func (f *Fake) mutate(call, id string, fn func(*session.Session) error) (session.Session, error) {
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return session.Session{}, err
	}
	s, err := f.get(id)
	if err == nil {
		err = fn(&s)
	}
	if err != nil {
		f.mu.Unlock()
		return session.Session{}, err
	}
	f.byID[id] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[session.Event](f.bus, session.Updated{Session: s})
	return s, nil
}

func (f *Fake) add(call string, s session.Session) (session.Session, error) {
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return session.Session{}, err
	}
	f.next++
	s.ID = fmt.Sprintf("s-%d", f.next)
	if s.Render != session.RenderRendered {
		s.Render = session.RenderTerminal
		s.TerminalID = fmt.Sprintf("t-%d", f.next)
	}
	s.State = session.StateStarting
	s.CreatedAt = f.Now()
	s.LastActivityAt = s.CreatedAt
	f.byID[s.ID] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[session.Event](f.bus, session.Updated{Session: s})
	return s, nil
}

// Create records the call and adds a STARTING session ("s-N", terminal "t-N"). With
// NewWorktree the session's worktree is /worktrees/cf-<N> (CreatedWorktree, BaseRef as
// requested). WorkspaceID is copied as is. With NewWorkspace the session belongs to
// workspace "w-new" and runs in /worktrees/<repo>, repo being RepoID or the first repo.
// The call reads "Create <repo> <path> <model> <effort>", then " perm=<n>",
// " new-worktree=<base>", " workspace=<id>", " new-workspace=<a,b>", " prompt=<text>"
// " attachments=<a,b>" and " render=<mode>" when set. A rendered session (Render
// RenderRendered) gets no terminal; anything else is a terminal session.
func (f *Fake) Create(_ context.Context, o session.CreateOptions) (session.Session, error) {
	call := fmt.Sprintf("Create %s %s %s %s", o.RepoID, o.WorktreePath, o.Model, o.Effort)
	s := session.Session{
		RepoID: o.RepoID, WorktreePath: o.WorktreePath, Model: o.Model, Effort: o.Effort, Name: o.Name,
		PermissionMode: o.PermissionMode, Render: o.Render,
	}
	if o.Render != session.RenderDefault {
		call += " render=" + o.Render.String()
	}
	if o.PermissionMode != session.PermissionDefault {
		call += fmt.Sprintf(" perm=%d", o.PermissionMode)
	}
	if o.NewWorktree != nil {
		call += " new-worktree=" + o.NewWorktree.BaseRef
		f.mu.Lock()
		s.WorktreePath = fmt.Sprintf("/worktrees/cf-%d", f.next+1)
		f.mu.Unlock()
		s.CreatedWorktree, s.BaseRef = true, o.NewWorktree.BaseRef
	}
	if o.WorkspaceID != "" {
		call += " workspace=" + o.WorkspaceID
		s.WorkspaceID = o.WorkspaceID
	}
	if nw := o.NewWorkspace; nw != nil && len(nw.Repos) > 0 {
		call += " new-workspace=" + strings.Join(nw.Repos, ",")
		s.RepoID = o.RepoID
		if s.RepoID == "" {
			s.RepoID = nw.Repos[0]
		}
		s.WorkspaceID, s.WorktreePath, s.CreatedWorktree, s.BaseRef = "w-new", "/worktrees/"+s.RepoID, true, nw.BaseRef
	}
	if o.InitialPrompt != "" {
		call += " prompt=" + o.InitialPrompt
	}
	if o.ComposerPrompt != "" {
		call += " composer=" + o.ComposerPrompt
	}
	if len(o.Attachments) > 0 {
		call += " attachments=" + strings.Join(o.Attachments, ",")
	}
	return f.add(call, s)
}

// StageAttachment records "StageAttachment <name> <mime> <len>" and returns
// /attachments/<N>-<name>.
func (f *Fake) StageAttachment(_ context.Context, name, mimeType string, data []byte) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record(fmt.Sprintf("StageAttachment %s %s %d", name, mimeType, len(data))); err != nil {
		return "", err
	}
	f.staged++
	return fmt.Sprintf("/attachments/%d-%s", f.staged, name), nil
}

// ReadAttachment records "ReadAttachment <path>" and returns "data:<path>" as image/png.
func (f *Fake) ReadAttachment(_ context.Context, path string) ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "ReadAttachment "+path)
	return []byte("data:" + path), "image/png", nil
}

// Fork adds a STARTING session with ParentID set.
func (f *Fake) Fork(_ context.Context, id, name string) (session.Session, error) {
	f.mu.Lock()
	parent, err := f.get(id)
	f.mu.Unlock()
	if err != nil {
		return session.Session{}, err
	}
	return f.add("Fork "+id, session.Session{
		RepoID: parent.RepoID, WorktreePath: parent.WorktreePath, Model: parent.Model, Effort: parent.Effort,
		Name: name, ParentID: id, PermissionMode: parent.PermissionMode, WorkspaceID: parent.WorkspaceID,
		Render: parent.Render,
	})
}

// Get returns one session.
func (f *Fake) Get(_ context.Context, id string) (session.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.get(id)
}

// Rename sets the name and clears AutoNamed.
func (f *Fake) Rename(_ context.Context, id, name string) (session.Session, error) {
	return f.mutate("Rename "+id+" "+name, id, func(s *session.Session) error {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("%w: name is empty", session.ErrInvalidArgument)
		}
		s.Name, s.AutoNamed = strings.TrimSpace(name), false
		return nil
	})
}

// Pin records "Pin <id> <pinned>" and sets Pinned.
func (f *Fake) Pin(_ context.Context, id string, pinned bool) (session.Session, error) {
	return f.mutate(fmt.Sprintf("Pin %s %t", id, pinned), id, func(s *session.Session) error {
		s.Pinned = pinned
		return nil
	})
}

// Close disconnects the session with reason "closed".
func (f *Fake) Close(_ context.Context, id string) error {
	_, err := f.mutate("Close "+id, id, func(s *session.Session) error {
		if s.State != session.StateDisconnected {
			s.State, s.DisconnectReason, s.TerminalID = session.StateDisconnected, session.ReasonClosed, ""
		}
		return nil
	})
	return err
}

// Reconnect requires DISCONNECTED and moves the session to STARTING.
func (f *Fake) Reconnect(_ context.Context, id string) (session.Session, error) {
	return f.mutate("Reconnect "+id, id, func(s *session.Session) error {
		if s.State != session.StateDisconnected {
			return fmt.Errorf("%w: session %s is %s", session.ErrFailedPrecondition, id, s.State)
		}
		s.State, s.DisconnectReason, s.TerminalID = session.StateStarting, "", "t-re-"+id
		if s.Render == session.RenderRendered {
			s.TerminalID = ""
		}
		return nil
	})
}

// RunIn records "RunIn <id> <repo> <path>". It requires a workspace thread. A
// disconnected session moves at once to the path (else /worktrees/<repo>); a live one
// gets it as PendingWorktreePath.
func (f *Fake) RunIn(_ context.Context, id string, t session.RunInTarget) (session.Session, error) {
	return f.mutate("RunIn "+id+" "+t.RepoID+" "+t.WorktreePath, id, func(s *session.Session) error {
		if s.WorkspaceID == "" {
			return fmt.Errorf("%w: thread %s does not belong to a workspace", session.ErrFailedPrecondition, id)
		}
		path := t.WorktreePath
		if path == "" {
			path = "/worktrees/" + t.RepoID
		}
		if s.State == session.StateDisconnected {
			s.WorktreePath, s.RepoID = path, t.RepoID
		} else {
			s.PendingWorktreePath = path
		}
		return nil
	})
}

// Remove forgets a session and publishes Removed. Like the Manager, a session's usage
// moves to the retired ledger (then RetiredUsage is published too).
func (f *Fake) Remove(_ context.Context, id string) error {
	f.mu.Lock()
	if err := f.record("Remove " + id); err != nil {
		f.mu.Unlock()
		return err
	}
	s, err := f.get(id)
	if err != nil {
		f.mu.Unlock()
		return err
	}
	delete(f.byID, id)
	if len(s.Usage) > 0 {
		f.retired = session.SumUsage(f.retired, s.Usage)
	}
	retired := f.retired
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[session.Event](f.bus, session.Removed{ID: id})
	if len(s.Usage) > 0 {
		bus.Publish[session.Event](f.bus, session.RetiredUsage{Buckets: retired})
	}
	return nil
}

// SetRetiredUsage replaces the retired usage ledger (Snapshot.RetiredUsage).
func (f *Fake) SetRetiredUsage(buckets []session.UsageBucket) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.retired = buckets
	f.rebuild()
}

// Snapshot returns the current snapshot.
func (f *Fake) Snapshot() *session.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

// PutItems replaces a session's thread items (and pending requests, derived from the
// request items) and publishes ItemAppended for each.
func (f *Fake) PutItems(id string, items ...session.Item) {
	f.mu.Lock()
	snap := &session.ItemsSnapshot{SessionID: id}
	f.items[id] = snap
	var evs []session.ThreadEvent
	for i, it := range items {
		if it.Ordinal == 0 {
			it.Ordinal = int64(i + 1)
		}
		snap.Seq++
		snap.Items = append(snap.Items, it)
		evs = append(evs, session.ItemAppended{SessionID: id, Seq: snap.Seq, Item: it})
	}
	snap.Pending = pending(snap.Items)
	f.mu.Unlock()
	for _, ev := range evs {
		bus.Publish(f.bus, ev)
	}
}

func pending(items []session.Item) []session.PendingRequest {
	var out []session.PendingRequest
	for _, it := range items {
		if it.Request != nil && it.Request.State == session.RequestPending {
			out = append(out, session.PendingRequest{RequestID: it.Request.RequestID, ItemID: it.ID, Kind: it.Kind, ToolName: it.Request.ToolName})
		}
	}
	return out
}

// rendered returns session id when it is a rendered thread. The lock is held.
func (f *Fake) rendered(id string) (session.Session, error) {
	s, err := f.get(id)
	if err != nil {
		return s, err
	}
	if s.Render != session.RenderRendered {
		return s, fmt.Errorf("%w: thread %s runs in a terminal", session.ErrFailedPrecondition, id)
	}
	return s, nil
}

func (f *Fake) itemsLocked(id string) session.ItemsSnapshot {
	snap, ok := f.items[id]
	if !ok {
		return session.ItemsSnapshot{SessionID: id}
	}
	out := *snap
	out.Items = slices.Clone(snap.Items)
	out.Pending = slices.Clone(snap.Pending)
	return out
}

// Items returns what PutItems, Send and Respond left.
func (f *Fake) Items(_ context.Context, id string) (session.ItemsSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.rendered(id); err != nil {
		return session.ItemsSnapshot{}, err
	}
	return f.itemsLocked(id), nil
}

// WatchItems is Items, counting a watcher (Watchers) until ctx ends.
func (f *Fake) WatchItems(ctx context.Context, id string) (session.ItemsSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.rendered(id); err != nil {
		return session.ItemsSnapshot{}, err
	}
	f.watchers[id]++
	context.AfterFunc(ctx, func() {
		f.mu.Lock()
		f.watchers[id]--
		f.mu.Unlock()
	})
	return f.itemsLocked(id), nil
}

// Watchers returns the number of live WatchItems calls for id.
func (f *Fake) Watchers(id string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.watchers[id]
}

// appendItem adds it to id's items and publishes ItemAppended. The lock is held; the
// event is returned for publishing after unlock.
func (f *Fake) appendItem(id string, it session.Item) (session.Item, session.ThreadEvent) {
	snap, ok := f.items[id]
	if !ok {
		snap = &session.ItemsSnapshot{SessionID: id}
		f.items[id] = snap
	}
	it.Ordinal = int64(len(snap.Items) + 1)
	it.CreatedAt, it.UpdatedAt = f.Now(), f.Now()
	snap.Seq++
	snap.Items = append(snap.Items, it)
	return it, session.ItemAppended{SessionID: id, Seq: snap.Seq, Item: it}
}

// Send records "Send <id> <text>" (" attachments=<a,b>" and " composer=<text>" when
// set) and appends a
// user_message item. The session must be rendered and not disconnected.
func (f *Fake) Send(_ context.Context, id string, msg session.Message) (session.Item, error) {
	f.mu.Lock()
	call := "Send " + id + " " + msg.Text
	if len(msg.Attachments) > 0 {
		call += " attachments=" + strings.Join(msg.Attachments, ",")
	}
	if msg.ComposerText != "" {
		call += " composer=" + msg.ComposerText
	}
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return session.Item{}, err
	}
	s, err := f.rendered(id)
	if err == nil && s.State == session.StateDisconnected {
		err = fmt.Errorf("%w: thread %s is disconnected", session.ErrFailedPrecondition, id)
	}
	if err != nil {
		f.mu.Unlock()
		return session.Item{}, err
	}
	f.next++
	it, ev := f.appendItem(id, session.Item{ID: fmt.Sprintf("u-%d", f.next), Kind: session.KindUserMessage, Text: msg.Text, Attachments: msg.Attachments, ComposerText: msg.ComposerText})
	f.mu.Unlock()
	bus.Publish(f.bus, ev)
	return it, nil
}

// Respond records "Respond <id> <request> allow|allow-session|deny" and resolves the
// pending request item (ErrNotFound when there is none).
func (f *Fake) Respond(_ context.Context, id, requestID string, d session.Decision) (session.Item, error) {
	verb := "deny"
	if d.Allow {
		verb = "allow"
		if d.ForSession {
			verb = "allow-session"
		}
	}
	f.mu.Lock()
	if err := f.record("Respond " + id + " " + requestID + " " + verb); err != nil {
		f.mu.Unlock()
		return session.Item{}, err
	}
	if _, err := f.rendered(id); err != nil {
		f.mu.Unlock()
		return session.Item{}, err
	}
	snap := f.items[id]
	i := -1
	if snap != nil {
		i = slices.IndexFunc(snap.Items, func(it session.Item) bool {
			return it.Request != nil && it.Request.RequestID == requestID && it.Request.State == session.RequestPending
		})
	}
	if i < 0 {
		f.mu.Unlock()
		return session.Item{}, fmt.Errorf("%w: no pending request %s", session.ErrNotFound, requestID)
	}
	it := snap.Items[i]
	r := *it.Request
	switch {
	case !d.Allow:
		r.State, r.Decision, r.Message = session.RequestDenied, session.DecisionDeny, d.Message
	case d.ForSession:
		r.State, r.Decision = session.RequestAllowed, session.DecisionAllowForSession
	default:
		r.State, r.Decision = session.RequestAllowed, session.DecisionAllow
	}
	if d.Allow && it.Kind == session.KindQuestion {
		r.Answers = d.Answers
	}
	it.Request = &r
	snap.Items[i] = it
	snap.Seq++
	snap.Pending = pending(snap.Items)
	evs := []session.ThreadEvent{
		session.ItemUpdated{SessionID: id, Seq: snap.Seq, Item: it},
		session.PendingChanged{SessionID: id, Seq: snap.Seq + 1, Pending: snap.Pending},
	}
	snap.Seq++
	f.mu.Unlock()
	for _, ev := range evs {
		bus.Publish(f.bus, ev)
	}
	return it, nil
}

// Interrupt records "Interrupt <id>".
func (f *Fake) Interrupt(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("Interrupt " + id); err != nil {
		return err
	}
	_, err := f.rendered(id)
	return err
}

// SetModel records "SetModel <id> <model>" and sets Model.
func (f *Fake) SetModel(_ context.Context, id, model string) (session.Session, error) {
	return f.mutate("SetModel "+id+" "+model, id, func(s *session.Session) error {
		if s.Render != session.RenderRendered {
			return fmt.Errorf("%w: thread %s runs in a terminal", session.ErrFailedPrecondition, id)
		}
		s.Model = model
		return nil
	})
}

// SetPermissionMode records "SetPermissionMode <id> <n>" and sets PermissionMode;
// PermissionDefault is refused like the Manager does.
func (f *Fake) SetPermissionMode(_ context.Context, id string, mode session.PermissionMode) (session.Session, error) {
	return f.mutate(fmt.Sprintf("SetPermissionMode %s %d", id, mode), id, func(s *session.Session) error {
		if s.Render != session.RenderRendered {
			return fmt.Errorf("%w: thread %s runs in a terminal", session.ErrFailedPrecondition, id)
		}
		if mode < session.PermissionSupervised || mode > session.PermissionAuto {
			return fmt.Errorf("%w: permission mode %d", session.ErrInvalidArgument, mode)
		}
		s.PermissionMode = mode
		return nil
	})
}

// SetEffort implements session.Store: the row's effort changes at once (no restart to
// fake).
func (f *Fake) SetEffort(_ context.Context, id, effort string) (session.Session, error) {
	return f.mutate(fmt.Sprintf("SetEffort %s %s", id, effort), id, func(s *session.Session) error {
		if s.Render != session.RenderRendered {
			return fmt.Errorf("%w: thread %s runs in a terminal", session.ErrFailedPrecondition, id)
		}
		if !slices.Contains(session.Efforts, effort) {
			return fmt.Errorf("%w: effort %q", session.ErrInvalidArgument, effort)
		}
		s.Effort = effort
		return nil
	})
}

// PutMcp sets a thread's MCP status (nil: none) and publishes McpChanged.
func (f *Fake) PutMcp(id string, s *session.McpStatus) {
	f.mu.Lock()
	snap, ok := f.items[id]
	if !ok {
		snap = &session.ItemsSnapshot{SessionID: id}
		f.items[id] = snap
	}
	snap.Seq++
	snap.Mcp = s
	ev := session.McpChanged{SessionID: id, Seq: snap.Seq, Status: s}
	f.mu.Unlock()
	bus.Publish[session.ThreadEvent](f.bus, ev)
}

// McpStatus records "McpStatus <id>" (" refresh" when asked) and returns what PutMcp
// left; a refresh stamps CheckedAt with Now and the refresh trigger.
func (f *Fake) McpStatus(_ context.Context, id string, refresh bool) (*session.McpStatus, error) {
	call := "McpStatus " + id
	if refresh {
		call += " refresh"
	}
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return nil, err
	}
	if _, err := f.rendered(id); err != nil {
		f.mu.Unlock()
		return nil, err
	}
	cur := f.itemsLocked(id).Mcp
	f.mu.Unlock()
	if !refresh || cur == nil {
		return cur, nil
	}
	next := *cur
	next.CheckedAt, next.Trigger, next.Server = f.Now(), session.McpTriggerRefresh, ""
	f.PutMcp(id, &next)
	return &next, nil
}

// SetMcpReconnectError makes McpReconnect of server report msg (the server stays as it
// is), like Claude refusing a server that still fails.
func (f *Fake) SetMcpReconnectError(server, msg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.mcpErrs == nil {
		f.mcpErrs = map[string]string{}
	}
	f.mcpErrs[server] = msg
}

// McpReconnect records "McpReconnect <id> <server>" and marks the server connected (its
// error cleared) unless SetMcpReconnectError named it. An unknown server is ErrNotFound.
func (f *Fake) McpReconnect(_ context.Context, id, server string) (session.McpReconnectResult, error) {
	f.mu.Lock()
	if err := f.record("McpReconnect " + id + " " + server); err != nil {
		f.mu.Unlock()
		return session.McpReconnectResult{}, err
	}
	if _, err := f.rendered(id); err != nil {
		f.mu.Unlock()
		return session.McpReconnectResult{}, err
	}
	cur := f.itemsLocked(id).Mcp
	msg := f.mcpErrs[server]
	f.mu.Unlock()
	if cur == nil || !slices.ContainsFunc(cur.Servers, func(s session.McpServer) bool { return s.Name == server }) {
		return session.McpReconnectResult{}, fmt.Errorf("%w: thread %s has no MCP server %q", session.ErrNotFound, id, server)
	}
	next := session.McpStatus{CheckedAt: f.Now(), Trigger: session.McpTriggerReconnect, Server: server, Servers: slices.Clone(cur.Servers)}
	if msg == "" {
		for i, s := range next.Servers {
			if s.Name == server {
				s.Status, s.Error = session.McpConnected, ""
				next.Servers[i] = s
			}
		}
	}
	f.PutMcp(id, &next)
	return session.McpReconnectResult{Status: &next, Error: msg}, nil
}
