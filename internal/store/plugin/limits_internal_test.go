package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Appends of many empty lines (each under the per-append byte limit) are kept for
// watchers in a ring bounded by bytes as well as count: 512 of them used to hold 1 GiB
// (64 here, 128 MB before the bound).
func TestAppendRingIsBoundedByBytes(t *testing.T) {
	v, canon, errs := validateView(json.RawMessage(`{"nodes":[{"key":"l","log":{"lines":[{"text":"x"}]}}]}`), "p", fuzzPerms)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	in := newFuzzInstance()
	in.accept(v, canon, time.Unix(0, 0))
	lines := make([]pluginsdk.AppendLine, 65535)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for range 64 {
		if _, err := in.appendLog(pluginsdk.ViewAppendParams{Instance: in.key, Key: "l", Lines: lines}); err != nil {
			t.Fatal(err)
		}
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	if grew := int64(after.HeapAlloc) - int64(before.HeapAlloc); grew > 32<<20 {
		t.Fatalf("the append ring holds %d MB", grew>>20)
	}
	// A watcher that fell behind the ring gets the whole view.
	w := &watcher{version: 1}
	if !slices.ContainsFunc(in.pull(w), func(u SurfaceUpdate) bool { return u.View != nil }) {
		t.Fatal("a watcher behind the ring did not get the view")
	}
}

// Setting and clearing a fact for many threads leaves no empty scopes behind.
func TestClearedFactScopesAreDropped(t *testing.T) {
	var c contextFacts
	for i := range 10000 {
		scope := fmt.Sprintf("thread:s-%d", i)
		if _, err := c.set(nil, "p", scope, "k", stringValue("v")); err != nil {
			t.Fatal(err)
		}
		if _, err := c.set(nil, "p", scope, "k", nullValue); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(c.by["p"].scope); n != 0 {
		t.Fatalf("%d empty scopes kept", n)
	}
}

// slowThreads and slowTerminals create slowly, so concurrent creates overlap.
type slowThreads struct {
	ownersOnly
	mu      sync.Mutex
	created []pluginsdk.PluginThread
}

func (s *slowThreads) Create(_ context.Context, _ string, _ ThreadSpec) (pluginsdk.PluginThread, error) {
	time.Sleep(5 * time.Millisecond)
	s.mu.Lock()
	defer s.mu.Unlock()
	t := pluginsdk.PluginThread{ThreadID: fmt.Sprintf("s-%d", len(s.created))}
	s.created = append(s.created, t)
	return t, nil
}

func (s *slowThreads) Owned(string) []pluginsdk.PluginThread {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.created)
}

type slowTerminals struct {
	termOwners
	mu      sync.Mutex
	created []pluginsdk.PluginTerminal
}

func (s *slowTerminals) Create(_ context.Context, _ string, _ TerminalSpec) (pluginsdk.PluginTerminal, error) {
	time.Sleep(5 * time.Millisecond)
	s.mu.Lock()
	defer s.mu.Unlock()
	t := pluginsdk.PluginTerminal{TerminalID: fmt.Sprintf("t-%d", len(s.created))}
	s.created = append(s.created, t)
	return t, nil
}

func (s *slowTerminals) Owned(string) []pluginsdk.PluginTerminal {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.created)
}

// Concurrent thread/create and terminal/create calls stay within the per-plugin limits,
// and the size limits count what the call really carries.
func TestOwnedLimitsUnderConcurrency(t *testing.T) {
	threads, terms := &slowThreads{}, &slowTerminals{}
	home := t.TempDir()
	m := &Manager{log: slog.New(slog.DiscardHandler), opts: Options{Home: home, DataDir: filepath.Join(home, "data"), Threads: threads, Terminals: terms}}
	a := &actor{m: m, name: "p", logs: newLogBuffer(filepath.Join(home, "p.log"), 1<<20, 100, time.Now)}
	var wg sync.WaitGroup
	for range 100 {
		wg.Go(func() { _, _ = a.threadCreate(context.Background(), json.RawMessage(`{"title":"t"}`)) })
		wg.Go(func() { _, _ = a.terminalCreate(context.Background(), json.RawMessage(`{"argv":["sh"]}`)) })
	}
	wg.Wait()
	if n := len(threads.created); n != maxPluginThreads {
		t.Errorf("%d threads created, the limit is %d", n, maxPluginThreads)
	}
	if n := len(terms.created); n != maxPluginTerminals {
		t.Errorf("%d terminals created, the limit is %d", n, maxPluginTerminals)
	}

	threads.created, terms.created = nil, nil
	prompt, _ := json.Marshal(map[string]string{"title": "t", "prompt": strings.Repeat("x", MaxThreadMessage+1)})
	if _, err := a.threadCreate(context.Background(), prompt); pluginsdk.ErrorCode(err) != pluginsdk.CodeInvalidParams {
		t.Errorf("an oversize prompt: %v", err)
	}
	argv, _ := json.Marshal(map[string]any{"argv": append([]string{"sh"}, make([]string, maxTerminalArgv)...)})
	if _, err := a.terminalCreate(context.Background(), argv); pluginsdk.ErrorCode(err) != pluginsdk.CodeInvalidParams {
		t.Errorf("an argv of %d empty strings: %v", maxTerminalArgv, err)
	}
}

// plugin.json is read only as a bounded regular file: a FIFO blocked discovery (and the
// store with it), a huge file filled memory.
func TestReadManifestRefusesFIFOsAndHugeFiles(t *testing.T) {
	fifo := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(fifo, pluginsdk.ManifestFile), 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, _, err := readManifest(fifo); done <- err }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "not a regular file") {
			t.Errorf("fifo: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reading a FIFO plugin.json blocked")
	}
	huge := t.TempDir()
	if err := os.WriteFile(filepath.Join(huge, pluginsdk.ManifestFile), make([]byte, maxManifestBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readManifest(huge); err == nil || !strings.Contains(err.Error(), "over") {
		t.Errorf("huge: %v", err)
	}
}
