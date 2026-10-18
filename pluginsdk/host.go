package pluginsdk

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync"
)

// Host is the plugin's handle on Code Foundry. Every method is one protocol call over
// stdio; the host checks each against the manifest's permissions.
type Host struct {
	conn *Conn
	log  *slog.Logger

	mu   sync.Mutex
	init InitializeParams
}

func newHost(conn *Conn) *Host {
	h := &Host{conn: conn}
	h.log = slog.New(&logHandler{conn: conn, level: slog.LevelDebug})
	return h
}

func (h *Host) setInit(p InitializeParams) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init = p
}

func (h *Host) info() InitializeParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.init
}

// Name is the plugin's name.
func (h *Host) Name() string { return h.info().Plugin.Name }

// Dir is the plugin's package directory.
func (h *Host) Dir() string { return h.info().Plugin.Dir }

// DataDir is the plugin's own state directory (0700), kept across updates.
func (h *Host) DataDir() string { return h.info().Plugin.DataDir }

// Granted is what the user consented to.
func (h *Host) Granted() Permissions { return h.info().Plugin.Granted }

// Dev reports whether the plugin runs in dev mode (plugin dev).
func (h *Host) Dev() bool { return h.info().Plugin.Dev }

// HostVersion is the Code Foundry version.
func (h *Host) HostVersion() string { return h.info().Host.Version }

// HasCapability reports whether the host announced a capability ("surfaces", …).
func (h *Host) HasCapability(c string) bool {
	return slices.Contains(h.info().Host.Capabilities, c)
}

// Log returns a logger whose records go to the plugin's log in Code Foundry
// (`code-foundry plugin logs <name>`).
func (h *Host) Log() *slog.Logger { return h.log }

// Invoke runs a Code Foundry command as the plugin: `thread.send` with
// UiContext{ThreadID: id} and args {"text": "…"}. The command must match one of the
// manifest's permissions.commands globs. A command that asks the user first fails with
// CodeConfirmationRequired; a plugin never confirms on the user's behalf.
func (h *Host) Invoke(ctx context.Context, command string, args map[string]string, uctx UiContext) (CommandResult, error) {
	var res CommandResult
	err := h.conn.Call(ctx, MethodHostInvoke, InvokeParams{Command: command, Args: args, Context: uctx}, &res)
	return res, err
}

// SetFlag raises or clears the plugin's flag on a thread (permission threadStatus).
func (h *Host) SetFlag(ctx context.Context, f Flag) error {
	return h.conn.Call(ctx, MethodThreadSetFlag, f, nil)
}

// Flags are the plugin's flags on threads as the host had them at initialize (they
// outlive restarts): reconcile them in Init.
func (h *Host) Flags() []Flag { return slices.Clone(h.info().Flags) }

// SetContext sets a predicate key ("<plugin>.<key>") the host's when-clauses read.
func (h *Host) SetContext(p ContextParams) error {
	return h.conn.Notify(MethodContextSet, p)
}

// SetEnvironment pushes the plugin's contribution to new Claude sessions (permission
// sessionEnv). Push it again whenever it changes; an empty Environment withdraws it.
func (h *Host) SetEnvironment(ctx context.Context, env Environment) (EnvironmentResult, error) {
	var res EnvironmentResult
	err := h.conn.Call(ctx, MethodSetEnvironment, env, &res)
	return res, err
}

// Subscribe asks for events from sources (permission events); they arrive in
// Plugin.OnEvent, each source's snapshot first. It returns the subscription id (the
// first events may reach OnEvent before Subscribe returns). Subscriptions end with the
// plugin's process.
func (h *Host) Subscribe(ctx context.Context, sources ...string) (string, error) {
	var res SubscribeResult
	err := h.conn.Call(ctx, MethodEventsSubscribe, SubscribeParams{Sources: sources}, &res)
	return res.Subscription, err
}

// Unsubscribe ends a subscription.
func (h *Host) Unsubscribe(ctx context.Context, subscription string) error {
	return h.conn.Call(ctx, MethodEventsUnsubscribe, SubscribeResult{Subscription: subscription}, nil)
}

// Toast shows a short message (ToastInfo, ToastAttention, ToastError) in the GUI.
func (h *Host) Toast(level, text string) error {
	return h.conn.Notify(MethodViewToast, ToastParams{Level: level, Text: text})
}

// UpdateView replaces a surface instance's view. view is a ui.View (or any value
// encoding to the view model's JSON).
func (h *Host) UpdateView(instance string, view any) error {
	if v, ok := view.(interface{ Validate() error }); ok {
		if err := v.Validate(); err != nil {
			return fmt.Errorf("pluginsdk: view for %s: %w", instance, err)
		}
	}
	raw, err := json.Marshal(view)
	if err != nil {
		return fmt.Errorf("pluginsdk: encode view: %w", err)
	}
	return h.conn.Notify(MethodViewUpdate, ViewUpdateParams{Instance: instance, View: raw})
}

// Secrets is the plugin's namespace in the host's secret store (the user's Keychain).
// Values travel host → plugin only; the host never logs or shows them.
func (h *Host) Secrets() Secrets { return Secrets{h: h} }

// Secrets reads and writes the plugin's secrets (permission secrets).
type Secrets struct{ h *Host }

// Get returns a secret's value and whether it is set.
func (s Secrets) Get(ctx context.Context, key string) (string, bool, error) {
	var res SecretGetResult
	if err := s.h.conn.Call(ctx, MethodSecretGet, SecretKeyParams{Key: key}, &res); err != nil {
		return "", false, err
	}
	return res.Value, res.Found, nil
}

// Set stores a secret (non-empty; Delete removes one).
func (s Secrets) Set(ctx context.Context, key, value string) error {
	return s.h.conn.Call(ctx, MethodSecretSet, SecretSetParams{Key: key, Value: value}, nil)
}

// Delete removes a secret; removing an unset one is not an error.
func (s Secrets) Delete(ctx context.Context, key string) error {
	return s.h.conn.Call(ctx, MethodSecretDelete, SecretKeyParams{Key: key}, nil)
}

// List returns the stored secrets' names and when they were set.
func (s Secrets) List(ctx context.Context) ([]SecretInfo, error) {
	var res SecretListResult
	if err := s.h.conn.Call(ctx, MethodSecretList, struct{}{}, &res); err != nil {
		return nil, err
	}
	return res.Secrets, nil
}

// logHandler sends slog records as log notifications.
type logHandler struct {
	conn   *Conn
	level  slog.Level
	attrs  []slog.Attr
	groups []string
}

func (l *logHandler) Enabled(_ context.Context, lv slog.Level) bool { return lv >= l.level }

func (l *logHandler) Handle(_ context.Context, r slog.Record) error {
	attrs := map[string]any{}
	prefix := ""
	for _, g := range l.groups {
		prefix += g + "."
	}
	for _, a := range l.attrs {
		flatten(attrs, "", a)
	}
	r.Attrs(func(a slog.Attr) bool {
		flatten(attrs, prefix, a)
		return true
	})
	p := LogParams{Level: levelName(r.Level), Msg: r.Message}
	if len(attrs) > 0 {
		p.Attrs = attrs
	}
	if err := l.conn.Notify(MethodLog, p); err != nil {
		// The host is gone or not reading: stderr still reaches the plugin's log file.
		fmt.Fprintf(os.Stderr, "%s %s %v\n", p.Level, p.Msg, attrs)
	}
	return nil
}

func flatten(out map[string]any, prefix string, a slog.Attr) {
	v := a.Value.Resolve()
	if v.Kind() == slog.KindGroup {
		for _, g := range v.Group() {
			flatten(out, prefix+a.Key+".", g)
		}
		return
	}
	switch v.Kind() {
	case slog.KindString:
		out[prefix+a.Key] = v.String()
	case slog.KindInt64:
		out[prefix+a.Key] = v.Int64()
	case slog.KindUint64:
		out[prefix+a.Key] = v.Uint64()
	case slog.KindFloat64:
		out[prefix+a.Key] = v.Float64()
	case slog.KindBool:
		out[prefix+a.Key] = v.Bool()
	default:
		out[prefix+a.Key] = v.String()
	}
}

func levelName(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "error"
	case l >= slog.LevelWarn:
		return "warn"
	case l >= slog.LevelInfo:
		return "info"
	default:
		return "debug"
	}
}

func (l *logHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	n := *l
	prefix := ""
	for _, g := range l.groups {
		prefix += g + "."
	}
	n.attrs = slices.Clone(l.attrs)
	for _, a := range attrs {
		a.Key = prefix + a.Key
		n.attrs = append(n.attrs, a)
	}
	return &n
}

func (l *logHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return l
	}
	n := *l
	n.groups = append(slices.Clone(l.groups), name)
	return &n
}
