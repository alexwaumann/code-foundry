// Package plugintest is a fake Code Foundry host for plugin unit tests. Start runs a
// pluginsdk.Plugin over in-memory pipes, performs the handshake, and records what the
// plugin asks of the host; the test drives it with Command, Event and Shutdown.
//
//	h := plugintest.Start(t, myPlugin(), plugintest.Options{Granted: pluginsdk.Permissions{Secrets: true}})
//	res, err := h.Command(ctx, "greet", map[string]string{"name": "Ada"}, pluginsdk.UiContext{})
//
// Permissions are enforced like the real host: host/invoke needs a matching
// permissions.commands glob and secret/* needs permissions.secrets.
package plugintest

import (
	"context"
	"encoding/json"
	"io"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Options configures Start.
type Options struct {
	// Name is the plugin's name (default "test").
	Name string
	// DataDir is the plugin's data dir (default t.TempDir()).
	DataDir string
	Granted pluginsdk.Permissions
	// Invoke answers host/invoke calls the permissions allow. Nil answers
	// CodeNotFound ("unknown command").
	Invoke func(ctx context.Context, p pluginsdk.InvokeParams) (pluginsdk.CommandResult, error)
	// Capabilities are the host capabilities announced in initialize.
	Capabilities []string
}

// Host is the fake host.
type Host struct {
	t    testing.TB
	opts Options
	conn *pluginsdk.Conn
	done chan error

	mu          sync.Mutex
	changed     chan struct{} // closed and replaced on every recorded call
	invocations []pluginsdk.InvokeParams
	logs        []pluginsdk.LogParams
	secrets     map[string]pluginsdk.SecretInfo
	values      map[string]string
	flags       []pluginsdk.Flag
	toasts      []pluginsdk.ToastParams
	contexts    []pluginsdk.ContextParams
	views       map[string]json.RawMessage
	versions    map[string]uint64
	appends     []pluginsdk.ViewAppendParams
	envs        []pluginsdk.Environment
	subs        [][]string
	closeOnce   sync.Once
}

// Start serves p against a new fake host and completes the handshake. The plugin is
// shut down when the test ends.
func Start(t testing.TB, p pluginsdk.Plugin, opts Options) *Host {
	t.Helper()
	if opts.Name == "" {
		opts.Name = "test"
	}
	if opts.DataDir == "" {
		opts.DataDir = t.TempDir()
	}
	h := &Host{t: t, opts: opts, done: make(chan error, 1), changed: make(chan struct{}),
		secrets: map[string]pluginsdk.SecretInfo{}, values: map[string]string{}, views: map[string]json.RawMessage{}, versions: map[string]uint64{}}
	toPluginR, toPluginW := io.Pipe()
	toHostR, toHostW := io.Pipe()
	go func() {
		err := pluginsdk.ServeConn(context.Background(), toPluginR, toHostW, p)
		_ = toHostW.Close()
		h.done <- err
	}()
	h.conn = pluginsdk.NewConn(toHostR, toPluginW, pluginsdk.ConnOptions{
		Handle:  h.handle,
		Notify:  h.notify,
		OnIssue: func(msg string) { t.Logf("plugintest: %s", msg) },
	})
	t.Cleanup(func() {
		h.Close()
		_ = toPluginW.Close()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var res pluginsdk.InitializeResult
	if err := h.conn.Call(ctx, pluginsdk.MethodInitialize, pluginsdk.InitializeParams{
		Protocol: pluginsdk.ProtocolVersion,
		Host:     pluginsdk.HostInfo{Version: "test", Capabilities: opts.Capabilities},
		Plugin:   pluginsdk.PluginInfo{Name: opts.Name, DataDir: opts.DataDir, Granted: opts.Granted},
	}, &res); err != nil {
		t.Fatalf("plugintest: initialize: %v", err)
	}
	if err := h.conn.Notify(pluginsdk.MethodInitialized, struct{}{}); err != nil {
		t.Fatalf("plugintest: initialized: %v", err)
	}
	return h
}

// Command invokes one of the plugin's commands (command/invoke).
func (h *Host) Command(ctx context.Context, name string, args map[string]string, uctx pluginsdk.UiContext) (pluginsdk.CommandResult, error) {
	var res pluginsdk.CommandResult
	err := h.conn.Call(ctx, pluginsdk.MethodCommandInvoke, pluginsdk.CommandRequest{Command: name, Args: args, Context: uctx}, &res)
	return res, err
}

// OpenSurface opens a surface instance (surface/open) and tells the plugin it is
// visible, as the host does for its first viewer. The plugin's views arrive in View.
func (h *Host) OpenSurface(ctx context.Context, instance, surface string, uctx pluginsdk.UiContext) error {
	if err := h.conn.Call(ctx, pluginsdk.MethodSurfaceOpen, pluginsdk.SurfaceOpen{Instance: instance, Surface: surface, Context: uctx}, nil); err != nil {
		return err
	}
	return h.conn.Notify(pluginsdk.MethodSurfaceVisibility, pluginsdk.SurfaceVisibility{Instance: instance, Visible: true})
}

// Act sends surface/act. A zero act.Version is the instance's latest.
func (h *Host) Act(ctx context.Context, act pluginsdk.SurfaceAct) error {
	if act.Version == 0 {
		act.Version = h.Version(act.Instance)
	}
	return h.conn.Call(ctx, pluginsdk.MethodSurfaceAct, act, nil)
}

// Visibility sends surface/visibility.
func (h *Host) Visibility(instance string, visible bool) error {
	return h.conn.Notify(pluginsdk.MethodSurfaceVisibility, pluginsdk.SurfaceVisibility{Instance: instance, Visible: visible})
}

// CloseSurface sends surface/close.
func (h *Host) CloseSurface(instance string) error {
	return h.conn.Notify(pluginsdk.MethodSurfaceClose, pluginsdk.SurfaceClose{Instance: instance, Reason: "idle"})
}

// Ping pings the plugin.
func (h *Host) Ping(ctx context.Context) error {
	return h.conn.Call(ctx, pluginsdk.MethodPing, struct{}{}, nil)
}

// Event delivers an events/event notification.
func (h *Host) Event(ev pluginsdk.Event) error {
	return h.conn.Notify(pluginsdk.MethodEventsEvent, ev)
}

// Shutdown asks the plugin to stop and returns what Serve returned.
func (h *Host) Shutdown(ctx context.Context) error {
	if err := h.conn.Call(ctx, pluginsdk.MethodShutdown, struct{}{}, nil); err != nil {
		return err
	}
	select {
	case err := <-h.done:
		h.done <- err
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close closes the host side; the plugin sees its stdin end.
func (h *Host) Close() {
	h.closeOnce.Do(func() { _ = h.conn.Close() })
}

// WaitFor waits until cond, checked after every recorded call, is true. It fails the
// test after timeout.
func (h *Host) WaitFor(timeout time.Duration, cond func(h *Host) bool) {
	h.t.Helper()
	deadline := time.After(timeout)
	for {
		h.mu.Lock()
		ch := h.changed
		h.mu.Unlock()
		if cond(h) {
			return
		}
		select {
		case <-ch:
		case <-deadline:
			h.t.Fatalf("plugintest: condition not met after %s", timeout)
		}
	}
}

func (h *Host) record(fn func()) {
	h.mu.Lock()
	fn()
	close(h.changed)
	h.changed = make(chan struct{})
	h.mu.Unlock()
}

// Invocations returns the host/invoke calls the plugin made (allowed or not).
func (h *Host) Invocations() []pluginsdk.InvokeParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.invocations)
}

// Logs returns the log notifications.
func (h *Host) Logs() []pluginsdk.LogParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.logs)
}

// Secret returns a stored secret.
func (h *Host) Secret(key string) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	v, ok := h.values[key]
	return v, ok
}

// SetSecret stores a secret as if the user had (a form with store, say).
func (h *Host) SetSecret(key, value string) {
	h.record(func() {
		h.values[key] = value
		h.secrets[key] = pluginsdk.SecretInfo{Key: key, UpdatedAt: time.Now()}
	})
}

// Flags returns the thread/setFlag calls.
func (h *Host) Flags() []pluginsdk.Flag {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.flags)
}

// Toasts returns the view/toast notifications.
func (h *Host) Toasts() []pluginsdk.ToastParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.toasts)
}

// Contexts returns the context/set notifications.
func (h *Host) Contexts() []pluginsdk.ContextParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.contexts)
}

// View returns the last view/update of an instance.
func (h *Host) View(instance string) (json.RawMessage, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	v, ok := h.views[instance]
	return v, ok
}

// Version returns how many views an instance has had (its latest version).
func (h *Host) Version(instance string) uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.versions[instance]
}

// Appends returns the view/append calls.
func (h *Host) Appends() []pluginsdk.ViewAppendParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.appends)
}

// Environments returns the session/setEnvironment calls.
func (h *Host) Environments() []pluginsdk.Environment {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.envs)
}

// Subscriptions returns the events/subscribe calls' sources.
func (h *Host) Subscriptions() [][]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.subs)
}

func decode[T any](params json.RawMessage) (T, error) {
	var v T
	if err := json.Unmarshal(params, &v); err != nil {
		return v, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%v", err)
	}
	return v, nil
}

func denied(what string) error {
	return pluginsdk.NewError(pluginsdk.CodePermissionDenied, "permission denied: %s", what)
}

func (h *Host) handle(ctx context.Context, method string, params json.RawMessage) (any, error) {
	g := h.opts.Granted
	switch method {
	case pluginsdk.MethodHostInvoke:
		p, err := decode[pluginsdk.InvokeParams](params)
		if err != nil {
			return nil, err
		}
		h.record(func() { h.invocations = append(h.invocations, p) })
		if !g.AllowsCommand(p.Command) {
			return nil, denied("command " + p.Command)
		}
		if h.opts.Invoke == nil {
			return nil, pluginsdk.NewError(pluginsdk.CodeNotFound, "unknown command %q", p.Command)
		}
		return h.opts.Invoke(ctx, p)
	case pluginsdk.MethodSecretGet, pluginsdk.MethodSecretSet, pluginsdk.MethodSecretDelete, pluginsdk.MethodSecretList:
		if !g.Secrets {
			return nil, denied("secrets")
		}
		return h.secret(method, params)
	case pluginsdk.MethodThreadSetFlag:
		if !g.ThreadStatus {
			return nil, denied("threadStatus")
		}
		f, err := decode[pluginsdk.Flag](params)
		if err != nil {
			return nil, err
		}
		h.record(func() { h.flags = append(h.flags, f) })
		return struct{}{}, nil
	case pluginsdk.MethodSetEnvironment:
		if !g.SessionEnv {
			return nil, denied("sessionEnv")
		}
		e, err := decode[pluginsdk.Environment](params)
		if err != nil {
			return nil, err
		}
		h.record(func() { h.envs = append(h.envs, e) })
		return pluginsdk.EnvironmentResult{Applied: true}, nil
	case pluginsdk.MethodEventsSubscribe:
		p, err := decode[pluginsdk.SubscribeParams](params)
		if err != nil {
			return nil, err
		}
		for _, s := range p.Sources {
			if !slices.Contains(g.Events, s) {
				return nil, denied("events " + s)
			}
		}
		var id string
		h.record(func() {
			h.subs = append(h.subs, p.Sources)
			id = "sub-" + strconv.Itoa(len(h.subs))
		})
		return pluginsdk.SubscribeResult{Subscription: id}, nil
	case pluginsdk.MethodEventsUnsubscribe:
		return struct{}{}, nil
	case pluginsdk.MethodViewUpdate:
		p, err := decode[pluginsdk.ViewUpdateParams](params)
		if err != nil {
			return nil, err
		}
		var v uint64
		h.record(func() {
			h.views[p.Instance] = p.View
			h.versions[p.Instance]++
			v = h.versions[p.Instance]
		})
		return pluginsdk.ViewUpdateResult{Version: v}, nil
	case pluginsdk.MethodViewAppend:
		p, err := decode[pluginsdk.ViewAppendParams](params)
		if err != nil {
			return nil, err
		}
		h.record(func() { h.appends = append(h.appends, p) })
		return pluginsdk.ViewUpdateResult{Version: h.Version(p.Instance)}, nil
	}
	return nil, pluginsdk.NewError(pluginsdk.CodeMethodNotFound, "method %q not supported by plugintest", method)
}

func (h *Host) secret(method string, params json.RawMessage) (any, error) {
	switch method {
	case pluginsdk.MethodSecretGet:
		p, err := decode[pluginsdk.SecretKeyParams](params)
		if err != nil {
			return nil, err
		}
		v, ok := h.Secret(p.Key)
		return pluginsdk.SecretGetResult{Value: v, Found: ok}, nil
	case pluginsdk.MethodSecretSet:
		p, err := decode[pluginsdk.SecretSetParams](params)
		if err != nil {
			return nil, err
		}
		if p.Key == "" || p.Value == "" {
			return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "key and value are required")
		}
		h.SetSecret(p.Key, p.Value)
		return struct{}{}, nil
	case pluginsdk.MethodSecretDelete:
		p, err := decode[pluginsdk.SecretKeyParams](params)
		if err != nil {
			return nil, err
		}
		h.record(func() {
			delete(h.values, p.Key)
			delete(h.secrets, p.Key)
		})
		return struct{}{}, nil
	default:
		h.mu.Lock()
		var out []pluginsdk.SecretInfo
		for _, s := range h.secrets {
			out = append(out, s)
		}
		h.mu.Unlock()
		slices.SortFunc(out, func(a, b pluginsdk.SecretInfo) int {
			switch {
			case a.Key < b.Key:
				return -1
			case a.Key > b.Key:
				return 1
			}
			return 0
		})
		return pluginsdk.SecretListResult{Secrets: out}, nil
	}
}

func (h *Host) notify(_ context.Context, method string, params json.RawMessage) {
	switch method {
	case pluginsdk.MethodLog:
		if p, err := decode[pluginsdk.LogParams](params); err == nil {
			h.record(func() { h.logs = append(h.logs, p) })
		}
	case pluginsdk.MethodViewToast:
		if p, err := decode[pluginsdk.ToastParams](params); err == nil {
			h.record(func() { h.toasts = append(h.toasts, p) })
		}
	case pluginsdk.MethodContextSet:
		if p, err := decode[pluginsdk.ContextParams](params); err == nil {
			h.record(func() { h.contexts = append(h.contexts, p) })
		}
	case pluginsdk.MethodViewUpdate:
		if p, err := decode[pluginsdk.ViewUpdateParams](params); err == nil {
			h.record(func() {
				h.views[p.Instance] = p.View
				h.versions[p.Instance]++
			})
		}
	}
}
