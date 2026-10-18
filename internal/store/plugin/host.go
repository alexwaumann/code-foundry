package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// hostMethod is one plugin → host request this host serves.
type hostMethod struct {
	// perm reports whether the running manifest grants the method; nil: always.
	perm func(pluginsdk.Permissions) bool
	// permName names the manifest key perm reads, for the refusal.
	permName string
	handle   func(a *actor, ctx context.Context, params json.RawMessage) (any, error)
}

func secretsGranted(p pluginsdk.Permissions) bool { return p.Secrets }

// hostMethods are the requests this protocol step serves. Adding a method is a new
// entry, not a branch.
var hostMethods = map[string]hostMethod{
	pluginsdk.MethodHostInvoke:   {handle: (*actor).hostInvoke},
	pluginsdk.MethodSecretGet:    {perm: secretsGranted, permName: "secrets", handle: (*actor).secretGet},
	pluginsdk.MethodSecretSet:    {perm: secretsGranted, permName: "secrets", handle: (*actor).secretSet},
	pluginsdk.MethodSecretDelete: {perm: secretsGranted, permName: "secrets", handle: (*actor).secretDelete},
	pluginsdk.MethodSecretList:   {perm: secretsGranted, permName: "secrets", handle: (*actor).secretList},
}

// hostNotifications are the notifications this protocol step serves.
var hostNotifications = map[string]func(a *actor, params json.RawMessage){
	pluginsdk.MethodLog: (*actor).logNotification,
}

// laterMethods arrive with later protocol steps (surfaces, events and flags, the session
// environment, plugin threads and terminals). Until then a request gets
// CodeMethodNotFound saying so and a notification is logged once per run.
var laterMethods = []string{
	pluginsdk.MethodViewUpdate, pluginsdk.MethodViewToast, pluginsdk.MethodContextSet,
	pluginsdk.MethodThreadSetFlag, pluginsdk.MethodEventsSubscribe, pluginsdk.MethodEventsUnsubscribe,
	pluginsdk.MethodSetEnvironment, pluginsdk.MethodThreadCreate, pluginsdk.MethodThreadSend,
	pluginsdk.MethodTerminalCreate, pluginsdk.MethodTerminalClose,
}

func notSupportedYet(method string) error {
	return pluginsdk.NewError(pluginsdk.CodeMethodNotFound, "%s is not supported yet by this Code Foundry", method)
}

// handle serves a plugin's request (on the Conn's goroutine for it).
func (a *actor) handle(ctx context.Context, method string, params json.RawMessage) (any, error) {
	h, ok := hostMethods[method]
	switch {
	case ok:
		if h.perm != nil && !h.perm(a.permissions()) {
			a.hostLog("refused %s: plugin.json does not grant permissions.%s", method, h.permName)
			return nil, pluginsdk.NewError(pluginsdk.CodePermissionDenied, "permission denied: %s needs \"%s\": true in plugin.json's permissions", method, h.permName)
		}
		return h.handle(a, ctx, params)
	case slices.Contains(laterMethods, method):
		return nil, notSupportedYet(method)
	default:
		return nil, pluginsdk.NewError(pluginsdk.CodeMethodNotFound, "unknown method %q", method)
	}
}

// notify serves a plugin's notification.
func (a *actor) notify(_ context.Context, method string, params json.RawMessage) {
	if fn, ok := hostNotifications[method]; ok {
		fn(a, params)
		return
	}
	a.mu.Lock()
	first := !a.ignored[method]
	if a.ignored != nil {
		a.ignored[method] = true
	}
	a.mu.Unlock()
	if !first {
		return
	}
	if slices.Contains(laterMethods, method) {
		a.hostLog("ignored %s: not supported yet by this Code Foundry", method)
	} else {
		a.hostLog("ignored unknown notification %q", method)
	}
}

// hostLog writes one of the daemon's own lines into the plugin's log.
func (a *actor) hostLog(format string, args ...any) {
	a.mu.Lock()
	logs := a.logs
	a.mu.Unlock()
	if logs != nil {
		logs.add("host", "", fmt.Sprintf(format, args...))
	}
}

func decodeParams[T any](method string, params json.RawMessage) (T, error) {
	var v T
	if len(params) == 0 {
		return v, nil
	}
	if err := json.Unmarshal(params, &v); err != nil {
		return v, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: %v", method, err)
	}
	return v, nil
}

// maxEchoPerSecond bounds how many of a plugin's log lines reach the daemon log.
const maxEchoPerSecond = 100

// logNotification writes a log notification into the plugin's log and echoes it to the
// daemon's log (plugin=<name>, at its level, rate-limited).
func (a *actor) logNotification(params json.RawMessage) {
	p, err := decodeParams[pluginsdk.LogParams](pluginsdk.MethodLog, params)
	if err != nil {
		a.hostLog("bad log notification: %v", err)
		return
	}
	level := strings.ToLower(p.Level)
	if !slices.Contains([]string{"debug", "info", "warn", "error"}, level) {
		level = "info"
	}
	text := p.Msg
	if len(p.Attrs) > 0 {
		keys := make([]string, 0, len(p.Attrs))
		for k := range p.Attrs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			text += fmt.Sprintf(" %s=%v", k, p.Attrs[k])
		}
	}
	a.mu.Lock()
	logs := a.logs
	a.mu.Unlock()
	if logs != nil {
		logs.add("log", level, text)
	}
	if a.echo.allow(a.m.opts.Now(), maxEchoPerSecond) {
		var lv slog.Level
		_ = lv.UnmarshalText([]byte(level))
		a.m.log.Log(context.Background(), lv, p.Msg, "plugin", a.name, "plugin_log", text)
	}
}

// managementVerb reports whether name is one of the host's own plugin.* verbs, which a
// plugin may never run (enabling, consenting, reading other plugins' secrets).
func managementVerb(name string) bool {
	rest, ok := strings.CutPrefix(name, "plugin.")
	if !ok {
		return false
	}
	verb, _, _ := strings.Cut(rest, ".")
	return slices.Contains(pluginsdk.ReservedNames, verb)
}

// hostInvoke runs a command for the plugin through the registry, as caller
// plugin:<name>. It never confirms on the user's behalf.
func (a *actor) hostInvoke(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := decodeParams[pluginsdk.InvokeParams](pluginsdk.MethodHostInvoke, params)
	if err != nil {
		return nil, err
	}
	switch {
	case p.Command == "":
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "host/invoke: command is required")
	case managementVerb(p.Command):
		a.hostLog("refused host/invoke %s: plugins cannot run plugin management commands", p.Command)
		return nil, pluginsdk.NewError(pluginsdk.CodePermissionDenied, "permission denied: plugins cannot run %s", p.Command)
	case !a.permissions().AllowsCommand(p.Command):
		a.hostLog("refused host/invoke %s: not in permissions.commands", p.Command)
		return nil, pluginsdk.NewError(pluginsdk.CodePermissionDenied, "permission denied: %s is not in plugin.json's permissions.commands", p.Command)
	}
	uctx := command.Context{
		ActiveThreadID: p.Context.ThreadID, ActiveProjectID: p.Context.ProjectID, ActiveWorktreePath: p.Context.WorktreePath,
		ActiveTerminalID: p.Context.TerminalID, ActiveWorkspaceID: p.Context.WorkspaceID, ActiveView: p.Context.View,
	}
	a.m.log.Info("command invoked", "caller", "plugin:"+a.name, "command", p.Command)
	a.hostLog("host/invoke %s", p.Command)
	res, err := a.m.opts.Commands.Invoke(ctx, uctx, p.Command, p.Args)
	if err != nil {
		if asked, ok := a.askUser(err, p); ok {
			return asked, nil
		}
		return nil, invokeError(err)
	}
	out := pluginsdk.CommandResult{Message: res.Message, ExitCode: res.ExitCode}
	js, err := res.EncodeJSON()
	if err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
	if js != "" {
		out.JSON = json.RawMessage(js)
	}
	return out, nil
}

// invokeError maps a registry error to the protocol's codes (ARCHITECTURE.md §B.3).
func invokeError(err error) error {
	var ce *command.ConfirmError
	switch {
	case errors.As(err, &ce):
		e := pluginsdk.NewError(pluginsdk.CodeConfirmationRequired, "%s asks the user first: %s", ce.Command, ce.Message)
		e.Data, _ = json.Marshal(map[string]string{"message": ce.Message})
		return e
	case errors.Is(err, command.ErrUnknownCommand):
		return pluginsdk.NewError(pluginsdk.CodeNotFound, "%v", err)
	case errors.Is(err, command.ErrInvalidArgs):
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%v", err)
	case errors.Is(err, command.ErrUnavailable):
		return pluginsdk.NewError(pluginsdk.CodeUnavailable, "%v", err)
	default:
		return pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
}

func checkSecretKey(key string) error {
	if !secretKeyPattern.MatchString(key) {
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "secret key %q must match %s", key, secretKeyPattern)
	}
	return nil
}

func (a *actor) secretGet(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := decodeParams[pluginsdk.SecretKeyParams](pluginsdk.MethodSecretGet, params)
	if err != nil {
		return nil, err
	}
	if err := checkSecretKey(p.Key); err != nil {
		return nil, err
	}
	v, ok, err := a.m.opts.Secrets.Get(ctx, a.name, p.Key)
	if err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
	return pluginsdk.SecretGetResult{Value: v, Found: ok}, nil
}

func (a *actor) secretSet(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := decodeParams[pluginsdk.SecretSetParams](pluginsdk.MethodSecretSet, params)
	if err != nil {
		return nil, err
	}
	if err := checkSecretKey(p.Key); err != nil {
		return nil, err
	}
	switch {
	case p.Value == "":
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "an empty secret: delete it instead")
	case len(p.Value) > MaxSecretBytes:
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "a secret is at most %d bytes", MaxSecretBytes)
	case !utf8.ValidString(p.Value):
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "a secret is UTF-8 text")
	}
	if err := a.m.opts.Secrets.Set(ctx, a.name, p.Key, p.Value); err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
	if err := putSecret(ctx, a.m.opts.DB, a.name, p.Key, a.m.opts.Now()); err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
	a.hostLog("secret set: %s", p.Key)
	return struct{}{}, nil
}

func (a *actor) secretDelete(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := decodeParams[pluginsdk.SecretKeyParams](pluginsdk.MethodSecretDelete, params)
	if err != nil {
		return nil, err
	}
	if err := checkSecretKey(p.Key); err != nil {
		return nil, err
	}
	if err := a.m.opts.Secrets.Delete(ctx, a.name, p.Key); err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
	if _, err := dropSecret(ctx, a.m.opts.DB, a.name, p.Key); err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
	a.hostLog("secret deleted: %s", p.Key)
	return struct{}{}, nil
}

func (a *actor) secretList(ctx context.Context, _ json.RawMessage) (any, error) {
	list, err := listSecrets(ctx, a.m.opts.DB, a.name)
	if err != nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeInternal, "%v", err)
	}
	return pluginsdk.SecretListResult{Secrets: list}, nil
}
