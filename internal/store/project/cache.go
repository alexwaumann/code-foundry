package project

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"slices"
	"sync"
	"time"
)

// Cold-start snapshot persistence: each registered project's last known metadata and
// worktree statuses are persisted to project_snapshot_cache on a debounced background
// writer and flushed on Close. Start hydrates g.projects before its initial commit(nil)
// so Snapshot() is immediately populated on daemon restart, while still scheduling a
// live reconcile + status refresh for every project to correct any drift.

const (
	snapshotCacheVersion   = 1
	defaultCacheFlushDelay = 5 * time.Second
	cacheWriteTimeout      = 5 * time.Second
)

type cachedProjectSnapshot struct {
	V             int              `json:"v"`
	DefaultBranch string           `json:"default_branch,omitempty"`
	GitHubSlug    string           `json:"github_slug,omitempty"`
	OriginURL     string           `json:"origin_url,omitempty"`
	Remotes       []string         `json:"remotes,omitempty"`
	Git           bool             `json:"git"`
	Worktrees     []cachedWorktree `json:"worktrees,omitempty"`
}

type cachedWorktree struct {
	Path     string       `json:"path"`
	Branch   string       `json:"branch,omitempty"`
	Head     string       `json:"head,omitempty"`
	IsMain   bool         `json:"is_main,omitempty"`
	Detached bool         `json:"detached,omitempty"`
	Status   cachedStatus `json:"status"`
}

type cachedStatus struct {
	Upstream      string `json:"upstream,omitempty"`
	Ahead         int    `json:"ahead,omitempty"`
	Behind        int    `json:"behind,omitempty"`
	Staged        int    `json:"staged,omitempty"`
	Modified      int    `json:"modified,omitempty"`
	Untracked     int    `json:"untracked,omitempty"`
	Conflicted    int    `json:"conflicted,omitempty"`
	Dirty         bool   `json:"dirty,omitempty"`
	BaseRef       string `json:"base_ref,omitempty"`
	BaseAhead     int    `json:"base_ahead,omitempty"`
	BaseBehind    int    `json:"base_behind,omitempty"`
	BaseMerged    bool   `json:"base_merged,omitempty"`
	RefreshedAtMs int64  `json:"refreshed_at_ms,omitempty"`
}

func cachedWorktreeFrom(w Worktree) cachedWorktree {
	cs := cachedStatus{
		Upstream:   w.Status.Upstream,
		Ahead:      w.Status.Ahead,
		Behind:     w.Status.Behind,
		Staged:     w.Status.Staged,
		Modified:   w.Status.Modified,
		Untracked:  w.Status.Untracked,
		Conflicted: w.Status.Conflicted,
		Dirty:      w.Status.Dirty,
		BaseRef:    w.Status.BaseRef,
		BaseAhead:  w.Status.BaseAhead,
		BaseBehind: w.Status.BaseBehind,
		BaseMerged: w.Status.BaseMerged,
	}
	if w.Status.Error == "" && !w.Status.RefreshedAt.IsZero() {
		cs.RefreshedAtMs = w.Status.RefreshedAt.UnixMilli()
	}
	return cachedWorktree{
		Path:     w.Path,
		Branch:   w.Branch,
		Head:     w.Head,
		IsMain:   w.IsMain,
		Detached: w.Detached,
		Status:   cs,
	}
}

func (cw cachedWorktree) toWorktree(projectID string) Worktree {
	// Keep RefreshedAt zero on hydrated worktrees: CleanupVerdict, dry-run Cleanup,
	// detail.go clean checks, and gitops treat a zero RefreshedAt as "status not yet
	// verified live", preventing unverified cached status (with stripped Operation)
	// from showing a dirtied or mid-rebase worktree as removable before the first live
	// git status completes.
	return Worktree{
		ProjectID: projectID,
		Path:      cw.Path,
		Branch:    cw.Branch,
		Head:      cw.Head,
		IsMain:    cw.IsMain,
		Detached:  cw.Detached,
		Status: Status{
			Upstream:   cw.Status.Upstream,
			Ahead:      cw.Status.Ahead,
			Behind:     cw.Status.Behind,
			Staged:     cw.Status.Staged,
			Modified:   cw.Status.Modified,
			Untracked:  cw.Status.Untracked,
			Conflicted: cw.Status.Conflicted,
			Dirty:      cw.Status.Dirty,
			BaseRef:    cw.Status.BaseRef,
			BaseAhead:  cw.Status.BaseAhead,
			BaseBehind: cw.Status.BaseBehind,
			BaseMerged: cw.Status.BaseMerged,
		},
	}
}

// snapshotCache coalesces dirty project IDs and persists their snapshots to SQLite off
// the hot path, draining cleanly before Close returns.
type snapshotCache struct {
	db         *sql.DB
	log        *slog.Logger
	now        func() time.Time
	flushDelay time.Duration
	read       func(id string) (*cachedProjectSnapshot, bool)

	mu     sync.Mutex
	dirty  map[string]struct{}
	closed bool

	wake chan struct{}
	stop chan struct{}
	done chan struct{}
}

func newSnapshotCache(db *sql.DB, log *slog.Logger, now func() time.Time, delay time.Duration, read func(string) (*cachedProjectSnapshot, bool)) *snapshotCache {
	if delay <= 0 {
		delay = defaultCacheFlushDelay
	}
	c := &snapshotCache{
		db:         db,
		log:        log,
		now:        now,
		flushDelay: delay,
		read:       read,
		dirty:      map[string]struct{}{},
		wake:       make(chan struct{}, 1),
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
	}
	go c.run()
	return c
}

func (c *snapshotCache) markDirty(projectID string) {
	if c == nil || projectID == "" {
		return
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.dirty[projectID] = struct{}{}
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *snapshotCache) forget(projectID string) {
	if c == nil || projectID == "" {
		return
	}
	c.mu.Lock()
	delete(c.dirty, projectID)
	c.mu.Unlock()
}

func (c *snapshotCache) close() {
	if c == nil {
		return
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		<-c.done
		return
	}
	c.closed = true
	close(c.stop)
	c.mu.Unlock()
	<-c.done
}

func (c *snapshotCache) run() {
	defer close(c.done)
	var timer *time.Timer
	var timerC <-chan time.Time
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
			timer = nil
			timerC = nil
		}
	}
	for {
		select {
		case <-c.wake:
			if timer == nil {
				timer = time.NewTimer(c.flushDelay)
				timerC = timer.C
			}
		case <-timerC:
			stopTimer()
			c.flush()
		case <-c.stop:
			stopTimer()
			c.flush()
			return
		}
	}
}

func (c *snapshotCache) takeDirty() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.dirty) == 0 {
		return nil
	}
	ids := make([]string, 0, len(c.dirty))
	for id := range c.dirty {
		ids = append(ids, id)
	}
	clear(c.dirty)
	slices.Sort(ids)
	return ids
}

func (c *snapshotCache) flush() {
	ids := c.takeDirty()
	if len(ids) == 0 {
		return
	}
	type item struct {
		id   string
		data string
	}
	items := make([]item, 0, len(ids))
	for _, id := range ids {
		snap, ok := c.read(id)
		if !ok {
			continue
		}
		b, err := json.Marshal(snap)
		if err != nil {
			c.log.Debug("encode project snapshot cache failed", "project", id, "err", err)
			continue
		}
		items = append(items, item{id: id, data: string(b)})
	}
	if len(items) == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), cacheWriteTimeout)
	defer cancel()
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		c.log.Debug("begin project snapshot cache tx failed", "err", err)
		return
	}
	updatedAt := c.now().UnixMilli()
	for _, it := range items {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO project_snapshot_cache (project_id, snapshot_json, updated_at)
			 SELECT id, ?, ? FROM projects WHERE id = ?
			 ON CONFLICT (project_id) DO UPDATE SET
			     snapshot_json = excluded.snapshot_json,
			     updated_at    = excluded.updated_at`,
			it.data, updatedAt, it.id); err != nil {
			_ = tx.Rollback()
			c.log.Debug("write project snapshot cache failed", "project", it.id, "err", err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		c.log.Debug("commit project snapshot cache failed", "err", err)
	}
}

// buildCachedProject builds the cache payload for project id. Returns false when the
// project no longer exists or its last reconcile recorded an error (so transient errors
// do not clobber a valid cached snapshot).
func (g *Git) buildCachedProject(id string) (*cachedProjectSnapshot, bool) {
	g.mu.RLock()
	st := g.projects[id]
	if st == nil {
		g.mu.RUnlock()
		return nil, false
	}
	m := st.meta.Load()
	if m.Error != "" {
		g.mu.RUnlock()
		return nil, false
	}
	c := &cachedProjectSnapshot{
		V:             snapshotCacheVersion,
		DefaultBranch: m.DefaultBranch,
		GitHubSlug:    m.GitHubSlug,
		OriginURL:     m.OriginURL,
		Remotes:       slices.Clone(m.Remotes),
		Git:           m.Git,
		Worktrees:     make([]cachedWorktree, 0, len(st.wts)),
	}
	for _, slot := range st.wts {
		w := *slot.cur.Load()
		c.Worktrees = append(c.Worktrees, cachedWorktreeFrom(w))
	}
	g.mu.RUnlock()
	slices.SortFunc(c.Worktrees, func(a, b cachedWorktree) int {
		if a.IsMain != b.IsMain {
			if a.IsMain {
				return -1
			}
			return 1
		}
		return cmp.Compare(a.Path, b.Path)
	})
	return c, true
}

// hydrateSnapshots loads cached snapshots from SQLite into g.projects before Start
// publishes its initial snapshot. Missing rows, malformed JSON, version mismatches,
// projects whose .git state flipped while down, and deleted directories are skipped
// cleanly so Start never fails on cache issues.
func (g *Git) hydrateSnapshots(ctx context.Context) {
	rows, err := g.db.QueryContext(ctx, `SELECT project_id, snapshot_json FROM project_snapshot_cache`)
	if err != nil {
		g.log.Debug("load project snapshot cache failed; continuing cold", "err", err)
		return
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			g.log.Debug("scan project snapshot cache failed", "err", err)
			continue
		}
		st := g.projects[id]
		if st == nil {
			continue
		}
		var cached cachedProjectSnapshot
		if err := json.Unmarshal([]byte(raw), &cached); err != nil || cached.V != snapshotCacheVersion {
			g.log.Debug("ignoring unusable project snapshot cache row", "project", id, "err", err)
			continue
		}
		m := *st.meta.Load()
		// Disk state wins: if the project directory vanished or flipped between git and
		// non-git while the daemon was down, skip the stale cached metadata/worktrees.
		if !isDir(m.Path) || cached.Git != m.Git {
			continue
		}
		if m.Git {
			m.DefaultBranch = cached.DefaultBranch
			m.GitHubSlug = cached.GitHubSlug
			m.OriginURL = cached.OriginURL
			if len(cached.Remotes) > 0 {
				m.Remotes = slices.Clone(cached.Remotes)
			} else {
				m.Remotes = nil
			}
		}
		st.meta.Store(&m)

		for _, cw := range cached.Worktrees {
			if cw.Path == "" || !isDir(cw.Path) {
				continue
			}
			if _, dup := st.wts[cw.Path]; dup {
				continue
			}
			w := cw.toWorktree(id)
			// Keep statusStamp, entries, and base nil on hydrated slots so live status
			// runs and CompareWorktree never trusts unverified hydrated Conflicted == 0.
			slot := &wtSlot{}
			slot.cur.Store(&w)
			st.wts[cw.Path] = slot
		}
		st.hydrated = true
	}
	if err := rows.Err(); err != nil {
		g.log.Debug("iterate project snapshot cache failed", "err", err)
	}
}
