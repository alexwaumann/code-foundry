package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Surface instances (docs/notes/plugins-2-surfaces.md). One instance is one surface for
// one scope: <plugin>/<surface>/<scope id>. The first watcher opens it in the plugin
// (surface/open), watchers going from none to some and back flip surface/visibility, and
// the last one leaving starts a grace after which it is closed (surface/close, reason
// idle). An open instance whose thread or project goes away is closed at once
// (context_gone), and one whose when clause stops holding too (unavailable; it reopens
// for its watchers when the clause holds again): see recheck. The instance keeps its
// last view, so a returning watcher paints at once. Views do not go on the bus: each
// watcher pulls the instance's latest state, coalesced.

// Defaults for the surface Options.
const (
	// DefaultSurfaceGrace is long enough that a plugin's per-instance state (the selected
	// run, a tab) survives switching to another thread and back.
	DefaultSurfaceGrace     = 10 * time.Minute
	DefaultFirstViewTimeout = 10 * time.Second
	DefaultCoalesce         = 100 * time.Millisecond
)

const (
	surfaceOpenTimeout = 5 * time.Second
	surfaceActTimeout  = 10 * time.Second
	// A plugin sending more than floodRate views a second for floodSeconds seconds is
	// throttled to one a second.
	floodRate         = 50
	floodSeconds      = 10
	throttledInterval = time.Second
	// maxRawView bounds view/update's view before decoding (the 256 KB limit excludes
	// up to four 64 KB logs).
	maxRawView = 1 << 20
	// Log buffers keep the last logKeepLines lines or logKeepBytes bytes per node.
	logKeepLines = 2000
	logKeepBytes = 256 << 10
	// appendRing appends are kept for watchers catching up; one further behind gets
	// the whole view.
	appendRing = 512
	// maxAppendBytes bounds the ring by size too (appendCost): appends of many empty
	// lines, each under the per-append limit, would otherwise hold a gigabyte.
	maxAppendBytes = 4 << 20
	toastRing      = 16
	keptVersions   = 4
	maxClosed      = 64
	maxActPayload  = 64 << 10
	maxToastText   = 200
)

// SurfacePhase is an instance's host-side state.
type SurfacePhase int

const (
	// PhaseOpening: surface/open sent, no view from this run yet.
	PhaseOpening SurfacePhase = iota + 1
	// PhaseLive: the plugin has sent a view.
	PhaseLive
	// PhaseNotResponding: no view in time after opening, or no answer to surface/open.
	PhaseNotResponding
	// PhasePluginDown: the plugin is not running.
	PhasePluginDown
	// PhaseFailed: the plugin refused to open it.
	PhaseFailed
)

func (p SurfacePhase) String() string {
	switch p {
	case PhaseOpening:
		return "opening"
	case PhaseLive:
		return "live"
	case PhaseNotResponding:
		return "not responding"
	case PhasePluginDown:
		return "plugin down"
	case PhaseFailed:
		return "failed"
	}
	return fmt.Sprintf("SurfacePhase(%d)", int(p))
}

// SurfaceRef names an instance by plugin, surface and the caller's context, or by the
// key of an instance the store already has.
type SurfaceRef struct {
	Plugin, Surface string
	Context         command.Context
	Instance        string
}

// SurfaceState is an instance's state.
type SurfaceState struct {
	Instance    string
	Phase       SurfacePhase
	Message     string
	PluginState State
}

// SurfaceView is one version of an instance's view, as JSON the daemon validated and
// re-encoded (log nodes hold everything appended since).
type SurfaceView struct {
	Instance     string
	Version      uint64
	JSON         []byte
	HostRendered bool
}

// SurfaceAppend extends a log node of the current version.
type SurfaceAppend struct {
	Instance string
	Version  uint64
	Key      string
	Text     string
	Lines    []pluginsdk.AppendLine
}

// SurfaceToast is a toast for an instance's viewers.
type SurfaceToast struct {
	Instance, Level, Text string
}

// SurfaceUpdate is one item of a watcher's stream: exactly one field is set.
type SurfaceUpdate struct {
	State  *SurfaceState
	View   *SurfaceView
	Append *SurfaceAppend
	Toast  *SurfaceToast
}

// SurfaceElement is one acting element of a view (SurfaceElements).
type SurfaceElement struct {
	Key string
	// Kind is click, submit, change or tab (Act sends them to the plugin), or command,
	// open_url or copy (the host's).
	Kind   string
	Action string
	Label  string
	Form   string
	// Args are a command element's args as the view sets them.
	Args map[string]string
}

// ActRequest is an action on an instance's view element.
type ActRequest struct {
	// Instance is the instance key; when empty, Ref names it.
	Instance string
	Ref      SurfaceRef
	// Version acted on; 0 is the current one.
	Version uint64
	// Key is the element's; may be empty when Action names exactly one element.
	Key    string
	Action string
	Value  *string
	Values map[string]any
	// Context is what the acting panel shows (the plugin's SurfaceAct.Context); when it
	// is empty and Ref names the instance, Ref's context.
	Context command.Context
}

// Surfaces is the surface half of the plugin store (the API's WatchSurface, GetSurface
// and Act). *Manager implements it.
type Surfaces interface {
	// SurfaceAvailable reports whether a surface is available in uctx, why not, and
	// whether that is only for now (its when clause waits on a fact not known yet).
	SurfaceAvailable(plugin, surface string, uctx command.Context) Availability
	// WatchSurface opens (or joins) the instance ref names and streams its updates until
	// ctx ends; it returns the instance key. The channel closes when ctx ends.
	WatchSurface(ctx context.Context, ref SurfaceRef) (string, <-chan SurfaceUpdate, error)
	// SurfaceElements lists the acting elements of an instance's view version (0: the
	// current one).
	SurfaceElements(instance string, version uint64) []SurfaceElement
	// Act forwards an action to the plugin (surface/act) and returns the version acted
	// on. A plugin's error wraps ErrPluginRefused.
	Act(ctx context.Context, req ActRequest) (uint64, error)
}

var _ Surfaces = (*Manager)(nil)

// ErrPluginRefused wraps the error a plugin answered an action with.
var ErrPluginRefused = errors.New("plugin refused")

// surfaceHub holds every instance.
type surfaceHub struct {
	m *Manager

	mu   sync.Mutex
	inst map[string]*instance

	issueMu sync.Mutex
	issues  map[string]map[string]string // plugin → surface → issue

	toastMu sync.Mutex
	toasts  map[string]*rateLimiter

	// recheckTimer runs recheck once after a burst of context changes.
	recheckMu    sync.Mutex
	recheckTimer *time.Timer

	stop chan struct{}
	done chan struct{}
}

func newSurfaceHub(m *Manager) *surfaceHub {
	return &surfaceHub{m: m, inst: map[string]*instance{}, issues: map[string]map[string]string{},
		toasts: map[string]*rateLimiter{}, stop: make(chan struct{}), done: make(chan struct{})}
}

// run follows plugin state changes: a plugin that starts (again) reopens the instances
// someone watches; one that stops leaves them showing that.
func (h *surfaceHub) run() {
	defer close(h.done)
	sub := bus.Subscribe[Event](h.m.opts.Bus, 256)
	defer sub.Close()
	var dropped uint64
	for {
		select {
		case <-h.stop:
			return
		case ev, ok := <-sub.C():
			if !ok {
				return
			}
			if d := sub.Dropped(); d != dropped {
				dropped = d
				for _, p := range h.m.Snapshot().Plugins {
					h.pluginChanged(p.Name)
				}
				continue
			}
			switch e := ev.(type) {
			case Changed:
				h.pluginChanged(e.Plugin.Name)
			case Removed:
				h.pluginChanged(e.Name)
			case AvailabilityChanged:
				h.recheckSoon()
			}
		}
	}
}

func (h *surfaceHub) close() {
	select {
	case <-h.stop:
		return
	default:
	}
	close(h.stop)
	<-h.done
	h.recheckMu.Lock()
	if h.recheckTimer != nil {
		h.recheckTimer.Stop()
	}
	h.recheckMu.Unlock()
	h.mu.Lock()
	all := make([]*instance, 0, len(h.inst))
	for _, in := range h.inst {
		all = append(all, in)
	}
	h.mu.Unlock()
	for _, in := range all {
		in.mu.Lock()
		in.stopTimersLocked()
		in.mu.Unlock()
	}
}

func (h *surfaceHub) instancesOf(plugin string) []*instance {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []*instance
	for _, in := range h.inst {
		if in.plugin == plugin {
			out = append(out, in)
		}
	}
	return out
}

// pluginChanged brings the plugin's instances in line with whether it runs.
func (h *surfaceHub) pluginChanged(name string) {
	conn := h.m.conn(name)
	state, why := h.m.whyDown(name)
	for _, in := range h.instancesOf(name) {
		in.mu.Lock()
		reopen := false
		switch {
		case conn == nil:
			in.openConn, in.openingConn = nil, nil
			in.stopTimer(&in.firstView)
			if len(in.watchers) > 0 && (in.state.Phase != PhasePluginDown || in.state.Message != why) {
				in.setStateLocked(PhasePluginDown, why, state)
			}
		case len(in.watchers) > 0 && in.openConn != conn && in.openingConn != conn && in.closedFor == "":
			// (One the host closed while watched reopens through recheck or a new watcher.)
			reopen = true
		}
		in.mu.Unlock()
		if reopen {
			h.activate(in)
		}
	}
}

// whyDown is the plugin's state and, when it is not running, why in words.
func (m *Manager) whyDown(name string) (State, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[name]
	if e == nil {
		return StateDisabled, "plugin " + name + " is not installed"
	}
	if e.state == StateRunning {
		return e.state, ""
	}
	return e.state, m.whyDownLocked(e)
}

// instance is one surface instance. Fields after mu are guarded by it.
type instance struct {
	h                      *surfaceHub
	key, plugin, surfaceID string
	// scope is the instance's scope id ("thread:<id>", "project:<id>", …).
	scope string
	pctx  pluginsdk.UiContext

	mu sync.Mutex // guards the fields below
	// uctx is the context the instance was last opened or acted in: recheck evaluates
	// the when clause in it.
	uctx        command.Context
	facts       map[string]json.RawMessage
	watchers    map[*watcher]struct{}
	openConn    *pluginsdk.Conn // surface/open answered on it
	openingConn *pluginsdk.Conn // surface/open in flight on it
	openVersion uint64          // version when the last open was sent
	grace       *time.Timer
	firstView   *time.Timer
	closedAt    time.Time // zero while open or watched
	// closedFor is why the host closed it last ("" while open, or never closed).
	closedFor pluginsdk.CloseReason

	version      uint64
	base         []byte   // the view's canonical JSON, logs as the view set them
	view         *ui.View // nil until a view
	hostRendered bool
	logs         map[string]*logBuf
	rendered     []byte
	renderedVer  uint64
	renderedSeq  uint64
	index        map[uint64]*actionIndex

	appendSeq   uint64
	appends     []appendRec
	appendBytes int // the appends' appendCost
	state       SurfaceState
	stateSeq    uint64
	toastSeq    uint64
	toasts      []toastRec

	winStart  time.Time
	winCount  int
	floodWins int
	throttled bool
}

type appendRec struct {
	seq     uint64
	version uint64
	key     string
	text    string
	lines   []pluginsdk.AppendLine
	cost    int
}

// appendCost is about what an append holds in memory.
func appendCost(text string, lines []pluginsdk.AppendLine) int {
	n := 64 + len(text)
	for _, l := range lines {
		n += 32 + len(l.Text) + len(l.Tone)
	}
	return n
}

type toastRec struct {
	seq   uint64
	toast SurfaceToast
}

// watcher is one WatchSurface stream's cursor.
type watcher struct {
	wake      chan struct{}
	version   uint64
	appendSeq uint64
	stateSeq  uint64
	toastSeq  uint64
}

func (in *instance) wakeLocked() {
	for w := range in.watchers {
		select {
		case w.wake <- struct{}{}:
		default:
		}
	}
}

func (in *instance) setStateLocked(p SurfacePhase, msg string, ps State) {
	in.state = SurfaceState{Instance: in.key, Phase: p, Message: msg, PluginState: ps}
	in.stateSeq++
	in.wakeLocked()
}

func (in *instance) stopTimer(t **time.Timer) {
	if *t != nil {
		(*t).Stop()
		*t = nil
	}
}

func (in *instance) stopTimersLocked() {
	in.stopTimer(&in.grace)
	in.stopTimer(&in.firstView)
}

// interval is how often a watcher is sent views.
func (in *instance) interval() time.Duration {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.throttled {
		return throttledInterval
	}
	return in.h.m.opts.CoalesceInterval
}

// InstanceKey is <plugin>/<surface>/<scope id>.
func InstanceKey(plugin, surface, scope string) string { return plugin + "/" + surface + "/" + scope }

// surfaceSpec finds a surface in the plugin's manifest.
func surfaceSpec(p Plugin, id string) (pluginsdk.SurfaceSpec, bool) {
	i := slices.IndexFunc(p.Manifest.Surfaces, func(s pluginsdk.SurfaceSpec) bool { return s.ID == id })
	if i < 0 {
		return pluginsdk.SurfaceSpec{}, false
	}
	s := p.Manifest.Surfaces[i]
	if s.Scope == "" {
		s.Scope = pluginsdk.ScopeThread
	}
	return s, true
}

// scopeOf is an instance's scope id and the context the plugin is told, for a surface
// in uctx; ok is false (with why) when the context lacks what the scope needs.
func (m *Manager) scopeOf(spec pluginsdk.SurfaceSpec, uctx command.Context) (string, pluginsdk.UiContext, string) {
	env := m.factEnv(uctx)
	switch spec.Scope {
	case pluginsdk.ScopeGlobal:
		return "global", pluginsdk.UiContext{}, ""
	case pluginsdk.ScopeProject:
		if p, ok := env.project(); ok {
			return "project:" + p.ID, pluginsdk.UiContext{ProjectID: p.ID}, ""
		}
		return "", pluginsdk.UiContext{}, "it shows a project: select one (or pass --context-project)"
	case pluginsdk.ScopeWorktree:
		if w := env.worktreePath(); w != "" {
			return "worktree:" + w, pluginsdk.UiContext{ProjectID: env.projectID(), WorktreePath: w}, ""
		}
		return "", pluginsdk.UiContext{}, "it shows a worktree: select one (or pass --context-worktree)"
	case pluginsdk.ScopePR:
		if pr, ok := env.pullRequest(); ok {
			return fmt.Sprintf("pr:%s#%d", pr.Slug, pr.Number), pluginsdk.UiContext{ProjectID: env.projectID()}, ""
		}
		if _, ok := env.thread(); !ok {
			return "", pluginsdk.UiContext{}, "it shows a thread's pull request: select a thread (or pass --context-thread)"
		}
		return "", pluginsdk.UiContext{}, "the thread has no pull request"
	default:
		if t, ok := env.thread(); ok && t.Archived {
			return "", pluginsdk.UiContext{}, "the thread is archived"
		} else if ok {
			return "thread:" + t.ID, pluginsdk.UiContext{ThreadID: t.ID, ProjectID: env.projectID(), WorktreePath: env.worktreePath(),
				WorkspaceID: env.workspaceID(), View: uctx.ActiveView}, ""
		}
		return "", pluginsdk.UiContext{}, "it shows a thread: select one (or pass --context-thread)"
	}
}

// surfaceAvailability is a surface's availability in uctx: its scope's context, then its
// when clause.
func (m *Manager) surfaceAvailability(spec pluginsdk.SurfaceSpec, uctx command.Context) availability {
	if spec.Scope == "" {
		spec.Scope = pluginsdk.ScopeThread
	}
	if _, _, why := m.scopeOf(spec, uctx); why != "" {
		return availability{reason: why}
	}
	p, err := m.predicate(spec.When)
	if err != nil {
		return availability{reason: "its when clause does not compile: " + err.Error()}
	}
	return m.evalPredicate(p, uctx)
}

// Availability is a surface's availability in a context.
type Availability struct {
	Available bool
	// Unknown: not available for now, because its when clause reads a fact that is not
	// known yet (a pull request's checks while they are fetched).
	Unknown bool
	// Reason says why it is not available.
	Reason string
}

// SurfaceAvailable implements Surfaces.
func (m *Manager) SurfaceAvailable(plugin, surface string, uctx command.Context) Availability {
	p, ok := m.Snapshot().Plugin(plugin)
	if !ok {
		return Availability{Reason: "plugin " + plugin + " is not installed"}
	}
	spec, ok := surfaceSpec(p, surface)
	if !ok {
		return Availability{Reason: fmt.Sprintf("plugin %s has no surface %q", plugin, surface)}
	}
	if !p.Enabled {
		return Availability{Reason: "plugin " + plugin + " is disabled"}
	}
	a := m.surfaceAvailability(spec, uctx)
	return Availability{Available: a.ok, Unknown: a.unknown, Reason: a.reason}
}

// resolve finds (or makes) the instance ref names.
func (h *surfaceHub) resolve(ref SurfaceRef) (*instance, error) {
	m := h.m
	if ref.Instance != "" {
		if in := h.lookup(ref.Instance); in != nil {
			return in, nil
		}
		return nil, fmt.Errorf("%w: no surface instance %q (open it by plugin, surface and context first)", ErrNotFound, ref.Instance)
	}
	p, ok := m.Snapshot().Plugin(ref.Plugin)
	if !ok {
		return nil, fmt.Errorf("%w: no plugin %q", ErrNotFound, ref.Plugin)
	}
	spec, ok := surfaceSpec(p, ref.Surface)
	if !ok {
		return nil, fmt.Errorf("%w: plugin %s has no surface %q", ErrNotFound, ref.Plugin, ref.Surface)
	}
	if !p.Enabled {
		return nil, fmt.Errorf("%w: plugin %s is disabled", ErrFailedPrecondition, ref.Plugin)
	}
	scope, pctx, why := m.scopeOf(spec, ref.Context)
	if why != "" {
		return nil, fmt.Errorf("%w: %s %s is not available here: %s", ErrFailedPrecondition, ref.Plugin, ref.Surface, why)
	}
	pred, err := m.predicate(spec.When)
	if err != nil {
		return nil, fmt.Errorf("%w: %s %s: its when clause does not compile: %v", ErrFailedPrecondition, ref.Plugin, ref.Surface, err)
	}
	if a := m.evalPredicate(pred, ref.Context); !a.ok {
		return nil, fmt.Errorf("%w: %s %s is not available here: %s", ErrFailedPrecondition, ref.Plugin, ref.Surface, a.reason)
	}
	facts := m.factsJSON(pred, ref.Context)
	if spec.Scope == pluginsdk.ScopePR {
		env := m.factEnv(ref.Context)
		if pr, ok := env.pullRequest(); ok {
			if facts == nil {
				facts = map[string]json.RawMessage{}
			}
			facts["pr"], _ = json.Marshal(map[string]any{"repo": pr.Slug, "number": pr.Number, "url": pr.URL})
		}
	}
	key := InstanceKey(ref.Plugin, ref.Surface, scope)
	h.mu.Lock()
	defer h.mu.Unlock()
	in := h.inst[key]
	if in == nil {
		in = &instance{h: h, key: key, plugin: ref.Plugin, surfaceID: ref.Surface, scope: scope, pctx: pctx,
			watchers: map[*watcher]struct{}{}, logs: map[string]*logBuf{}, index: map[uint64]*actionIndex{}}
		in.state, in.stateSeq = SurfaceState{Instance: key, Phase: PhaseOpening}, 1
		h.inst[key] = in
		h.evictLocked()
	}
	in.mu.Lock()
	in.facts, in.uctx = facts, ref.Context
	in.mu.Unlock()
	return in, nil
}

// evictLocked forgets the oldest closed instances beyond maxClosed. h.mu held.
func (h *surfaceHub) evictLocked() {
	var closed []*instance
	for _, in := range h.inst {
		in.mu.Lock()
		if !in.closedAt.IsZero() && len(in.watchers) == 0 {
			closed = append(closed, in)
		}
		in.mu.Unlock()
	}
	if len(closed) <= maxClosed {
		return
	}
	slices.SortFunc(closed, func(a, b *instance) int { return a.closedAt.Compare(b.closedAt) })
	for _, in := range closed[:len(closed)-maxClosed] {
		delete(h.inst, in.key)
	}
}

func (h *surfaceHub) lookup(key string) *instance {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.inst[key]
}

// WatchSurface implements Surfaces.
func (m *Manager) WatchSurface(ctx context.Context, ref SurfaceRef) (string, <-chan SurfaceUpdate, error) {
	if m.isClosed() {
		return "", nil, ErrClosed
	}
	in, err := m.surf.resolve(ref)
	if err != nil {
		return "", nil, err
	}
	w := &watcher{wake: make(chan struct{}, 1)}
	in.mu.Lock()
	in.watchers[w] = struct{}{}
	// The first watcher opens it, and so does one of an instance the host closed while
	// it was watched (its when clause had stopped holding).
	activate := len(in.watchers) == 1 || (in.openConn == nil && in.openingConn == nil)
	in.stopTimer(&in.grace)
	in.closedAt = time.Time{}
	w.toastSeq = in.toastSeq
	in.mu.Unlock()
	if activate {
		m.surf.activate(in)
	}
	select {
	case w.wake <- struct{}{}:
	default:
	}
	out := make(chan SurfaceUpdate)
	go m.surf.serve(ctx, in, w, out)
	return in.key, out, nil
}

// serve feeds one watcher until ctx ends, at most one batch per interval.
func (h *surfaceHub) serve(ctx context.Context, in *instance, w *watcher, out chan<- SurfaceUpdate) {
	defer close(out)
	defer h.release(in, w)
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.wake:
		}
		for _, u := range in.pull(w) {
			select {
			case out <- u:
			case <-ctx.Done():
				return
			}
		}
		t := time.NewTimer(in.interval())
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// release drops a watcher; the last one hides the instance and starts the grace.
func (h *surfaceHub) release(in *instance, w *watcher) {
	in.mu.Lock()
	delete(in.watchers, w)
	if len(in.watchers) > 0 {
		in.mu.Unlock()
		return
	}
	conn := in.openConn
	in.stopTimer(&in.grace)
	in.grace = time.AfterFunc(h.m.opts.SurfaceGrace, func() { h.graceOver(in) })
	in.mu.Unlock()
	if conn != nil {
		_ = conn.Notify(pluginsdk.MethodSurfaceVisibility, pluginsdk.SurfaceVisibility{Instance: in.key, Visible: false})
	}
}

// graceOver closes an instance nobody came back to.
func (h *surfaceHub) graceOver(in *instance) {
	in.mu.Lock()
	if len(in.watchers) > 0 {
		in.mu.Unlock()
		return
	}
	conn := in.openConn
	in.openConn, in.openingConn, in.grace = nil, nil, nil
	in.stopTimer(&in.firstView)
	in.closedAt = h.m.opts.Now()
	in.mu.Unlock()
	if conn != nil {
		_ = conn.Notify(pluginsdk.MethodSurfaceClose, pluginsdk.SurfaceClose{Instance: in.key, Reason: pluginsdk.CloseIdle})
		h.m.surfLog(in.plugin, "closed %s (no viewer for %s)", in.key, shortDuration(h.m.opts.SurfaceGrace))
	}
	h.mu.Lock()
	h.evictLocked()
	h.mu.Unlock()
}

// activate makes a watched instance visible: open it in the running plugin, or tell
// the plugin it is visible again.
func (h *surfaceHub) activate(in *instance) {
	conn := h.m.conn(in.plugin)
	state, why := h.m.whyDown(in.plugin)
	in.mu.Lock()
	switch {
	case conn == nil:
		in.setStateLocked(PhasePluginDown, why, state)
		in.mu.Unlock()
		return
	case in.openConn == conn:
		in.mu.Unlock()
		_ = conn.Notify(pluginsdk.MethodSurfaceVisibility, pluginsdk.SurfaceVisibility{Instance: in.key, Visible: true})
		return
	case in.openingConn == conn:
		in.mu.Unlock()
		return
	}
	in.openingConn, in.openConn = conn, nil
	in.openVersion, in.closedFor = in.version, ""
	msg := ""
	if in.view != nil {
		msg = "updating"
	}
	in.setStateLocked(PhaseOpening, msg, StateRunning)
	open := pluginsdk.SurfaceOpen{Instance: in.key, Surface: in.surfaceID, Context: in.pctx, Facts: in.facts}
	in.mu.Unlock()
	go h.open(in, conn, open)
}

func (h *surfaceHub) open(in *instance, conn *pluginsdk.Conn, open pluginsdk.SurfaceOpen) {
	ctx, cancel := context.WithTimeout(context.Background(), surfaceOpenTimeout)
	err := conn.Call(ctx, pluginsdk.MethodSurfaceOpen, open, nil)
	cancel()
	in.mu.Lock()
	if in.openingConn != conn {
		in.mu.Unlock()
		return
	}
	in.openingConn = nil
	if err != nil {
		var perr *pluginsdk.Error
		if errors.As(err, &perr) {
			in.setStateLocked(PhaseFailed, perr.Message, StateRunning)
		} else {
			in.setStateLocked(PhaseNotResponding, "did not answer surface/open: "+err.Error(), StateRunning)
		}
		in.mu.Unlock()
		h.m.surfLog(in.plugin, "surface/open %s failed: %v", in.key, err)
		return
	}
	in.openConn = conn
	if in.version == in.openVersion {
		in.stopTimer(&in.firstView)
		in.firstView = time.AfterFunc(h.m.opts.FirstViewTimeout, func() {
			in.mu.Lock()
			defer in.mu.Unlock()
			in.firstView = nil
			if in.openConn == conn && in.version == in.openVersion {
				in.setStateLocked(PhaseNotResponding, fmt.Sprintf("no view %s after opening", shortDuration(h.m.opts.FirstViewTimeout)), StateRunning)
			}
		})
	}
	visible := len(in.watchers) > 0
	in.mu.Unlock()
	h.m.surfLog(in.plugin, "opened %s", in.key)
	_ = conn.Notify(pluginsdk.MethodSurfaceVisibility, pluginsdk.SurfaceVisibility{Instance: in.key, Visible: visible})
}

// pull is what a watcher has not seen yet: the state, then the view or the appends
// since its last one, then toasts.
func (in *instance) pull(w *watcher) []SurfaceUpdate {
	in.mu.Lock()
	defer in.mu.Unlock()
	var out []SurfaceUpdate
	if w.stateSeq != in.stateSeq {
		st := in.state
		out = append(out, SurfaceUpdate{State: &st})
		w.stateSeq = in.stateSeq
	}
	switch {
	case in.version == 0:
	case w.version != in.version || (len(in.appends) > 0 && w.appendSeq+1 < in.appends[0].seq && w.appendSeq < in.appendSeq):
		out = append(out, SurfaceUpdate{View: &SurfaceView{Instance: in.key, Version: in.version, JSON: in.renderLocked(), HostRendered: in.hostRendered}})
		w.version, w.appendSeq = in.version, in.appendSeq
	case w.appendSeq < in.appendSeq:
		var last *SurfaceAppend
		for _, a := range in.appends {
			if a.seq <= w.appendSeq || a.version != in.version {
				continue
			}
			if last != nil && last.Key == a.key && (last.Lines == nil) == (a.lines == nil) {
				last.Text += a.text
				last.Lines = append(last.Lines, a.lines...)
				continue
			}
			out = append(out, SurfaceUpdate{Append: &SurfaceAppend{Instance: in.key, Version: a.version, Key: a.key, Text: a.text, Lines: slices.Clone(a.lines)}})
			last = out[len(out)-1].Append
		}
		w.appendSeq = in.appendSeq
	}
	for _, t := range in.toasts {
		if t.seq > w.toastSeq {
			tt := t.toast
			out = append(out, SurfaceUpdate{Toast: &tt})
		}
	}
	w.toastSeq = in.toastSeq
	return out
}

// renderLocked is the current view's JSON with the log buffers in its log nodes.
func (in *instance) renderLocked() []byte {
	if in.rendered != nil && in.renderedVer == in.version && in.renderedSeq == in.appendSeq {
		return in.rendered
	}
	out := in.base
	if len(in.logs) > 0 {
		var v ui.View
		if err := json.Unmarshal(in.base, &v); err == nil {
			walkNodes(v.Nodes, func(n *ui.Node) {
				if n.Log == nil {
					return
				}
				if b := in.logs[n.Key]; b != nil {
					n.Log.Text, n.Log.Lines = b.text, slices.Clone(b.lines)
					n.Log.Truncated = n.Log.Truncated || b.trimmed
				}
			})
			if b, err := json.Marshal(v); err == nil {
				out = b
			}
		}
	}
	in.rendered, in.renderedVer, in.renderedSeq = out, in.version, in.appendSeq
	return out
}

// walkNodes calls fn for every node, sections' children included.
func walkNodes(nodes []ui.Node, fn func(n *ui.Node)) {
	for i := range nodes {
		fn(&nodes[i])
		if s := nodes[i].Section; s != nil {
			walkNodes(s.Children, fn)
		}
	}
}

// SurfaceElements implements Surfaces.
func (m *Manager) SurfaceElements(key string, version uint64) []SurfaceElement {
	in := m.surf.lookup(key)
	if in == nil {
		return nil
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	if version == 0 {
		version = in.version
	}
	idx := in.index[version]
	if idx == nil {
		return nil
	}
	out := make([]SurfaceElement, 0, len(idx.order))
	for _, k := range idx.order {
		el := idx.elements[k]
		se := SurfaceElement{Key: el.key, Kind: el.kind, Action: el.actionName(), Label: el.label, Form: el.form}
		if el.action != nil && el.action.Command != nil && len(el.action.Command.Args) > 0 {
			se.Args = maps.Clone(el.action.Command.Args)
		}
		out = append(out, se)
	}
	return out
}

// surfLog writes one of the daemon's lines about a plugin's surfaces into its log.
func (m *Manager) surfLog(plugin, format string, args ...any) {
	if m.isClosed() {
		return // the log files are closed (or closing)
	}
	if e, ok := m.entry(plugin); ok {
		e.logs.add("host", "", fmt.Sprintf(format, args...))
	}
}

// setIssue records (msg != "") or clears a surface's issue and republishes the plugin.
func (h *surfaceHub) setIssue(plugin, surface, msg string) {
	h.issueMu.Lock()
	cur := h.issues[plugin][surface]
	if cur == msg {
		h.issueMu.Unlock()
		return
	}
	if h.issues[plugin] == nil {
		h.issues[plugin] = map[string]string{}
	}
	if msg == "" {
		delete(h.issues[plugin], surface)
	} else {
		h.issues[plugin][surface] = msg
	}
	h.issueMu.Unlock()
	h.m.update(plugin, nil, func(*entry) {})
}

// issuesOf lists a plugin's surface issues, sorted.
func (h *surfaceHub) issuesOf(plugin string) []string {
	h.issueMu.Lock()
	defer h.issueMu.Unlock()
	var out []string
	for s, msg := range h.issues[plugin] {
		out = append(out, "surface "+s+": "+msg)
	}
	slices.Sort(out)
	return out
}

// instanceOf returns the plugin's instance key if the host opened it on conn (or is
// opening it), for view/update and view/append.
func (h *surfaceHub) instanceFor(a *actor, key string) (*instance, error) {
	conn := a.running()
	in := h.lookup(key)
	if in == nil || in.plugin != a.name || conn == nil {
		return nil, pluginsdk.NewError(pluginsdk.CodeNotFound, "no open surface instance %q", key)
	}
	in.mu.Lock()
	open := in.openConn == conn || in.openingConn == conn
	in.mu.Unlock()
	if !open {
		return nil, pluginsdk.NewError(pluginsdk.CodeNotFound, "surface instance %q is not open (it was closed, or never opened)", key)
	}
	return in, nil
}

// accept installs a valid view and returns its version.
func (in *instance) accept(v *ui.View, canon []byte, now time.Time) (uint64, bool) {
	in.mu.Lock()
	defer in.mu.Unlock()
	flooding := in.countLocked(now)
	if !in.hostRendered && in.view != nil && bytes.Equal(canon, in.base) && !hasLogContent(v) {
		// The same view again: no new version, but the instance is live.
		in.stopTimer(&in.firstView)
		if in.state.Phase != PhaseLive {
			in.setStateLocked(PhaseLive, "", StateRunning)
		}
		return in.version, flooding
	}
	in.version++
	in.base, in.view, in.hostRendered = canon, v, false
	in.installLogsLocked(v)
	in.indexLocked(v)
	in.stopTimer(&in.firstView)
	if in.state.Phase != PhaseLive {
		in.setStateLocked(PhaseLive, "", StateRunning)
	}
	in.wakeLocked()
	return in.version, flooding
}

// countLocked counts a view for the flood rule and reports when the instance has just
// become throttled.
func (in *instance) countLocked(now time.Time) bool {
	if now.Sub(in.winStart) >= time.Second {
		if in.winCount > floodRate && now.Sub(in.winStart) < 2*time.Second {
			in.floodWins++
		} else {
			in.floodWins = 0
		}
		in.winStart, in.winCount = now, 0
	}
	in.winCount++
	if !in.throttled && in.floodWins >= floodSeconds {
		in.throttled = true
		return true
	}
	return false
}

func hasLogContent(v *ui.View) bool {
	has := false
	walkNodes(v.Nodes, func(n *ui.Node) {
		if n.Log != nil && (n.Log.Text != "" || len(n.Log.Lines) > 0) {
			has = true
		}
	})
	return has
}

// installLogsLocked applies a new view to the log buffers: a log node with text or
// lines replaces its buffer, one with neither keeps it, and a node gone drops it.
func (in *instance) installLogsLocked(v *ui.View) {
	next := map[string]*logBuf{}
	walkNodes(v.Nodes, func(n *ui.Node) {
		if n.Log == nil {
			return
		}
		old := in.logs[n.Key]
		switch {
		case n.Log.Text != "" || len(n.Log.Lines) > 0:
			b := &logBuf{linesMode: len(n.Log.Lines) > 0, text: n.Log.Text, lines: slices.Clone(n.Log.Lines)}
			b.trim()
			next[n.Key] = b
		case old != nil:
			next[n.Key] = old
		default:
			next[n.Key] = &logBuf{}
		}
	})
	in.logs = next
}

// reject records an invalid view: the plugin's earlier view stays; without one (or for a
// dev plugin, above it) the instance shows a host-made notice saying why.
func (in *instance) reject(displayName string, errs []string, dev bool) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.view != nil && !dev {
		return
	}
	detail := strings.Join(errs, "\n")
	if len(detail) > ui.MaxNoticeDetail {
		detail = truncateUTF8(detail, ui.MaxNoticeDetail-3) + "..."
	}
	body := fmt.Sprintf("%s sent a view Code Foundry cannot show (%d problem", displayName, len(errs))
	if len(errs) != 1 {
		body += "s"
	}
	body += "). Its log has the details: code-foundry plugin logs " + in.plugin
	notice := ui.Node{Key: "cf-invalid-view", Notice: &ui.Notice{Tone: ui.ToneError, Title: "Invalid view", Body: &ui.Inline{Text: body}, Detail: detail}}
	v := ui.View{Nodes: []ui.Node{notice}}
	if in.view != nil {
		prev := *in.view
		keys := map[string]bool{}
		walkNodes(prev.Nodes, func(n *ui.Node) { keys[n.Key] = true })
		for keys[notice.Key] {
			notice.Key += "-"
		}
		v = ui.View{Header: prev.Header, Tabs: prev.Tabs, Nodes: append([]ui.Node{notice}, prev.Nodes...)}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	in.version++
	in.base, in.hostRendered = b, true
	if in.view == nil {
		in.logs = map[string]*logBuf{}
	}
	in.indexLocked(&v)
	in.stopTimer(&in.firstView)
	if in.state.Phase != PhaseLive {
		in.setStateLocked(PhaseLive, "", StateRunning)
	}
	in.wakeLocked()
}

func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && !utf8RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func utf8RuneStart(b byte) bool { return b&0xC0 != 0x80 }

// appendLog extends a log node of the current view.
func (in *instance) appendLog(p pluginsdk.ViewAppendParams) (uint64, error) {
	size := len(p.Text)
	for _, l := range p.Lines {
		size += len(l.Text) + 1
		if !slices.Contains([]string{"", "neutral", "muted", "attention", "error", "ok"}, l.Tone) {
			return 0, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "view/append: unknown tone %q", l.Tone)
		}
	}
	switch {
	case size > ui.MaxLogText:
		return 0, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "view/append: %d bytes, at most %d per append", size, ui.MaxLogText)
	case p.Text != "" && len(p.Lines) > 0:
		return 0, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "view/append: text or lines, not both")
	case size == 0:
		return in.currentVersion(), nil
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	b := in.logs[p.Key]
	if b == nil {
		return 0, pluginsdk.NewError(pluginsdk.CodeNotFound, "view/append: no log node %q in version %d of %s", p.Key, in.version, in.key)
	}
	b.append(p.Text, p.Lines)
	in.appendSeq++
	rec := appendRec{seq: in.appendSeq, version: in.version, key: p.Key, text: p.Text, lines: slices.Clone(p.Lines), cost: appendCost(p.Text, p.Lines)}
	in.appends = append(in.appends, rec)
	in.appendBytes += rec.cost
	drop := 0
	for drop < len(in.appends)-1 && (len(in.appends)-drop > appendRing || in.appendBytes > maxAppendBytes) {
		in.appendBytes -= in.appends[drop].cost
		drop++
	}
	in.appends = slices.Delete(in.appends, 0, drop)
	in.wakeLocked()
	return in.version, nil
}

func (in *instance) currentVersion() uint64 {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.version
}

func (in *instance) toast(t SurfaceToast) {
	in.mu.Lock()
	defer in.mu.Unlock()
	in.toastSeq++
	in.toasts = append(in.toasts, toastRec{seq: in.toastSeq, toast: t})
	if len(in.toasts) > toastRing {
		in.toasts = slices.Delete(in.toasts, 0, len(in.toasts)-toastRing)
	}
	in.wakeLocked()
}

// logBuf is one log node's text as the host keeps it: a text log's string, or a lines
// log's lines, head-trimmed to logKeepLines / logKeepBytes.
type logBuf struct {
	linesMode bool
	text      string
	lines     []ui.LogLine
	trimmed   bool
}

func (b *logBuf) append(text string, lines []pluginsdk.AppendLine) {
	switch {
	case b.linesMode && text != "":
		for l := range strings.SplitSeq(strings.TrimSuffix(text, "\n"), "\n") {
			b.lines = append(b.lines, ui.LogLine{Text: l})
		}
	case b.linesMode:
		for _, l := range lines {
			b.lines = append(b.lines, ui.LogLine{Text: l.Text, Tone: ui.Tone(l.Tone)})
		}
	case text != "":
		b.text += text
	default:
		if len(b.text) > 0 && !strings.HasSuffix(b.text, "\n") {
			b.text += "\n"
		}
		for _, l := range lines {
			b.text += l.Text + "\n"
		}
	}
	b.trim()
}

func (b *logBuf) trim() {
	if b.linesMode {
		size := 0
		for _, l := range b.lines {
			size += len(l.Text) + 1
		}
		drop := 0
		for drop < len(b.lines) && (len(b.lines)-drop > logKeepLines || size > logKeepBytes) {
			size -= len(b.lines[drop].Text) + 1
			drop++
		}
		if drop > 0 {
			b.lines = slices.Delete(b.lines, 0, drop)
			b.trimmed = true
		}
		return
	}
	t := b.text
	if len(t) > logKeepBytes {
		t = t[len(t)-logKeepBytes:]
		if i := strings.IndexByte(t, '\n'); i >= 0 {
			t = t[i+1:]
		} else {
			for len(t) > 0 && !utf8RuneStart(t[0]) {
				t = t[1:]
			}
		}
	}
	if n := strings.Count(t, "\n"); n > logKeepLines {
		cut := 0
		for range n - logKeepLines {
			cut += strings.IndexByte(t[cut:], '\n') + 1
		}
		t = t[cut:]
	}
	if len(t) != len(b.text) {
		b.text, b.trimmed = t, true
	}
}
