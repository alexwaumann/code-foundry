package session

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

// A rendered thread's MCP servers (docs/notes/mcp-panel.md). Claude pushes nothing when
// a server's status changes, so the runner asks (mcp_status) after every system/init,
// i.e. at the start of each turn, again every few seconds while a server is still
// connecting, and after the user's own reconnects. The answer is cached on the thread's
// log in memory, not persisted: a disconnected thread has none. Every new answer is an
// McpChanged event in the thread's seq order, so ThreadService.Watch carries it.

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
// checked again or dropped (Status nil: the process ended).
type McpChanged struct {
	SessionID string
	Seq       uint64
	Status    *McpStatus
}

func (McpChanged) isThreadEvent() {}

// Thread implements ThreadEvent.
func (e McpChanged) Thread() string { return e.SessionID }

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
}

// mcpTicket numbers a check about to be made.
func (t *threadLog) mcpTicket() uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.mcp.issued++
	return t.mcp.issued
}

// setMcp caches the answer of check ticket and publishes it, unless a later check's
// answer is there already. It reports whether it was applied.
func (t *threadLog) setMcp(ticket uint64, s *McpStatus) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if ticket <= t.mcp.applied {
		return false
	}
	t.mcp.applied = ticket
	t.mcp.status = s
	t.seq++
	bus.Publish[ThreadEvent](t.bus, McpChanged{SessionID: t.id, Seq: t.seq, Status: s})
	return true
}

// clearMcp drops the cached status (the process ended) and every check in flight.
func (t *threadLog) clearMcp() {
	t.mu.Lock()
	had := t.mcp.status != nil
	t.mu.Unlock()
	ticket := t.mcpTicket()
	if had {
		t.setMcp(ticket, nil)
		return
	}
	t.mu.Lock()
	t.mcp.applied = max(t.mcp.applied, ticket)
	t.mu.Unlock()
}

func (t *threadLog) mcpStatus() *McpStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.mcp.status
}

// MCP polling while the answer is unsettled (mcpUnsettled): Claude starts servers in the
// background, so the first turn's check often finds one pending.
const (
	mcpPendingPolls    = 5
	mcpPendingInterval = 3 * time.Second
)

// checkMcp asks Claude for its MCP servers off the runner goroutine (system/init, whose
// mcp_servers fill in what the answer lacks) and, while the answer looks unsettled, asks
// again a few times: a server still connecting, a server init listed missing, or no
// servers at all on the process's first check (claude.ai connectors arrive a moment
// after the first turn starts; mcp_status then answered none in a live run).
func (r *runner) checkMcp(init []claudestream.McpServerInit) {
	conn, log, m, id := r.st.conn, r.st.log, r.m, r.id
	first := !r.st.mcpChecked
	r.st.mcpChecked = true
	go func() {
		trigger := McpTriggerTurn
		for poll := 0; ; poll++ {
			s, err := m.fetchMcp(context.Background(), conn, log, trigger, "", init)
			if err != nil {
				if !errors.Is(err, claudestream.ErrClosed) {
					m.log.Warn("check MCP servers", "session", id, "err", err)
				}
				return
			}
			if !mcpUnsettled(s, init, first) || poll >= mcpPendingPolls {
				return
			}
			select {
			case <-conn.Done():
				return
			case <-time.After(mcpPendingInterval):
			}
			trigger = McpTriggerRefresh
		}
	}()
}

// mcpUnsettled reports whether a turn's check should be repeated soon.
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
// answer, completed by fill (system/init's list). It returns the answer, also when a
// later check's answer was cached first.
func (m *Manager) fetchMcp(ctx context.Context, conn *claudestream.Conn, log *threadLog, trigger McpTrigger, server string, fill []claudestream.McpServerInit) (*McpStatus, error) {
	ticket := log.mcpTicket()
	ctx, cancel := context.WithTimeout(ctx, streamControlTimeout)
	defer cancel()
	wire, err := conn.McpStatus(ctx)
	if err != nil {
		return nil, err
	}
	s := &McpStatus{CheckedAt: m.opts.Now(), Trigger: trigger, Server: server, Servers: fillFromInit(mcpFromWire(wire), fill)}
	log.setMcp(ticket, s)
	return s, nil
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
	}
	r, _, err := m.liveStream(id)
	if err != nil {
		if refresh {
			return nil, err
		}
		return nil, nil // not running: no servers to report
	}
	conn, err := r.st.connection()
	if err != nil {
		return nil, err
	}
	s, err := m.fetchMcp(ctx, conn, log, McpTriggerRefresh, "", nil)
	return s, controlErr(err)
}

// McpReconnect implements Store.
func (m *Manager) McpReconnect(ctx context.Context, id, server string) (McpReconnectResult, error) {
	if strings.TrimSpace(server) == "" {
		return McpReconnectResult{}, fmt.Errorf("%w: a server name is required", ErrInvalidArgument)
	}
	log, err := m.thread(ctx, id)
	if err != nil {
		return McpReconnectResult{}, err
	}
	r, _, err := m.liveStream(id)
	if err != nil {
		return McpReconnectResult{}, err
	}
	if cur := log.mcpStatus(); cur != nil {
		if _, ok := cur.server(server); !ok {
			return McpReconnectResult{}, fmt.Errorf("%w: thread %s has no MCP server %q", ErrNotFound, id, server)
		}
	}
	conn, err := r.st.connection()
	if err != nil {
		return McpReconnectResult{}, err
	}
	var res McpReconnectResult
	var ce *claudestream.ControlError
	switch err := conn.McpReconnect(ctx, server); {
	case err == nil:
	case errors.As(err, &ce) && strings.HasPrefix(ce.Message, "Server not found"):
		return res, fmt.Errorf("%w: thread %s has no MCP server %q", ErrNotFound, id, server)
	case errors.As(err, &ce):
		// The attempt failed: the status says how (the server's error).
		res.Error = ce.Message
	default:
		return res, controlErr(err)
	}
	m.log.Info("MCP server reconnected", "session", id, "server", server, "err", res.Error)
	if res.Status, err = m.fetchMcp(ctx, conn, log, McpTriggerReconnect, server, nil); err != nil {
		return res, controlErr(err)
	}
	return res, nil
}
