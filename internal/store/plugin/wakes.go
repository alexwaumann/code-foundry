package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Wake sources (docs/notes/plugins-wake-sources.md): the manifest's wakes are events an
// agent's thread subscribes to (`thread subscribe --plugin <plugin>/<source>`). The
// thread store keeps the subscriptions and delivers the wakes; this side resolves a new
// subscription's args against the manifest and the subscriber's context
// (ResolveWake), tells the running plugin about subscriptions (wake/subscribed and
// wake/unsubscribed; every live one again after each initialized with rearm set, then
// wake/armed, so a restarted plugin re-arms and drops the ones that ended), serves wake/fire, and ends a plugin's subscriptions with a last "source
// gone" wake when it is disabled, removed, uninstalled or replaced, or an update drops
// a source (endWakes). No permission: a wake only reaches threads that asked for it.

// WakeSink is the thread store as wake sources need it. The daemon adapts it.
type WakeSink interface {
	// Fire wakes the subscriptions to plugin's source whose args match covers, with
	// title and payload, and says how many subscribers were woken.
	Fire(plugin, display, source string, match map[string]string, title string, payload json.RawMessage) int
	// Gone sends the subscriptions to plugin's sources (all of them for nil) one last
	// wake saying the source is gone (reason) and deletes them; it says how many went.
	Gone(plugin, display string, sources []string, reason string) int
	// Subscriptions returns the live subscriptions to plugin's sources (every plugin's
	// for ""), oldest first.
	Subscriptions(plugin string) []WakeSub
}

// WakeSub is one live wake subscription.
type WakeSub struct {
	ID, Plugin, Source string
	// ThreadID is the subscriber.
	ThreadID string
	Args     map[string]string
	Repeat   bool
}

// maxFiresPerSecond bounds a plugin's wake/fire calls.
const maxFiresPerSecond = 20

func init() {
	hostMethods[pluginsdk.MethodWakeFire] = hostMethod{handle: (*actor).wakeFire}
	hostCapabilities = append(hostCapabilities, "wakes")
}

// actorWakes is an actor's wake state: whether the running plugin has been armed
// (subscriptions are sent only then, in order, under mu) and its fire rate.
type actorWakes struct {
	mu   sync.Mutex
	conn *pluginsdk.Conn // set by arm, cleared by disarm
	rate rateLimiter
}

func (m *Manager) wakeSink() WakeSink { return m.opts.Wakes }

// armWakes sends the starting plugin every live subscription to its sources (rearm
// set), then wake/armed with their count (also 0, so the plugin can drop state for
// subscriptions that ended while it was down), then lets WakeChanged send the next ones.
func (a *actor) armWakes(conn *pluginsdk.Conn) {
	sink := a.m.wakeSink()
	a.wakes.mu.Lock()
	defer a.wakes.mu.Unlock()
	a.wakes.conn = conn
	if sink == nil {
		return
	}
	subs := sink.Subscriptions(a.name)
	for _, s := range subs {
		sub := a.m.wakeSubscription(s)
		sub.Rearm = true
		_ = conn.Notify(pluginsdk.MethodWakeSubscribed, sub)
	}
	_ = conn.Notify(pluginsdk.MethodWakeArmed, pluginsdk.WakeArmed{Count: len(subs)})
	if len(subs) > 0 {
		a.hostLog("re-armed %d wake subscriptions", len(subs))
	}
}

// disarmWakes stops sending subscriptions (the process is ending).
func (a *actor) disarmWakes() {
	a.wakes.mu.Lock()
	defer a.wakes.mu.Unlock()
	a.wakes.conn = nil
}

// WakeChanged tells the plugin that a subscription to one of its sources was added or
// removed. Nothing is sent while it is not running: it gets every live one when it
// starts.
func (m *Manager) WakeChanged(s WakeSub, added bool) {
	m.mu.Lock()
	var a *actor
	if e := m.entries[s.Plugin]; e != nil {
		a = e.actor
	}
	m.mu.Unlock()
	if a == nil {
		return
	}
	a.wakes.mu.Lock()
	defer a.wakes.mu.Unlock()
	if a.wakes.conn == nil {
		return
	}
	if added {
		_ = a.wakes.conn.Notify(pluginsdk.MethodWakeSubscribed, m.wakeSubscription(s))
		a.hostLog("wake subscription %s to %s by %s (%s)", s.ID, s.Source, s.ThreadID, argsOrNone(s.Args))
		return
	}
	_ = a.wakes.conn.Notify(pluginsdk.MethodWakeUnsubscribed, pluginsdk.WakeUnsubscribed{Subscription: s.ID, Source: s.Source})
	a.hostDebug("wake subscription %s to %s ended", s.ID, s.Source)
}

func argsOrNone(args map[string]string) string {
	if f := pluginsdk.FormatWakeArgs(args); f != "" {
		return f
	}
	return "no args"
}

// wakeSubscription is wake/subscribed's params for s, with its thread's context.
func (m *Manager) wakeSubscription(s WakeSub) pluginsdk.WakeSubscription {
	uctx := pluginsdk.UiContext{ThreadID: s.ThreadID}
	if m.opts.Facts != nil {
		if t, ok := m.opts.Facts.Thread(s.ThreadID); ok {
			uctx.ProjectID, uctx.WorktreePath, uctx.WorkspaceID = t.ProjectID, t.WorktreePath, t.WorkspaceID
		}
	}
	return pluginsdk.WakeSubscription{Subscription: s.ID, Source: s.Source, Args: maps.Clone(s.Args), Context: uctx, Repeat: s.Repeat}
}

// wakeFire serves wake/fire.
func (a *actor) wakeFire(_ context.Context, params json.RawMessage) (any, error) {
	sink := a.m.wakeSink()
	if sink == nil {
		return nil, notServed(pluginsdk.MethodWakeFire)
	}
	p, err := decodeParams[pluginsdk.WakeFire](pluginsdk.MethodWakeFire, params)
	if err != nil {
		return nil, err
	}
	pl, _ := a.m.Snapshot().Plugin(a.name)
	spec, ok := pl.Manifest.Wake(p.Source)
	if !ok {
		return nil, pluginsdk.NewError(pluginsdk.CodeNotFound, "wake/fire: plugin.json declares no wake source %q", p.Source)
	}
	invalid := func(format string, args ...any) error {
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "wake/fire: "+format, args...)
	}
	for k := range p.Match {
		if _, ok := spec.Arg(k); !ok {
			return nil, invalid("wake source %s has no arg %q", p.Source, k)
		}
	}
	title := strings.TrimSpace(p.Title)
	switch {
	case title == "" || strings.ContainsAny(title, "\r\n"):
		return nil, invalid("title is one line, required")
	case utf8.RuneCountInString(title) > pluginsdk.MaxWakeTitle:
		return nil, invalid("title longer than %d characters", pluginsdk.MaxWakeTitle)
	case len(p.Payload) > pluginsdk.MaxWakePayload:
		return nil, invalid("payload of %d bytes (at most %d)", len(p.Payload), pluginsdk.MaxWakePayload)
	case len(p.Payload) > 0 && !json.Valid(p.Payload):
		return nil, invalid("payload is not JSON")
	case !a.wakes.rate.allow(a.m.opts.Now(), maxFiresPerSecond):
		return nil, pluginsdk.NewError(pluginsdk.CodeRateLimited, "wake/fire: at most %d fires a second", maxFiresPerSecond)
	}
	n := sink.Fire(a.name, pl.DisplayName(), p.Source, p.Match, title, p.Payload)
	if n > 0 {
		a.hostLog("wake %s fired (%s): woke %d", p.Source, argsOrNone(p.Match), n)
	} else {
		a.hostDebug("wake %s fired (%s): no subscriber", p.Source, argsOrNone(p.Match))
	}
	return pluginsdk.WakeFireResult{Delivered: n}, nil
}

// endWakes ends the subscriptions to name's sources (every source for nil) with a last
// "source gone (why)" wake.
func (m *Manager) endWakes(name string, sources []string, why string, logs *logBuffer) {
	sink := m.wakeSink()
	if sink == nil {
		return
	}
	display := name
	if p, ok := m.Snapshot().Plugin(name); ok {
		display = p.DisplayName()
	}
	if n := sink.Gone(name, display, sources, why); n > 0 {
		m.log.Info("plugin: wake subscriptions ended", "plugin", name, "why", why, "count", n)
		if logs != nil {
			logs.add("host", "", fmt.Sprintf("ended %d wake subscriptions (%s)", n, why))
		}
	}
}

// dropUndeclaredWakes ends the subscriptions to sources mf no longer declares (an
// update or a dev edit dropped them).
func (m *Manager) dropUndeclaredWakes(name string, mf pluginsdk.Manifest, logs *logBuffer) {
	sink := m.wakeSink()
	if sink == nil {
		return
	}
	var gone []string
	for _, s := range sink.Subscriptions(name) {
		if _, ok := mf.Wake(s.Source); !ok && !slices.Contains(gone, s.Source) {
			gone = append(gone, s.Source)
		}
	}
	if len(gone) > 0 {
		m.endWakes(name, gone, "no longer in the plugin's manifest", logs)
	}
}

// sweepWakes ends, at startup, the subscriptions of plugins that are not enabled and to
// sources an enabled plugin no longer declares (changed while the daemon was stopped).
func (m *Manager) sweepWakes() {
	sink := m.wakeSink()
	if sink == nil {
		return
	}
	snap := m.Snapshot()
	var seen []string
	for _, s := range sink.Subscriptions("") {
		if slices.Contains(seen, s.Plugin) {
			continue
		}
		seen = append(seen, s.Plugin)
		p, ok := snap.Plugin(s.Plugin)
		switch {
		case !ok:
			m.endWakes(s.Plugin, nil, "the plugin is not installed", nil)
		case !p.Enabled:
			m.endWakes(s.Plugin, nil, "the plugin is disabled", nil)
		case p.Manifest.Name != "": // a manifest that loaded
			m.dropUndeclaredWakes(s.Plugin, p.Manifest, nil)
		}
	}
}

// ResolveWake checks a new subscription of thread threadID (in project projectID, ""
// for none) to target "<plugin>/<source>" and returns the args to keep: each given arg
// checked against the source's (a pr value "owner/name#123", "#123" or "123" for the
// thread's repository, or a pull request URL), then, for each arg not given, the
// thread's id, pull request or project for a context arg, else the default. A required
// arg left without a value is ErrInvalidArgument naming it. The plugin must be enabled
// (it need not be running: it re-arms when it starts).
func (m *Manager) ResolveWake(_ context.Context, threadID, projectID, target string, args map[string]string) (map[string]string, error) {
	plugin, source, err := pluginsdk.ParseWakeTarget(target)
	if err != nil {
		return nil, fmt.Errorf("%w: %v (code-foundry plugin wakes lists the wake sources)", ErrInvalidArgument, err)
	}
	p, ok := m.Snapshot().Plugin(plugin)
	switch {
	case !ok:
		return nil, fmt.Errorf("%w: no plugin %q (code-foundry plugin list)", ErrNotFound, plugin)
	case !p.Enabled:
		return nil, fmt.Errorf("%w: plugin %s is disabled; enable it to subscribe to its wake sources", ErrFailedPrecondition, plugin)
	}
	spec, ok := p.Manifest.Wake(source)
	if !ok {
		var names []string
		for _, w := range p.Manifest.Wakes {
			names = append(names, w.Name)
		}
		has := "it declares none"
		if len(names) > 0 {
			has = "it has " + strings.Join(names, ", ")
		}
		return nil, fmt.Errorf("%w: plugin %s has no wake source %q (%s; code-foundry plugin wakes %s)", ErrNotFound, plugin, source, has, plugin)
	}
	ctxv := m.wakeContext(threadID, projectID)
	out := map[string]string{}
	var problems, missing []string
	for name, v := range args {
		a, ok := spec.Arg(name)
		if !ok {
			problems = append(problems, fmt.Sprintf("%s/%s has no arg %q", plugin, source, name))
			continue
		}
		v = strings.TrimSpace(v)
		if a.Context == pluginsdk.WakeContextPR {
			nv, err := normalizePR(v, ctxv.repo)
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s: %v", name, err))
				continue
			}
			v = nv
		}
		if err := a.Check(v); err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		out[name] = v
	}
	for _, a := range spec.Args {
		if _, given := args[a.Name]; given {
			continue
		}
		v := ctxv.of(a.Context)
		if v == "" {
			v = a.Default
		}
		switch {
		case v != "":
			out[a.Name] = v
		case a.Required:
			missing = append(missing, a.Name+missingWhy(a.Context))
		}
	}
	slices.Sort(problems)
	if len(missing) > 0 {
		problems = append(problems, fmt.Sprintf("%s/%s needs %s", plugin, source, strings.Join(missing, ", ")))
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgument, strings.Join(problems, "; "))
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// missingWhy says why a required context arg has no value.
func missingWhy(context string) string {
	switch context {
	case pluginsdk.WakeContextPR:
		return " (the thread has no pull request: give --arg <name>=owner/name#123)"
	case pluginsdk.WakeContextProject:
		return " (the thread has no project)"
	}
	return " (give --arg <name>=<value>)"
}

// wakeCtx is a subscriber's context values.
type wakeCtx struct {
	thread, project, pr string
	// repo is the slug a bare pull request number belongs to: the thread's pull
	// request's, else its project's GitHub slug.
	repo string
}

func (c wakeCtx) of(context string) string {
	switch context {
	case pluginsdk.WakeContextThread:
		return c.thread
	case pluginsdk.WakeContextProject:
		return c.project
	case pluginsdk.WakeContextPR:
		return c.pr
	}
	return ""
}

func (m *Manager) wakeContext(threadID, projectID string) wakeCtx {
	c := wakeCtx{thread: threadID, project: projectID}
	if m.opts.Facts == nil {
		return c
	}
	if t, ok := m.opts.Facts.Thread(threadID); ok {
		if c.project == "" {
			c.project = t.ProjectID
		}
		if len(t.PullRequests) > 0 {
			pr := t.PullRequests[0]
			c.repo = strings.ToLower(pr.Slug)
			c.pr = c.repo + "#" + strconv.Itoa(pr.Number)
		}
	}
	if c.repo == "" && c.project != "" {
		if p, ok := m.opts.Facts.Project(c.project); ok {
			c.repo = strings.ToLower(p.Slug)
		}
	}
	return c
}

var (
	prRefPattern = regexp.MustCompile(`^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$`)
	prURLPattern = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)/?$`)
	prNumPattern = regexp.MustCompile(`^#?([1-9][0-9]*)$`)
)

// normalizePR turns a pull request value into "owner/name#123" (lower-case slug): that
// form, a pull request URL, or "#123"/"123" for repo.
func normalizePR(v, repo string) (string, error) {
	if m := prRefPattern.FindStringSubmatch(v); m != nil {
		return strings.ToLower(m[1]) + "#" + m[2], nil
	}
	if m := prURLPattern.FindStringSubmatch(v); m != nil {
		return strings.ToLower(m[1]) + "#" + m[2], nil
	}
	if m := prNumPattern.FindStringSubmatch(v); m != nil {
		if repo == "" {
			return "", fmt.Errorf("%q has no repository and the thread's project is not on GitHub: give owner/name#%s", v, m[1])
		}
		return repo + "#" + m[1], nil
	}
	return "", fmt.Errorf("%q is not a pull request (owner/name#123, #123 or its URL)", v)
}

// DescribeWake is a target's name ("Hello: Tick") and state in words for listings: the
// plugin's state, "source gone" when it no longer declares the source, "plugin gone"
// when it is not installed.
func (m *Manager) DescribeWake(target string) (string, string) {
	plugin, source, ok := strings.Cut(target, "/")
	if !ok {
		return target, "gone"
	}
	p, ok := m.Snapshot().Plugin(plugin)
	if !ok {
		return target, "plugin gone"
	}
	w, ok := p.Manifest.Wake(source)
	if !ok {
		return p.DisplayName() + ": " + source, "source gone"
	}
	return p.DisplayName() + ": " + w.Title, p.State.String()
}

// WakeSubscribeLine is the shortest `thread subscribe` line for a source: its required
// args without a context as --arg name=<name>.
func WakeSubscribeLine(plugin string, w pluginsdk.WakeSpec) string {
	line := pluginsdk.WakeHint(plugin, w.Name, nil)
	for _, a := range w.Args {
		if a.Required && a.Context == "" {
			line += " --arg " + a.Name + "=<" + a.Name + ">"
		}
	}
	return line
}
