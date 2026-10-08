package session

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/awaumann/code-foundry/internal/store/terminal"
)

// TestProbe drives a real program through the terminal store for manual experiments.
// CF_PROBE_DIR=cwd CF_PROBE_ARGV="claude --model opus" CF_PROBE_STEPS="wait:5;screen;key:\r"
func TestProbe(t *testing.T) {
	dir := os.Getenv("CF_PROBE_DIR")
	if dir == "" {
		t.Skip("CF_PROBE_DIR not set")
	}
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "CLAUDE") {
			env = append(env, k)
		}
	}
	m := terminal.New(terminal.Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	defer func() { _ = m.Close(context.Background()) }()
	var mu sync.Mutex
	var log strings.Builder
	start := time.Now()
	obs := func(_ string, ev terminal.ObserveEvent) {
		mu.Lock()
		defer mu.Unlock()
		el := time.Since(start).Milliseconds()
		switch {
		case ev.Title != nil:
			fmt.Fprintf(&log, "%6dms title %q\n", el, *ev.Title)
		case ev.AltScreen != nil:
			fmt.Fprintf(&log, "%6dms alt %v\n", el, *ev.AltScreen)
		case ev.Exited != nil:
			fmt.Fprintf(&log, "%6dms exited %d\n", el, ev.Exited.Code)
		case ev.Output != nil:
			if os.Getenv("CF_PROBE_RAW") != "" {
				fmt.Fprintf(&log, "%6dms out %q\n", el, ev.Output)
			}
		}
	}
	ctx := context.Background()
	term, err := m.Create(ctx, terminal.Spec{
		Argv: strings.Fields(os.Getenv("CF_PROBE_ARGV")), Cwd: dir, Env: env, Cols: 120, Rows: 40, Observer: obs,
	})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("pid %d terminal %s\n", term.Pid, term.ID)
	for _, step := range strings.Split(os.Getenv("CF_PROBE_STEPS"), ";") {
		kind, arg, _ := strings.Cut(step, ":")
		switch kind {
		case "wait":
			f, _ := strconv.ParseFloat(arg, 64)
			time.Sleep(time.Duration(f * float64(time.Second)))
		case "screen":
			s, err := m.ScreenText(ctx, term.ID)
			fmt.Printf("---- screen @%dms (err=%v)\n%s\n----\n", time.Since(start).Milliseconds(), err, s)
		case "key", "type":
			u, err := strconv.Unquote(`"` + arg + `"`)
			if err != nil {
				t.Fatal(err)
			}
			if err := m.Write(ctx, term.ID, []byte(u)); err != nil {
				fmt.Println("write:", err)
			}
		case "log":
			mu.Lock()
			fmt.Print(log.String())
			log.Reset()
			mu.Unlock()
		case "cat":
			home, _ := os.UserHomeDir()
			p := strings.ReplaceAll(strings.ReplaceAll(arg, "{pid}", strconv.Itoa(term.Pid)), "~", home)
			b, err := os.ReadFile(p)
			fmt.Printf("cat %s (err=%v):\n%s\n", p, err, b)
		case "ls":
			home, _ := os.UserHomeDir()
			ents, err := os.ReadDir(strings.ReplaceAll(arg, "~", home))
			fmt.Printf("ls %s (err=%v):", arg, err)
			for _, e := range ents {
				fmt.Printf(" %s", e.Name())
			}
			fmt.Println()
		case "info":
			ti, _ := m.Get(ctx, term.ID)
			fmt.Printf("info state=%v exit=%d alt=%v title=%q\n", ti.State, ti.ExitCode, ti.AltScreen, ti.Title)
		}
	}
	mu.Lock()
	fmt.Print(log.String())
	mu.Unlock()
}
