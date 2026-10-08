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
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/store/update/updatetest"
)

type updateFixture struct {
	store     *update.Store
	source    *updatetest.Source
	installer *updatetest.Installer
	update    codefoundryv1connect.UpdateServiceClient
	events    codefoundryv1connect.EventServiceClient
}

func newUpdateFixture(t *testing.T, current string) *updateFixture {
	t.Helper()
	b := bus.New()
	disk := updatetest.NewOnDisk(current)
	f := &updateFixture{source: updatetest.NewSource("v0.2.0"), installer: updatetest.NewInstaller(disk)}
	opts := update.Options{
		Current: current, Repo: "o/n", Source: f.source, Installer: f.installer,
		InstalledVersion: disk.Version, Bus: b, InitialDelay: time.Hour,
	}
	if !update.IsSemver(current) {
		opts.DisabledReason = "dev build"
	}
	f.store = update.Start(context.Background(), opts)
	t.Cleanup(f.store.Close)
	mux := http.NewServeMux()
	for _, r := range []Route{
		NewUpdate(f.store, b, nil).Route(),
		NewEvents(EventsDeps{Bus: b, Update: f.store}).Route(),
	} {
		mux.Handle(r.Path, r.Handler)
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	f.update = codefoundryv1connect.NewUpdateServiceClient(srv.Client(), srv.URL)
	f.events = codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)
	return f
}

func TestUpdateServiceFlow(t *testing.T) {
	f := newUpdateFixture(t, "v0.1.0")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	w, err := f.update.Watch(ctx, connect.NewRequest(&v1.WatchUpdateRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	next := func() *v1.UpdateEvent {
		t.Helper()
		if !w.Receive() {
			t.Fatalf("watch ended: %v", w.Err())
		}
		return w.Msg()
	}
	if st := next().GetStatus(); st.GetState() != v1.UpdateState_UPDATE_STATE_IDLE || !st.GetEnabled() || st.GetCurrentVersion() != "v0.1.0" || st.GetReleaseRepo() != "o/n" {
		t.Fatalf("snapshot %v", st)
	}

	// Install before a check: nothing to install.
	if _, err := f.update.Install(ctx, connect.NewRequest(&v1.InstallUpdateRequest{})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("Install err = %v", err)
	}

	res, err := f.update.Check(ctx, connect.NewRequest(&v1.CheckForUpdateRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	st := res.Msg.GetStatus()
	if st.GetState() != v1.UpdateState_UPDATE_STATE_AVAILABLE || st.GetTargetVersion() != "v0.2.0" || st.GetNotesUrl() == "" || st.GetLastCheckedAt() == nil {
		t.Fatalf("check %v", st)
	}
	// Watch saw checking, then available.
	if !next().GetStatus().GetChecking() {
		t.Fatal("no checking event")
	}
	if next().GetStatus().GetState() != v1.UpdateState_UPDATE_STATE_AVAILABLE {
		t.Fatal("no available event")
	}

	ir, err := f.update.Install(ctx, connect.NewRequest(&v1.InstallUpdateRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if ir.Msg.GetStatus().GetState() != v1.UpdateState_UPDATE_STATE_DOWNLOADING {
		t.Fatalf("install %v", ir.Msg.GetStatus())
	}
	for {
		if s := next().GetStatus(); s.GetState() == v1.UpdateState_UPDATE_STATE_INSTALLED {
			break
		}
	}

	rr, err := f.update.Relaunch(ctx, connect.NewRequest(&v1.RelaunchAppRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if rr.Msg.GetDelivered() != 1 { // this Watch stream
		t.Fatalf("delivered %d", rr.Msg.GetDelivered())
	}
	sawRestart, sawRelaunch := false, false
	for !sawRestart || !sawRelaunch {
		ev := next()
		sawRelaunch = sawRelaunch || ev.GetRelaunchRequested() != nil
		sawRestart = sawRestart || ev.GetStatus().GetState() == v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED
	}
}

func TestUpdateServiceDisabled(t *testing.T) {
	f := newUpdateFixture(t, "dev")
	ctx := context.Background()
	g, err := f.update.Get(ctx, connect.NewRequest(&v1.GetUpdateStatusRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if g.Msg.GetStatus().GetEnabled() || g.Msg.GetStatus().GetDisabledReason() != "dev build" {
		t.Fatalf("%v", g.Msg.GetStatus())
	}
	for name, call := range map[string]func() error{
		"Check": func() error {
			_, err := f.update.Check(ctx, connect.NewRequest(&v1.CheckForUpdateRequest{}))
			return err
		},
		"Install": func() error {
			_, err := f.update.Install(ctx, connect.NewRequest(&v1.InstallUpdateRequest{}))
			return err
		},
	} {
		if err := call(); connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Errorf("%s err = %v, want FailedPrecondition", name, err)
		}
	}
}

func TestUpdateCheckErrorIsUnavailable(t *testing.T) {
	f := newUpdateFixture(t, "v0.1.0")
	f.source.Set("", errors.New("gh: error connecting to api.github.com"))
	_, err := f.update.Check(context.Background(), connect.NewRequest(&v1.CheckForUpdateRequest{}))
	if connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatalf("err = %v", err)
	}
	g, _ := f.update.Get(context.Background(), connect.NewRequest(&v1.GetUpdateStatusRequest{}))
	if g.Msg.GetStatus().GetLastCheckError() == "" {
		t.Fatal("last_check_error not set")
	}
}

func TestEventsCarryUpdate(t *testing.T) {
	f := newUpdateFixture(t, "v0.1.0")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := f.events.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_UPDATE}}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if !s.Receive() {
		t.Fatal(s.Err())
	}
	if st := s.Msg().GetUpdate().GetStatus(); st.GetState() != v1.UpdateState_UPDATE_STATE_IDLE {
		t.Fatalf("snapshot %v", s.Msg())
	}
	if n := f.store.RequestRelaunch(); n != 1 {
		t.Fatalf("relaunch delivered to %d, want 1 (the events stream)", n)
	}
	if !s.Receive() || s.Msg().GetUpdate().GetRelaunchRequested() == nil {
		t.Fatalf("want relaunch_requested, got %v (%v)", s.Msg(), s.Err())
	}
}
