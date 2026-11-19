package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
)

// NotificationStore is the notification store as NotificationService and the
// EventService notification source read it. Writes are the notification.* commands', not
// this service's.
type NotificationStore interface {
	Snapshot() *notification.Snapshot
	List(closed bool) []notification.Notification
}

var _ NotificationStore = (*notification.Manager)(nil)

// Notification implements codefoundryv1connect.NotificationServiceHandler over the
// notification store (docs/notes/notifications-1-store.md).
type Notification struct {
	store NotificationStore
}

var _ codefoundryv1connect.NotificationServiceHandler = (*Notification)(nil)

// NewNotification returns a NotificationService handler.
func NewNotification(store NotificationStore) *Notification { return &Notification{store: store} }

// Route mounts the service.
func (h *Notification) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewNotificationServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// List returns the active notifications, and the closed ones on request.
func (h *Notification) List(_ context.Context, req *connect.Request[v1.ListNotificationsRequest]) (*connect.Response[v1.ListNotificationsResponse], error) {
	snap := h.store.Snapshot()
	out := &v1.ListNotificationsResponse{Snapshot: NotificationSnapshotToProto(snap)}
	if req.Msg.GetIncludeClosed() {
		for _, n := range h.store.List(true) {
			if n.State != notification.StateActive {
				out.Closed = append(out.Closed, NotificationToProto(n))
			}
		}
	}
	return connect.NewResponse(out), nil
}

// notificationSource is EventService's notification source: the whole snapshot, on
// connect and per change, with the ids that arrived or were updated.
type notificationSource struct {
	store NotificationStore
	bus   *bus.Bus
}

func (notificationSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_NOTIFICATION }

func (s notificationSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, func(ev notification.Event) *v1.Event {
		if m := notificationEventToProto(ev); m != nil {
			return &v1.Event{Event: &v1.Event_Notification{Notification: m}}
		}
		return nil
	})}
}

func (s notificationSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{{Event: &v1.Event_Notification{Notification: &v1.NotificationEvent{Snapshot: NotificationSnapshotToProto(s.store.Snapshot())}}}}
}

// notificationEventToProto converts a bus event to the wire event (nil for one it does
// not know).
func notificationEventToProto(ev notification.Event) *v1.NotificationEvent {
	switch e := ev.(type) {
	case notification.Changed:
		return &v1.NotificationEvent{Snapshot: NotificationSnapshotToProto(e.Snapshot), ArrivedIds: e.Arrived, UpdatedIds: e.Updated}
	case *notification.Snapshot:
		if e != nil {
			return &v1.NotificationEvent{Snapshot: NotificationSnapshotToProto(e)}
		}
	}
	return nil
}

// NotificationSnapshotToProto converts a snapshot (nil: an empty one).
func NotificationSnapshotToProto(snap *notification.Snapshot) *v1.NotificationSnapshot {
	out := &v1.NotificationSnapshot{}
	if snap == nil {
		return out
	}
	out.TimeSensitive, out.Unseen, out.Version = int32(snap.TimeSensitive), int32(snap.Unseen), snap.Version
	for _, n := range snap.Notifications {
		out.Notifications = append(out.Notifications, NotificationToProto(n))
	}
	return out
}

var notificationLevels = map[notification.Level]v1.NotificationLevel{
	notification.LevelInfo:    v1.NotificationLevel_NOTIFICATION_LEVEL_INFO,
	notification.LevelWarning: v1.NotificationLevel_NOTIFICATION_LEVEL_WARNING,
	notification.LevelError:   v1.NotificationLevel_NOTIFICATION_LEVEL_ERROR,
}

var notificationStatuses = map[notification.Status]v1.NotificationStatus{
	notification.StatusShown:     v1.NotificationStatus_NOTIFICATION_STATUS_SHOWN,
	notification.StatusSnoozed:   v1.NotificationStatus_NOTIFICATION_STATUS_SNOOZED,
	notification.StatusScheduled: v1.NotificationStatus_NOTIFICATION_STATUS_SCHEDULED,
	notification.StatusDismissed: v1.NotificationStatus_NOTIFICATION_STATUS_DISMISSED,
	notification.StatusWithdrawn: v1.NotificationStatus_NOTIFICATION_STATUS_WITHDRAWN,
	notification.StatusResolved:  v1.NotificationStatus_NOTIFICATION_STATUS_RESOLVED,
}

// notificationActionKinds fills a wire action's kind from the store's, one per kind.
var notificationActionKinds = map[notification.ActionKind]func(notification.Action, *v1.NotificationAction){
	notification.KindCommand: func(a notification.Action, out *v1.NotificationAction) {
		out.Kind = &v1.NotificationAction_Command{Command: &v1.NotificationCommandAction{Command: a.Command, Args: a.Args}}
	},
	notification.KindSend: func(a notification.Action, out *v1.NotificationAction) {
		out.Kind = &v1.NotificationAction_Send{Send: &v1.NotificationSendAction{ThreadId: a.ThreadID, Text: a.Text}}
	},
	notification.KindStart: func(a notification.Action, out *v1.NotificationAction) {
		out.Kind = &v1.NotificationAction_Start{Start: &v1.NotificationStartAction{Prompt: a.Prompt, ProjectId: a.ProjectID}}
	},
	notification.KindOpen: func(a notification.Action, out *v1.NotificationAction) {
		out.Kind = &v1.NotificationAction_Open{Open: &v1.NotificationOpenAction{Url: a.URL}}
	},
}

// NotificationToProto converts one notification.
func NotificationToProto(n notification.Notification) *v1.Notification {
	out := &v1.Notification{
		Id: n.ID, Source: n.Source, Key: n.Key, Level: notificationLevels[n.Level], TimeSensitive: n.TimeSensitive,
		Title: n.Title, Body: n.Body, ThreadId: n.ThreadID, Status: notificationStatuses[n.Status()],
		ShowAt: timestamp(n.ShowAt), CreatedAt: timestamp(n.CreatedAt), UpdatedAt: timestamp(n.UpdatedAt),
		ArrivedAt: timestamp(n.ArrivedAt), SnoozedUntil: timestamp(n.SnoozedUntil), Seen: n.Seen,
	}
	for _, a := range n.Actions {
		pa := &v1.NotificationAction{Label: a.Label, Resolves: a.Resolves}
		if fill := notificationActionKinds[a.Kind]; fill != nil {
			fill(a, pa)
		}
		out.Actions = append(out.Actions, pa)
	}
	return out
}
