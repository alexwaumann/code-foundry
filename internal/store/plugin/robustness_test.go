package plugin_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Misbehaving plugins (docs/notes/plugins-9-fuzz.md): each mode below is a helper the
// test binary runs as a plugin (helper_test.go), and each test checks that the actor
// recovers (keeps running, restarts with backoff, or fails) without wedging the store.

var extraHelpers = map[string]func() int{
	"garbage":     garbagePlugin,
	"flood":       floodPlugin,
	"wrongids":    wrongIDsPlugin,
	"closestdout": closeStdoutPlugin,
	"binstderr":   binaryStderrPlugin,
	"bigline":     bigLinePlugin,
	"midexit":     func() int { return servePlugin(midExitPlugin()) },
	"hugeresult":  func() int { return servePlugin(hugeResultPlugin()) },
}

func servePlugin(p pluginsdk.Plugin) int {
	if err := pluginsdk.Serve(p); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		return 1
	}
	return 0
}

// lockedWriter serializes whole writes to stdout, so raw lines and the Conn's do not
// interleave.
type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// rawPlugin answers initialize, ping and command/invoke ("still here") with a Conn on
// stdin/stdout and hands misbehave the stdout writer once initialized.
func rawPlugin(misbehave func(w io.Writer)) int {
	out := &lockedWriter{w: os.Stdout}
	ready := make(chan struct{})
	var once sync.Once
	c := pluginsdk.NewConn(os.Stdin, out, pluginsdk.ConnOptions{
		Handle: func(_ context.Context, method string, _ json.RawMessage) (any, error) {
			switch method {
			case pluginsdk.MethodInitialize:
				return pluginsdk.InitializeResult{Protocol: pluginsdk.ProtocolVersion}, nil
			case pluginsdk.MethodCommandInvoke:
				return pluginsdk.CommandResult{Message: "still here"}, nil
			}
			return struct{}{}, nil
		},
		Notify: func(_ context.Context, method string, _ json.RawMessage) {
			if method == pluginsdk.MethodInitialized {
				once.Do(func() { close(ready) })
			}
		},
	})
	go func() {
		<-ready
		misbehave(out)
	}()
	<-c.Done()
	return 0
}

// garbagePlugin writes everything a broken plugin could: invalid UTF-8, a partial line,
// a line over the limit, a nesting bomb, batches, responses to unknown ids, a request
// with a field of the wrong type, binary stderr. Then it behaves.
func garbagePlugin() int {
	return rawPlugin(func(w io.Writer) {
		_, _ = os.Stderr.Write([]byte("\xff\xfe\x00 binary stderr \xc3\x28\n"))
		for _, s := range []string{
			"\xff\xfe garbage\n",
			`[{"jsonrpc":"2.0","method":"log","params":{"msg":"batched"}}]` + "\n",
			strings.Repeat("[", 100000) + "\n",
			`{"jsonrpc":"2.0","id":999999,"result":{}}` + "\n",
			`{"jsonrpc":"2.0","id":"abc","error":{"code":"x","message":1}}` + "\n",
			`{"jsonrpc":"2.0","method":"log","params":{"msg":"part`, "ial \xff line\"}}\n",
			`{"jsonrpc":2,"id":77,"method":"secret/list"}` + "\n",
			`{"jsonrpc":"2.0","id":78,"method":"no/such"}` + "\n",
			`{"jsonrpc":"2.0","method":""}` + "\n",
			`{"jsonrpc":"2.0","method":"log","params":"not an object"}` + "\n",
			`{"jsonrpc":"2.0","method":"log","params":{"msg":"garbage done"}}` + "\n",
		} {
			_, _ = io.WriteString(w, s)
		}
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","method":"log","params":{"msg":"`+strings.Repeat("x", 5<<20)+`"}}`+"\n")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","method":"log","params":{"msg":"after the long line"}}`+"\n")
	})
}

// floodPlugin floods notifications (logs, views for no instance) and requests as fast as
// the pipe takes them, until stdin closes.
func floodPlugin() int {
	view := `{"nodes":[` + strings.TrimSuffix(strings.Repeat(`{"key":"a"},`, 20000), ",") + `]}`
	return rawPlugin(func(w io.Writer) {
		log := []byte(`{"jsonrpc":"2.0","method":"log","params":{"msg":"` + strings.Repeat("f", 1000) + `"}}` + "\n")
		upd := []byte(`{"jsonrpc":"2.0","method":"view/update","params":{"instance":"x","view":` + view + `}}` + "\n")
		for i := 0; ; i++ {
			var err error
			switch i % 3 {
			case 0:
				_, err = w.Write(log)
			case 1:
				_, err = w.Write(upd)
			default:
				_, err = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"method":"secret/list"}`+"\n", 1_000_000+i)
			}
			if err != nil {
				return
			}
		}
	})
}

// wrongIDsPlugin answers initialize, then answers every request with the wrong id.
func wrongIDsPlugin() int {
	r := bufio.NewReader(os.Stdin)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return 0
		}
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(line, &m) != nil || len(m.ID) == 0 {
			continue
		}
		id := string(m.ID)
		if m.Method != pluginsdk.MethodInitialize {
			id = "1" + id + "0"
		}
		fmt.Printf(`{"jsonrpc":"2.0","id":%s,"result":{"protocol":1}}`+"\n", id)
	}
}

// closeStdoutPlugin answers initialize, closes stdout and lives on, writing to stderr.
func closeStdoutPlugin() int {
	r := bufio.NewReader(os.Stdin)
	line, _ := r.ReadBytes('\n')
	var m struct {
		ID json.RawMessage `json:"id"`
	}
	_ = json.Unmarshal(line, &m)
	fmt.Printf(`{"jsonrpc":"2.0","id":%s,"result":{"protocol":1}}`+"\n", m.ID)
	time.Sleep(100 * time.Millisecond)
	_ = os.Stdout.Close()
	for {
		fmt.Fprintln(os.Stderr, "still alive without stdout")
		time.Sleep(50 * time.Millisecond)
	}
}

// binaryStderrPlugin dies with invalid UTF-8 on stderr.
func binaryStderrPlugin() int {
	// Invalid UTF-8, and a line over the 16 KiB stderr tail that is cut inside a rune.
	_, _ = os.Stderr.Write([]byte("boom \xff\xfe\xc3\x28 " + strings.Repeat("é", 9000) + "\n"))
	return 3
}

// bigLinePlugin writes a 100 MB line, then a log line.
func bigLinePlugin() int {
	return rawPlugin(func(w io.Writer) {
		chunk := []byte(strings.Repeat("x", 1<<20))
		for range 100 {
			if _, err := os.Stdout.Write(chunk); err != nil {
				return
			}
		}
		_, _ = io.WriteString(w, "\n"+`{"jsonrpc":"2.0","method":"log","params":{"msg":"after 100 MB"}}`+"\n")
	})
}

// midExitPlugin exits while it handles greet.
func midExitPlugin() pluginsdk.Plugin {
	return pluginsdk.Plugin{Commands: map[string]pluginsdk.CommandFunc{
		"greet": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			os.Exit(4)
			return pluginsdk.CommandResult{}, nil
		},
	}}
}

// hugeResultPlugin answers greet with a message over the line limit.
func hugeResultPlugin() pluginsdk.Plugin {
	return pluginsdk.Plugin{Commands: map[string]pluginsdk.CommandFunc{
		"greet": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			return pluginsdk.CommandResult{Message: strings.Repeat("x", pluginsdk.MaxLine+1)}, nil
		},
	}}
}

// validUTF8 fails the test when a log line or the last error is not UTF-8 (the API's
// protobuf strings refuse it).
func (e *env) validUTF8(name string) {
	e.t.Helper()
	lines, err := e.m.Logs(name, 0)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, l := range lines {
		if !utf8.ValidString(l.Text) {
			e.t.Errorf("log line not UTF-8: %q", l.Text)
		}
	}
	if p, _ := e.m.Snapshot().Plugin(name); !utf8.ValidString(p.LastError) {
		e.t.Errorf("last error not UTF-8: %q", p.LastError)
	}
}

func (e *env) waitLog(name, want string) {
	e.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(e.logText(name), want) {
		if time.Now().After(deadline) {
			e.t.Fatalf("log has no %q:\n%s", want, e.logText(name))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func heapMB() uint64 {
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return ms.HeapAlloc >> 20
}

func TestMisbehavingPlugins(t *testing.T) {
	tests := []struct {
		mode  string
		opts  func(o *plugin.Options)
		check func(t *testing.T, e *env)
	}{
		{mode: "garbage", check: func(t *testing.T, e *env) {
			first := e.waitState("hello", plugin.StateRunning)
			e.waitLog("hello", "after the long line")
			for _, want := range []string{"garbage done", "partial \ufffd line", "protocol: malformed line", "protocol: skipped a line over",
				"protocol: response to unknown id 999999", "binary stderr"} {
				if !strings.Contains(e.logText("hello"), want) {
					t.Errorf("log has no %q", want)
				}
			}
			if r, err := e.invoke("plugin.hello.greet", nil, command.Context{}); err != nil || r.Message != "still here" {
				t.Fatalf("greet after the garbage: %+v, %v", r, err)
			}
			if p, _ := e.m.Snapshot().Plugin("hello"); p.State != plugin.StateRunning || p.PID != first.PID {
				t.Fatalf("garbage restarted it: %+v", p)
			}
			e.validUTF8("hello")
		}},
		{mode: "flood", opts: func(o *plugin.Options) { o.PingInterval, o.PingTimeout = 200*time.Millisecond, 2*time.Second }, check: func(t *testing.T, e *env) {
			before := heapMB()
			e.waitState("hello", plugin.StateRunning)
			e.waitLog("hello", "f")
			deadline := time.Now().Add(3 * time.Second)
			peak := uint64(0)
			for time.Now().Before(deadline) {
				peak = max(peak, heapMB())
				start := time.Now()
				_ = e.m.Snapshot()
				if _, err := e.m.Logs("hello", 10); err != nil {
					t.Fatal(err)
				}
				if d := time.Since(start); d > time.Second {
					t.Fatalf("the store took %s to answer during the flood", d)
				}
				time.Sleep(100 * time.Millisecond)
			}
			t.Logf("heap %d MB before, %d MB at most during the flood", before, peak)
			if peak > before+256 {
				t.Errorf("heap grew from %d MB to %d MB during the flood", before, peak)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if r, err := e.reg.Invoke(ctx, command.Context{}, "plugin.hello.greet", nil); err != nil || r.Message != "still here" {
				t.Fatalf("greet during the flood: %+v, %v", r, err)
			}
			start := time.Now()
			if _, err := e.m.Disable(context.Background(), "hello"); err != nil {
				t.Fatal(err)
			}
			e.waitState("hello", plugin.StateDisabled)
			if d := time.Since(start); d > 10*time.Second {
				t.Errorf("disable took %s", d)
			}
		}},
		{mode: "wrongids", opts: func(o *plugin.Options) {
			o.PingInterval, o.PingTimeout, o.CrashLimit = 50*time.Millisecond, 50*time.Millisecond, 2
		}, check: func(t *testing.T, e *env) {
			p := e.waitState("hello", plugin.StateFailed)
			if !strings.Contains(p.LastError, "not answering pings") {
				t.Fatalf("err %q", p.LastError)
			}
			if !strings.Contains(e.logText("hello"), "response to unknown id") {
				t.Error("wrong ids not logged")
			}
		}},
		{mode: "closestdout", opts: func(o *plugin.Options) {
			o.KillGrace, o.BackoffBase, o.BackoffMax = 200*time.Millisecond, time.Hour, time.Hour
		}, check: func(t *testing.T, e *env) {
			running := e.waitState("hello", plugin.StateRunning)
			p := e.waitState("hello", plugin.StateCrashed)
			if p.LastError != "closed its stdout" {
				t.Fatalf("err %q", p.LastError)
			}
			deadline := time.Now().Add(5 * time.Second)
			for syscall.Kill(running.PID, 0) == nil {
				if time.Now().After(deadline) {
					t.Fatal("the process outlived its crash")
				}
				time.Sleep(20 * time.Millisecond)
			}
		}},
		{mode: "binstderr", opts: func(o *plugin.Options) { o.CrashLimit = 1 }, check: func(t *testing.T, e *env) {
			p := e.waitState("hello", plugin.StateFailed)
			if !strings.Contains(p.LastError, "exited with status 3: ") {
				t.Fatalf("err %q", p.LastError)
			}
			e.validUTF8("hello")
		}},
		{mode: "bigline", check: func(t *testing.T, e *env) {
			before := heapMB()
			e.waitState("hello", plugin.StateRunning)
			e.waitLog("hello", "after 100 MB")
			if after := heapMB(); after > before+64 {
				t.Errorf("heap grew from %d MB to %d MB", before, after)
			}
			if !strings.Contains(e.logText("hello"), "skipped a line over") {
				t.Error("the long line was not reported")
			}
		}},
		{mode: "midexit", opts: func(o *plugin.Options) { o.BackoffBase, o.BackoffMax = 20*time.Millisecond, 20*time.Millisecond }, check: func(t *testing.T, e *env) {
			first := e.waitState("hello", plugin.StateRunning)
			start := time.Now()
			_, err := e.invoke("plugin.hello.greet", nil, command.Context{})
			if err == nil || !strings.Contains(err.Error(), "stopped while running greet") {
				t.Fatalf("greet: %v", err)
			}
			if d := time.Since(start); d > 5*time.Second {
				t.Errorf("the failure took %s", d)
			}
			e.wait("hello", "a restart", func(p plugin.Plugin) bool {
				return p.State == plugin.StateRunning && p.PID != first.PID && p.PID != 0
			})
		}},
		{mode: "hugeresult", check: func(t *testing.T, e *env) {
			e.waitState("hello", plugin.StateRunning)
			start := time.Now()
			_, err := e.invoke("plugin.hello.greet", nil, command.Context{})
			if err == nil || !strings.Contains(err.Error(), "over the") {
				t.Fatalf("greet: %v", err)
			}
			if d := time.Since(start); d > 5*time.Second {
				t.Errorf("the answer took %s (the command's timeout?)", d)
			}
			if p, _ := e.m.Snapshot().Plugin("hello"); p.State != plugin.StateRunning {
				t.Errorf("state %s", p.State)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.mode, func(t *testing.T) {
			e := newEnv(t, tt.opts)
			e.install(e.opts.Dir, "hello", tt.mode, testManifest("hello"))
			m := e.start()
			if _, err := m.Enable(context.Background(), "hello", true); err != nil {
				t.Fatal(err)
			}
			tt.check(t, e)
		})
	}
}
