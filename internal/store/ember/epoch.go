package ember

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// persisted is Ember's state.json: what the store keeps across daemon restarts besides
// the board (ember_tasks) and the thread's own row.
type persisted struct {
	// Epoch is the resident's epoch the store last saw, EpochStartedAt when it began.
	Epoch          int       `json:"epoch"`
	EpochStartedAt time.Time `json:"epoch_started_at"`
	// LastConsolidatedAt is when the last good consolidation finished (its input starts
	// there next time; a failed one leaves it); LastConsolidationError why the last one
	// failed, "" when it went well.
	LastConsolidatedAt     time.Time `json:"last_consolidated_at"`
	LastConsolidationError string    `json:"last_consolidation_error,omitempty"`
	// LastConsolidationUsage is the last consolidation call's usage (nil before one
	// reported it); ConsolidationUsageTotal sums every call's.
	LastConsolidationUsage  *ConsolidationUsage `json:"last_consolidation_usage,omitempty"`
	ConsolidationUsageTotal ConsolidationUsage  `json:"consolidation_usage_total"`
	// WorkerNext counts the workers given a model from ember.worker_models.
	WorkerNext int `json:"worker_next"`
}

// loadState reads dir's state.json; the zero value when it is missing or unreadable
// (logged).
func loadState(log *slog.Logger, dir string) persisted {
	var p persisted
	b, err := os.ReadFile(filepath.Join(dir, stateFile))
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		log.Warn("ember: read its state", "err", err)
	default:
		if err := json.Unmarshal(b, &p); err != nil {
			log.Warn("ember: its state does not parse; starting afresh", "err", err)
			return persisted{}
		}
	}
	return p
}

// saveStateLocked writes state.json (s.mu held). A failure is logged: the state is a
// convenience (an epoch's age, the worker rotation).
func (s *Store) saveStateLocked() {
	b, err := json.MarshalIndent(s.st, "", "  ")
	if err == nil {
		if err = os.MkdirAll(s.opts.Dir, 0o700); err == nil {
			err = writeAtomic(filepath.Join(s.opts.Dir, stateFile), append(b, '\n'))
		}
	}
	if err != nil {
		s.log.Warn("ember: save its state", "err", err)
	}
}

// seedParts are an epoch's seed: the system prompt append and the prefix.
type seedParts struct {
	system, prefix string
}

// reseedOptions are the thread store's reseed options for a seed and add-dirs.
func reseedOptions(sd seedParts, dirs []string) thread.ReseedOptions {
	return thread.ReseedOptions{SystemPromptAppend: sd.system, AddDirs: dirs, Prefix: sd.prefix}
}

// buildSeed writes seed/ (BOARD.md, PROJECTS.md, RECENT.md, from the board, the
// projects and resident id's messages; none for "") and returns the seed: rules.md and
// SOUL.md as the system prompt, MEMORY.md and the three files as the prefix.
func (s *Store) buildSeed(ctx context.Context, id string) (seedParts, error) {
	now, loc := s.opts.Now(), s.opts.Location
	soul := s.readFile(soulFile)
	s.memMu.Lock()
	memory := s.readFile(memoryFile)
	s.memMu.Unlock()
	snap := s.Snapshot()
	board := RenderBoard(snap.Tasks, snap.Timers, now, loc)
	projects := RenderProjects(s.projectSeeds()) + RenderSkills(s.opts.OrchestrateSkill)
	var msgs []Message
	if id != "" {
		var err error
		if msgs, err = s.messages(ctx, id, time.Time{}); err != nil {
			s.log.Warn("ember: read its messages for the seed", "thread", id, "err", err)
		}
	}
	recent := RenderRecent(msgs, RecentBudget(memory, board, projects), loc)
	dir := filepath.Join(s.opts.Dir, seedDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return seedParts{}, fmt.Errorf("ember: make %s: %w", dir, err)
	}
	for name, body := range map[string]string{boardFile: board, projectFile: projects, recentFile: recent} {
		if err := writeAtomic(filepath.Join(dir, name), []byte(body)); err != nil {
			return seedParts{}, err
		}
	}
	return seedParts{system: SystemPrompt(rules, soul), prefix: Prefix(memory, board, projects, recent)}, nil
}

// messages are resident id's visible messages after since, oldest first: the user's
// own (not wakes) and its replies (top-level text; one turn's texts joined).
func (s *Store) messages(ctx context.Context, id string, since time.Time) ([]Message, error) {
	items, err := s.opts.Threads.Items(ctx, id)
	if err != nil {
		return nil, err
	}
	return visibleMessages(items.Items, since), nil
}

// visibleMessages picks the user's messages and Ember's replies from items, after since.
// Consecutive reply texts (one turn's, around its tool calls) are one message.
func visibleMessages(items []thread.Item, since time.Time) []Message {
	var out []Message
	lastReply := false
	for _, it := range items {
		if !it.CreatedAt.After(since) || it.Streaming {
			continue
		}
		switch {
		case it.Kind == thread.KindUserMessage && it.Origin == thread.OriginUser && strings.TrimSpace(it.Text) != "":
			out = append(out, Message{At: it.CreatedAt, User: true, Text: it.Text})
			lastReply = false
		case it.Kind == thread.KindUserMessage:
			lastReply = false // a wake: the next reply is another message
		case it.Kind == thread.KindAssistantText && it.ParentToolUseID == "" && strings.TrimSpace(it.Text) != "":
			if lastReply {
				out[len(out)-1].Text += "\n\n" + it.Text
				continue
			}
			out = append(out, Message{At: it.CreatedAt, Text: it.Text})
			lastReply = true
		}
	}
	return out
}

// projectSeeds are every project with its latest threads the user sees.
func (s *Store) projectSeeds() []ProjectSeed {
	if s.opts.Projects == nil {
		return nil
	}
	ps := s.opts.Projects.Snapshot()
	if ps == nil {
		return nil
	}
	threads := s.opts.Threads.Snapshot()
	showCreated := s.opts.Config().ShowCreatedThreads
	out := make([]ProjectSeed, 0, len(ps.Projects))
	for _, p := range ps.Projects {
		seed := ProjectSeed{ID: p.ID, Name: p.Name, Path: p.Path, DefaultBranch: p.DefaultBranch, Git: p.Git, GitHubSlug: p.GitHubSlug}
		var list []thread.Thread
		if threads != nil {
			for _, t := range threads.Threads {
				if t.ProjectID == p.ID && t.ArchivedAt.IsZero() && t.Kind == thread.KindNormal && t.Owner == "" && t.InSidebar(showCreated) {
					list = append(list, t)
				}
			}
		}
		slices.SortFunc(list, func(a, b thread.Thread) int {
			return cmp.Or(b.LastActivityAt.Compare(a.LastActivityAt), strings.Compare(a.ID, b.ID))
		})
		for _, t := range list[:min(len(list), recentThreads)] {
			tt := taskThread(threads, t.ID)
			seed.Threads = append(seed.Threads, ThreadLine{ID: t.ID, Name: t.Name, State: ThreadState(tt)})
		}
		out = append(out, seed)
	}
	return out
}

// Reseed starts a new epoch now (code-foundry ember reseed): consolidation, the seed,
// the reseed. It returns once the reseed is recorded (the resident stops at once when
// idle, else after its turn); a ctx that ends first leaves the boundary running.
func (s *Store) Reseed(ctx context.Context) (Status, error) {
	s.mu.Lock()
	switch {
	case !s.enabled:
		s.mu.Unlock()
		return Status{}, fmt.Errorf("%w: Ember is off (code-foundry ember enable turns it on)", ErrFailedPrecondition)
	case s.consolidating:
		s.mu.Unlock()
		return Status{}, fmt.Errorf("%w: a new epoch is being prepared already", ErrFailedPrecondition)
	}
	res, ok := residentOf(s.opts.Threads.Snapshot())
	if !ok {
		s.mu.Unlock()
		return Status{}, fmt.Errorf("%w: Ember has no thread yet", ErrFailedPrecondition)
	}
	s.consolidating = true
	s.publishLocked(s.opts.Threads.Snapshot())
	s.mu.Unlock()
	done := make(chan error, 1)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		done <- s.boundary(s.ctx, res.ID)
	}()
	select {
	case err := <-done:
		return s.Snapshot().Status, err
	case <-ctx.Done():
		return s.Snapshot().Status, ctx.Err()
	}
}

// boundary runs an epoch boundary for resident id (s.consolidating set by the caller,
// cleared here): consolidation (a failure keeps MEMORY.md and LastConsolidatedAt, and
// goes on), the seed, the reseed.
func (s *Store) boundary(ctx context.Context, id string) error {
	s.epochMu.Lock()
	defer s.epochMu.Unlock()
	defer func() {
		s.mu.Lock()
		s.consolidating = false
		s.publishLocked(s.opts.Threads.Snapshot())
		s.mu.Unlock()
	}()
	consErr := s.consolidate(ctx, id)
	sd, err := s.buildSeed(ctx, id)
	if err != nil {
		return err
	}
	t, stopped, err := s.opts.Threads.Reseed(ctx, id, reseedOptions(sd, s.addDirs()))
	if err != nil {
		return fmt.Errorf("ember: reseed: %w", err)
	}
	now := s.opts.Now()
	s.mu.Lock()
	s.st.Epoch, s.st.EpochStartedAt = t.Epoch, now
	s.st.LastConsolidationError = ""
	if consErr != nil {
		// The next consolidation starts where the last good one ended, so this epoch's
		// conversation still reaches MEMORY.md (ConsolidationInput caps the input).
		s.st.LastConsolidationError = consErr.Error()
	} else {
		s.st.LastConsolidatedAt = now
	}
	s.saveStateLocked()
	s.mu.Unlock()
	s.log.Info("ember: new epoch", "thread", id, "epoch", t.Epoch, "stopped", stopped, "pending", t.ReseedPending,
		"prefix_bytes", len(sd.prefix), "system_prompt_bytes", len(sd.system), "consolidation_err", consErr)
	return nil
}
