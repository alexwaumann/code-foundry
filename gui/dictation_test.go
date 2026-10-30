package main

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// eventLog records what the fakes were asked to do, in order.
type eventLog struct {
	mu  sync.Mutex
	evs []string
}

func (l *eventLog) add(ev string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.evs = append(l.evs, ev)
}

func (l *eventLog) get() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.evs)
}

// fakeMic is a microphone whose permission and answer the test sets. A capture
// delivers two frames, then nothing until stopped.
type fakeMic struct {
	log      *eventLog
	mu       sync.Mutex
	perm     micPermission
	answer   bool  // RequestAccess's answer; it also sets perm
	startErr error // Start fails with it
	last     *fakeCapture
}

func (m *fakeMic) setStartErr(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.startErr = err
}

// capture is the last capture Start opened.
func (m *fakeMic) capture() *fakeCapture {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.last
}

func (m *fakeMic) setPermission(p micPermission) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.perm = p
}

func (m *fakeMic) Permission() micPermission {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.log.add("permission")
	return m.perm
}

func (m *fakeMic) RequestAccess(context.Context) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.log.add("request")
	m.perm = micDenied
	if m.answer {
		m.perm = micGranted
	}
	return m.answer, nil
}

func (m *fakeMic) Start() (micCapture, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.log.add("mic.start")
	if m.startErr != nil {
		return nil, m.startErr
	}
	c := &fakeCapture{log: m.log, frames: make(chan micFrame, 2), changed: make(chan struct{}, 1)}
	c.frames <- micFrame{pcm: []byte{1, 0}, rms: 0.1}
	c.frames <- micFrame{pcm: []byte{2, 0}, rms: 0.2}
	m.last = c
	return c, nil
}

type fakeCapture struct {
	log     *eventLog
	frames  chan micFrame
	changed chan struct{}
	once    sync.Once
}

func (c *fakeCapture) Frames() <-chan micFrame { return c.frames }

func (c *fakeCapture) Changed() <-chan struct{} { return c.changed }

func (c *fakeCapture) Stop() {
	c.once.Do(func() {
		c.log.add("mic.stop")
		close(c.frames)
	})
}

// lose ends the capture's frames as a failed audio device would, without Stop.
func (c *fakeCapture) lose() { c.once.Do(func() { close(c.frames) }) }

// fakeDaemon is DictationService: each Watch reads the next stream of snapshots the
// test feeds; ending one makes the next dial a reconnect.
type fakeDaemon struct {
	log     *eventLog
	mu      sync.Mutex
	streams []chan *v1.DictationSnapshot
	watches int
}

// stream returns the i-th Watch stream's channel, creating it.
func (d *fakeDaemon) stream(i int) chan *v1.DictationSnapshot {
	d.mu.Lock()
	defer d.mu.Unlock()
	for len(d.streams) <= i {
		d.streams = append(d.streams, make(chan *v1.DictationSnapshot))
	}
	return d.streams[i]
}

func (d *fakeDaemon) Watch(ctx context.Context) (dictationStream, error) {
	d.log.add("watch")
	d.mu.Lock()
	i := d.watches
	d.watches++
	d.mu.Unlock()
	return &fakeWatch{ctx: ctx, c: d.stream(i)}, nil
}

func (d *fakeDaemon) Audio(context.Context) audioSink {
	d.log.add("audio.open")
	return &fakeSink{log: d.log}
}

func (d *fakeDaemon) MicDenied(_ context.Context, denied bool) error {
	if denied {
		d.log.add("denied:true")
	} else {
		d.log.add("denied:false")
	}
	return nil
}

func (d *fakeDaemon) Stop(_ context.Context, id string) error {
	d.log.add("stop:" + id)
	return nil
}

type fakeWatch struct {
	ctx context.Context
	c   chan *v1.DictationSnapshot
	msg *v1.DictationSnapshot
}

func (w *fakeWatch) Receive() bool {
	select {
	case <-w.ctx.Done():
		return false
	case m, ok := <-w.c:
		w.msg = m
		return ok
	}
}

func (w *fakeWatch) Msg() *v1.DictationSnapshot { return w.msg }
func (w *fakeWatch) Err() error                 { return nil }
func (w *fakeWatch) Close() error               { return nil }

type fakeSink struct{ log *eventLog }

func (s *fakeSink) Send(f *v1.DictationAudioFrame) error {
	s.log.add("frame:" + f.GetSessionId())
	return nil
}

func (s *fakeSink) Close() error {
	s.log.add("audio.close")
	return nil
}

// Snapshots for the steps.
func snapState(state v1.DictationState, denied bool) *v1.DictationSnapshot {
	return &v1.DictationSnapshot{Enabled: state != v1.DictationState_DICTATION_STATE_DISABLED, State: state, MicDenied: denied}
}

func snapListening(id string, denied bool) *v1.DictationSnapshot {
	s := snapState(v1.DictationState_DICTATION_STATE_LISTENING, denied)
	s.Session = &v1.DictationSession{Id: id, ClientId: "c"}
	return s
}

var (
	snapDisabled  = snapState(v1.DictationState_DICTATION_STATE_DISABLED, false)
	snapReady     = snapState(v1.DictationState_DICTATION_STATE_READY, false)
	snapHeartbeat = &v1.DictationSnapshot{Heartbeat: &v1.StreamHeartbeat{}}
)

// dictStep feeds snap to the current Watch stream (or ends the stream when end is set;
// or changes the permission when perm is set; or signals a hardware change on the open
// capture when change is set, after setting Start's error to startErr; or ends the
// capture's frames when lose is set), then waits for the log to be want.
type dictStep struct {
	snap     *v1.DictationSnapshot
	end      bool
	perm     *micPermission
	change   bool
	startErr error
	lose     bool
	want     []string
}

func permission(p micPermission) *micPermission { return &p }

func TestDictationWatcher(t *testing.T) {
	// Every log starts with the first Watch.
	tests := []struct {
		name   string
		perm   micPermission
		answer bool
		start  error
		steps  []dictStep
	}{
		{
			name: "disabled: no permission check, no capture",
			steps: []dictStep{
				{snap: snapDisabled, want: []string{"watch"}},
				{snap: snapState(v1.DictationState_DICTATION_STATE_DISABLED, true), want: []string{"watch"}},
				{snap: snapHeartbeat, want: []string{"watch"}},
			},
		},
		{
			name: "ready: nothing until listening",
			perm: micGranted,
			steps: []dictStep{
				{snap: snapReady, want: []string{"watch"}},
				{snap: snapHeartbeat, want: []string{"watch"}},
			},
		},
		{
			name: "granted: streams the session, closes when it ends",
			perm: micGranted,
			steps: []dictStep{
				{snap: snapReady, want: []string{"watch"}},
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
				{snap: snapHeartbeat, want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
				{snap: snapReady, want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1", "mic.stop", "audio.close"}},
			},
		},
		{
			name:   "first session asks, granted",
			perm:   micUndetermined,
			answer: true,
			steps: []dictStep{
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "request", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
			},
		},
		{
			name:   "first session asks, denied: report and stop the session",
			perm:   micUndetermined,
			answer: false,
			steps: []dictStep{
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "request", "denied:true", "stop:s1"}},
				{snap: snapState(v1.DictationState_DICTATION_STATE_READY, true), want: []string{"watch", "permission", "request", "denied:true", "stop:s1", "permission"}},
			},
		},
		{
			name: "denied before, daemon knows: stop only",
			perm: micDenied,
			steps: []dictStep{
				{snap: snapListening("s1", true), want: []string{"watch", "permission", "stop:s1"}},
			},
		},
		{
			name: "granted since the denial: report it with the session",
			perm: micGranted,
			steps: []dictStep{
				{snap: snapListening("s1", true), want: []string{"watch", "permission", "denied:false", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
			},
		},
		{
			name: "allowed in System Settings while idle: reported on a heartbeat",
			perm: micDenied,
			steps: []dictStep{
				{snap: snapState(v1.DictationState_DICTATION_STATE_READY, true), want: []string{"watch", "permission"}},
				{snap: snapHeartbeat, want: []string{"watch", "permission", "permission"}},
				{perm: permission(micGranted), want: []string{"watch", "permission", "permission"}},
				{snap: snapHeartbeat, want: []string{"watch", "permission", "permission", "permission", "denied:false"}},
				// Reported once; the daemon's next snapshot agrees.
				{snap: snapHeartbeat, want: []string{"watch", "permission", "permission", "permission", "denied:false"}},
			},
		},
		{
			name:  "no microphone: stop the session",
			perm:  micGranted,
			start: errors.New("no microphone"),
			steps: []dictStep{
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "mic.start", "stop:s1"}},
			},
		},
		{
			name: "a new session replaces the old capture",
			perm: micGranted,
			steps: []dictStep{
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
				{snap: snapListening("s2", false), want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1", "mic.stop", "audio.close",
					"permission", "mic.start", "audio.open", "frame:s2", "frame:s2"}},
			},
		},
		{
			name: "hardware change: reopens and keeps streaming the session",
			perm: micGranted,
			steps: []dictStep{
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
				{change: true, want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1",
					"mic.stop", "mic.start", "frame:s1", "frame:s1"}},
				{snap: snapReady, want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1",
					"mic.stop", "mic.start", "frame:s1", "frame:s1", "mic.stop", "audio.close"}},
			},
		},
		{
			name: "hardware change, no input to reopen: tries, then stops the session",
			perm: micGranted,
			steps: []dictStep{
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
				{change: true, startErr: errors.New("no microphone"), want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1",
					"mic.stop", "mic.start", "mic.start", "mic.start", "stop:s1", "audio.close"}},
			},
		},
		{
			name: "the microphone stops by itself: stop the session",
			perm: micGranted,
			steps: []dictStep{
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
				{lose: true, want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1", "stop:s1", "audio.close"}},
			},
		},
		{
			name: "daemon restart: capture stops, the watcher reconnects",
			perm: micGranted,
			steps: []dictStep{
				{snap: snapListening("s1", false), want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1"}},
				{end: true, want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1", "mic.stop", "audio.close", "watch"}},
				{snap: snapReady, want: []string{"watch", "permission", "mic.start", "audio.open", "frame:s1", "frame:s1", "mic.stop", "audio.close", "watch"}},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := &eventLog{}
			mic := &fakeMic{log: log, perm: tt.perm, answer: tt.answer, startErr: tt.start}
			daemon := &fakeDaemon{log: log}
			w := dictationWatcher{
				dial:       func(context.Context) (dictationConn, error) { return daemon, nil },
				mic:        mic,
				log:        slog.New(slog.DiscardHandler),
				retry:      time.Millisecond,
				reopenWait: time.Millisecond,
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				w.run(ctx)
			}()
			defer func() {
				cancel()
				<-done
			}()
			stream := 0
			for i, st := range tt.steps {
				switch {
				case st.end:
					close(daemon.stream(stream))
					stream++
				case st.perm != nil:
					mic.setPermission(*st.perm)
				case st.change:
					mic.setStartErr(st.startErr)
					mic.capture().changed <- struct{}{}
				case st.lose:
					mic.capture().lose()
				default:
					// Unbuffered: returns once the watcher has taken it.
					daemon.stream(stream) <- st.snap
				}
				waitLog(t, i, log, st.want)
			}
		})
	}
}

// waitLog waits for log to read want and stay so briefly (nothing more arrives).
func waitLog(t *testing.T, step int, log *eventLog, want []string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !slices.Equal(log.get(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("step %d: log = %q, want %q", step, log.get(), want)
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	if got := log.get(); !slices.Equal(got, want) {
		t.Fatalf("step %d: log went on to %q, want %q", step, got, want)
	}
}
