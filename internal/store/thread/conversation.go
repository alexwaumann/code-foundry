package thread

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Store methods for a thread's conversation (Send, Respond, Interrupt, SetModel,
// SetPermissionMode). Items and WatchItems are in items.go. A message to a stopped
// thread starts it (lifecycle.go); settings changed while it is stopped go to its row.

// call runs cmd on the runner's goroutine. errProcessGone when the runner finished
// before taking it.
func (r *runner) call(ctx context.Context, cmd threadCmd) (Item, error) {
	cmd.ctx, cmd.reply = ctx, make(chan threadReply, 1)
	select {
	case r.st.cmds <- cmd:
	case <-r.done:
		return Item{}, errProcessGone
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

// Send implements Store. A thread that is not running starts with the message as its
// first prompt (startStopped): the item is written at once, and a start that fails is
// told in the timeline, not by an error. A message to a starting thread waits for the
// handshake behind the first prompt (queue); one to a closing thread waits for the exit,
// then starts it. A sent message unarchives and unsnoozes the thread.
func (m *Manager) Send(ctx context.Context, id string, msg Message) (Item, error) {
	log, err := m.thread(ctx, id)
	if err != nil {
		return Item{}, err
	}
	// "/clear" and the like: the app has its own control (slashdeny.go). The commands
	// Claude last reported count while it is stopped too.
	if ref := refusedSlashCommand(msg.Text, log.offersSlashCommand); ref != nil {
		m.log.Info("refused a slash command the app replaces", "thread", id, "command", ref.Command)
		return Item{}, ref
	}
	attachments, err := messageAttachments(ctx, m.opts.AttachmentsDir, msg.Attachments)
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
	s, err := m.Get(ctx, id)
	if err != nil {
		return Item{}, err
	}
	prompt, dropped := rewriteFileRefs(prompt, m.fileRefRoots(s))
	if len(dropped) > 0 {
		m.log.Warn("file references outside the thread's projects; passing their relative paths", "thread", id, "refs", dropped)
	}
	prompt = m.rewriteThreadRefsLogged(id, prompt)
	o := &outgoing{text: strings.TrimSpace(msg.Text), composer: strings.TrimSpace(msg.ComposerText), attachments: attachments, prompt: prompt,
		origin: msg.Origin, wakeTitle: msg.WakeTitle, wakeJSON: msg.WakeJSON}
	m.nameFromFirstMessage(id, log, o)
	for {
		live, closing, reserved, _, err := m.lifecycle(id)
		var it Item
		switch {
		case err != nil:
			return Item{}, err
		case live != nil:
			if it, err = live.call(ctx, threadCmd{send: o}); errors.Is(err, errProcessGone) {
				continue // it is ending: wait for it, then start again
			}
		case closing != nil:
			if err := waitDone(ctx, closing); err != nil {
				return Item{}, err
			}
			continue
		case reserved != nil:
			select {
			case <-reserved:
			case <-ctx.Done():
				return Item{}, ctx.Err()
			}
			continue
		default:
			if it, err = m.startStopped(ctx, id, startOpts{first: o, backToList: true}); errors.Is(err, errNotStopped) {
				continue
			}
		}
		if err == nil {
			// A new turn brings an archived or snoozed thread back to the main list.
			m.backToList(id)
		}
		return it, err
	}
}

// fileRefRoots resolves a file reference's repository to its worktree for thread s:
// the workspace's member in that project, else s's own worktree for its project. A
// thread without a project resolves none.
func (m *Manager) fileRefRoots(s Thread) func(projectID string) (string, bool) {
	var members []workspace.Member
	if s.WorkspaceID != "" && m.opts.Workspaces != nil {
		if w, ok := m.opts.Workspaces.Snapshot().Workspace(s.WorkspaceID); ok {
			members = w.Members
		}
	}
	return func(projectID string) (string, bool) {
		if i := slices.IndexFunc(members, func(mem workspace.Member) bool { return mem.ProjectID == projectID }); i >= 0 {
			return members[i].WorktreePath, true
		}
		return s.WorktreePath, s.ProjectID != "" && projectID == s.ProjectID
	}
}

// Respond implements Store. A thread that is not running has no pending request.
func (m *Manager) Respond(ctx context.Context, id, requestID string, d Decision) (Item, error) {
	if requestID == "" {
		return Item{}, fmt.Errorf("%w: a request id is required", ErrInvalidArgument)
	}
	r, _, err := m.liveOrStopped(ctx, id)
	if err != nil {
		return Item{}, err
	}
	if r == nil {
		return Item{}, fmt.Errorf("%w: no pending request %s on thread %s: Claude is not running", ErrFailedPrecondition, requestID, id)
	}
	return r.call(ctx, threadCmd{requestID: requestID, decision: d})
}

// Interrupt implements Store. A thread that is not running has nothing to stop: a
// no-op.
func (m *Manager) Interrupt(ctx context.Context, id string) error {
	r, _, err := m.liveOrStopped(ctx, id)
	if err != nil || r == nil {
		return err
	}
	conn, err := r.st.connection()
	if err != nil {
		return err
	}
	return controlErr(conn.Interrupt(ctx))
}

// setLive applies a setting: through Claude's control protocol (apply) on a live
// thread, then on the row; only on the row (persisted) for a thread that is not
// running, which the next spawn reads (claudeCommand).
func (m *Manager) setLive(ctx context.Context, id string, apply func(*claudestream.Conn) error, row func(*Thread)) (Thread, error) {
	for {
		r, _, err := m.liveOrStopped(ctx, id)
		if err != nil {
			return Thread{}, err
		}
		if r == nil {
			s, ok, err := m.updateStopped(id, row)
			if err != nil || ok {
				return s, err
			}
			continue // started meanwhile
		}
		select { // a starting process gets it once it answered the handshake
		case <-r.ready:
		case <-r.done:
			continue
		case <-ctx.Done():
			return Thread{}, ctx.Err()
		}
		conn, err := r.st.connection()
		if err != nil {
			return Thread{}, err
		}
		if err := apply(conn); errors.Is(err, claudestream.ErrClosed) {
			// The process ended under the request (an idle stop raced it): once the
			// runner is gone the row takes the setting (updateStopped).
			select {
			case <-r.done:
			case <-ctx.Done():
				return Thread{}, ctx.Err()
			}
			continue
		} else if err != nil {
			return Thread{}, controlErr(err)
		}
		s, _ := m.update(id, true, func(rec *record) { row(&rec.s) })
		return s, nil
	}
}

// SetModel implements Store.
func (m *Manager) SetModel(ctx context.Context, id, model string) (Thread, error) {
	if model == "" {
		return Thread{}, fmt.Errorf("%w: a model is required", ErrInvalidArgument)
	}
	if err := validateModelEffort(model, ""); err != nil {
		return Thread{}, err
	}
	s, err := m.setLive(ctx, id, func(c *claudestream.Conn) error { return c.SetModel(ctx, model) },
		func(s *Thread) { s.Model = model })
	if err == nil {
		m.log.Info("thread model changed", "thread", id, "model", model)
	}
	return s, err
}

// SetPermissionMode implements Store. Only supervised, accept edits and auto: plan and
// bypass are not representable, and Claude's default (no flag: the user's
// defaultMode setting) cannot be selected live.
func (m *Manager) SetPermissionMode(ctx context.Context, id string, mode PermissionMode) (Thread, error) {
	wire := ""
	switch mode {
	case PermissionSupervised:
		wire = claudestream.ModeDefault // what --permission-mode manual is called on the wire
	case PermissionAcceptEdits:
		wire = claudestream.ModeAcceptEdits
	case PermissionAuto:
		wire = claudestream.ModeAuto
	default:
		return Thread{}, fmt.Errorf("%w: permission mode %d (want supervised, accept edits or auto)", ErrInvalidArgument, mode)
	}
	s, err := m.setLive(ctx, id, func(c *claudestream.Conn) error { return c.SetPermissionMode(ctx, wire) },
		func(s *Thread) { s.PermissionMode = mode })
	if err == nil {
		m.log.Info("thread permission mode changed", "thread", id, "mode", mode.Flag())
	}
	return s, err
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
