package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// newNotificationServer serves NotificationService and EventService (the notification
// source only) over a store holding one shown notification.
func newNotificationServer(t *testing.T) (*notificationtest.Store, codefoundryv1connect.NotificationServiceClient, codefoundryv1connect.EventServiceClient) {
	t.Helper()
	s := notificationtest.New(t, notificationtest.Options{})
	if _, err := s.Post(context.Background(), notification.Post{Source: "ci", Key: "build", Level: notification.LevelError, TimeSensitive: true,
		Title: "Build failed", Body: "3 tests", ThreadID: "s-1", Actions: []notification.ActionSpec{
			{Action: notification.Action{Label: "Retry", Kind: notification.KindCommand, Command: "retry", Args: map[string]string{"job": "7"}}},
			{Action: notification.Action{Label: "Tell", Kind: notification.KindSend, ThreadID: "s-1", Text: "look"}},
			{Action: notification.Action{Label: "Logs", Kind: notification.KindOpen, URL: "https://ci.example.com/7"}},
		}}); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	mux := http.NewServeMux()
	for _, r := range []Route{NewNotification(s).Route(), NewEvents(EventsDeps{Bus: s.Bus, Notification: s, Done: done}).Route()} {
		mux.Handle(r.Path, r.Handler)
	}
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return s, codefoundryv1connect.NewNotificationServiceClient(srv.Client(), srv.URL), codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)
}

func TestNotificationList(t *testing.T) {
	s, c, _ := newNotificationServer(t)
	ctx := context.Background()
	res, err := c.List(ctx, connect.NewRequest(&v1.ListNotificationsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	snap := res.Msg.GetSnapshot()
	if len(snap.GetNotifications()) != 1 || snap.GetTimeSensitive() != 1 || len(res.Msg.GetClosed()) != 0 {
		t.Fatalf("list = %v", res.Msg)
	}
	n := snap.GetNotifications()[0]
	if n.GetSource() != "ci" || n.GetKey() != "build" || n.GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_ERROR ||
		!n.GetTimeSensitive() || n.GetTitle() != "Build failed" || n.GetBody() != "3 tests" || n.GetThreadId() != "s-1" ||
		n.GetStatus() != v1.NotificationStatus_NOTIFICATION_STATUS_SHOWN || !n.GetArrivedAt().AsTime().Equal(notificationtest.T0) ||
		n.GetShowAt() != nil || n.GetSnoozedUntil() != nil {
		t.Errorf("notification = %v", n)
	}
	as := n.GetActions()
	if len(as) != 3 || as[0].GetCommand().GetArgs()["job"] != "7" || !as[0].GetResolves() ||
		as[1].GetSend().GetText() != "look" || as[2].GetOpen().GetUrl() != "https://ci.example.com/7" || as[2].GetResolves() {
		t.Errorf("actions = %v", as)
	}

	if _, err := s.Dismiss(ctx, n.GetId()); err != nil {
		t.Fatal(err)
	}
	res, err = c.List(ctx, connect.NewRequest(&v1.ListNotificationsRequest{IncludeClosed: true}))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Msg.GetSnapshot().GetNotifications()) != 0 || len(res.Msg.GetClosed()) != 1 ||
		res.Msg.GetClosed()[0].GetStatus() != v1.NotificationStatus_NOTIFICATION_STATUS_DISMISSED {
		t.Errorf("after a dismiss = %v", res.Msg)
	}
}

// The source sends the snapshot, then the whole snapshot per change with the ids that
// arrived apart from those updated: an update in place is not an arrival.
func TestNotificationEventSource(t *testing.T) {
	s, _, ev := newNotificationServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := ev.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_NOTIFICATION}}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() *v1.NotificationEvent {
		t.Helper()
		for stream.Receive() {
			if m := stream.Msg(); m.GetHeartbeat() == nil {
				return m.GetNotification()
			}
		}
		t.Fatalf("stream ended: %v", stream.Err())
		return nil
	}
	snap := next()
	if len(snap.GetSnapshot().GetNotifications()) != 1 || len(snap.GetArrivedIds())+len(snap.GetUpdatedIds()) != 0 {
		t.Fatalf("snapshot event = %v", snap)
	}
	id := snap.GetSnapshot().GetNotifications()[0].GetId()

	res, err := s.Post(context.Background(), notification.Post{Source: "ci", Key: "deploy", Title: "Deploy ready"})
	if err != nil {
		t.Fatal(err)
	}
	if e := next(); !slices.Equal(e.GetArrivedIds(), []string{res.Notification.ID}) || len(e.GetUpdatedIds()) != 0 ||
		len(e.GetSnapshot().GetNotifications()) != 2 {
		t.Errorf("arrival event = %v", e)
	}
	if _, err := s.Post(context.Background(), notification.Post{Source: "ci", Key: "build", Title: "Build failed", Body: "4 tests"}); err != nil {
		t.Fatal(err)
	}
	if e := next(); len(e.GetArrivedIds()) != 0 || !slices.Equal(e.GetUpdatedIds(), []string{id}) {
		t.Errorf("update event = %v", e)
	}
	if _, err := s.Snooze(context.Background(), id, s.Clock.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if e := next(); len(e.GetArrivedIds())+len(e.GetUpdatedIds()) != 0 || e.GetSnapshot().GetTimeSensitive() != 0 {
		t.Errorf("snooze event = %v", e)
	}
	s.Clock.Advance(time.Minute)
	s.Tick()
	if e := next(); !slices.Equal(e.GetArrivedIds(), []string{id}) {
		t.Errorf("snooze end event = %v", e)
	}
	if notificationEventToProto(nil) != nil {
		t.Error("a nil event converts")
	}
}
