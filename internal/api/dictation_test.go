package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/dictate"
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
		Enabled:  func() bool { return true },
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
	if _, err := c.Stop(ctx, connect.NewRequest(&v1.StopDictationRequest{SessionId: id, Flush: true, Tail: true})); err != nil {
		t.Fatal(err)
	}
	if ends := eng.Ends(); len(ends) != 1 || !ends[0].Tail {
		t.Errorf("ends %+v, want a release", ends)
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

	if _, err := c.Accessibility(ctx, connect.NewRequest(&v1.DictationAccessibilityRequest{Accessibility: &v1.DictationAccessibility{
		Granted: true, TapSilent: true, ListName: "Accessibility", Executable: "/x",
	}})); err != nil {
		t.Fatal(err)
	}
	recvUntil(t, watch, func(m *v1.DictationSnapshot) bool {
		a := m.GetAccessibility()
		return a.GetGranted() && a.GetTapSilent() && a.GetListName() == "Accessibility" && a.GetExecutable() == "/x"
	})
	if _, err := c.Inputs(ctx, connect.NewRequest(&v1.DictationInputsRequest{Inputs: &v1.DictationInputs{
		DefaultUid: "pods", MicrophoneName: "Shure MV7",
		Devices: []*v1.DictationInput{{Uid: "pods", Name: "AirPods Pro", Transport: "bluetooth"}, {Uid: "mac", Name: "MacBook Pro Microphone", Transport: "built_in"}},
	}})); err != nil {
		t.Fatal(err)
	}
	recvUntil(t, watch, func(m *v1.DictationSnapshot) bool {
		in := m.GetInputs()
		return len(in.GetDevices()) == 2 && in.GetDefaultUid() == "pods" && in.GetMicrophoneName() == "Shure MV7" && in.GetDevices()[1].GetTransport() == "built_in" &&
			m.GetMicrophonePick().GetState() == "plain" // the harness's settings leave avoid off
	})
	if _, err := c.ComposerTarget(ctx, connect.NewRequest(&v1.DictationComposerTargetRequest{Available: true})); err != nil {
		t.Fatal(err)
	}
	recvUntil(t, watch, func(m *v1.DictationSnapshot) bool { return m.GetComposerTarget() })

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

// A host that dies mid-session never closes its audio stream. The session must end with it:
// left open, the next launch would capture for a hold nobody is making.
func TestDictationAudioLostEndsTheSession(t *testing.T) {
	_, c := newDictationServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	watch, err := c.Watch(ctx, connect.NewRequest(&v1.WatchDictationRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	recvUntil(t, watch, func(m *v1.DictationSnapshot) bool {
		return m.GetState() == v1.DictationState_DICTATION_STATE_READY
	})
	start, err := c.Start(ctx, connect.NewRequest(&v1.StartDictationRequest{ClientId: "system"}))
	if err != nil {
		t.Fatal(err)
	}
	audioCtx, lose := context.WithCancel(ctx)
	defer lose()
	audio := c.Audio(audioCtx)
	if err := audio.Send(&v1.DictationAudioFrame{SessionId: start.Msg.GetSessionId(), Pcm: make([]byte, 640)}); err != nil {
		t.Fatal(err)
	}
	recvUntil(t, watch, func(m *v1.DictationSnapshot) bool {
		return m.GetState() == v1.DictationState_DICTATION_STATE_LISTENING
	})
	lose()
	recvUntil(t, watch, func(m *v1.DictationSnapshot) bool {
		return m.GetState() == v1.DictationState_DICTATION_STATE_READY
	})
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

func TestDictationSnapshotPick(t *testing.T) {
	inputs := &dictation.Inputs{Default: "pods", Devices: []dictate.Input{
		{UID: "pods", Name: "AirPods Pro", Transport: dictate.TransportBluetooth},
		{UID: "mac", Name: "MacBook Pro Microphone", Transport: dictate.TransportBuiltIn},
	}}
	tests := []struct {
		name   string
		prefs  dictation.Prefs
		inputs *dictation.Inputs
		want   *v1.DictationMicrophonePick
	}{
		{"no report", dictation.Prefs{AvoidBluetooth: true}, nil, nil},
		{"plain", dictation.Prefs{}, inputs, &v1.DictationMicrophonePick{State: "plain"}},
		{"avoiding", dictation.Prefs{AvoidBluetooth: true}, inputs, &v1.DictationMicrophonePick{State: "avoiding", Name: "MacBook Pro Microphone", DefaultName: "AirPods Pro"}},
		{"named", dictation.Prefs{Microphone: "mac"}, inputs, &v1.DictationMicrophonePick{State: "named"}},
		{"missing", dictation.Prefs{Microphone: "shure"}, inputs, &v1.DictationMicrophonePick{State: "missing"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := dictationSnapshotToProto(dictation.Snapshot{Prefs: tt.prefs, Inputs: tt.inputs})
			if !proto.Equal(got.GetMicrophonePick(), tt.want) {
				t.Errorf("got %v, want %v", got.GetMicrophonePick(), tt.want)
			}
			if got.GetMicrophone() != tt.prefs.Microphone || got.GetAvoidBluetooth() != tt.prefs.AvoidBluetooth {
				t.Errorf("settings: %v", got)
			}
		})
	}
}

// endsQuietly is a store whose session ends without its end reaching the bus, as when a
// stalled stream's buffer was full.
type endsQuietly struct {
	DictationStore
	mu    sync.Mutex
	ended bool
}

func (s *endsQuietly) end() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ended = true
}

func (s *endsQuietly) SessionEnded(string) (dictation.EndReason, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return dictation.EndSilence, s.ended, true
}

// A session stream whose end event was dropped still ends, at its next heartbeat.
func TestDictationSessionEndsWhenTheEndWasDropped(t *testing.T) {
	st := &endsQuietly{}
	h := NewDictation(st, bus.New())
	h.beat = 10 * time.Millisecond
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := codefoundryv1connect.NewDictationServiceClient(srv.Client(), srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	session, err := c.Session(ctx, connect.NewRequest(&v1.DictationSessionRequest{SessionId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	if !session.Receive() || session.Msg().GetHeartbeat() == nil {
		t.Fatalf("first message %v, want a heartbeat: %v", session.Msg(), session.Err())
	}
	st.end()
	var last *v1.DictationSessionEvent
	for session.Receive() {
		last = session.Msg()
	}
	if err := session.Err(); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if last.GetEnded().GetReason() != v1.DictationEndReason_DICTATION_END_REASON_SILENCE {
		t.Errorf("last message %v, want ended by silence", last)
	}
}
