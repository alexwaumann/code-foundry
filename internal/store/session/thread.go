package session

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Store methods for rendered threads (Send, Respond, Interrupt, SetModel,
// SetPermissionMode). Items and WatchItems are in items.go.

// liveStream returns a rendered thread's runner, or why there is none.
func (m *Manager) liveStream(id string) (*runner, Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return nil, Session{}, err
	}
	if rec.s.Render != RenderRendered {
		return nil, rec.s, fmt.Errorf("%w: thread %s runs in a terminal", ErrFailedPrecondition, id)
	}
	if rec.run == nil || rec.run.st == nil || rec.s.State == StateClosing {
		return nil, rec.s, fmt.Errorf("%w: thread %s is %s; reconnect it first", ErrFailedPrecondition, id, rec.s.State)
	}
	return rec.run, rec.s, nil
}

// call runs cmd on the runner's goroutine.
func (r *runner) call(ctx context.Context, cmd threadCmd) (Item, error) {
	cmd.ctx, cmd.reply = ctx, make(chan threadReply, 1)
	select {
	case r.st.cmds <- cmd:
	case <-r.done:
		return Item{}, fmt.Errorf("%w: thread %s disconnected", ErrFailedPrecondition, r.id)
	case <-ctx.Done():
		return Item{}, ctx.Err()
	}
	select {
	case rep := <-cmd.reply:
		return rep.item, rep.err
	case <-ctx.Done():
		return Item{}, ctx.Err()
	}
}

// Send implements Store.
func (m *Manager) Send(ctx context.Context, id string, msg Message) (Item, error) {
	r, s, err := m.liveStream(id)
	if err != nil {
		return Item{}, err
	}
	attachments, err := checkAttachments(m.opts.AttachmentsDir, msg.Attachments)
	if err != nil {
		return Item{}, err
	}
	prompt := buildPrompt(msg.Text, attachments)
	if prompt == "" {
		return Item{}, fmt.Errorf("%w: the message is empty", ErrInvalidArgument)
	}
	if strings.ContainsRune(prompt, 0) {
		return Item{}, fmt.Errorf("%w: message contains a NUL byte", ErrInvalidArgument)
	}
	prompt, dropped := rewriteFileRefs(prompt, m.fileRefRoots(s))
	if len(dropped) > 0 {
		m.log.Warn("file references outside the thread's projects; passing their relative paths", "session", id, "refs", dropped)
	}
	return r.call(ctx, threadCmd{send: &outgoing{text: strings.TrimSpace(msg.Text), composer: strings.TrimSpace(msg.ComposerText), attachments: attachments, prompt: prompt}})
}

// fileRefRoots resolves a file reference's repository to its worktree for thread s:
// the workspace's member in that repository, else s's own worktree for its repo.
func (m *Manager) fileRefRoots(s Session) func(repoID string) (string, bool) {
	var members []workspace.Member
	if s.WorkspaceID != "" && m.opts.Workspaces != nil {
		if w, ok := m.opts.Workspaces.Snapshot().Workspace(s.WorkspaceID); ok {
			members = w.Members
		}
	}
	return func(repoID string) (string, bool) {
		if i := slices.IndexFunc(members, func(mem workspace.Member) bool { return mem.RepoID == repoID }); i >= 0 {
			return members[i].WorktreePath, true
		}
		return s.WorktreePath, repoID == s.RepoID
	}
}

// Respond implements Store.
func (m *Manager) Respond(ctx context.Context, id, requestID string, d Decision) (Item, error) {
	if requestID == "" {
		return Item{}, fmt.Errorf("%w: a request id is required", ErrInvalidArgument)
	}
	r, _, err := m.liveStream(id)
	if err != nil {
		return Item{}, err
	}
	return r.call(ctx, threadCmd{requestID: requestID, decision: d})
}

// Interrupt implements Store.
func (m *Manager) Interrupt(ctx context.Context, id string) error {
	r, _, err := m.liveStream(id)
	if err != nil {
		return err
	}
	conn, err := r.st.connection()
	if err != nil {
		return err
	}
	return controlErr(conn.Interrupt(ctx))
}

// SetModel implements Store.
func (m *Manager) SetModel(ctx context.Context, id, model string) (Session, error) {
	if model == "" {
		return Session{}, fmt.Errorf("%w: a model is required", ErrInvalidArgument)
	}
	if err := validateModelEffort(model, ""); err != nil {
		return Session{}, err
	}
	r, _, err := m.liveStream(id)
	if err != nil {
		return Session{}, err
	}
	conn, err := r.st.connection()
	if err != nil {
		return Session{}, err
	}
	if err := controlErr(conn.SetModel(ctx, model)); err != nil {
		return Session{}, err
	}
	s, _ := m.update(id, true, func(rec *record) { rec.s.Model = model })
	m.log.Info("thread model changed", "session", id, "model", model)
	return s, nil
}

// SetPermissionMode implements Store. Only supervised, accept edits and auto: plan and
// bypass are not representable, and Claude's default (no flag: the user's
// defaultMode setting) cannot be selected live.
func (m *Manager) SetPermissionMode(ctx context.Context, id string, mode PermissionMode) (Session, error) {
	wire := ""
	switch mode {
	case PermissionSupervised:
		wire = claudestream.ModeDefault // what --permission-mode manual is called on the wire
	case PermissionAcceptEdits:
		wire = claudestream.ModeAcceptEdits
	case PermissionAuto:
		wire = claudestream.ModeAuto
	default:
		return Session{}, fmt.Errorf("%w: permission mode %d (want supervised, accept edits or auto)", ErrInvalidArgument, mode)
	}
	r, _, err := m.liveStream(id)
	if err != nil {
		return Session{}, err
	}
	conn, err := r.st.connection()
	if err != nil {
		return Session{}, err
	}
	if err := controlErr(conn.SetPermissionMode(ctx, wire)); err != nil {
		return Session{}, err
	}
	s, _ := m.update(id, true, func(rec *record) { rec.s.PermissionMode = mode })
	m.log.Info("thread permission mode changed", "session", id, "mode", mode.Flag())
	return s, nil
}

// controlErr maps the CLI's refusal to InvalidArgument and a gone process to
// FailedPrecondition.
func controlErr(err error) error {
	var ce *claudestream.ControlError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &ce):
		return fmt.Errorf("%w: %v", ErrInvalidArgument, ce)
	case errors.Is(err, claudestream.ErrClosed):
		return fmt.Errorf("%w: the thread's process has ended", ErrFailedPrecondition)
	}
	return err
}
