package main

import (
	"context"
	"log/slog"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/client"
)

// dictationRetry is how long the watcher waits before reconnecting to the daemon.
const dictationRetry = 2 * time.Second

// dictationStream is the client side of DictationService.Watch.
type dictationStream interface {
	Receive() bool
	Msg() *v1.DictationSnapshot
	Err() error
	Close() error
}

// audioSink is an open DictationService.Audio client stream.
type audioSink interface {
	Send(*v1.DictationAudioFrame) error
	// Close ends the stream and waits for the daemon's reply.
	Close() error
}

// dictationConn is DictationService as the watcher uses it (daemonDictation; a fake in
// tests).
type dictationConn interface {
	Watch(ctx context.Context) (dictationStream, error)
	Audio(ctx context.Context) audioSink
	MicDenied(ctx context.Context, denied bool) error
	Stop(ctx context.Context, sessionID string) error
}

// dictationWatcher makes the host the daemon's microphone (docs/notes/dictation-3-host.md):
// it follows DictationService.Watch and, while the snapshot is LISTENING, captures the
// microphone and streams it to the session with DictationService.Audio. It asks for the
// microphone permission on the first session, never before, and touches nothing while
// dictation is off. Fields are injectable for tests; watchDictation fills them.
type dictationWatcher struct {
	// dial connects to the daemon; ending ctx must end what it opened.
	dial  func(ctx context.Context) (dictationConn, error)
	mic   microphone
	log   *slog.Logger
	retry time.Duration
}

// watchDictation runs the dictation watcher over the host's daemon client until ctx
// ends, reconnecting when the daemon restarts (connectDaemon may start it).
func watchDictation(ctx context.Context, connectDaemon func(context.Context) (*client.Client, error), mic microphone, log *slog.Logger) {
	w := dictationWatcher{
		dial: func(ctx context.Context) (dictationConn, error) {
			c, err := connectDaemon(ctx)
			if err != nil {
				return nil, err
			}
			return daemonDictation{c.Dictation}, nil
		},
		mic:   mic,
		log:   log,
		retry: dictationRetry,
	}
	w.run(ctx)
}

// run watches until ctx ends.
func (w *dictationWatcher) run(ctx context.Context) {
	for ctx.Err() == nil {
		err := w.once(ctx)
		if ctx.Err() != nil {
			return
		}
		w.log.Debug("dictation watch ended; reconnecting", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.retry):
		}
	}
}

// micSession is the capture for one listening session.
type micSession struct {
	id     string
	cancel context.CancelFunc
	done   chan struct{}
}

// stop ends the session's capture and waits for it.
func (s *micSession) stop() {
	s.cancel()
	<-s.done
}

// once follows one Watch stream until it ends. Ending it stops any capture.
func (w *dictationWatcher) once(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	conn, err := w.dial(ctx)
	if err != nil {
		return err
	}
	stream, err := conn.Watch(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = stream.Close() }()

	var sess *micSession
	defer func() {
		if sess != nil {
			sess.stop()
		}
	}()
	// The daemon's view, from the last snapshot (a heartbeat carries none).
	var enabled, denied bool
	for stream.Receive() {
		snap := stream.Msg()
		if snap.GetHeartbeat() == nil {
			enabled, denied = snap.GetEnabled(), snap.GetMicDenied()
			id := ""
			if snap.GetState() == v1.DictationState_DICTATION_STATE_LISTENING {
				id = snap.GetSession().GetId()
			}
			if sess != nil && sess.id != id {
				sess.stop()
				sess = nil
			}
			if sess == nil && id != "" {
				sess = w.startSession(ctx, conn, id, denied)
			}
		}
		// The user may have allowed the microphone in System Settings since it was
		// denied: tell the daemon (checked on every snapshot and heartbeat, so within
		// seconds). A session checks for itself.
		if enabled && denied && sess == nil && w.mic.Permission() == micGranted {
			w.reportDenied(ctx, conn, false)
			denied = false
		}
	}
	return stream.Err()
}

// startSession runs the capture for session id until stop. daemonDenied is what the
// daemon last said about the permission.
func (w *dictationWatcher) startSession(connCtx context.Context, conn dictationConn, id string, daemonDenied bool) *micSession {
	ctx, cancel := context.WithCancel(connCtx)
	s := &micSession{id: id, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(s.done)
		w.capture(ctx, connCtx, conn, id, daemonDenied)
	}()
	return s
}

// capture asks for the microphone if needed, then streams it to session id until ctx
// ends. Without the microphone it reports the denial and stops the session, so the
// composer returns to idle and shows why. The audio stream lives on connCtx so it is
// closed cleanly, not cancelled, when the session ends.
func (w *dictationWatcher) capture(ctx, connCtx context.Context, conn dictationConn, id string, daemonDenied bool) {
	perm := w.mic.Permission()
	if perm == micUndetermined {
		w.log.Info("dictation: asking for the microphone")
		granted, err := w.mic.RequestAccess(ctx)
		switch {
		case ctx.Err() != nil:
			return
		case err != nil:
			w.log.Warn("dictation: microphone permission", "err", err)
		}
		perm = micDenied
		if granted {
			perm = micGranted
		}
	}
	if perm != micGranted {
		w.log.Info("dictation: microphone denied; stopping the session", "session", id)
		if !daemonDenied {
			w.reportDenied(ctx, conn, true)
		}
		w.stopSession(ctx, conn, id)
		return
	}
	if daemonDenied {
		w.reportDenied(ctx, conn, false)
	}
	mic, err := w.mic.Start()
	if err != nil {
		w.log.Warn("dictation: cannot open the microphone; stopping the session", "session", id, "err", err)
		w.stopSession(ctx, conn, id)
		return
	}
	w.log.Info("dictation: microphone open", "session", id)
	sink := conn.Audio(connCtx)
	defer func() {
		mic.Stop()
		if err := sink.Close(); err != nil && connCtx.Err() == nil {
			w.log.Debug("dictation: audio stream", "err", err)
		}
		w.log.Info("dictation: microphone closed", "session", id)
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-mic.Frames():
			if !ok {
				w.log.Warn("dictation: the microphone stopped", "session", id)
				return
			}
			if err := sink.Send(&v1.DictationAudioFrame{SessionId: id, Pcm: f.pcm, Rms: f.rms}); err != nil {
				w.log.Debug("dictation: audio stream", "err", err)
				return
			}
		}
	}
}

func (w *dictationWatcher) reportDenied(ctx context.Context, conn dictationConn, denied bool) {
	if err := conn.MicDenied(ctx, denied); err != nil {
		w.log.Warn("dictation: report microphone permission", "denied", denied, "err", err)
	}
}

func (w *dictationWatcher) stopSession(ctx context.Context, conn dictationConn, id string) {
	if err := conn.Stop(ctx, id); err != nil {
		w.log.Warn("dictation: stop session", "session", id, "err", err)
	}
}

// daemonDictation is dictationConn over the daemon's DictationService client.
type daemonDictation struct {
	c codefoundryv1connect.DictationServiceClient
}

func (d daemonDictation) Watch(ctx context.Context) (dictationStream, error) {
	return d.c.Watch(ctx, connect.NewRequest(&v1.WatchDictationRequest{}))
}

func (d daemonDictation) Audio(ctx context.Context) audioSink {
	return audioStream{d.c.Audio(ctx)}
}

func (d daemonDictation) MicDenied(ctx context.Context, denied bool) error {
	_, err := d.c.MicDenied(ctx, connect.NewRequest(&v1.DictationMicDeniedRequest{Denied: denied}))
	return err
}

func (d daemonDictation) Stop(ctx context.Context, sessionID string) error {
	_, err := d.c.Stop(ctx, connect.NewRequest(&v1.StopDictationRequest{SessionId: sessionID}))
	return err
}

type audioStream struct {
	s *connect.ClientStreamForClient[v1.DictationAudioFrame, v1.DictationAudioResponse]
}

func (a audioStream) Send(f *v1.DictationAudioFrame) error { return a.s.Send(f) }

func (a audioStream) Close() error {
	_, err := a.s.CloseAndReceive()
	return err
}
