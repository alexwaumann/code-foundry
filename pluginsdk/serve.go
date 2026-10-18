package pluginsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// CommandFunc runs one of the manifest's commands.
type CommandFunc func(ctx context.Context, h *Host, req CommandRequest) (CommandResult, error)

// SurfaceFactory opens one instance of a surface (a side-panel tab for one thread, say).
// The surface then pushes views with Host.UpdateView(open.Instance, view).
type SurfaceFactory func(ctx context.Context, h *Host, open SurfaceOpen) (Surface, error)

// Surface is one open surface instance.
type Surface interface {
	// Act handles the user acting on the view (a click, a submit, a change, a tab). An
	// error's message is shown to the user.
	Act(ctx context.Context, act SurfaceAct) error
	// Visibility reports whether anyone is looking; a hidden surface may stop polling.
	Visibility(visible bool)
	// Close ends the instance, saying why (CloseIdle, CloseContextGone,
	// CloseUnavailable, CloseShutdown, CloseReopened; another host may send another).
	// Stop its pollers; state that must outlive it belongs to the plugin, not the Surface.
	Close(reason CloseReason)
}

// Plugin is what a plugin implements. Every field is optional.
type Plugin struct {
	// Init runs once the host has finished the handshake (after initialized): subscribe,
	// push the environment, set context. An error ends Serve; the host restarts the
	// plugin with backoff.
	Init func(ctx context.Context, h *Host) error
	// Commands by manifest name ("greet").
	Commands map[string]CommandFunc
	// Surfaces by manifest surface id.
	Surfaces map[string]SurfaceFactory
	// OnEvent receives subscribed events in order.
	OnEvent func(ctx context.Context, h *Host, ev Event)
	// OnTerminalExit learns that the process of one of its terminals exited (terminal/
	// exited): read what it printed with Host.ReadTerminal, close it when done.
	OnTerminalExit func(ctx context.Context, h *Host, ex TerminalExited)
	// OnSecretChanged learns that the user deleted one of its secrets (`plugin secrets
	// delete`, Settings): drop what was read from it and ask again (a form, a notice).
	OnSecretChanged func(ctx context.Context, h *Host, c SecretChanged)
	// Shutdown runs when the host asks the plugin to stop (it has about 2 seconds).
	Shutdown func(ctx context.Context, h *Host)
	// Capabilities the plugin announces in addition to the SDK's own.
	Capabilities []string
}

// Serve runs p over stdin and stdout until the host shuts it down or closes stdin. It
// points os.Stdout at stderr first, so a stray fmt.Println lands in the log instead of
// corrupting the protocol.
func Serve(p Plugin) error {
	out := os.Stdout
	os.Stdout = os.Stderr
	return ServeConn(context.Background(), os.Stdin, out, p)
}

// ServeConn is Serve over any reader and writer (tests, other transports).
func ServeConn(ctx context.Context, r io.Reader, w io.Writer, p Plugin) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &server{p: p, ctx: ctx, stop: make(chan struct{}), ready: make(chan struct{}), surfaces: map[string]Surface{}}
	conn := NewConn(r, w, ConnOptions{
		Handle: s.handle,
		Notify: s.notify,
		OnIssue: func(msg string) {
			fmt.Fprintln(os.Stderr, "pluginsdk:", msg)
		},
		Answered: func(method string) {
			if method == MethodShutdown {
				s.stopOnce.Do(func() { close(s.stop) })
			}
		},
	})
	s.h = newHost(conn)
	close(s.ready)
	var err error
	select {
	case <-ctx.Done():
	case <-conn.Done():
		if e := conn.Err(); e != nil && !errors.Is(e, io.EOF) && !errors.Is(e, ErrClosed) {
			err = e
		}
	case <-s.stop:
	case err = <-s.failed():
	}
	s.closeSurfaces()
	_ = conn.Close()
	select {
	case <-conn.Drained():
	case <-time.After(time.Second):
	}
	return err
}

type server struct {
	p        Plugin
	h        *Host
	ctx      context.Context
	stop     chan struct{}
	stopOnce sync.Once
	ready    chan struct{} // closed once h is set; handlers wait for it

	errMu sync.Mutex
	errc  chan error

	smu      sync.Mutex
	surfaces map[string]Surface
}

func (s *server) failed() chan error {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	if s.errc == nil {
		s.errc = make(chan error, 1)
	}
	return s.errc
}

// handle answers the host's requests.
func (s *server) handle(ctx context.Context, method string, params json.RawMessage) (any, error) {
	<-s.ready
	switch method {
	case MethodInitialize:
		var p InitializeParams
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, NewError(CodeInvalidParams, "initialize: %v", err)
		}
		s.h.setInit(p)
		caps := []string{"ping"}
		if len(s.p.Surfaces) > 0 {
			caps = append(caps, "surfaces")
		}
		return InitializeResult{Protocol: ProtocolVersion, Capabilities: append(caps, s.p.Capabilities...)}, nil
	case MethodPing:
		return struct{}{}, nil
	case MethodShutdown:
		if s.p.Shutdown != nil {
			sctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
			s.p.Shutdown(sctx, s.h)
			cancel()
		}
		return struct{}{}, nil
	case MethodCommandInvoke:
		var req CommandRequest
		if err := json.Unmarshal(params, &req); err != nil {
			return nil, NewError(CodeInvalidParams, "command/invoke: %v", err)
		}
		fn, ok := s.p.Commands[req.Command]
		if !ok {
			return nil, NewError(CodeNotFound, "no command %q in this plugin", req.Command)
		}
		return fn(ctx, s.h, req)
	case MethodSurfaceOpen:
		return s.openSurface(ctx, params)
	case MethodSurfaceAct:
		var act SurfaceAct
		if err := json.Unmarshal(params, &act); err != nil {
			return nil, NewError(CodeInvalidParams, "surface/act: %v", err)
		}
		sf, ok := s.surface(act.Instance)
		if !ok {
			return nil, NewError(CodeNotFound, "no open surface %q", act.Instance)
		}
		return struct{}{}, sf.Act(ctx, act)
	}
	return nil, NewError(CodeMethodNotFound, "method %q not supported by this plugin", method)
}

// notify handles the host's notifications.
func (s *server) notify(ctx context.Context, method string, params json.RawMessage) {
	<-s.ready
	switch method {
	case MethodInitialized:
		if s.p.Init == nil {
			return
		}
		go func() {
			if err := s.p.Init(s.ctx, s.h); err != nil {
				s.h.Log().Error("init failed", "err", err.Error())
				s.failed() <- fmt.Errorf("init: %w", err)
			}
		}()
	case MethodEventsEvent:
		if s.p.OnEvent == nil {
			return
		}
		var ev Event
		if json.Unmarshal(params, &ev) == nil {
			s.p.OnEvent(ctx, s.h, ev)
		}
	case MethodTerminalExited:
		var ex TerminalExited
		if s.p.OnTerminalExit != nil && json.Unmarshal(params, &ex) == nil {
			s.p.OnTerminalExit(ctx, s.h, ex)
		}
	case MethodSecretChanged:
		var c SecretChanged
		if s.p.OnSecretChanged != nil && json.Unmarshal(params, &c) == nil {
			s.p.OnSecretChanged(ctx, s.h, c)
		}
	case MethodSurfaceVisibility:
		var p struct {
			Instance string `json:"instance"`
			Visible  bool   `json:"visible"`
		}
		if json.Unmarshal(params, &p) == nil {
			if sf, ok := s.surface(p.Instance); ok {
				sf.Visibility(p.Visible)
			}
		}
	case MethodSurfaceClose:
		var p SurfaceClose
		if json.Unmarshal(params, &p) == nil {
			s.smu.Lock()
			sf, ok := s.surfaces[p.Instance]
			delete(s.surfaces, p.Instance)
			s.smu.Unlock()
			if ok {
				if p.Reason == "" {
					p.Reason = CloseIdle
				}
				sf.Close(p.Reason)
			}
		}
	}
}

func (s *server) openSurface(ctx context.Context, params json.RawMessage) (any, error) {
	var open SurfaceOpen
	if err := json.Unmarshal(params, &open); err != nil {
		return nil, NewError(CodeInvalidParams, "surface/open: %v", err)
	}
	f, ok := s.p.Surfaces[open.Surface]
	if !ok {
		return nil, NewError(CodeNotFound, "no surface %q in this plugin", open.Surface)
	}
	sf, err := f(s.ctx, s.h, open)
	if err != nil {
		return nil, err
	}
	s.smu.Lock()
	old := s.surfaces[open.Instance]
	s.surfaces[open.Instance] = sf
	s.smu.Unlock()
	if old != nil {
		old.Close(CloseReopened)
	}
	return struct{}{}, nil
}

func (s *server) surface(instance string) (Surface, bool) {
	s.smu.Lock()
	defer s.smu.Unlock()
	sf, ok := s.surfaces[instance]
	return sf, ok
}

func (s *server) closeSurfaces() {
	s.smu.Lock()
	all := s.surfaces
	s.surfaces = map[string]Surface{}
	s.smu.Unlock()
	for _, sf := range all {
		sf.Close(CloseShutdown)
	}
}
