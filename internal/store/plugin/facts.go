package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// FactSource is what the host knows about threads, projects and pull requests, for
// predicates. The daemon implements it over the thread, project and gh stores, so this
// store imports none of them.
type FactSource interface {
	// Thread describes a thread; false when there is none with id.
	Thread(id string) (ThreadFacts, bool)
	// Project describes a project; false when there is none with id.
	Project(id string) (ProjectFacts, bool)
	// PullRequestChecks returns the checks on a pull request's head commit. It may
	// wait on GitHub (the gh store caches); the plugin store calls it off the hot path.
	PullRequestChecks(ctx context.Context, slug string, number int) ([]CheckRun, error)
}

// ThreadFacts are a thread's facts.
type ThreadFacts struct {
	ID, State, Status      string
	ProjectID, WorkspaceID string
	WorktreePath, Branch   string
	// Archived: the thread is archived (an open surface for it closes, context_gone).
	Archived bool
	// PullRequests are the thread's pull requests, the one to show first: its branch's
	// (an open one first), then the ones Claude linked, newest first; distinct.
	PullRequests []PullRequestRef
}

// PullRequestRef names a pull request.
type PullRequestRef struct {
	Slug   string // "owner/name"
	Number int
	URL    string
}

// ProjectFacts are a project's facts.
type ProjectFacts struct {
	ID, Name string
	// Slug is the GitHub "owner/name"; empty when origin is not on GitHub.
	Slug string
	Git  bool
}

// CheckRun is one check on a pull request's head commit.
type CheckRun struct {
	Name     string `json:"name"`
	Workflow string `json:"workflow,omitempty"`
	// Status is GitHub's (QUEUED, IN_PROGRESS, COMPLETED, …); Conclusion is set once
	// completed (SUCCESS, FAILURE, …).
	Status     string `json:"status"`
	Conclusion string `json:"conclusion,omitempty"`
	// App is the GitHub App slug of a check run ("github-actions"); empty for a status.
	App         string    `json:"app,omitempty"`
	URL         string    `json:"url,omitempty"`
	StartedAt   time.Time `json:"startedAt,omitzero"`
	CompletedAt time.Time `json:"completedAt,omitzero"`
}

// Provider is who ran a check (pluginsdk.CheckProvider): "github-actions", another
// app's slug, or "status".
func (c CheckRun) Provider() string { return pluginsdk.CheckProvider(c.App, c.URL) }

// hostFact computes one host fact for a context.
type hostFact func(e *factEnv) value

// hostFacts are the facts every predicate can read. Adding one is an entry here.
var hostFacts = map[string]hostFact{
	"view": func(e *factEnv) value { return optString(e.uctx.ActiveView) },
	// thread: a thread is active (and known).
	"thread":        func(e *factEnv) value { _, ok := e.thread(); return boolValue(ok) },
	"thread.id":     func(e *factEnv) value { t, _ := e.thread(); return optString(t.ID) },
	"thread.state":  func(e *factEnv) value { t, _ := e.thread(); return optString(t.State) },
	"thread.status": func(e *factEnv) value { t, _ := e.thread(); return optString(t.Status) },
	"thread.branch": func(e *factEnv) value { t, _ := e.thread(); return optString(t.Branch) },
	"thread.hasPr":  func(e *factEnv) value { t, _ := e.thread(); return boolValue(len(t.PullRequests) > 0) },
	"thread.pr.url": func(e *factEnv) value {
		t, _ := e.thread()
		urls := make([]string, len(t.PullRequests))
		for i, p := range t.PullRequests {
			urls[i] = p.URL
		}
		return stringsValue(urls)
	},
	"thread.pr.number": func(e *factEnv) value {
		if pr, ok := e.pullRequest(); ok {
			return numberValue(float64(pr.Number))
		}
		return nullValue
	},
	"thread.pr.repo": func(e *factEnv) value { pr, _ := e.pullRequest(); return optString(pr.Slug) },
	// project: a project is active (the context's, else the thread's).
	"project":      func(e *factEnv) value { _, ok := e.project(); return boolValue(ok) },
	"project.id":   func(e *factEnv) value { p, _ := e.project(); return optString(p.ID) },
	"project.name": func(e *factEnv) value { p, _ := e.project(); return optString(p.Name) },
	"project.slug": func(e *factEnv) value { p, _ := e.project(); return optString(p.Slug) },
	"project.git":  func(e *factEnv) value { p, ok := e.project(); return boolValue(ok && p.Git) },
	"workspace":    func(e *factEnv) value { return boolValue(e.workspaceID() != "") },
	"workspace.id": func(e *factEnv) value { return optString(e.workspaceID()) },
	// pr.checks*: the checks of the thread's pull request (async: unknown until fetched).
	"pr.checks":          func(e *factEnv) value { return e.checks(func(CheckRun) string { return "x" }).truthyList() },
	"pr.checks.provider": func(e *factEnv) value { return e.checks(CheckRun.Provider) },
	"pr.checks.app":      func(e *factEnv) value { return e.checks(func(c CheckRun) string { return c.App }) },
	"pr.checks.name":     func(e *factEnv) value { return e.checks(func(c CheckRun) string { return c.Name }) },
	"pr.checks.workflow": func(e *factEnv) value { return e.checks(func(c CheckRun) string { return c.Workflow }) },
	"pr.checks.url":      func(e *factEnv) value { return e.checks(func(c CheckRun) string { return c.URL }) },
	"pr.checks.conclusion": func(e *factEnv) value {
		return e.checks(func(c CheckRun) string { return c.Conclusion })
	},
}

// truthyList turns a checks list into "has any": unknown stays unknown, null false.
func (v value) truthyList() value {
	switch v.k {
	case vUnknown:
		return v
	case vList:
		return boolValue(len(v.list) > 0)
	}
	return boolValue(false)
}

// HostFactNames lists the host facts, sorted.
func HostFactNames() []string {
	return slices.Sorted(maps.Keys(hostFacts))
}

// factEnv resolves the facts of one context, each looked up at most once.
type factEnv struct {
	m      *Manager
	uctx   command.Context
	cache  map[string]value
	th     *ThreadFacts
	thOK   bool
	pr     *PullRequestRef
	prOK   bool
	pj     *ProjectFacts
	pjOK   bool
	asyncs bool // a fact was unknown
}

func (m *Manager) factEnv(uctx command.Context) *factEnv {
	return &factEnv{m: m, uctx: uctx, cache: map[string]value{}}
}

// lookup resolves a fact name.
func (e *factEnv) lookup(name string) value {
	if v, ok := e.cache[name]; ok {
		return v
	}
	var v value
	if f, ok := hostFacts[name]; ok {
		v = f(e)
	} else {
		plugin, key, _ := strings.Cut(name, ".")
		v = e.m.ctxFacts.get(e.m, plugin, key, e.uctx.ActiveThreadID, e.projectID())
	}
	if v.k == vUnknown {
		e.asyncs = true
	}
	e.cache[name] = v
	return v
}

func (e *factEnv) thread() (ThreadFacts, bool) {
	if e.th == nil {
		e.th = &ThreadFacts{}
		id := e.uctx.ActiveThreadID
		switch {
		case id == "":
		case e.m.opts.Facts == nil:
			// No fact source (tests): any thread id is a thread.
			*e.th, e.thOK = ThreadFacts{ID: id}, true
		default:
			*e.th, e.thOK = e.m.opts.Facts.Thread(id)
		}
	}
	return *e.th, e.thOK
}

func (e *factEnv) pullRequest() (PullRequestRef, bool) {
	if e.pr == nil {
		e.pr = &PullRequestRef{}
		if t, ok := e.thread(); ok && len(t.PullRequests) > 0 {
			*e.pr, e.prOK = t.PullRequests[0], true
		}
	}
	return *e.pr, e.prOK
}

func (e *factEnv) projectID() string {
	if e.uctx.ActiveProjectID != "" {
		return e.uctx.ActiveProjectID
	}
	t, _ := e.thread()
	return t.ProjectID
}

func (e *factEnv) workspaceID() string {
	if e.uctx.ActiveWorkspaceID != "" {
		return e.uctx.ActiveWorkspaceID
	}
	t, _ := e.thread()
	return t.WorkspaceID
}

func (e *factEnv) worktreePath() string {
	if e.uctx.ActiveWorktreePath != "" {
		return e.uctx.ActiveWorktreePath
	}
	t, _ := e.thread()
	return t.WorktreePath
}

func (e *factEnv) project() (ProjectFacts, bool) {
	if e.pj == nil {
		e.pj = &ProjectFacts{}
		id := e.projectID()
		switch {
		case id == "":
		case e.m.opts.Facts == nil:
			*e.pj, e.pjOK = ProjectFacts{ID: id}, true
		default:
			*e.pj, e.pjOK = e.m.opts.Facts.Project(id)
		}
	}
	return *e.pj, e.pjOK
}

// checks is one string per check of the thread's pull request (empty strings
// dropped, distinct): null without a pull request, unknown until they are fetched.
func (e *factEnv) checks(field func(CheckRun) string) value {
	pr, ok := e.pullRequest()
	if !ok || e.m.opts.Facts == nil {
		return nullValue
	}
	runs, known := e.m.checks.get(e.m, pr)
	if !known {
		return unknownValue
	}
	var out []string
	for _, r := range runs {
		if s := field(r); s != "" && !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return stringsValue(out)
}

// availability is a predicate's verdict for a context, with the reason when it is not
// available; unknown when it reads a fact that is not known yet (unavailable for now).
type availability struct {
	ok      bool
	unknown bool
	reason  string
}

// evalPredicate evaluates p (nil: true) in uctx. An unknown result is unavailable
// "for now".
func (m *Manager) evalPredicate(p *Predicate, uctx command.Context) availability {
	if p == nil {
		return availability{ok: true}
	}
	env := m.factEnv(uctx)
	switch p.eval(env.lookup) {
	case triTrue:
		return availability{ok: true}
	case triUnknown:
		return availability{unknown: true, reason: "not known yet (" + p.src + " waits on a pull request's checks)"}
	}
	return availability{reason: "its condition does not hold here: " + p.src}
}

// factsJSON resolves p's facts for surface/open: what the predicate matched.
func (m *Manager) factsJSON(p *Predicate, uctx command.Context) map[string]json.RawMessage {
	if p == nil || len(p.facts) == 0 {
		return nil
	}
	env := m.factEnv(uctx)
	out := make(map[string]json.RawMessage, len(p.facts))
	for _, f := range p.facts {
		if b, err := json.Marshal(env.lookup(f)); err == nil {
			out[f] = b
		}
	}
	return out
}

// AvailabilityChanged is published when availability may have changed without a plugin
// changing: a pull request's checks arrived, or a plugin set a context fact. Clients
// re-list commands.
type AvailabilityChanged struct{ Epoch uint64 }

func (AvailabilityChanged) isPluginEvent() {}

// availabilityInterval spaces AvailabilityChanged events.
const availabilityInterval = 250 * time.Millisecond

// availabilityNotifier bumps the epoch and publishes AvailabilityChanged, at most once
// per interval (a burst of context/set calls is one re-list).
type availabilityNotifier struct {
	mu       sync.Mutex
	epoch    uint64
	pending  bool
	last     time.Time
	interval time.Duration
}

func (n *availabilityNotifier) changed(m *Manager) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.epoch++
	if n.pending {
		return
	}
	wait := n.interval - time.Since(n.last)
	if wait <= 0 {
		n.last = time.Now()
		bus.Publish[Event](m.opts.Bus, AvailabilityChanged{Epoch: n.epoch})
		return
	}
	n.pending = true
	time.AfterFunc(wait, func() {
		n.mu.Lock()
		n.pending, n.last = false, time.Now()
		ep := n.epoch
		n.mu.Unlock()
		bus.Publish[Event](m.opts.Bus, AvailabilityChanged{Epoch: ep})
	})
}

// Checks cache: the async pull request checks fact.
const (
	// checksFresh is how long fetched checks are used without a refresh; after it the
	// stale value still answers while a refresh runs. A safety net: the daemon
	// invalidates an entry when the GitHub poll sees its pull request's head or checks
	// move (InvalidatePullRequestChecks), so this only bounds a missed change.
	checksFresh = 10 * time.Minute
	// checksFetchTimeout bounds one fetch.
	checksFetchTimeout = 30 * time.Second
	// checksKeep bounds the cache: entries unused this long go first.
	checksKeep = 10 * time.Minute
	checksMax  = 256
)

type checksEntry struct {
	runs      []CheckRun
	known     bool
	fetchedAt time.Time
	usedAt    time.Time
	fetching  bool
	// again refetches once the running fetch ends: the entry was invalidated while it
	// ran, so its answer may predate the change.
	again bool
	err   string
}

// checksCache holds the pull requests' checks the predicates asked for. A miss
// schedules one fetch per pull request; its arrival publishes AvailabilityChanged.
type checksCache struct {
	mu      sync.Mutex
	entries map[string]*checksEntry
}

func prKey(pr PullRequestRef) string {
	return fmt.Sprintf("%s#%d", strings.ToLower(pr.Slug), pr.Number)
}

// get returns the checks of pr and whether they are known, scheduling a fetch when
// they are not, or are stale.
func (c *checksCache) get(m *Manager, pr PullRequestRef) ([]CheckRun, bool) {
	if pr.Slug == "" || pr.Number <= 0 {
		return nil, true
	}
	k := prKey(pr)
	now := m.opts.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]*checksEntry{}
	}
	e := c.entries[k]
	if e == nil {
		c.evictLocked(now)
		e = &checksEntry{}
		c.entries[k] = e
	}
	e.usedAt = now
	if !e.fetching && (!e.known || now.Sub(e.fetchedAt) >= checksFresh) {
		e.fetching = true
		go c.fetch(m, pr, k)
	}
	return e.runs, e.known
}

func (c *checksCache) evictLocked(now time.Time) {
	for k, e := range c.entries {
		if !e.fetching && now.Sub(e.usedAt) > checksKeep {
			delete(c.entries, k)
		}
	}
	for len(c.entries) >= checksMax {
		var oldest string
		var at time.Time
		for k, e := range c.entries {
			if !e.fetching && (oldest == "" || e.usedAt.Before(at)) {
				oldest, at = k, e.usedAt
			}
		}
		if oldest == "" {
			return
		}
		delete(c.entries, oldest)
	}
}

func (c *checksCache) fetch(m *Manager, pr PullRequestRef, k string) {
	ctx, cancel := context.WithTimeout(context.Background(), checksFetchTimeout)
	runs, err := m.opts.Facts.PullRequestChecks(ctx, pr.Slug, pr.Number)
	cancel()
	c.mu.Lock()
	e := c.entries[k]
	if e == nil {
		c.mu.Unlock()
		return
	}
	first := !e.known
	changed := first || !sameChecks(e.runs, runs)
	e.fetching, e.known, e.fetchedAt = false, true, m.opts.Now()
	if e.again {
		e.again, e.fetching = false, true
		go c.fetch(m, pr, k)
	}
	e.err = ""
	if err != nil {
		// Known and empty (unavailable), not unknown forever: tried again once stale.
		e.err = err.Error()
		changed = first
		if first {
			e.runs = nil
		}
	} else {
		e.runs = runs
	}
	c.mu.Unlock()
	if err != nil {
		m.log.Debug("plugin facts: pull request checks", "pr", k, "err", err)
	}
	if changed {
		m.avail.changed(m)
	}
}

// invalidate marks pr's checks stale and refetches them now (the next get would): an
// entry exists only while predicates use it (checksKeep). The fetch publishes
// AvailabilityChanged when the result differs. A pull request nobody asked about is
// left alone.
func (c *checksCache) invalidate(m *Manager, pr PullRequestRef) {
	k := prKey(pr)
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[k]
	switch {
	case e == nil:
	case e.fetching:
		e.again = true
	default:
		e.fetching = true
		go c.fetch(m, pr, k)
	}
}

// InvalidatePullRequestChecks tells the store a pull request's checks changed (the
// daemon calls it on the gh store's events): the pr.checks fact refetches them if a
// predicate uses them, and availability is re-announced when they differ.
func (m *Manager) InvalidatePullRequestChecks(slug string, number int) {
	if slug == "" || number <= 0 {
		return
	}
	m.checks.invalidate(m, PullRequestRef{Slug: slug, Number: number})
}

// sameChecks compares what predicates read of two check lists.
func sameChecks(a, b []CheckRun) bool {
	key := func(rs []CheckRun) []string {
		out := make([]string, len(rs))
		for i, r := range rs {
			out[i] = r.Provider() + "\x00" + r.App + "\x00" + r.Name + "\x00" + r.Workflow + "\x00" + r.URL + "\x00" + r.Conclusion
		}
		slices.Sort(out)
		return out
	}
	return slices.Equal(key(a), key(b))
}

// Plugin facts: context/set.
const (
	// maxContextFacts bounds the facts one plugin keeps (every scope together).
	maxContextFacts = 1000
	maxFactString   = 1024
	maxFactList     = 100
	// maxFactScopeID bounds a fact's thread or project id (ids are short; a fact keyed
	// by megabytes of id would hold them).
	maxFactScopeID = 256
)

var contextKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$`)

// pluginFacts are one plugin process's context facts: scope ("", "thread:<id>",
// "project:<id>") → key → value. They belong to the run (conn) that set them, so a
// restarted plugin starts with none.
type pluginFacts struct {
	conn  *pluginsdk.Conn
	n     int
	scope map[string]map[string]value
}

// contextFacts are every plugin's context facts.
type contextFacts struct {
	mu sync.Mutex
	by map[string]*pluginFacts
}

// set records a fact for the plugin's run conn; it reports whether it changed.
func (c *contextFacts) set(conn *pluginsdk.Conn, plugin, scope, key string, v value) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.by == nil {
		c.by = map[string]*pluginFacts{}
	}
	pf := c.by[plugin]
	if pf == nil || pf.conn != conn {
		pf = &pluginFacts{conn: conn, scope: map[string]map[string]value{}}
		c.by[plugin] = pf
	}
	vals := pf.scope[scope]
	old, had := vals[key]
	if v.k == vNull {
		if !had {
			return false, nil
		}
		delete(vals, key)
		if len(vals) == 0 {
			delete(pf.scope, scope) // else set-then-clear over many thread ids grows the map
		}
		pf.n--
		return true, nil
	}
	if had && valuesEqual(old, v) {
		return false, nil
	}
	if !had && pf.n >= maxContextFacts {
		return false, fmt.Errorf("at most %d context facts per plugin", maxContextFacts)
	}
	if vals == nil {
		vals = map[string]value{}
		pf.scope[scope] = vals
	}
	vals[key] = v
	if !had {
		pf.n++
	}
	return true, nil
}

func valuesEqual(a, b value) bool {
	if a.k != b.k {
		return false
	}
	if a.k == vList {
		return slices.EqualFunc(a.list, b.list, scalarEqual)
	}
	return scalarEqual(a, b)
}

// get resolves <plugin>.<key>: the thread's fact, else the project's, else the global
// one; null when unset or set by an earlier run of the plugin.
func (c *contextFacts) get(m *Manager, plugin, key, threadID, projectID string) value {
	conn := m.conn(plugin)
	c.mu.Lock()
	defer c.mu.Unlock()
	pf := c.by[plugin]
	if pf == nil || conn == nil || pf.conn != conn {
		return nullValue
	}
	for _, s := range []string{scopeThread(threadID), scopeProject(projectID), ""} {
		if s == "-" {
			continue
		}
		if v, ok := pf.scope[s][key]; ok {
			return v
		}
	}
	return nullValue
}

func scopeThread(id string) string {
	if id == "" {
		return "-"
	}
	return "thread:" + id
}

func scopeProject(id string) string {
	if id == "" {
		return "-"
	}
	return "project:" + id
}

// conn returns the plugin's live connection; nil when it is not running.
func (m *Manager) conn(name string) *pluginsdk.Conn {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[name]
	if e == nil || e.actor == nil || e.state != StateRunning {
		return nil
	}
	return e.actor.running()
}

// contextSet serves context/set: a plugin's predicate fact.
func (a *actor) contextSet(params json.RawMessage) {
	var p struct {
		Key       string          `json:"key"`
		Value     json.RawMessage `json:"value"`
		ThreadID  string          `json:"threadId"`
		ProjectID string          `json:"projectId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		a.hostLog("bad context/set: %v", err)
		return
	}
	key := strings.TrimPrefix(p.Key, a.name+".")
	if len(key) > 64 || !contextKeyPattern.MatchString(key) {
		a.hostLog("refused context/set: key %q must match %s (64 characters at most)", p.Key, contextKeyPattern)
		return
	}
	if p.ThreadID != "" && p.ProjectID != "" {
		a.hostLog("refused context/set %s: a fact is for a thread or a project, not both", key)
		return
	}
	if len(p.ThreadID) > maxFactScopeID || len(p.ProjectID) > maxFactScopeID {
		a.hostLog("refused context/set %s: a thread or project id is at most %d bytes", key, maxFactScopeID)
		return
	}
	var raw any
	dec := json.NewDecoder(strings.NewReader(string(p.Value)))
	if len(p.Value) > 0 {
		if err := dec.Decode(&raw); err != nil {
			a.hostLog("refused context/set %s: %v", key, err)
			return
		}
	}
	v, err := valueFromJSON(raw, 0)
	if err == nil {
		err = checkFactValue(v)
	}
	if err != nil {
		a.hostLog("refused context/set %s: %v", key, err)
		return
	}
	scope := ""
	switch {
	case p.ThreadID != "":
		scope = "thread:" + p.ThreadID
	case p.ProjectID != "":
		scope = "project:" + p.ProjectID
	}
	conn := a.running()
	if conn == nil {
		return
	}
	changed, err := a.m.ctxFacts.set(conn, a.name, scope, key, v)
	if err != nil {
		a.hostLog("refused context/set %s: %v", key, err)
		return
	}
	if changed {
		a.m.avail.changed(a.m)
	}
}

func checkFactValue(v value) error {
	switch v.k {
	case vString:
		if len(v.s) > maxFactString {
			return fmt.Errorf("a string fact is at most %d bytes", maxFactString)
		}
	case vList:
		if len(v.list) > maxFactList {
			return fmt.Errorf("a list fact holds at most %d values", maxFactList)
		}
		for _, x := range v.list {
			if err := checkFactValue(x); err != nil {
				return err
			}
		}
	}
	return nil
}
