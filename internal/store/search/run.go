package search

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// runEffort is every run's effort: a search needs reading, not deep thinking, and low
// keeps it fast and cheap whatever the model (as naming's).
const runEffort = "low"

// allowedCommands are the run's only commands (Bash permission rules). With
// --permission-mode dontAsk, any other tool call is denied without asking; Claude still
// runs read-only commands inside the working directory unasked, which is why the run
// starts in the empty cwd/.
var allowedCommands = []string{
	"Bash(" + cliName + " thread search *)",
	"Bash(" + cliName + " thread read *)",
	"Bash(" + cliName + " search report *)",
}

// runArgs is the run's claude command line. The hardened flags (minimal false) are
//
//	--safe-mode                    no CLAUDE.md, skills, plugins, hooks or MCP servers
//	--tools Bash                   no built-in tool but Bash (no Read, Edit, Write, WebFetch, Agent…)
//	--permission-mode dontAsk      a call no rule allows is denied, never asked
//	--allowedTools <rules>         the three commands (allowedCommands)
//	--system-prompt-snapshot off   nothing recorded, so a promoted thread renders its own
//
// the same flags a managed laptop lets naming use (no hooks, no --strict-mcp-config, no
// --mcp-config). minimal drops --safe-mode and --system-prompt-snapshot, the flags an
// older Claude or an organization's settings may refuse; the tool limits stay.
func runArgs(claude, sessionID, model, prompt string, minimal bool) []string {
	argv := []string{claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--session-id", sessionID, "--model", model, "--effort", runEffort,
		"--tools", "Bash", "--permission-mode", "dontAsk"}
	if !minimal {
		argv = append(argv, "--safe-mode", "--system-prompt-snapshot", "off")
	}
	argv = append(argv, "--append-system-prompt", prompt)
	// Variadic: last.
	return append(append(argv, "--allowedTools"), allowedCommands...)
}

// stopReason is why a run was asked to stop.
type stopReason int

const (
	stopUser stopReason = iota + 1
	stopShutdown
)

// run is one agent search's process and loop.
type run struct {
	id   string
	stop chan stopReason // buffered 1: the first request wins
	done chan struct{}
	once sync.Once
}

func (r *run) requestStop(why stopReason) {
	r.once.Do(func() { r.stop <- why })
}

func (s *Store) cwd() string             { return filepath.Join(s.opts.Dir, "cwd") }
func (s *Store) tmpDir(id string) string { return filepath.Join(s.opts.Dir, "tmp", id) }

// StartAgent starts an agent search for question and returns its entry, RUNNING.
func (s *Store) StartAgent(ctx context.Context, question string) (Entry, error) {
	question = strings.TrimSpace(question)
	switch {
	case question == "":
		return Entry{}, fmt.Errorf("%w: a question is required", ErrInvalidArgument)
	case strings.ContainsRune(question, 0):
		return Entry{}, fmt.Errorf("%w: the question has a NUL byte", ErrInvalidArgument)
	case utf8.RuneCountInString(question) > MaxQuestionRunes:
		return Entry{}, fmt.Errorf("%w: the question is %d characters; at most %d", ErrInvalidArgument, utf8.RuneCountInString(question), MaxQuestionRunes)
	case s.opts.Dir == "":
		return Entry{}, fmt.Errorf("%w: agent search has no directory", ErrFailedPrecondition)
	}
	id, err := newID()
	if err != nil {
		return Entry{}, err
	}
	sid, err := newSessionID()
	if err != nil {
		return Entry{}, err
	}
	for _, d := range []string{s.cwd(), s.tmpDir(id)} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return Entry{}, fmt.Errorf("search: %w", err)
		}
	}
	e := &Entry{ID: id, Mode: ModeAgent, Query: question, CreatedAt: s.opts.Now().Truncate(time.Millisecond), Status: StatusRunning,
		ClaudeSessionID: sid, Model: s.opts.UtilityModel(), Version: 1}
	r := &run{id: id, stop: make(chan stopReason, 1), done: make(chan struct{})}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Entry{}, ErrClosed
	}
	if err := saveEntry(ctx, s.opts.DB, *e); err != nil {
		s.mu.Unlock()
		return Entry{}, err
	}
	s.entries[id] = e
	s.runs[id] = r
	minimal := s.minimal
	s.wg.Add(1)
	c := e.clone()
	s.mu.Unlock()
	s.publish(Changed{ID: id, Version: c.Version, Kind: EventEntry, Entry: c})
	s.prune(ctx)
	go func() {
		defer s.wg.Done()
		defer close(r.done)
		s.runAgent(r, c, minimal)
	}()
	return c, nil
}

// Stop stops a running agent search; a finished one is left as it is.
func (s *Store) Stop(ctx context.Context, id string) (Entry, error) {
	s.mu.Lock()
	r := s.runs[id]
	_, ok := s.entries[id]
	s.mu.Unlock()
	if !ok {
		return Entry{}, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if r != nil {
		r.requestStop(stopUser)
		select {
		case <-r.done:
		case <-ctx.Done():
			return Entry{}, ctx.Err()
		}
	}
	return s.Get(id)
}

// Wait blocks until search id is no longer running (or ctx ends) and returns it.
func (s *Store) Wait(ctx context.Context, id string) (Entry, error) {
	s.mu.Lock()
	r := s.runs[id]
	s.mu.Unlock()
	if r != nil {
		select {
		case <-r.done:
		case <-ctx.Done():
			return Entry{}, ctx.Err()
		}
	}
	return s.Get(id)
}

// runAgent runs search e's claude until it answers, fails, is stopped or runs out of
// time, and records the end. A start whose hardened flags claude refuses is tried once
// more without them, and later runs leave them out.
func (s *Store) runAgent(r *run, e Entry, minimal bool) {
	log := s.log.With("search", e.ID)
	start := time.Now()
	l := newLoop(s, r, e)
	end := l.run(minimal)
	if end.refused && !minimal {
		log.Warn("claude refused a search flag; retrying with the minimal command for this daemon run", "err", end.err)
		s.mu.Lock()
		s.minimal = true
		s.mu.Unlock()
		l = newLoop(s, r, e)
		end = l.run(true)
	}
	s.finish(e.ID, end, time.Since(start))
	got, _ := s.Get(e.ID)
	log.Info("agent search finished", "status", end.status, "hits", len(got.Hits), "steps", len(got.Steps), "cost_usd", end.cost,
		"took", time.Since(start).Round(time.Millisecond).String(), "err", end.err)
}

// runEnd is how a run ended.
type runEnd struct {
	status  Status
	answer  string
	note    string // the entry's error: why it failed, or how it ended
	cost    float64
	err     error // for the log
	refused bool  // claude refused a flag before it started
}

// finish records a run's end and forgets its process: the answer first (its own
// version, EventAnswer), then the status (EventStatus), so a watcher sees both.
func (s *Store) finish(id string, end runEnd, took time.Duration) {
	ctx := context.Background()
	defer func() {
		s.mu.Lock()
		delete(s.runs, id)
		s.mu.Unlock()
	}()
	if end.answer != "" {
		e, _, err := s.update(ctx, id, func(e *Entry) bool {
			e.Answer = end.answer
			return true
		})
		if err != nil {
			s.log.Error("search: record a run's answer", "search", id, "err", err)
		} else {
			s.publish(Changed{ID: id, Version: e.Version, Kind: EventAnswer, Answer: end.answer})
		}
	}
	e, _, err := s.update(ctx, id, func(e *Entry) bool {
		e.Status, e.Error, e.FinishedAt = end.status, end.note, s.opts.Now().Truncate(time.Millisecond)
		e.CostUSD, e.Duration, e.Unseen = end.cost, took, true
		for i := range e.Steps {
			if !e.Steps[i].Done {
				e.Steps[i] = completeStep(e.Steps[i], "", true)
			}
		}
		return true
	})
	if err != nil {
		s.log.Error("search: record a run's end", "search", id, "err", err)
		return
	}
	s.publish(Changed{ID: id, Version: e.Version, Kind: EventStatus, Entry: e})
}

// loop is one claude process of a run.
type loop struct {
	s     *Store
	r     *run
	e     Entry
	steps map[string]int // tool use id -> step index
	calls int
	// wrapping: asked for the answer (interrupted); wrapSent: the wrap-up message went.
	wrapping, wrapSent bool
	lastText           string
	cost               float64
}

func newLoop(s *Store, r *run, e Entry) *loop {
	return &loop{s: s, r: r, e: e, steps: map[string]int{}}
}

func (l *loop) hits() int {
	got, err := l.s.Get(l.e.ID)
	if err != nil {
		return 0
	}
	return len(got.Hits)
}

// run starts claude and drives it to the end.
func (l *loop) run(minimal bool) runEnd {
	s, e := l.s, l.e
	env := append(append([]string{}, s.opts.Env...), "TMPDIR="+s.tmpDir(e.ID))
	argv := runArgs(s.opts.Claude, e.ClaudeSessionID, e.Model, systemPrompt(e.ID, s.opts.MaxHits), minimal)
	proc, err := claudestream.Start(claudestream.Spec{Argv: argv, Env: env, Dir: s.cwd(),
		Conn: claudestream.Options{Log: s.log.With("search", e.ID)}})
	if err != nil {
		return runEnd{status: StatusFailed, note: "Claude did not start: " + err.Error(), err: err}
	}
	defer proc.CloseOutput()
	conn := proc.Conn()
	defer conn.Close()
	ictx, cancel := context.WithTimeout(context.Background(), s.opts.StartTimeout)
	_, err = conn.Initialize(ictx)
	cancel()
	if err != nil {
		kill(proc, s.opts.KillGrace)
		detail := strings.TrimSpace(proc.Stderr())
		ferr := fmt.Errorf("%w: %s", err, detail)
		if thread.IsFlagRefused(ferr) {
			return runEnd{status: StatusFailed, refused: true, note: "Claude refused a flag: " + lastLine(detail), err: ferr}
		}
		return runEnd{status: StatusFailed, note: "Claude did not start: " + cmpOr(lastLine(detail), err.Error()), err: ferr}
	}
	sctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	err = conn.Send(sctx, claudestream.UserMessage{Blocks: []claudestream.ContentBlock{claudestream.TextBlock(e.Query)}})
	cancel()
	if err != nil {
		kill(proc, s.opts.KillGrace)
		return runEnd{status: StatusFailed, note: "Claude did not take the question: " + err.Error(), err: err}
	}
	wrapAt := time.NewTimer(s.opts.WrapUpAfter)
	defer wrapAt.Stop()
	deadline := time.NewTimer(s.opts.WallTime)
	defer deadline.Stop()
	for {
		select {
		case ev, ok := <-conn.Events():
			if !ok {
				return l.exited(proc)
			}
			if end, over := l.event(conn, ev); over {
				_ = conn.CloseStdin()
				waitExit(proc, s.opts.KillGrace)
				return end
			}
		case <-wrapAt.C:
			l.wrapUp(conn)
		case <-deadline.C:
			kill(proc, s.opts.KillGrace)
			return l.cut(StatusDone, "stopped at the "+s.opts.WallTime.String()+" limit")
		case why := <-l.r.stop:
			kill(proc, s.opts.KillGrace)
			if why == stopShutdown {
				return l.cut(StatusFailed, "the daemon stopped while it ran")
			}
			return l.cut(StatusStopped, "")
		}
	}
}

// cut is the end of a run broken off: status, with the hits it has; a time limit with no
// hit is a failure.
func (l *loop) cut(status Status, note string) runEnd {
	if status == StatusDone && l.hits() == 0 {
		status = StatusFailed
	}
	return runEnd{status: status, note: note, cost: l.cost}
}

// exited is the end of a run whose claude exited before it answered.
func (l *loop) exited(proc *claudestream.Process) runEnd {
	waitExit(proc, l.s.opts.KillGrace)
	why := cmpOr(lastLine(proc.Stderr()), fmt.Sprintf("exit status %d", proc.ExitCode()))
	return runEnd{status: StatusFailed, note: "Claude exited before it answered: " + why, cost: l.cost, err: errors.New(why)}
}

// wrapUp asks the run for its answer now: the turn is interrupted, and once it ends
// (its result) the wrap-up message goes.
func (l *loop) wrapUp(conn *claudestream.Conn) {
	if l.wrapping {
		return
	}
	l.wrapping = true
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := conn.Interrupt(ctx); err != nil {
		l.s.log.Warn("search: interrupt for the answer", "search", l.e.ID, "err", err)
	}
}

// event handles one line of claude's output; over is true once the run has ended.
func (l *loop) event(conn *claudestream.Conn, ev claudestream.Event) (runEnd, bool) {
	switch ev := ev.(type) {
	case *claudestream.Assistant:
		if ev.ParentToolUseID != "" {
			return runEnd{}, false
		}
		if ev.APIError() {
			l.lastText = ""
			return runEnd{}, false
		}
		for _, b := range ev.Message.Content {
			switch b.Type {
			case "text":
				if t := strings.TrimSpace(b.Text); t != "" {
					l.lastText = t
				}
			case "tool_use":
				l.lastText = ""
				l.toolCall(conn, b)
			}
		}
	case *claudestream.User:
		if ev.ParentToolUseID != "" {
			return runEnd{}, false
		}
		for _, b := range ev.Blocks() {
			if b.Type == "tool_result" {
				l.toolResult(b)
			}
		}
	case *claudestream.Result:
		l.cost = ev.TotalCostUSD
		if l.wrapping && !l.wrapSent {
			// The interrupted turn ended: ask for the answer.
			l.wrapSent = true
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := conn.Send(ctx, claudestream.UserMessage{Blocks: []claudestream.ContentBlock{claudestream.TextBlock(wrapUpMessage)}}); err != nil {
				return runEnd{status: StatusFailed, note: "Claude did not take the wrap-up: " + err.Error(), cost: l.cost, err: err}, true
			}
			return runEnd{}, false
		}
		if ev.IsError && !ev.Interrupted() {
			why := strings.Join(ev.Errors, "; ")
			if why == "" {
				why = cmpOr(strings.TrimSpace(ev.Result), ev.Subtype)
			}
			if l.hits() > 0 {
				return runEnd{status: StatusDone, note: "Claude failed before it answered: " + why, cost: l.cost, err: errors.New(why)}, true
			}
			return runEnd{status: StatusFailed, note: why, cost: l.cost, err: errors.New(why)}, true
		}
		answer := strings.TrimSpace(ev.Result)
		if answer == "" {
			answer = l.lastText
		}
		return runEnd{status: StatusDone, answer: answer, cost: l.cost}, true
	}
	return runEnd{}, false
}

// toolCall records a tool call's step and counts it against MaxToolCalls.
func (l *loop) toolCall(conn *claudestream.Conn, b claudestream.Block) {
	l.calls++
	if l.calls >= l.s.opts.MaxToolCalls {
		l.wrapUp(conn)
	}
	st, ok := stepOf(b.Name, b.Input, threadNamer(l.s.opts.Threads.Snapshot()))
	if !ok {
		return
	}
	st = withText(st)
	e, _, err := l.s.update(context.Background(), l.e.ID, func(e *Entry) bool {
		st.Index = len(e.Steps)
		e.Steps = append(e.Steps, st)
		return true
	})
	if err != nil {
		l.s.log.Warn("search: record a step", "search", l.e.ID, "err", err)
		return
	}
	l.steps[b.ID] = st.Index
	l.s.publish(Changed{ID: l.e.ID, Version: e.Version, Kind: EventStep, Step: e.Steps[st.Index]})
}

// toolResult completes its call's step.
func (l *loop) toolResult(b claudestream.Block) {
	i, ok := l.steps[b.ToolUseID]
	if !ok {
		return
	}
	delete(l.steps, b.ToolUseID)
	var st Step
	e, _, err := l.s.update(context.Background(), l.e.ID, func(e *Entry) bool {
		if i >= len(e.Steps) {
			return false
		}
		e.Steps[i] = completeStep(e.Steps[i], b.ResultText(), b.IsError)
		st = e.Steps[i]
		return true
	})
	if err != nil {
		l.s.log.Warn("search: record a step", "search", l.e.ID, "err", err)
		return
	}
	l.s.publish(Changed{ID: l.e.ID, Version: e.Version, Kind: EventStep, Step: st})
}

// kill stops claude's process group: SIGTERM, then SIGKILL after grace.
func kill(proc *claudestream.Process, grace time.Duration) {
	_ = proc.Signal(syscall.SIGTERM)
	select {
	case <-proc.Done():
	case <-time.After(grace):
		_ = proc.Signal(syscall.SIGKILL)
		<-proc.Done()
	}
}

// waitExit waits for claude to exit after its stdin closed, killing it after grace.
func waitExit(proc *claudestream.Process, grace time.Duration) {
	select {
	case <-proc.Done():
	case <-time.After(grace):
		kill(proc, grace)
	}
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	return clip(strings.TrimSpace(s), 300)
}

// Report records a hit the run found (`code-foundry search report`): the quote must
// occur in that message (thread.Manager.VerifyQuote), the message must not be a hit
// already, and the run must have room for it. left is how many more it may report.
func (s *Store) Report(ctx context.Context, searchID, threadID, item, quote, why string) (hit Hit, left int, err error) {
	why = strings.Join(strings.Fields(why), " ")
	if why == "" {
		return Hit{}, 0, fmt.Errorf("%w: --why is required: one short line on why the message answers the question", ErrInvalidArgument)
	}
	if utf8.RuneCountInString(why) > MaxWhyRunes {
		why = clip(why, MaxWhyRunes)
	}
	s.mu.Lock()
	e, ok := s.entries[searchID]
	var status Status
	var mode Mode
	var n int
	if ok {
		status, mode, n = e.Status, e.Mode, len(e.Hits)
	}
	s.mu.Unlock()
	switch {
	case !ok || mode != ModeAgent:
		return Hit{}, 0, fmt.Errorf("%w: no agent search %q", ErrNotFound, searchID)
	case status != StatusRunning:
		return Hit{}, 0, fmt.Errorf("%w: search %s has ended", ErrFailedPrecondition, searchID)
	case n >= s.opts.MaxHits:
		return Hit{}, 0, fmt.Errorf("%w: %d hits reported, the most a search keeps: write your answer now", ErrInvalidArgument, s.opts.MaxHits)
	}
	q, err := s.opts.Threads.VerifyQuote(ctx, threadID, item, quote)
	if err != nil {
		if errors.Is(err, thread.ErrInvalidArgument) || errors.Is(err, thread.ErrNotFound) {
			return Hit{}, 0, fmt.Errorf("%w: %s", ErrInvalidArgument, strings.TrimPrefix(strings.TrimPrefix(err.Error(), thread.ErrInvalidArgument.Error()+": "), thread.ErrNotFound.Error()+": "))
		}
		return Hit{}, 0, err
	}
	var dup *Hit
	got, _, err := s.update(ctx, searchID, func(e *Entry) bool {
		if e.Status != StatusRunning || len(e.Hits) >= s.opts.MaxHits {
			return false
		}
		for i := range e.Hits {
			if e.Hits[i].ItemID == q.ItemID {
				dup = &e.Hits[i]
				return false
			}
		}
		hit = Hit{N: len(e.Hits) + 1, ThreadID: q.Thread.ID, ItemID: q.ItemID, Ordinal: q.Ordinal, Speaker: q.Speaker,
			ItemCreatedAt: q.CreatedAt, Quote: q.Quote, Why: why, ReportedAt: s.opts.Now().Truncate(time.Millisecond)}
		e.Hits = append(e.Hits, hit)
		return true
	})
	switch {
	case err != nil:
		return Hit{}, 0, err
	case dup != nil:
		return Hit{}, 0, fmt.Errorf("%w: #%d of thread %s is hit [%d] already", ErrInvalidArgument, dup.Ordinal, dup.ThreadID, dup.N)
	case hit.N == 0:
		return Hit{}, 0, fmt.Errorf("%w: search %s has ended or is full", ErrFailedPrecondition, searchID)
	}
	hit.ThreadName, hit.Archived = q.Thread.Name, !q.Thread.ArchivedAt.IsZero()
	s.publish(Changed{ID: searchID, Version: got.Version, Kind: EventHit, Hit: hit})
	return hit, s.opts.MaxHits - len(got.Hits), nil
}

// Promote makes a thread without a project that continues search id's conversation, on
// the user's default model and effort, its first message the question with the hits as
// citation links (promoteMessage). It returns the new thread's id.
func (s *Store) Promote(ctx context.Context, id string) (string, error) {
	e, err := s.Get(id)
	if err != nil {
		return "", err
	}
	switch {
	case e.Mode != ModeAgent:
		return "", fmt.Errorf("%w: search %s is a Find entry; only an agent search can be promoted", ErrFailedPrecondition, id)
	case e.Status == StatusRunning:
		return "", fmt.Errorf("%w: search %s is still running", ErrFailedPrecondition, id)
	case e.ClaudeSessionID == "":
		return "", fmt.Errorf("%w: search %s has no conversation to continue", ErrFailedPrecondition, id)
	}
	m, effort := s.opts.ThreadDefaults()
	t, err := s.opts.Threads.Create(ctx, thread.CreateOptions{
		NoProject: true, Model: m, Effort: effort, PermissionMode: thread.PermissionAuto,
		InitialPrompt: promoteMessage(e), ResumeSession: e.ClaudeSessionID,
	})
	if err != nil {
		if errors.Is(err, thread.ErrTranscriptMissing) {
			return "", fmt.Errorf("%w: search %s's conversation is gone (Claude deleted its transcript)", ErrFailedPrecondition, id)
		}
		return "", err
	}
	got, _, err := s.update(ctx, id, func(e *Entry) bool {
		e.PromotedThreadID, e.Unseen = t.ID, false
		return true
	})
	if err != nil {
		s.log.Warn("search: record the promoted thread", "search", id, "thread", t.ID, "err", err)
	} else {
		s.publish(Changed{ID: id, Version: got.Version, Kind: EventEntry, Entry: got})
	}
	return t.ID, nil
}
