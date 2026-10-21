package thread

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// A thread's MCP servers (docs/notes/mcp-panel.md). Claude pushes nothing when
// a server's status changes, so the runner asks (mcp_status) after every system/init,
// i.e. at the start of each turn, again every few seconds while a server is still
// connecting, and after the user's own reconnects. The answer is cached on the thread's
// log and persisted (threadcache_db.go): a thread whose process stopped (lifecycle.go)
// keeps its last check, also across a daemon restart. Every new answer is an McpChanged
// event in the thread's seq order, so ThreadService.Watch carries it.

// McpTrigger says what made the daemon check the servers.
type McpTrigger string

// MCP check triggers.
const (
	// McpTriggerTurn: system/init, the start of a turn.
	McpTriggerTurn McpTrigger = "turn"
	// McpTriggerRefresh: asked for (Store.McpStatus), or a follow-up while a server was
	// still connecting.
	McpTriggerRefresh McpTrigger = "refresh"
	// McpTriggerReconnect: after Store.McpReconnect of McpStatus.Server.
	McpTriggerReconnect McpTrigger = "reconnect"
)

// MCP server statuses as Claude names them (McpServer.Status); a newer Claude's other
// values pass through.
const (
	McpConnected = claudestream.McpConnected
	McpFailed    = claudestream.McpFailed
	McpNeedsAuth = claudestream.McpNeedsAuth
	McpPending   = claudestream.McpPending
	McpDisabled  = claudestream.McpDisabled
)

// McpStatus is a thread's MCP servers as Claude last reported them. A value: never
// mutate one read from a snapshot or an event.
type McpStatus struct {
	CheckedAt time.Time
	Trigger   McpTrigger
	// Server is the server reconnected (McpTriggerReconnect).
	Server string
	// Servers in Claude's order.
	Servers []McpServer
}

// McpServer is one MCP server of a thread.
type McpServer struct {
	// Name is the config key (untrusted text).
	Name string
	// Status is connected, failed, needs-auth, pending or disabled.
	Status string
	// ServerName and Version are what a connected server says about itself.
	ServerName string
	Version    string
	// Error is why it failed.
	Error string
	// Scope is the configuration scope (user, project, local, dynamic, claudeai, ...);
	// Source where the definition came from (the same names, plus plugin and sdk).
	Scope  string
	Source string
	// Transport is stdio, sse, http, sdk or claudeai-proxy.
	Transport string
	// Tools are a connected server's tools.
	Tools []McpTool
}

// McpTool is one tool of a server. The hints are the ones the server set to true.
type McpTool struct {
	Name        string
	Description string
	ReadOnly    bool
	Destructive bool
	OpenWorld   bool
}

// McpReconnectResult is Store.McpReconnect's answer.
type McpReconnectResult struct {
	// Status is the servers checked after the reconnect.
	Status *McpStatus
	// Error is Claude's refusal of the reconnect (the server still fails: its error),
	// empty when it went through.
	Error string
}

// McpChanged is published on the bus (as a ThreadEvent) when a thread's MCP status was
// checked again.
type McpChanged struct {
	ThreadID string
	Seq      uint64
	Status   *McpStatus
}

func (McpChanged) isThreadEvent() {}

// Thread implements ThreadEvent.
func (e McpChanged) Thread() string { return e.ThreadID }

// Connected counts the connected servers.
func (s *McpStatus) Connected() int {
	n := 0
	for _, sv := range s.Servers {
		if sv.Status == McpConnected {
			n++
		}
	}
	return n
}

func (s *McpStatus) server(name string) (McpServer, bool) {
	i := slices.IndexFunc(s.Servers, func(sv McpServer) bool { return sv.Name == name })
	if i < 0 {
		return McpServer{}, false
	}
	return s.Servers[i], true
}

func (s *McpStatus) anyPending() bool {
	return slices.ContainsFunc(s.Servers, func(sv McpServer) bool { return sv.Status == McpPending })
}

// mcpFromWire maps mcp_status's servers.
func mcpFromWire(in []claudestream.McpServer) []McpServer {
	out := make([]McpServer, 0, len(in))
	for _, w := range in {
		s := McpServer{
			Name: w.Name, Status: w.Status, Error: w.Error, Scope: w.Scope, Source: w.Source,
			Transport: w.Config.Transport(),
		}
		if w.ServerInfo != nil {
			s.ServerName, s.Version = w.ServerInfo.Name, w.ServerInfo.Version
		}
		for _, t := range w.Tools {
			s.Tools = append(s.Tools, McpTool{
				Name: t.Name, Description: t.Description,
				ReadOnly: t.Annotations.ReadOnly, Destructive: t.Annotations.Destructive, OpenWorld: t.Annotations.OpenWorld,
			})
		}
		out = append(out, s)
	}
	return out
}

// mcpState is the MCP part of a threadLog, guarded by its mu. Answers can arrive out of
// order (a turn's check and a refresh race), so each check takes a ticket first and an
// answer older than the one applied is dropped.
type mcpState struct {
	status  *McpStatus
	issued  uint64
	applied uint64
	// saved is the ticket of the status last persisted, guarded by threadLog.saveMu:
	// setMcp saves after unlocking mu, so two checks' saves can arrive out of order.
	saved uint64
	// conn is the process whose answer was applied last (nil: none since the last one
	// ended), and reported whether it has listed a server yet: Claude starts MCP servers
	// in the background, so a process's first answers can list none.
	conn     *claudestream.Conn
	reported bool
}

// mcpTicket numbers a check about to be made.
func (t *threadLog) mcpTicket() uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.mcp.issued++
	return t.mcp.issued
}

// setMcp caches the answer of check ticket, publishes and persists it, unless a later
// check's answer is there already. It reports whether it was applied.
func (t *threadLog) setMcp(ticket uint64, s *McpStatus) bool {
	t.mu.Lock()
	ok := t.applyMcpLocked(ticket, s)
	t.mu.Unlock()
	if ok {
		t.persistMcp(ticket, s)
	}
	return ok
}

// applyMcpLocked caches and publishes s unless a later check's answer is there. t.mu
// held.
func (t *threadLog) applyMcpLocked(ticket uint64, s *McpStatus) bool {
	if ticket <= t.mcp.applied {
		return false
	}
	t.mcp.applied = ticket
	t.mcp.status = s
	t.seq++
	bus.Publish[ThreadEvent](t.bus, McpChanged{ThreadID: t.id, Seq: t.seq, Status: s})
	return true
}

// answerMcp is setMcp for an answer of process conn that listed answered servers. An
// answer listing none from a process that has listed none yet is Claude still starting
// them: with keep set, s then takes the cached servers, as pending, rather than
// replacing a known list with nothing. first reports that no answer of conn was applied
// before this one.
func (t *threadLog) answerMcp(ticket uint64, conn *claudestream.Conn, s *McpStatus, answered int, keep bool) (first bool) {
	t.mu.Lock()
	same := t.mcp.conn == conn
	if answered == 0 && keep && (!same || !t.mcp.reported) && t.mcp.status != nil {
		s.Servers = pendingServers(t.mcp.status.Servers)
	}
	ok := t.applyMcpLocked(ticket, s)
	if ok {
		if !same {
			t.mcp.conn, t.mcp.reported = conn, false
		}
		t.mcp.reported = t.mcp.reported || answered > 0
	}
	t.mu.Unlock()
	if ok {
		t.persistMcp(ticket, s)
	}
	return !same
}

// pendingServers is servers as they read while connecting again: what their
// configuration says (name, scope, source, transport), nothing a connection reported.
func pendingServers(servers []McpServer) []McpServer {
	out := make([]McpServer, len(servers))
	for i, sv := range servers {
		out[i] = McpServer{Name: sv.Name, Status: McpPending, Scope: sv.Scope, Source: sv.Source, Transport: sv.Transport}
	}
	return out
}

// persistMcp saves the status of check ticket unless a later check's is saved already.
func (t *threadLog) persistMcp(ticket uint64, s *McpStatus) {
	if t.saveMcp == nil {
		return
	}
	t.saveMu.Lock()
	defer t.saveMu.Unlock()
	if ticket <= t.mcp.saved {
		return
	}
	t.mcp.saved = ticket
	t.saveMcp(s)
}

// dropMcpChecks discards every check in flight (the process ended: a late answer of
// the old process must not land), keeping the cached status.
func (t *threadLog) dropMcpChecks() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.mcp.applied = t.mcp.issued
	t.mcp.conn, t.mcp.reported = nil, false
}

func (t *threadLog) mcpStatus() *McpStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.mcp.status
}

// MCP polling while the answer is unsettled (mcpUnsettled): Claude starts servers in the
// background, so a process's first check often finds one pending, or none at all.
// Options.McpPollInterval overrides the interval.
const (
	mcpPendingPolls    = 5
	mcpPendingInterval = 3 * time.Second
)

// mcpCheck is one check of a thread's MCP servers, and the polls that follow it.
type mcpCheck struct {
	conn    *claudestream.Conn
	log     *threadLog
	id      string
	trigger McpTrigger
	server  string // the server reconnected (McpTriggerReconnect)
	// init is system/init's servers on a turn's check (turn): they fill in what the
	// answer lacks, and they are the process's server list, so an empty answer is not
	// filled from the cache then.
	init []claudestream.McpServerInit
	turn bool
}

// checkMcp asks Claude for its MCP servers off the runner goroutine (system/init, whose
// mcp_servers fill in what the answer lacks) and settles the answer (settleMcp).
func (r *runner) checkMcp(init []claudestream.McpServerInit) {
	c := mcpCheck{conn: r.st.conn, log: r.st.log, id: r.id, trigger: McpTriggerTurn, init: init, turn: true}
	m := r.m
	go func() {
		s, first, err := m.fetchMcp(context.Background(), c, false)
		if err != nil {
			m.warnMcp(c.id, err)
			return
		}
		m.settleMcp(c, s, first)
	}()
}

// settleMcp asks again, a few times, while the answer s of check c looks unsettled: a
// server still connecting (pending, also the cached servers kept while a process lists
// none), a server init listed missing, or no servers at all on the process's first
// check (claude.ai connectors arrive a moment after the process starts; mcp_status then
// answered none in a live run). The polls run on their own goroutine and end with the
// process; their answers are McpChanged events. The last poll's answer is taken as it
// is: a process that still lists no servers then has none.
func (m *Manager) settleMcp(c mcpCheck, s *McpStatus, first bool) {
	if !mcpUnsettled(s, c.init, first) {
		return
	}
	c.trigger, c.server = McpTriggerRefresh, ""
	go func() {
		for poll := 1; poll <= mcpPendingPolls; poll++ {
			select {
			case <-c.conn.Done():
				return
			case <-time.After(m.opts.McpPollInterval):
			}
			s, _, err := m.fetchMcp(context.Background(), c, poll == mcpPendingPolls)
			if err != nil {
				m.warnMcp(c.id, err)
				return
			}
			if !mcpUnsettled(s, c.init, first) {
				return
			}
		}
	}()
}

func (m *Manager) warnMcp(id string, err error) {
	if !errors.Is(err, claudestream.ErrClosed) {
		m.log.Warn("check MCP servers", "thread", id, "err", err)
	}
}

// mcpUnsettled reports whether a check should be repeated soon.
func mcpUnsettled(s *McpStatus, init []claudestream.McpServerInit, first bool) bool {
	if s.anyPending() || (first && len(s.Servers) == 0) {
		return true
	}
	return slices.ContainsFunc(init, func(in claudestream.McpServerInit) bool {
		sv, ok := s.server(in.Name)
		return !ok || sv.Transport == ""
	})
}

// fillFromInit adds the servers system/init listed that mcp_status did not report, with
// init's status and source (no transport, tools or version: init does not say).
func fillFromInit(servers []McpServer, init []claudestream.McpServerInit) []McpServer {
	for _, in := range init {
		if !slices.ContainsFunc(servers, func(sv McpServer) bool { return sv.Name == in.Name }) {
			servers = append(servers, McpServer{Name: in.Name, Status: in.Status, Source: in.Source, Scope: in.Source})
		}
	}
	return servers
}

// fetchMcp asks Claude (mcp_status, bounded by streamControlTimeout) and caches the
// answer, completed by c.init and, unless final or a turn's check, by the cached
// servers while the process lists none (answerMcp). It returns the answer, also when a
// later check's answer was cached first, and whether it was the process's first.
func (m *Manager) fetchMcp(ctx context.Context, c mcpCheck, final bool) (*McpStatus, bool, error) {
	ticket := c.log.mcpTicket()
	ctx, cancel := context.WithTimeout(ctx, streamControlTimeout)
	defer cancel()
	wire, err := c.conn.McpStatus(ctx)
	if err != nil {
		return nil, false, err
	}
	s := &McpStatus{CheckedAt: m.opts.Now(), Trigger: c.trigger, Server: c.server, Servers: fillFromInit(mcpFromWire(wire), c.init)}
	first := c.log.answerMcp(ticket, c.conn, s, len(wire), !final && !c.turn)
	return s, first, nil
}

// McpStatus implements Store.
func (m *Manager) McpStatus(ctx context.Context, id string, refresh bool) (*McpStatus, error) {
	log, err := m.thread(ctx, id)
	if err != nil {
		return nil, err
	}
	if !refresh {
		if s := log.mcpStatus(); s != nil {
			return s, nil
		}
		r, _, err := m.liveOrStopped(ctx, id)
		if err != nil || r == nil {
			return nil, err // not running and never checked: nothing to report
		}
	}
	// Asked again: a stopped thread starts (without a prompt) to answer.
	r, err := m.running(ctx, id)
	if err != nil {
		return nil, err
	}
	conn, err := r.st.connection()
	if err != nil {
		return nil, err
	}
	c := mcpCheck{conn: conn, log: log, id: id, trigger: McpTriggerRefresh}
	s, first, err := m.fetchMcp(ctx, c, false)
	if err != nil {
		return nil, controlErr(err)
	}
	m.settleMcp(c, s, first)
	return s, nil
}

// mcpReconnectTimeout bounds mcp_reconnect: Claude starts the server again first.
const mcpReconnectTimeout = 60 * time.Second

// McpReconnect implements Store.
func (m *Manager) McpReconnect(ctx context.Context, id, server string) (McpReconnectResult, error) {
	if strings.TrimSpace(server) == "" {
		return McpReconnectResult{}, fmt.Errorf("%w: a server name is required", ErrInvalidArgument)
	}
	log, err := m.thread(ctx, id)
	if err != nil {
		return McpReconnectResult{}, err
	}
	if cur := log.mcpStatus(); cur != nil {
		if _, ok := cur.server(server); !ok {
			return McpReconnectResult{}, fmt.Errorf("%w: thread %s has no MCP server %q", ErrNotFound, id, server)
		}
	}
	// A stopped thread starts (without a prompt) to reconnect it.
	r, err := m.running(ctx, id)
	if err != nil {
		return McpReconnectResult{}, err
	}
	conn, err := r.st.connection()
	if err != nil {
		return McpReconnectResult{}, err
	}
	var res McpReconnectResult
	var ce *claudestream.ControlError
	reconnect := func(ctx context.Context) error { return conn.McpReconnect(ctx, server) }
	switch err := boundedControl(ctx, "MCP reconnect", mcpReconnectTimeout, reconnect); {
	case err == nil:
	case errors.As(err, &ce) && strings.HasPrefix(ce.Message, "Server not found"):
		return res, fmt.Errorf("%w: thread %s has no MCP server %q", ErrNotFound, id, server)
	case errors.As(err, &ce):
		// The attempt failed: the status says how (the server's error).
		res.Error = ce.Message
	default:
		return res, controlErr(err)
	}
	m.log.Info("MCP server reconnected", "thread", id, "server", server, "err", res.Error)
	c := mcpCheck{conn: conn, log: log, id: id, trigger: McpTriggerReconnect, server: server}
	s, first, err := m.fetchMcp(ctx, c, false)
	if err != nil {
		return res, controlErr(err)
	}
	res.Status = s
	m.settleMcp(c, s, first)
	return res, nil
}
