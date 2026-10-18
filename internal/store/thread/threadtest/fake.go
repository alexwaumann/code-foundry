// Package threadtest provides an in-memory thread.Store for tests of code that
// consumes threads (API handlers, commands, the events stream). No processes are
// involved: tests drive state changes with Put.
package threadtest

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Fake implements thread.Store. Every mutation publishes the same events as the real
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
	byID    map[string]thread.Thread
	snap    *thread.Snapshot
	calls   []string
	retired []thread.UsageBucket
	items   map[string]*thread.ItemsSnapshot
	// Watchers counts WatchItems calls whose ctx has not ended, by thread.
	watchers map[string]int
	mcpErrs  map[string]string
	// subs are the wake subscriptions (subscriptions.go).
	subs    []thread.Subscription
	nextSub int
	// requests are CreateOnce's keys (creator NUL key) to thread ids.
	requests map[string]string
}

var _ thread.Store = (*Fake)(nil)

// New returns an empty fake publishing on b (a private bus if nil).
func New(b *bus.Bus) *Fake {
	if b == nil {
		b = bus.New()
	}
	return &Fake{bus: b, Now: time.Now, byID: map[string]thread.Thread{}, snap: &thread.Snapshot{},
		items: map[string]*thread.ItemsSnapshot{}, watchers: map[string]int{}}
}

// Bus returns the bus the fake publishes on.
func (f *Fake) Bus() *bus.Bus { return f.bus }

// Calls returns the recorded method calls, e.g. "Create /w opus high", "Close s-1".
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// Put inserts or replaces a thread and publishes Updated.
func (f *Fake) Put(s thread.Thread) {
	f.mu.Lock()
	f.byID[s.ID] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[thread.Event](f.bus, thread.Updated{Thread: s})
}

func (f *Fake) rebuild() {
	out := make([]thread.Thread, 0, len(f.byID))
	for _, s := range f.byID {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b thread.Thread) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	f.snap = &thread.Snapshot{Threads: out, RetiredUsage: f.retired}
}

func (f *Fake) record(call string) error {
	f.calls = append(f.calls, call)
	return f.Err
}

func (f *Fake) get(id string) (thread.Thread, error) {
	s, ok := f.byID[id]
	if !ok {
		return thread.Thread{}, fmt.Errorf("%w: %s", thread.ErrNotFound, id)
	}
	return s, nil
}

// mutate applies fn to thread id under the lock and publishes the result.
func (f *Fake) mutate(call, id string, fn func(*thread.Thread) error) (thread.Thread, error) {
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return thread.Thread{}, err
	}
	s, err := f.get(id)
	if err == nil {
		err = fn(&s)
	}
	if err != nil {
		f.mu.Unlock()
		return thread.Thread{}, err
	}
	f.byID[id] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[thread.Event](f.bus, thread.Updated{Thread: s})
	return s, nil
}

func (f *Fake) add(call string, s thread.Thread) (thread.Thread, error) {
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return thread.Thread{}, err
	}
	f.next++
	s.ID = fmt.Sprintf("s-%d", f.next)
	s.State = thread.StateStarting
	s.CreatedAt = f.Now()
	s.LastActivityAt = s.CreatedAt
	f.byID[s.ID] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[thread.Event](f.bus, thread.Updated{Thread: s})
	return s, nil
}

// Create records the call and adds a STARTING thread ("s-N"). With
// NewWorktree the thread's worktree is /worktrees/cf-<N> on branch cf/<N> (CreatedWorktree,
// BaseRef as requested). WorkspaceID is copied as is. With NewWorkspace the thread belongs to
// workspace "w-new" and runs in /worktrees/<project>, project being ProjectID or the first project.
// With NoProject it runs in /home. The call reads "Create <project> <path> <model>
// <effort>", then " perm=<n>", " new-worktree=<base>", " workspace=<id>",
// " new-workspace=<a,b>", " no-project", " prompt=<text>"
// " composer=<text>" and " attachments=<a,b>" when set.
func (f *Fake) Create(_ context.Context, o thread.CreateOptions) (thread.Thread, error) {
	call := fmt.Sprintf("Create %s %s %s %s", o.ProjectID, o.WorktreePath, o.Model, o.Effort)
	s := thread.Thread{
		ProjectID: o.ProjectID, WorktreePath: o.WorktreePath, Model: o.Model, Effort: o.Effort, Name: o.Name,
		PermissionMode: o.PermissionMode,
	}
	if o.PermissionMode != thread.PermissionDefault {
		call += fmt.Sprintf(" perm=%d", o.PermissionMode)
	}
	if o.NewWorktree != nil {
		call += " new-worktree=" + o.NewWorktree.BaseRef
		f.mu.Lock()
		s.WorktreePath, s.Branch = fmt.Sprintf("/worktrees/cf-%d", f.next+1), fmt.Sprintf("cf/%d", f.next+1)
		f.mu.Unlock()
		s.CreatedWorktree, s.BaseRef = true, o.NewWorktree.BaseRef
	}
	if o.WorkspaceID != "" {
		call += " workspace=" + o.WorkspaceID
		s.WorkspaceID = o.WorkspaceID
	}
	if nw := o.NewWorkspace; nw != nil && len(nw.Projects) > 0 {
		call += " new-workspace=" + strings.Join(nw.Projects, ",")
		s.ProjectID = o.ProjectID
		if s.ProjectID == "" {
			s.ProjectID = nw.Projects[0]
		}
		s.WorkspaceID, s.WorktreePath, s.CreatedWorktree, s.BaseRef = "w-new", "/worktrees/"+s.ProjectID, true, nw.BaseRef
	}
	if o.NoProject {
		call += " no-project"
		s.WorktreePath = "/home"
		if o.Cwd != "" {
			call += " cwd=" + o.Cwd
			s.WorktreePath = o.Cwd
		}
	}
	if o.Owner != "" {
		call += " owner=" + o.Owner
		s.Owner = o.Owner
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
	if err := f.createMetadata(&s, o, &call); err != nil {
		return thread.Thread{}, err
	}
	if o.Notify {
		if s.CreatedBy == "" {
			return thread.Thread{}, fmt.Errorf("%w: notify needs created-by", thread.ErrInvalidArgument)
		}
		call += " notify"
	}
	s, err := f.add(call, s)
	if err == nil && o.Notify {
		f.mu.Lock()
		f.nextSub++
		f.subs = append(f.subs, thread.Subscription{ID: fmt.Sprintf("sub-%d", f.nextSub), SubscriberID: s.CreatedBy,
			TargetKind: thread.TargetThread, TargetID: s.ID, Condition: thread.CondSettled, Repeat: true, CreatedAt: f.Now()})
		f.mu.Unlock()
	}
	return s, err
}

// CreateOnce is Create keyed by requestID (validated like the store's): a key its
// creator used before returns that thread, reused, and records nothing. Keys never
// expire in the fake.
func (f *Fake) CreateOnce(ctx context.Context, requestID string, o thread.CreateOptions) (thread.Thread, bool, error) {
	key, err := thread.CleanRequestID(requestID)
	if err != nil {
		return thread.Thread{}, false, err
	}
	slot := strings.TrimSpace(o.CreatedBy) + "\x00" + key
	if key != "" {
		f.mu.Lock()
		id, ok := f.requests[slot]
		s, exists := f.byID[id]
		f.mu.Unlock()
		if ok && exists {
			return s, true, nil
		}
	}
	s, err := f.Create(ctx, o)
	if err == nil && key != "" {
		f.mu.Lock()
		if f.requests == nil {
			f.requests = map[string]string{}
		}
		f.requests[slot] = s.ID
		f.mu.Unlock()
	}
	return s, false, err
}

// StageAttachment records "StageAttachment <name> <mime> <len>" (and " pages=<n>"
// when pages is set) and returns /attachments/<N>-<name>.
func (f *Fake) StageAttachment(_ context.Context, name, mimeType string, data []byte, pages int) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := fmt.Sprintf("StageAttachment %s %s %d", name, mimeType, len(data))
	if pages > 0 {
		call += fmt.Sprintf(" pages=%d", pages)
	}
	if err := f.record(call); err != nil {
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

// Fork adds a STARTING thread with ParentID set, in the parent's worktree (with what
// it was made for: CreatedWorktree, BaseRef, Branch).
func (f *Fake) Fork(_ context.Context, id, name string) (thread.Thread, error) {
	f.mu.Lock()
	parent, err := f.get(id)
	f.mu.Unlock()
	if err != nil {
		return thread.Thread{}, err
	}
	return f.add("Fork "+id, thread.Thread{
		ProjectID: parent.ProjectID, WorktreePath: parent.WorktreePath, Model: parent.Model, Effort: parent.Effort,
		Name: name, ParentID: id, PermissionMode: parent.PermissionMode, WorkspaceID: parent.WorkspaceID,
		CreatedWorktree: parent.CreatedWorktree, BaseRef: parent.BaseRef, Branch: parent.Branch,
	})
}

// Get returns one thread.
func (f *Fake) Get(_ context.Context, id string) (thread.Thread, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.get(id)
}

// Rename sets the name and clears AutoNamed.
func (f *Fake) Rename(_ context.Context, id, name string) (thread.Thread, error) {
	return f.mutate("Rename "+id+" "+name, id, func(s *thread.Thread) error {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("%w: name is empty", thread.ErrInvalidArgument)
		}
		s.Name, s.AutoNamed = strings.TrimSpace(name), false
		return nil
	})
}

// Pin records "Pin <id> <pinned>" and sets Pinned. Pinning unarchives and unsnoozes.
func (f *Fake) Pin(_ context.Context, id string, pinned bool) (thread.Thread, error) {
	return f.mutate(fmt.Sprintf("Pin %s %t", id, pinned), id, func(s *thread.Thread) error {
		s.Pinned = pinned
		if pinned {
			s.ArchivedAt, s.SnoozedUntil = time.Time{}, time.Time{}
		}
		return nil
	})
}

// Archive records "Archive <id> <archived>". Archiving disconnects a live thread
// (reason "closed"), unpins and unsnoozes it and sets ArchivedAt to Now unless already
// set; unarchiving clears ArchivedAt only. No shells are involved.
func (f *Fake) Archive(_ context.Context, id string, archived bool) (thread.Thread, error) {
	return f.mutate(fmt.Sprintf("Archive %s %t", id, archived), id, func(s *thread.Thread) error {
		if !archived {
			s.ArchivedAt = time.Time{}
			return nil
		}
		if s.State != thread.StateDisconnected {
			s.State, s.DisconnectReason = thread.StateDisconnected, thread.ReasonClosed
		}
		s.Pinned, s.SnoozedUntil = false, time.Time{}
		if s.ArchivedAt.IsZero() {
			s.ArchivedAt = f.Now()
		}
		return nil
	})
}

// Snooze records "Snooze <id> <until RFC3339 ms>" ("Snooze <id> -" to unsnooze).
// Snoozing requires until after Now (ErrInvalidArgument), disconnects a live thread
// (reason "closed"), unpins and unarchives it and sets SnoozedUntil; unsnoozing clears
// SnoozedUntil only. No shells are involved and nothing wakes: tests Put the woken
// state.
func (f *Fake) Snooze(_ context.Context, id string, until time.Time) (thread.Thread, error) {
	call := "Snooze " + id + " -"
	if !until.IsZero() {
		call = "Snooze " + id + " " + until.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	}
	return f.mutate(call, id, func(s *thread.Thread) error {
		if until.IsZero() {
			s.SnoozedUntil = time.Time{}
			return nil
		}
		if !until.After(f.Now()) {
			return fmt.Errorf("%w: snooze time is not in the future", thread.ErrInvalidArgument)
		}
		if s.State != thread.StateDisconnected {
			s.State, s.DisconnectReason = thread.StateDisconnected, thread.ReasonClosed
		}
		s.Pinned, s.ArchivedAt, s.SnoozedUntil = false, time.Time{}, until
		return nil
	})
}

// Close disconnects the thread with reason "closed".
func (f *Fake) Close(_ context.Context, id string) error {
	_, err := f.mutate("Close "+id, id, func(s *thread.Thread) error {
		if s.State != thread.StateDisconnected {
			s.State, s.DisconnectReason = thread.StateDisconnected, thread.ReasonClosed
		}
		return nil
	})
	return err
}

// Reconnect requires DISCONNECTED and moves the thread to STARTING, unarchived and
// unsnoozed.
func (f *Fake) Reconnect(_ context.Context, id string) (thread.Thread, error) {
	return f.mutate("Reconnect "+id, id, func(s *thread.Thread) error {
		if s.State != thread.StateDisconnected {
			return fmt.Errorf("%w: thread %s is %s", thread.ErrFailedPrecondition, id, s.State)
		}
		s.State, s.DisconnectReason, s.ArchivedAt, s.SnoozedUntil = thread.StateStarting, "", time.Time{}, time.Time{}
		return nil
	})
}

// RunIn records "RunIn <id> <project> <path>". It requires a workspace thread. A
// disconnected thread moves at once to the path (else /worktrees/<project>); a live one
// gets it as PendingWorktreePath.
func (f *Fake) RunIn(_ context.Context, id string, t thread.RunInTarget) (thread.Thread, error) {
	return f.mutate("RunIn "+id+" "+t.ProjectID+" "+t.WorktreePath, id, func(s *thread.Thread) error {
		if s.WorkspaceID == "" {
			return fmt.Errorf("%w: thread %s does not belong to a workspace", thread.ErrFailedPrecondition, id)
		}
		path := t.WorktreePath
		if path == "" {
			path = "/worktrees/" + t.ProjectID
		}
		if s.State == thread.StateDisconnected {
			s.WorktreePath, s.ProjectID = path, t.ProjectID
		} else {
			s.PendingWorktreePath = path
		}
		return nil
	})
}

// Remove forgets a thread and publishes Removed. Like the Manager, a thread's usage
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
		f.retired = thread.SumUsage(f.retired, s.Usage)
	}
	retired := f.retired
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[thread.Event](f.bus, thread.Removed{ID: id})
	if len(s.Usage) > 0 {
		bus.Publish[thread.Event](f.bus, thread.RetiredUsage{Buckets: retired})
	}
	return nil
}

// SetRetiredUsage replaces the retired usage ledger (Snapshot.RetiredUsage).
func (f *Fake) SetRetiredUsage(buckets []thread.UsageBucket) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.retired = buckets
	f.rebuild()
}

// Snapshot returns the current snapshot.
func (f *Fake) Snapshot() *thread.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

// List filters the snapshot like the store (thread.FilterThreads), comparing Project and
// Workspace as ids.
func (f *Fake) List(_ context.Context, o thread.ListOptions) ([]thread.Thread, error) {
	return thread.FilterThreads(f.Snapshot().Threads, o), nil
}

// PutItems replaces a thread's items (and pending requests, derived from the
// request items) and publishes ItemAppended for each.
func (f *Fake) PutItems(id string, items ...thread.Item) {
	f.mu.Lock()
	snap := &thread.ItemsSnapshot{ThreadID: id}
	f.items[id] = snap
	var evs []thread.ThreadEvent
	for i, it := range items {
		if it.Ordinal == 0 {
			it.Ordinal = int64(i + 1)
		}
		snap.Seq++
		snap.Items = append(snap.Items, it)
		evs = append(evs, thread.ItemAppended{ThreadID: id, Seq: snap.Seq, Item: it})
	}
	snap.Pending = pending(snap.Items)
	f.mu.Unlock()
	for _, ev := range evs {
		bus.Publish(f.bus, ev)
	}
}

func pending(items []thread.Item) []thread.PendingRequest {
	var out []thread.PendingRequest
	for _, it := range items {
		if it.Request != nil && it.Request.State == thread.RequestPending {
			out = append(out, thread.PendingRequest{RequestID: it.Request.RequestID, ItemID: it.ID, Kind: it.Kind, ToolName: it.Request.ToolName})
		}
	}
	return out
}

func (f *Fake) itemsLocked(id string) thread.ItemsSnapshot {
	snap, ok := f.items[id]
	if !ok {
		return thread.ItemsSnapshot{ThreadID: id}
	}
	out := *snap
	out.Items = slices.Clone(snap.Items)
	out.Pending = slices.Clone(snap.Pending)
	return out
}

// Items returns what PutItems, Send and Respond left.
func (f *Fake) Items(_ context.Context, id string) (thread.ItemsSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.get(id); err != nil {
		return thread.ItemsSnapshot{}, err
	}
	return f.itemsLocked(id), nil
}

// WatchItems is Items, counting a watcher (Watchers) until ctx ends.
func (f *Fake) WatchItems(ctx context.Context, id string) (thread.ItemsSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.get(id); err != nil {
		return thread.ItemsSnapshot{}, err
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
func (f *Fake) appendItem(id string, it thread.Item) (thread.Item, thread.ThreadEvent) {
	snap, ok := f.items[id]
	if !ok {
		snap = &thread.ItemsSnapshot{ThreadID: id}
		f.items[id] = snap
	}
	it.Ordinal = int64(len(snap.Items) + 1)
	it.CreatedAt, it.UpdatedAt = f.Now(), f.Now()
	snap.Seq++
	snap.Items = append(snap.Items, it)
	return it, thread.ItemAppended{ThreadID: id, Seq: snap.Seq, Item: it}
}

// AppendItem adds it to id's items (the next ordinal) and publishes ItemAppended, as
// the runner does for what Claude streams.
func (f *Fake) AppendItem(id string, it thread.Item) thread.Item {
	f.mu.Lock()
	it, ev := f.appendItem(id, it)
	f.mu.Unlock()
	bus.Publish(f.bus, ev)
	return it
}

// Send records "Send <id> <text>" (" attachments=<a,b>" and " composer=<text>" when
// set) and appends a user_message item. A disconnected thread becomes CONNECTED (the
// Manager starts it). Sending unarchives and unsnoozes.
func (f *Fake) Send(_ context.Context, id string, msg thread.Message) (thread.Item, error) {
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
		return thread.Item{}, err
	}
	s, err := f.get(id)
	if err != nil {
		f.mu.Unlock()
		return thread.Item{}, err
	}
	f.next++
	it, ev := f.appendItem(id, thread.Item{ID: fmt.Sprintf("u-%d", f.next), Kind: thread.KindUserMessage, Text: msg.Text, Attachments: msg.Attachments, ComposerText: msg.ComposerText})
	// A message starts a stopped thread (no handshake to fake: connected at once).
	started := s.State == thread.StateDisconnected
	if started {
		s.State, s.DisconnectReason = thread.StateConnected, ""
	}
	changed := started || !s.ArchivedAt.IsZero() || !s.SnoozedUntil.IsZero()
	if changed {
		s.ArchivedAt, s.SnoozedUntil = time.Time{}, time.Time{}
		f.byID[id] = s
		f.rebuild()
	}
	f.mu.Unlock()
	bus.Publish(f.bus, ev)
	if changed {
		bus.Publish[thread.Event](f.bus, thread.Updated{Thread: s})
	}
	return it, nil
}

// Respond records "Respond <id> <request> allow|allow-session|deny" and resolves the
// pending request item (ErrNotFound when there is none).
func (f *Fake) Respond(_ context.Context, id, requestID string, d thread.Decision) (thread.Item, error) {
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
		return thread.Item{}, err
	}
	if _, err := f.get(id); err != nil {
		f.mu.Unlock()
		return thread.Item{}, err
	}
	snap := f.items[id]
	i := -1
	if snap != nil {
		i = slices.IndexFunc(snap.Items, func(it thread.Item) bool {
			return it.Request != nil && it.Request.RequestID == requestID && it.Request.State == thread.RequestPending
		})
	}
	if i < 0 {
		f.mu.Unlock()
		return thread.Item{}, fmt.Errorf("%w: no pending request %s", thread.ErrNotFound, requestID)
	}
	it := snap.Items[i]
	r := *it.Request
	switch {
	case !d.Allow:
		r.State, r.Decision, r.Message = thread.RequestDenied, thread.DecisionDeny, d.Message
	case d.ForSession:
		r.State, r.Decision = thread.RequestAllowed, thread.DecisionAllowForSession
	default:
		r.State, r.Decision = thread.RequestAllowed, thread.DecisionAllow
	}
	if d.Allow && it.Kind == thread.KindQuestion {
		r.Answers = d.Answers
	}
	it.Request = &r
	snap.Items[i] = it
	snap.Seq++
	snap.Pending = pending(snap.Items)
	evs := []thread.ThreadEvent{
		thread.ItemUpdated{ThreadID: id, Seq: snap.Seq, Item: it},
		thread.PendingChanged{ThreadID: id, Seq: snap.Seq + 1, Pending: snap.Pending},
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
	_, err := f.get(id)
	return err
}

// SetModel records "SetModel <id> <model>" and sets Model.
func (f *Fake) SetModel(_ context.Context, id, model string) (thread.Thread, error) {
	return f.mutate("SetModel "+id+" "+model, id, func(s *thread.Thread) error {
		s.Model = model
		return nil
	})
}

// SetPermissionMode records "SetPermissionMode <id> <n>" and sets PermissionMode;
// PermissionDefault is refused like the Manager does.
func (f *Fake) SetPermissionMode(_ context.Context, id string, mode thread.PermissionMode) (thread.Thread, error) {
	return f.mutate(fmt.Sprintf("SetPermissionMode %s %d", id, mode), id, func(s *thread.Thread) error {
		if mode < thread.PermissionSupervised || mode > thread.PermissionAuto {
			return fmt.Errorf("%w: permission mode %d", thread.ErrInvalidArgument, mode)
		}
		s.PermissionMode = mode
		return nil
	})
}

// SetEffort implements thread.Store: the row's effort changes at once (no restart to
// fake).
func (f *Fake) SetEffort(_ context.Context, id, effort string) (thread.Thread, error) {
	return f.mutate(fmt.Sprintf("SetEffort %s %s", id, effort), id, func(s *thread.Thread) error {
		if !slices.Contains(thread.Efforts, effort) {
			return fmt.Errorf("%w: effort %q", thread.ErrInvalidArgument, effort)
		}
		s.Effort = effort
		return nil
	})
}

// PutMcp sets a thread's MCP status (nil: none) and publishes McpChanged.
func (f *Fake) PutMcp(id string, s *thread.McpStatus) {
	f.mu.Lock()
	snap, ok := f.items[id]
	if !ok {
		snap = &thread.ItemsSnapshot{ThreadID: id}
		f.items[id] = snap
	}
	snap.Seq++
	snap.Mcp = s
	ev := thread.McpChanged{ThreadID: id, Seq: snap.Seq, Status: s}
	f.mu.Unlock()
	bus.Publish[thread.ThreadEvent](f.bus, ev)
}

// McpStatus records "McpStatus <id>" (" refresh" when asked) and returns what PutMcp
// left; a refresh stamps CheckedAt with Now and the refresh trigger.
func (f *Fake) McpStatus(_ context.Context, id string, refresh bool) (*thread.McpStatus, error) {
	call := "McpStatus " + id
	if refresh {
		call += " refresh"
	}
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return nil, err
	}
	if _, err := f.get(id); err != nil {
		f.mu.Unlock()
		return nil, err
	}
	cur := f.itemsLocked(id).Mcp
	f.mu.Unlock()
	if !refresh || cur == nil {
		return cur, nil
	}
	next := *cur
	next.CheckedAt, next.Trigger, next.Server = f.Now(), thread.McpTriggerRefresh, ""
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
func (f *Fake) McpReconnect(_ context.Context, id, server string) (thread.McpReconnectResult, error) {
	f.mu.Lock()
	if err := f.record("McpReconnect " + id + " " + server); err != nil {
		f.mu.Unlock()
		return thread.McpReconnectResult{}, err
	}
	if _, err := f.get(id); err != nil {
		f.mu.Unlock()
		return thread.McpReconnectResult{}, err
	}
	cur := f.itemsLocked(id).Mcp
	msg := f.mcpErrs[server]
	f.mu.Unlock()
	if cur == nil || !slices.ContainsFunc(cur.Servers, func(s thread.McpServer) bool { return s.Name == server }) {
		return thread.McpReconnectResult{}, fmt.Errorf("%w: thread %s has no MCP server %q", thread.ErrNotFound, id, server)
	}
	next := thread.McpStatus{CheckedAt: f.Now(), Trigger: thread.McpTriggerReconnect, Server: server, Servers: slices.Clone(cur.Servers)}
	if msg == "" {
		for i, s := range next.Servers {
			if s.Name == server {
				s.Status, s.Error = thread.McpConnected, ""
				next.Servers[i] = s
			}
		}
	}
	f.PutMcp(id, &next)
	return thread.McpReconnectResult{Status: &next, Error: msg}, nil
}
