package project

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fsnotify/fsevents"
)

// Two kinds of test here (docs/notes/project-watcher-tests.md):
//
//   - What an event leads to (routing, debounce, stream paths) runs on the test's own
//     event source (fakestream_test.go), so it never waits on fseventsd.
//   - That a real FSEvents stream over the store's roots delivers, and that its real
//     flags work with the store, runs on a streamRecorder. Its waits say which side was
//     slow: "FSEvents delivered nothing" is fseventsd, a timeout after the delivery is
//     the store.

// requireFSEvents skips the test when an FSEvents stream cannot be started here.
func requireFSEvents(t *testing.T) {
	t.Helper()
	es := &fsevents.EventStream{Paths: []string{t.TempDir()}, Latency: streamLatency, Flags: streamFlags}
	if err := es.Start(); err != nil {
		t.Skipf("FSEvents unavailable: %v", err)
	}
	es.Stop()
}

// streamRecorder is a real-FSEvents source that records every event it delivers to the
// store.
type streamRecorder struct {
	mu      sync.Mutex
	running []string
	log     []string // delivered paths, in order
	probes  int
}

func (r *streamRecorder) source(paths []string, events chan []fsevents.Event) (func(), error) {
	tee := make(chan []fsevents.Event, eventBuffer)
	stop, err := fseventsSource(paths, tee)
	if err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			case b := <-tee:
				r.mu.Lock()
				for _, e := range b {
					r.log = append(r.log, filepath.Clean(e.Path))
				}
				r.mu.Unlock()
				select {
				case events <- b:
				case <-done:
					return
				}
			}
		}
	}()
	r.mu.Lock()
	r.running = slices.Clone(paths)
	r.mu.Unlock()
	return func() {
		stop()
		close(done)
		r.mu.Lock()
		defer r.mu.Unlock()
		if slices.Equal(r.running, paths) {
			r.running = nil
		}
	}, nil
}

// mark is a position in the delivery log: waitDelivered looks only after it.
func (r *streamRecorder) mark() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.log)
}

// waitRunning waits until the store has started a stream whose paths satisfy pred.
func (r *streamRecorder) waitRunning(t *testing.T, what string, pred func([]string) bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		r.mu.Lock()
		ok := pred(r.running)
		r.mu.Unlock()
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the store started no stream with %s in 10s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// waitDelivered waits until the stream has delivered an event for each of paths since
// mark. A timeout here is fseventsd's: the store had nothing to act on yet.
func (r *streamRecorder) waitDelivered(t *testing.T, mark int, paths ...string) {
	t.Helper()
	start := time.Now()
	deadline := start.Add(10 * time.Second)
	for {
		r.mu.Lock()
		var missing []string
		for _, p := range paths {
			if !slices.Contains(r.log[mark:], p) {
				missing = append(missing, p)
			}
		}
		delivered := len(r.log) - mark
		r.mu.Unlock()
		if len(missing) == 0 {
			t.Logf("FSEvents delivered %d paths in %v", len(paths), time.Since(start).Round(time.Millisecond))
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("FSEvents delivered no event for %v in 10s (%d other events delivered meanwhile; fseventsd CPU %s): "+
				"the system's file event daemon is slow, the store was never asked to act", missing, delivered, fseventsdCPU())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// catchUp writes a probe file in dir (inside the stream, where no route acts on it) and
// waits for its event. FSEvents delivers a stream's events in order, so every change
// made before it, the fixture's setup included, has been delivered by then: a late
// event from the setup cannot stand in for the test's own.
func (r *streamRecorder) catchUp(t *testing.T, dir string) {
	t.Helper()
	r.mu.Lock()
	r.probes++
	p := filepath.Join(dir, fmt.Sprintf("cf-probe-%d", r.probes))
	r.mu.Unlock()
	mark := r.mark()
	writeFile(t, p, "probe\n")
	r.waitDelivered(t, mark, p)
}

// fseventsdCPU is fseventsd's CPU use, for a delivery timeout's message.
func fseventsdCPU() string {
	out, err := exec.Command("ps", "-Ao", "%cpu=,comm=").Output()
	if err != nil {
		return "unknown"
	}
	for line := range strings.SplitSeq(string(out), "\n") {
		if f := strings.Fields(line); len(f) == 2 && filepath.Base(f[1]) == "fseventsd" {
			return f[0] + "%"
		}
	}
	return "unknown"
}

// A real FSEvents stream over the store's roots delivers an edit anywhere in a worktree:
// nested files in the main checkout, in a managed worktree, and in a hand-made worktree
// outside both roots, which the stream gains when a reconcile lists it. What each event
// leads to is TestStreamPathsFollowTheWorktrees's and the routing tests' concern.
func TestStreamSeesNestedEdits(t *testing.T) {
	requireFSEvents(t)
	f := newFixture(t)
	rec := &streamRecorder{}
	h := startHarness(t, "", Options{WorktreeRoot: filepath.Join(f.base, "wt"), streams: rec.source})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	managed, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat"})
	if err != nil {
		t.Fatal(err)
	}
	hand := filepath.Join(f.base, "hand")
	git(t, f.project, "worktree", "add", "-q", "-b", "hand", hand)
	// The refresh lists it; the stream is recreated with its root.
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	rec.waitRunning(t, "the hand-made worktree", func(p []string) bool { return slices.Contains(p, hand) })
	rec.catchUp(t, filepath.Join(f.project, ".git"))

	for _, wt := range []string{f.project, managed.Path, hand} {
		p := filepath.Join(wt, "sub", "x.txt")
		mark := rec.mark()
		writeFile(t, p, "changed in "+wt+"\n")
		rec.waitDelivered(t, mark, p)
		h.waitFor("the store's refresh after the nested edit in "+wt, worktreeUpdated(wt, func(w Worktree) bool { return w.Status.Modified == 1 }))
	}
}

// The stream's paths follow the worktrees: the managed root, the project, and a
// hand-made worktree outside both once a reconcile lists it, until it is removed; an
// unregistered project leaves. Edits anywhere in each root refresh it.
func TestStreamPathsFollowTheWorktrees(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	managed, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat"})
	if err != nil {
		t.Fatal(err)
	}
	hand := filepath.Join(f.base, "hand")
	git(t, f.project, "worktree", "add", "-q", "-b", "hand", hand)
	h.fsChanged()
	h.waitFor("hand-made worktree", func(ev Event) bool {
		u, ok := ev.(ProjectUpdated)
		return ok && len(u.Project.Worktrees) == 3
	})
	h.waitStreamRunning("the hand-made worktree", func(p []string) bool { return slices.Contains(p, hand) })
	if got, want := h.fake.running(), []string{hand, f.project, filepath.Join(f.base, "wt")}; !slices.Equal(got, want) {
		t.Fatalf("stream paths = %v, want %v", got, want)
	}

	for _, wt := range []string{f.project, managed.Path, hand} {
		writeFile(t, filepath.Join(wt, "sub", "x.txt"), "changed in "+wt+"\n")
		h.fsChanged()
		h.waitFor("nested edit in "+wt, worktreeUpdated(wt, func(w Worktree) bool { return w.Status.Modified == 1 }))
		if err := os.MkdirAll(filepath.Join(wt, "sub", "deeper"), 0o755); err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(wt, "sub", "deeper", "new.txt"), "n\n")
		h.fsChanged()
		h.waitFor("nested new file in "+wt, worktreeUpdated(wt, func(w Worktree) bool { return w.Status.Untracked == 1 }))
	}

	// Removing the hand-made worktree drops it from the stream.
	git(t, f.project, "worktree", "remove", "--force", hand)
	h.fsChanged()
	h.waitFor("hand-made worktree removed", func(ev Event) bool {
		rm, ok := ev.(WorktreeRemoved)
		return ok && rm.Path == hand
	})
	h.waitStreamRunning("no hand-made worktree", func(p []string) bool { return len(p) > 0 && !slices.Contains(p, hand) })

	// Unregistering drops the project; the managed root stays.
	if err := h.store.Unregister(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if got := h.fake.running(); !slices.Equal(got, []string{filepath.Join(f.base, "wt")}) {
		t.Fatalf("stream paths after unregister = %v", got)
	}
}

// A burst of thousands of files (an npm install, an untar, a dev server writing
// continuously) costs one status run per tree window that saw events, however many
// events and batches it brings: onEvents triggers the tree debouncer once per key per
// batch, the debouncer fires a key once per window, and the scheduler runs one status
// per fire. The window is a manual clock and the batches go to onEvents directly, so
// the count does not depend on how fast the machine or fseventsd is.
func TestTreeBurstCostsOneStatusPerWindow(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr})
	clock := &manualClock{}
	h.store.treeDeb.setClock(clock.after)
	r, err := h.store.Register(context.Background(), f.project)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.Refresh(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	before := cr.count("status")

	// 2000 files in 40 directories, delivered as FSEvents delivers a burst: batches
	// of about 32 events.
	var evs []fsevents.Event
	for i := range 2000 {
		d := filepath.Join(f.project, "node_modules", fmt.Sprintf("pkg%02d", i%40))
		if i < 40 {
			if err := os.MkdirAll(d, 0o755); err != nil {
				t.Fatal(err)
			}
			evs = append(evs, fsevents.Event{Path: d, Flags: fsevents.ItemCreated | fsevents.ItemIsDir})
		}
		p := filepath.Join(d, fmt.Sprintf("f%04d.js", i))
		writeFile(t, p, "x\n")
		evs = append(evs, fsevents.Event{Path: p, Flags: fsevents.ItemCreated | fsevents.ItemModified | fsevents.ItemIsFile})
	}
	for chunk := range slices.Chunk(evs, 32) {
		h.store.onEvents(chunk)
	}
	if n := clock.fire(); n != 1 {
		t.Fatalf("%d tree timers armed by the burst, want 1", n)
	}
	h.waitFor("untracked node_modules", worktreeUpdated(f.project, func(w Worktree) bool { return w.Status.Untracked == 2000 }))
	if runs := cr.count("status") - before; runs != 1 {
		t.Fatalf("%d status runs for a burst in one window, want 1", runs)
	}

	// A writer that keeps going: three windows with events, three runs.
	before = cr.count("status")
	for w := range 3 {
		for chunk := range slices.Chunk(evs[w*500:(w+1)*500], 32) {
			h.store.onEvents(chunk)
		}
		if n := clock.fire(); n != 1 {
			t.Fatalf("window %d: %d tree timers armed, want 1", w, n)
		}
		eventually(t, fmt.Sprintf("status run for window %d", w), 10*time.Second, func() bool { return cr.count("status")-before == w+1 })
	}
	if n := clock.fire(); n != 0 {
		t.Fatalf("%d tree timers armed with no events", n)
	}
	if runs := cr.count("status") - before; runs != 3 {
		t.Fatalf("%d status runs for three windows, want 3", runs)
	}
}

// `git init` in a project without git is seen through the stream, without the poll.
func TestStreamSeesGitInit(t *testing.T) {
	dir := newPlainDir(t)
	h := startHarness(t, "", Options{})
	r, err := h.store.Register(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	h.waitStreamRunning("the plain project", func(p []string) bool { return slices.Contains(p, dir) })
	git(t, dir, "init", "-q", "-b", "main")
	h.fsChanged()
	h.waitFor("git project", func(ev Event) bool {
		u, ok := ev.(ProjectUpdated)
		return ok && u.Project.ID == r.ID && u.Project.Git
	})
}

func TestResolveMissing(t *testing.T) {
	tmp := t.TempDir() // /var/folders/... on macOS, a symlink to /private/var/...
	real, err := filepath.EvalSymlinks(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if got := resolveMissing(tmp); got != real {
		t.Errorf("resolveMissing(%q) = %q, want %q", tmp, got, real)
	}
	if got, want := resolveMissing(filepath.Join(tmp, "a", "b")), filepath.Join(real, "a", "b"); got != want {
		t.Errorf("resolveMissing(missing) = %q, want %q", got, want)
	}
}
