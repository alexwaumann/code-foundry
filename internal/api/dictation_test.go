package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/dictation"
	"github.com/alexwaumann/code-foundry/internal/store/dictation/dictationtest"
)

// newDictationServer serves DictationService over the real store, driving a fake
// engine, with the (tiny) model on disk and dictation on.
func newDictationServer(t *testing.T) (*dictationtest.Launcher, codefoundryv1connect.DictationServiceClient) {
	t.Helper()
	dir := t.TempDir()
	model := dictation.Model{Name: "m.bin", Size: 4, SHA256: "unused"}
	if err := os.WriteFile(filepath.Join(dir, model.Name), []byte("abcd"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := bus.New()
	l := &dictationtest.Launcher{}
	st := dictation.New(dictation.Options{
		Dir: dir, Bus: b, Model: model, Launch: l.Launch, Clock: dictationtest.NewClock(time.Unix(0, 0)),
		Enabled: func() bool { return true }, Attended: func() bool { return true },
		Hardware: func() dictation.Hardware { return dictation.HardwareOf("Apple M4 Pro", 48<<30) },
	})
	t.Cleanup(st.Close)
	h := NewDictation(st, b)
	h.beat = time.Hour
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return l, codefoundryv1connect.NewDictationServiceClient(srv.Client(), srv.URL)
}

// recvUntil reads the Watch stream until ok, failing after a while.
func recvUntil(t *testing.T, s *connect.ServerStreamForClient[v1.DictationSnapshot], ok func(*v1.DictationSnapshot) bool) *v1.DictationSnapshot {
	t.Helper()
	got := make(chan *v1.DictationSnapshot, 1)
	go func() {
		for s.Receive() {
			if m := s.Msg(); ok(m) {
				got <- m
				return
			}
		}
		close(got)
	}()
	select {
	case m, open := <-got:
		if !open {
			t.Fatalf("watch ended: %v", s.Err())
		}
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("watch: timed out")
	}
	return nil
}

func TestDictationService(t *testing.T) {
	l, c := newDictationServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	watch, err := c.Watch(ctx, connect.NewRequest(&v1.WatchDictationRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	ready := recvUntil(t, watch, func(m *v1.DictationSnapshot) bool {
		return m.GetState() == v1.DictationState_DICTATION_STATE_READY
	})
	if !ready.GetEnabled() || !ready.GetModel().GetDownloaded() || ready.GetModel().GetSizeBytes() != 4 ||
		ready.GetHardware().GetChip() != "Apple M4 Pro" || ready.GetHardware().GetM1Family() || ready.GetSession() != nil {
		t.Errorf("snapshot %v", ready)
	}

	if _, err := c.Start(ctx, connect.NewRequest(&v1.StartDictationRequest{})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("Start without a client: %v", err)
	}
	start, err := c.Start(ctx, connect.NewRequest(&v1.StartDictationRequest{ClientId: "composer-1"}))
	if err != nil {
		t.Fatal(err)
	}
	id := start.Msg.GetSessionId()
	listening := recvUntil(t, watch, func(m *v1.DictationSnapshot) bool {
		return m.GetState() == v1.DictationState_DICTATION_STATE_LISTENING
	})
	if listening.GetSession().GetId() != id || listening.GetSession().GetClientId() != "composer-1" || listening.GetSession().GetStartedAt() == nil {
		t.Errorf("session %v", listening.GetSession())
	}
	if _, err := c.Start(ctx, connect.NewRequest(&v1.StartDictationRequest{ClientId: "composer-2"})); connect.CodeOf(err) != connect.CodeAborted {
		t.Errorf("a second client: %v", err)
	}

	session, err := c.Session(ctx, connect.NewRequest(&v1.DictationSessionRequest{SessionId: id}))
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan *v1.DictationSessionEvent, 16)
	go func() {
		defer close(events)
		for session.Receive() {
			if session.Msg().GetHeartbeat() == nil {
				events <- session.Msg()
			}
		}
	}()
	next := func() *v1.DictationSessionEvent {
		t.Helper()
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatalf("session stream ended: %v", session.Err())
			}
			return ev
		case <-time.After(3 * time.Second):
			t.Fatal("session: timed out")
		}
		return nil
	}

	audio := c.Audio(ctx)
	if err := audio.Send(&v1.DictationAudioFrame{SessionId: id, Pcm: make([]byte, 640), Rms: 0.25}); err != nil {
		t.Fatal(err)
	}
	if ev := next(); ev.GetLevel().GetRms() != 0.25 {
		t.Errorf("first event %v, want the level", ev)
	}
	eng := l.Last()
	if _, err := audio.CloseAndReceive(); err != nil {
		t.Fatal(err)
	}
	if f, b := eng.Frames(); f != 1 || b != 640 {
		t.Errorf("engine got %d frames, %d bytes", f, b)
	}
	eng.Speak("Hello world.")
	if ev := next(); ev.GetPhrase().GetText() != "Hello world." {
		t.Errorf("event %v, want the phrase", ev)
	}
	eng.SetPhrases("The tail.")
	if _, err := c.Stop(ctx, connect.NewRequest(&v1.StopDictationRequest{SessionId: id, Flush: true})); err != nil {
		t.Fatal(err)
	}
	if ev := next(); ev.GetPhrase().GetText() != "The tail." {
		t.Errorf("event %v, want the flushed phrase", ev)
	}
	if ev := next(); ev.GetEnded().GetReason() != v1.DictationEndReason_DICTATION_END_REASON_STOPPED {
		t.Errorf("event %v, want ended", ev)
	}
	if _, open := <-events; open {
		t.Error("session stream not closed after ended")
	}

	// A late Session stream for the ended session gets its end; an unknown id NotFound.
	late, err := c.Session(ctx, connect.NewRequest(&v1.DictationSessionRequest{SessionId: id}))
	if err != nil {
		t.Fatal(err)
	}
	if !late.Receive() || late.Msg().GetEnded().GetReason() != v1.DictationEndReason_DICTATION_END_REASON_STOPPED {
		t.Errorf("late session: %v %v", late.Msg(), late.Err())
	}
	unknown, err := c.Session(ctx, connect.NewRequest(&v1.DictationSessionRequest{SessionId: "nope"}))
	if err == nil {
		for unknown.Receive() {
		}
		err = unknown.Err()
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown session: %v", err)
	}

	if _, err := c.MicDenied(ctx, connect.NewRequest(&v1.DictationMicDeniedRequest{Denied: true})); err != nil {
		t.Fatal(err)
	}
	recvUntil(t, watch, func(m *v1.DictationSnapshot) bool { return m.GetMicDenied() })

	if _, err := c.Download(ctx, connect.NewRequest(&v1.DownloadDictationModelRequest{})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("Download with the model there: %v", err)
	}
	removed, err := c.RemoveModel(ctx, connect.NewRequest(&v1.RemoveDictationModelRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if s := removed.Msg.GetSnapshot(); s.GetState() != v1.DictationState_DICTATION_STATE_NO_MODEL || s.GetModel().GetDownloaded() {
		t.Errorf("after remove %v", s)
	}
	if _, err := c.Start(ctx, connect.NewRequest(&v1.StartDictationRequest{ClientId: "composer-1"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("Start without the model: %v", err)
	}
	if _, err := c.CancelDownload(ctx, connect.NewRequest(&v1.CancelDictationDownloadRequest{})); err != nil {
		t.Errorf("CancelDownload with none running: %v", err)
	}
}

func TestDictationErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want connect.Code
	}{
		{dictation.ErrBusy, connect.CodeAborted},
		{dictation.ErrUnknownSession, connect.CodeNotFound},
		{dictation.ErrDisabled, connect.CodeFailedPrecondition},
		{dictation.ErrNoModel, connect.CodeFailedPrecondition},
		{dictation.ErrDownloaded, connect.CodeFailedPrecondition},
		{errors.Join(dictation.ErrEngine, errors.New("x")), connect.CodeFailedPrecondition},
		{context.DeadlineExceeded, connect.CodeDeadlineExceeded},
		{errors.New("disk full"), connect.CodeInternal},
	} {
		if got := connect.CodeOf(dictationError(tc.err)); got != tc.want {
			t.Errorf("%v: %v, want %v", tc.err, got, tc.want)
		}
	}
}
