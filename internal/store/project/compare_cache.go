package project

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Bounded LRU caches for immutable commit-to-commit compare queries, short-lived
// openCompare context reuse, and event-invalidated per-project ListRefs results.

const (
	maxCompareWorktreeEntries = 64
	maxCompareWorktreeBytes   = 16 << 20 // 16 MiB
	maxCompareFileEntries     = 256
	maxCompareFileBytes       = 24 << 20 // 24 MiB
	maxCompareCommitsEntries  = 64
	maxCompareCommitsBytes    = 8 << 20 // 8 MiB
	maxCommitBodyEntries      = 512
	maxCommitBodyBytes        = 4 << 20 // 4 MiB
	maxVerifiedCommits        = 2048
	maxOpenCompareEntries     = 128
	openCompareTTL            = 5 * time.Second
	refsCacheTTL              = 15 * time.Second
)

// lruNode is one entry in an intrusive doubly-linked LRU list.
type lruNode[K comparable, V any] struct {
	key        K
	val        V
	weight     int64
	prev, next *lruNode[K, V]
}

// lruCache is a goroutine-safe bounded LRU supporting both entry-count and byte-weight caps.
type lruCache[K comparable, V any] struct {
	mu         sync.Mutex
	maxEntries int
	maxBytes   int64
	bytes      int64
	items      map[K]*lruNode[K, V]
	head, tail *lruNode[K, V] // head = most recent, tail = least recent
}

func newLRUCache[K comparable, V any](maxEntries int, maxBytes int64) *lruCache[K, V] {
	return &lruCache[K, V]{
		maxEntries: maxEntries,
		maxBytes:   maxBytes,
		items:      make(map[K]*lruNode[K, V]),
	}
}

func (c *lruCache[K, V]) get(k K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n, ok := c.items[k]
	if !ok {
		var zero V
		return zero, false
	}
	c.moveToFrontLocked(n)
	return n.val, true
}

func (c *lruCache[K, V]) put(k K, v V, weight int64) {
	if weight < 0 {
		weight = 0
	}
	if c.maxBytes > 0 && weight > c.maxBytes {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if n, ok := c.items[k]; ok {
		c.bytes -= n.weight
		n.val = v
		n.weight = weight
		c.bytes += weight
		c.moveToFrontLocked(n)
		c.evictLocked()
		return
	}
	n := &lruNode[K, V]{key: k, val: v, weight: weight}
	c.items[k] = n
	c.bytes += weight
	c.pushFrontLocked(n)
	c.evictLocked()
}

func (c *lruCache[K, V]) deleteFunc(pred func(K) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, n := range c.items {
		if pred(k) {
			c.removeLocked(n)
		}
	}
}

func (c *lruCache[K, V]) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	clear(c.items)
	c.head, c.tail, c.bytes = nil, nil, 0
}

func (c *lruCache[K, V]) pushFrontLocked(n *lruNode[K, V]) {
	n.prev = nil
	n.next = c.head
	if c.head != nil {
		c.head.prev = n
	} else {
		c.tail = n
	}
	c.head = n
}

func (c *lruCache[K, V]) moveToFrontLocked(n *lruNode[K, V]) {
	if c.head == n {
		return
	}
	if n.prev != nil {
		n.prev.next = n.next
	}
	if n.next != nil {
		n.next.prev = n.prev
	} else {
		c.tail = n.prev
	}
	c.pushFrontLocked(n)
}

func (c *lruCache[K, V]) removeLocked(n *lruNode[K, V]) {
	if n.prev != nil {
		n.prev.next = n.next
	} else {
		c.head = n.next
	}
	if n.next != nil {
		n.next.prev = n.prev
	} else {
		c.tail = n.prev
	}
	n.prev, n.next = nil, nil
	delete(c.items, n.key)
	c.bytes -= n.weight
}

func (c *lruCache[K, V]) evictLocked() {
	for c.tail != nil && ((c.maxEntries > 0 && len(c.items) > c.maxEntries) || (c.maxBytes > 0 && c.bytes > c.maxBytes)) {
		c.removeLocked(c.tail)
	}
}

// --- Compare caches ---------------------------------------------------------------

type compareWorktreeKey struct {
	projectID, baseSHA, headSHA string
}

type compareFileKey struct {
	projectID, baseSHA, headSHA, oldPath, file string
}

type compareCommitsKey struct {
	projectID, fromSHA, toSHA string
}

type commitBodyKey struct {
	projectID, sha string
}

type openCompareKey struct {
	projectID, dir string
	base, head     DiffSource
	needBase       bool
}

// fileStamp snapshots a path's identity (device, inode, size, mtime, existence) so a
// cached entry can detect any atomic rename/edit/delete without spawning git.
type fileStamp struct {
	exists bool
	dev    uint64
	ino    uint64
	size   int64
	mtime  time.Time
}

func statStamp(path string) fileStamp {
	fi, err := os.Stat(path)
	if err != nil {
		return fileStamp{}
	}
	st := fileStamp{exists: true, size: fi.Size(), mtime: fi.ModTime()}
	if raw, ok := fi.Sys().(*syscall.Stat_t); ok {
		st.dev = uint64(raw.Dev)
		st.ino = raw.Ino
	}
	return st
}

type pathStamp struct {
	path  string
	stamp fileStamp
}

type openCompareEntry struct {
	base, head ResolvedSource
	baseRef    string
	mergeBase  string
	headSHA    string

	// Validation state captured when resolved.
	wtHead    string
	hasWTHead bool
	projBase  projectBase
	stamps    []pathStamp
	cachedAt  time.Time
}

type compareCaches struct {
	worktree *lruCache[compareWorktreeKey, []CompareChange]
	files    *lruCache[compareFileKey, CompareSides]
	commits  *lruCache[compareCommitsKey, CompareLog]
	bodies   *lruCache[commitBodyKey, CompareCommitMessage]
	verified *lruCache[commitBodyKey, struct{}]
	open     *lruCache[openCompareKey, openCompareEntry]
}

func newCompareCaches() *compareCaches {
	return &compareCaches{
		worktree: newLRUCache[compareWorktreeKey, []CompareChange](maxCompareWorktreeEntries, maxCompareWorktreeBytes),
		files:    newLRUCache[compareFileKey, CompareSides](maxCompareFileEntries, maxCompareFileBytes),
		commits:  newLRUCache[compareCommitsKey, CompareLog](maxCompareCommitsEntries, maxCompareCommitsBytes),
		bodies:   newLRUCache[commitBodyKey, CompareCommitMessage](maxCommitBodyEntries, maxCommitBodyBytes),
		verified: newLRUCache[commitBodyKey, struct{}](maxVerifiedCommits, 0),
		open:     newLRUCache[openCompareKey, openCompareEntry](maxOpenCompareEntries, 0),
	}
}

func (c *compareCaches) forgetProject(projectID string) {
	if c == nil {
		return
	}
	c.worktree.deleteFunc(func(k compareWorktreeKey) bool { return k.projectID == projectID })
	c.files.deleteFunc(func(k compareFileKey) bool { return k.projectID == projectID })
	c.commits.deleteFunc(func(k compareCommitsKey) bool { return k.projectID == projectID })
	c.bodies.deleteFunc(func(k commitBodyKey) bool { return k.projectID == projectID })
	c.verified.deleteFunc(func(k commitBodyKey) bool { return k.projectID == projectID })
	c.open.deleteFunc(func(k openCompareKey) bool { return k.projectID == projectID })
}

func (c *compareCaches) clear() {
	if c == nil {
		return
	}
	c.worktree.clear()
	c.files.clear()
	c.commits.clear()
	c.bodies.clear()
	c.verified.clear()
	c.open.clear()
}

func cloneCompareSides(s CompareSides) CompareSides {
	s.Old.Contents = bytes.Clone(s.Old.Contents)
	s.New.Contents = bytes.Clone(s.New.Contents)
	return s
}

func compareSidesWeight(s CompareSides) int64 {
	return int64(len(s.Old.Contents)+len(s.New.Contents)) + 256
}

func compareChangesWeight(list []CompareChange) int64 {
	w := int64(64)
	for _, f := range list {
		w += int64(len(f.Path)+len(f.OldPath)) + 96
	}
	return w
}

func compareLogWeight(l CompareLog) int64 {
	w := int64(64)
	for _, c := range l.Commits {
		w += int64(len(c.SHA)+len(c.ShortSHA)+len(c.Parent)+len(c.Subject)) + 96
	}
	return w
}

// --- Fast HEAD / ref validation helpers -------------------------------------------

// readHeadFast reads the worktree's HEAD commit SHA directly from gitDir/HEAD (and its
// loose ref file in commonDir when symbolic). Returns ok=false for unborn branches,
// packed refs, reftables, or missing admin dirs so callers fall back to `git rev-parse`.
func readHeadFast(gitDir, commonDir string) (string, bool) {
	if gitDir == "" || commonDir == "" {
		return "", false
	}
	b, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return "", false
	}
	s := strings.TrimSpace(string(b))
	if isSHA(s) {
		return s, true
	}
	ref, ok := strings.CutPrefix(s, "ref: ")
	if !ok {
		return "", false
	}
	ref = strings.TrimSpace(ref)
	if !strings.HasPrefix(ref, "refs/") || strings.Contains(ref, "..") {
		return "", false
	}
	rb, err := os.ReadFile(filepath.Join(commonDir, filepath.FromSlash(ref)))
	if err != nil {
		return "", false
	}
	sha := strings.TrimSpace(string(rb))
	if !isSHA(sha) {
		return "", false
	}
	return sha, true
}

// isSpecialPseudoRef reports git pseudo-refs stored directly under gitDir/commonDir
// rather than under refs/{heads,remotes,tags}/ (so our loose-ref stamps do not cover them).
func isSpecialPseudoRef(ref string) bool {
	switch ref {
	case "stash", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_HEAD", "AUTO_MERGE":
		return true
	}
	return false
}

// isLooseSymref reports whether path is an existing loose ref file containing a symbolic
// ref ("ref: ..."), whose target file would also need to be stamped.
func isLooseSymref(path string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(string(b)), "ref:")
}

// refStampsFor collects the filesystem stamps needed to validate a cached SourceRef.
// Returns ok=false for expressions that cannot be cheaply validated (e.g. reflog queries,
// pseudo-refs, symrefs, or abbreviated SHAs), causing openCompare to skip caching.
func refStampsFor(s DiffSource, gitDir, commonDir string) ([]pathStamp, bool) {
	if s.Kind != SourceRef {
		return nil, true
	}
	if s.Ref == emptyTree || isSHA(s.Ref) {
		// Immutable content-addressed object name (once verified).
		return nil, true
	}
	if gitDir == "" || commonDir == "" {
		return nil, false
	}
	if strings.Contains(s.Ref, "@{") {
		return nil, false
	}
	// Strip ~ / ^ ancestry suffixes to validate the base ref.
	baseRef := s.Ref
	if idx := strings.IndexAny(baseRef, "~^"); idx >= 0 {
		baseRef = baseRef[:idx]
	}
	if baseRef == "" || isSpecialPseudoRef(baseRef) {
		return nil, false
	}
	if baseRef == "HEAD" || baseRef == "@" {
		// Validated by wtHead + HEAD stamp.
		return []pathStamp{{path: filepath.Join(gitDir, "HEAD"), stamp: statStamp(filepath.Join(gitDir, "HEAD"))}}, true
	}
	// Validate packed-refs plus candidate loose ref files.
	stamps := []pathStamp{
		{path: filepath.Join(commonDir, "packed-refs"), stamp: statStamp(filepath.Join(commonDir, "packed-refs"))},
	}
	if strings.HasPrefix(baseRef, "refs/") && !strings.Contains(baseRef, "..") {
		p := filepath.Join(commonDir, filepath.FromSlash(baseRef))
		st := statStamp(p)
		if st.exists && isLooseSymref(p) {
			return nil, false
		}
		stamps = append(stamps, pathStamp{path: p, stamp: st})
		return stamps, true
	}
	if strings.Contains(baseRef, "..") {
		return nil, false
	}
	// Only cache simple ref names (branches, remotes, tags) if at least one loose ref
	// file exists or packed-refs exists (so short SHAs skip caching cleanly).
	candidates := []string{
		filepath.Join(commonDir, "refs", "heads", filepath.FromSlash(baseRef)),
		filepath.Join(commonDir, "refs", "remotes", filepath.FromSlash(baseRef)),
		filepath.Join(commonDir, "refs", "tags", filepath.FromSlash(baseRef)),
	}
	anyLoose := false
	for _, p := range candidates {
		st := statStamp(p)
		if st.exists {
			if isLooseSymref(p) {
				return nil, false
			}
			anyLoose = true
		}
		stamps = append(stamps, pathStamp{path: p, stamp: st})
	}
	// If no loose ref exists and packed-refs does not exist, baseRef may be a short SHA
	// or missing ref; skip caching to stay exact.
	if !anyLoose && !stamps[0].stamp.exists {
		return nil, false
	}
	return stamps, true
}

func stampsMatch(stamps []pathStamp) bool {
	for _, ps := range stamps {
		if statStamp(ps.path) != ps.stamp {
			return false
		}
	}
	return true
}

// --- ListRefs cache ---------------------------------------------------------------

type refsCacheEntry struct {
	refs     Refs
	cachedAt time.Time
}

// refsCache caches ListRefs per project, invalidated via generation counters on ref/branch
// mutations and FSEvents (with a short refsCacheTTL backstop for non-FSEvents environments
// or dropped events) so an in-flight ListRefs never stores a stale result after invalidation.
type refsCache struct {
	mu      sync.Mutex
	entries map[string]refsCacheEntry
	gen     map[string]uint64
}

func (c *refsCache) get(projectID string, now time.Time) (Refs, uint64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	gen := c.gen[projectID]
	e, ok := c.entries[projectID]
	if !ok {
		return Refs{}, gen, false
	}
	if now.Sub(e.cachedAt) > refsCacheTTL {
		delete(c.entries, projectID)
		return Refs{}, gen, false
	}
	return cloneRefs(e.refs), gen, true
}

func (c *refsCache) put(projectID string, gen uint64, r Refs, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen[projectID] != gen {
		return // invalidated while git for-each-ref was running
	}
	if c.entries == nil {
		c.entries = map[string]refsCacheEntry{}
	}
	c.entries[projectID] = refsCacheEntry{refs: cloneRefs(r), cachedAt: now}
}

func (c *refsCache) invalidate(projectID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen == nil {
		c.gen = map[string]uint64{}
	}
	c.gen[projectID]++
	delete(c.entries, projectID)
}

func (c *refsCache) forget(projectID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, projectID)
	delete(c.gen, projectID)
}

func cloneRefs(r Refs) Refs {
	r.Local = slices.Clone(r.Local)
	r.Remote = slices.Clone(r.Remote)
	r.Branches = slices.Clone(r.Branches)
	return r
}
