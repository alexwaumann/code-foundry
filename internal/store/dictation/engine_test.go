package dictation

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/dictate"
)

// pipeEngine runs a scripted engine on the other end of an EngineConn: answer gets each
// request line and returns the lines to write back.
func pipeEngine(t *testing.T, answer func(req map[string]any) []string) (*EngineConn, func()) {
	t.Helper()
	toEngine, fromDaemon := io.Pipe()
	toDaemon, fromEngine := io.Pipe()
	c := newEngineConn(toDaemon, fromDaemon, nil)
	go func() {
		sc := bufio.NewScanner(toEngine)
		for sc.Scan() {
			var req map[string]any
			if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
				t.Errorf("engine got %q: %v", sc.Text(), err)
				continue
			}
			for _, l := range answer(req) {
				if _, err := io.WriteString(fromEngine, l+"\n"); err != nil {
					return
				}
			}
		}
	}()
	return c, func() { _ = fromEngine.Close() }
}

func TestEngineConn(t *testing.T) {
	var audio []map[string]any
	c, hangUp := pipeEngine(t, func(req map[string]any) []string {
		id, _ := req["id"].(float64)
		reply := func(result string) string {
			b, _ := json.Marshal(map[string]any{"id": id, "result": json.RawMessage(result)})
			return string(b)
		}
		switch req["method"] {
		case dictate.MethodLoad:
			return []string{`{"event":"state","params":{"state":"loading"}}`, "not json", reply(`{"load_ms":900,"rss_bytes":12}`)}
		case dictate.MethodEnd:
			return []string{`{"event":"phrase","params":{"session":"s1","text":"tail"}}`, reply(`{}`)}
		case dictate.MethodBegin:
			b, _ := json.Marshal(map[string]any{"id": id, "error": map[string]string{"message": "busy"}})
			return []string{string(b)}
		case dictate.MethodAudio:
			audio = append(audio, req["params"].(map[string]any))
		}
		return nil
	})
	ctx := context.Background()
	var res dictate.LoadResult
	if err := c.Call(ctx, dictate.MethodLoad, dictate.LoadParams{Model: "/m.bin", Language: "en"}, &res); err != nil {
		t.Fatal(err)
	}
	if res.LoadMS != 900 || res.RSSBytes != 12 {
		t.Errorf("load result %+v", res)
	}
	if ev := <-c.Events(); ev.Name != dictate.EventState || string(ev.Params) != `{"state":"loading"}` {
		t.Errorf("event %+v", ev)
	}
	if err := c.Call(ctx, dictate.MethodBegin, dictate.BeginParams{Session: "s1"}, nil); err == nil || !strings.Contains(err.Error(), "busy") {
		t.Errorf("begin error %v", err)
	}
	if err := c.Notify(dictate.MethodAudio, dictate.AudioParams{Session: "s1", PCM: []byte{1, 2, 3}}); err != nil {
		t.Fatal(err)
	}
	// The phrase sent before end's reply is counted by the time Call returns.
	if err := c.Call(ctx, dictate.MethodEnd, dictate.EndParams{Session: "s1", Flush: true}, nil); err != nil {
		t.Fatal(err)
	}
	if n := c.Enqueued(); n != 2 {
		t.Errorf("enqueued %d, want 2", n)
	}
	if ev := <-c.Events(); ev.Name != dictate.EventPhrase {
		t.Errorf("event %+v", ev)
	}
	if len(audio) != 1 || audio[0]["pcm"] != "AQID" || audio[0]["session"] != "s1" {
		t.Errorf("audio %v", audio)
	}
	// A call waiting when the engine goes away fails, and so does every later one.
	waiting := make(chan error, 1)
	go func() { waiting <- c.Call(ctx, dictate.MethodStatus, nil, nil) }()
	time.Sleep(20 * time.Millisecond)
	hangUp()
	<-c.Done()
	if err := <-waiting; err == nil {
		t.Error("pending call did not fail")
	}
	if err := c.Call(ctx, dictate.MethodStatus, nil, nil); err == nil {
		t.Error("call after exit did not fail")
	}
	if _, open := <-c.Events(); open {
		t.Error("events not closed")
	}
}

type fakeProcess struct {
	code   int
	stderr string
}

func (p fakeProcess) Done() <-chan struct{}     { return nil }
func (p fakeProcess) ExitCode() int             { return p.code }
func (p fakeProcess) LastStderrLine() string    { return p.stderr }
func (fakeProcess) Signal(syscall.Signal) error { return nil }
func (fakeProcess) CloseOutput()                {}

func TestExitError(t *testing.T) {
	for _, tc := range []struct {
		p    fakeProcess
		want string
	}{
		{fakeProcess{code: 2, stderr: "ggml_metal_init: no Metal device"}, "the engine exited with status 2: ggml_metal_init: no Metal device"},
		{fakeProcess{code: -1, stderr: `time=x level=INFO msg="dictate: model loaded"`}, "the engine was killed by a signal"},
		{fakeProcess{code: 1, stderr: `time=x level=ERROR msg="load failed"`}, `the engine exited with status 1: time=x level=ERROR msg="load failed"`},
		{fakeProcess{code: 0}, "the engine exited with status 0"},
	} {
		if got := exitError(tc.p).Error(); got != tc.want {
			t.Errorf("exitError(%+v) = %q, want %q", tc.p, got, tc.want)
		}
	}
}

func TestEngineConnCallTimeout(t *testing.T) {
	c, hangUp := pipeEngine(t, func(map[string]any) []string { return nil })
	defer hangUp()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := c.Call(ctx, dictate.MethodLoad, nil, nil); err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Errorf("err %v", err)
	}
}
