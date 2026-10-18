package plugin

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// recordingOwned records what thread/create and terminal/create hand the stores.
type recordingOwned struct {
	ownersOnly
	thread *ThreadSpec
}

func (r *recordingOwned) Owner(string) (string, bool) { return "", false }

func (r *recordingOwned) Create(_ context.Context, _ string, s ThreadSpec) (pluginsdk.PluginThread, error) {
	r.thread = &s
	return pluginsdk.PluginThread{ThreadID: "s-1"}, nil
}

type recordingTerms struct {
	termOwners
	term *TerminalSpec
}

func (r *recordingTerms) Create(_ context.Context, _ string, s TerminalSpec) (pluginsdk.PluginTerminal, error) {
	r.term = &s
	return pluginsdk.PluginTerminal{TerminalID: "t-1"}, nil
}

// FuzzOwnedParams sends random thread/create and terminal/create params: what reaches the
// thread and terminal stores obeys the rules (one-line title, sizes, env, cwd under home).
func FuzzOwnedParams(f *testing.F) {
	f.Add([]byte(`{"title":"t","cwd":"~/w","env":{"A":"1"},"addDirs":["~/w"],"prompt":"hi","model":" x "}`), []byte(`{"argv":["sh","-c","x"],"cwd":"~","title":"a\nb","env":{"PATH":"x"}}`))
	f.Add([]byte(`{"title":"  ","cwd":"/etc"}`), []byte(`{"argv":["", "x\u0000"]}`))
	f.Add([]byte(`{"title":"x","cwd":"~/../.."}`), []byte(`{"argv":["sh"],"cwd":"~/w/../../.."}`))
	f.Add([]byte(`{"title":"x","projectId":"p"}`), []byte(`{"argv":["sh"]}`))
	home := f.TempDir()
	if err := os.Mkdir(filepath.Join(home, "w"), 0o700); err != nil {
		f.Fatal(err)
	}
	f.Fuzz(func(t *testing.T, threadParams, termParams []byte) {
		threads, terms := &recordingOwned{}, &recordingTerms{}
		m := &Manager{log: slog.New(slog.DiscardHandler), opts: Options{Home: home, DataDir: filepath.Join(home, "data"), Threads: threads, Terminals: terms}}
		a := &actor{m: m, name: "p", logs: newLogBuffer(filepath.Join(home, "p.log"), 1<<20, 10, time.Now)}
		checkDir := func(what, d string) {
			if !filepath.IsAbs(d) || !strings.HasPrefix(filepath.Clean(d)+"/", home+"/") {
				t.Fatalf("%s %q outside home", what, d)
			}
			if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
				t.Fatalf("%s %q is not a directory", what, d)
			}
		}
		checkEnv := func(env []string) {
			for _, kv := range env {
				k, v, ok := strings.Cut(kv, "=")
				if !ok || !envKeyPattern.MatchString(k) || reservedEnvKey(k) || strings.ContainsRune(v, 0) {
					t.Fatalf("env %q", kv)
				}
			}
		}
		if _, err := a.threadCreate(context.Background(), threadParams); err == nil {
			s := threads.thread
			if s == nil {
				t.Fatal("accepted without creating")
			}
			if s.Title == "" || strings.ContainsAny(s.Title, "\r\n\x00") || len(s.Title) > maxThreadTitle || !utf8.ValidString(s.Title) {
				t.Fatalf("title %q", s.Title)
			}
			if len(s.Prompt) > MaxThreadMessage {
				t.Fatalf("prompt of %d bytes", len(s.Prompt))
			}
			if s.Cwd != "" || s.ProjectID == "" { // a project's thread may leave it to the project
				checkDir("cwd", s.Cwd)
			}
			checkEnv(s.Env)
			for _, d := range s.AddDirs {
				checkDir("add-dir", d)
			}
		}
		if _, err := a.terminalCreate(context.Background(), termParams); err == nil {
			s := terms.term
			if s == nil {
				t.Fatal("accepted without creating")
			}
			size := 0
			for _, x := range s.Argv {
				size += len(x) + 1
			}
			if len(s.Argv) == 0 || strings.TrimSpace(s.Argv[0]) == "" || size > maxTerminalArgv || slices.ContainsFunc(s.Argv, func(x string) bool { return strings.ContainsRune(x, 0) }) {
				t.Fatalf("argv %q", s.Argv)
			}
			if strings.ContainsAny(s.Title, "\r\n\x00") || len(s.Title) > maxTerminalTitle {
				t.Fatalf("title %q", s.Title)
			}
			checkDir("cwd", s.Cwd)
			checkEnv(s.Env)
		}
	})
}
