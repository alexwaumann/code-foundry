package thread

import (
	"context"
	"time"
)

// Reseeds (docs/notes/ember-1-primitives.md): a thread's next Claude process starts a
// new conversation instead of resuming its own, with a seed: a system prompt append and
// add-dirs that every spawn of the thread passes from then on (Thread.SystemPromptAppend,
// SpawnAddDirs), and a prefix the first message of the new conversation starts with
// (SeedPrefix, like a resume note: Claude gets "<prefix>\n\n<message>", the item keeps
// the message and shows the prefix as Item.SeedPrefix). The thread's items stay; Epoch
// goes up by one; the context size goes to 0 (the new session has none yet).
//
// When it applies: a stopped thread only records it (FreshStart, persisted), and its
// next start is fresh (resumeLaunch). A running thread stops for it (disconnect reason
// ReasonReseed) as soon as nothing would be lost: at once when it is idle at its prompt,
// else once its turn, any pending request and its background work are over
// (reseedHoldOf; Thread.ReseedPending meanwhile); a message sent before then still goes
// to the old session. A stop is a stop: what "allow for thread" granted the old
// process goes with it, as at an idle stop, and the cached MCP status and slash commands
// stay until the new process reports. An effort change or a user's restart while the
// reseed waits still restarts the old session; the reseed stops it afterwards.

// ReasonReseed is the disconnect reason of a process stopped for a reseed.
const ReasonReseed = "reseed"

// ReseedOptions is a thread's new seed (Store.Reseed). Each field replaces the thread's:
// empty clears it.
type ReseedOptions struct {
	// SystemPromptAppend is appended to Claude's system prompt on every spawn; at most
	// 64 KiB.
	SystemPromptAppend string
	// AddDirs are absolute directories passed as --add-dir on every spawn (missing ones
	// are skipped then).
	AddDirs []string
	// Prefix starts the first message of the new session; at most 256 KiB.
	Prefix string
}

// Reseed implements Store: stopped reports that a running Claude was stopped at once.
func (m *Manager) Reseed(ctx context.Context, id string, o ReseedOptions) (t Thread, stopped bool, err error) {
	sd, err := cleanSeed(o.SystemPromptAppend, o.AddDirs, o.Prefix)
	if err != nil {
		return Thread{}, false, err
	}
	for {
		live, _, err := m.liveOrStopped(ctx, id)
		if err != nil {
			return Thread{}, false, err
		}
		if live != nil {
			cmd := threadCmd{reseed: &sd, reply: make(chan threadReply, 1)}
			select {
			case live.st.cmds <- cmd:
			case <-live.done:
				continue // it stopped meanwhile: the row takes it
			case <-ctx.Done():
				return Thread{}, false, ctx.Err()
			}
			select {
			case rep := <-cmd.reply:
				return rep.thread, rep.restarted, rep.err
			case <-ctx.Done():
				return Thread{}, false, ctx.Err()
			}
		}
		// Not running (or closing): its next start is fresh.
		s, ok, err := m.updateStopped(id, func(s *Thread) {
			s.applySeed(sd)
			s.resetContext()
		})
		if err != nil {
			return Thread{}, false, err
		}
		if ok {
			m.log.Info("thread reseeded for its next start", "thread", id, "epoch", s.Epoch, "prefix_bytes", len(sd.prefix),
				"system_prompt_bytes", len(sd.prompt), "add_dirs", sd.dirs)
			return s, false, nil
		}
	}
}

// applySeed records sd as the thread's seed, its next spawn fresh, one epoch on.
func (s *Thread) applySeed(sd seed) {
	s.SystemPromptAppend, s.SpawnAddDirs, s.SeedPrefix = sd.prompt, sd.dirs, sd.prefix
	s.FreshStart = true
	s.Epoch = max(s.Epoch, 1) + 1
}

// resetContext forgets the context size of the session a reseed leaves.
func (s *Thread) resetContext() {
	s.ContextTokens, s.ContextModel, s.LastResultAt, s.CacheExpiresAt = 0, "", time.Time{}, time.Time{}
}

// onReseed is Reseed on the runner's goroutine: the row takes the seed, and Claude
// stops at once when nothing holds it (maybeReseed), else once the turn ends (every
// maybeRestart looks again). It reports whether the stop began.
func (r *runner) onReseed(sd seed) (Thread, bool) {
	r.reseedPending = true
	r.m.update(r.id, true, func(rec *record) {
		rec.s.applySeed(sd)
		rec.s.ReseedPending = true
	})
	stopped := r.maybeReseed()
	s, _ := r.m.Snapshot().Thread(r.id)
	r.log().info("thread reseeded", "epoch", s.Epoch, "stopping_now", stopped, "prefix_bytes", len(sd.prefix),
		"system_prompt_bytes", len(sd.prompt), "add_dirs", sd.dirs)
	return s, stopped
}

// maybeReseed stops Claude for a pending reseed when nothing would be lost
// (reseedHoldOf), and reports whether it did. Run goroutine only.
func (r *runner) maybeReseed() bool {
	if !r.reseedPending || r.closing || r.finished {
		return false
	}
	if hold := reseedHoldOf(r.idleInputs(r.m.opts.Now())); hold != "" {
		return false
	}
	r.log().info("stopping claude for a reseed; the next message starts a fresh session")
	r.disconnectAs = ReasonReseed
	r.beginClose()
	return true
}

// reseedHoldOf is what keeps a process with a pending reseed up, "" when nothing
// does: the idle stop's holds (idleHoldOf) but the effort change (the next spawn takes
// the row's effort), the grace and the prompt cache.
func reseedHoldOf(in idleInputs) string {
	in.effortChange, in.idleGrace = false, 0
	in.cacheExpiresAt = in.now
	return idleHoldOf(in)
}

// clearSeedPrefix clears thread id's seed prefix once a message carrying it went out,
// unless a newer reseed replaced it meanwhile.
func (m *Manager) clearSeedPrefix(id, sent string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.s.SeedPrefix != sent {
		return
	}
	rec.s.SeedPrefix = ""
	m.commitLocked(rec, true)
}
