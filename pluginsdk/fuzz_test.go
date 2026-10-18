package pluginsdk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Fuzz targets for the wire and the manifest (docs/notes/plugins-9-fuzz.md). `make fuzz`
// runs each briefly; regression inputs live in testdata/fuzz/<target>/.

// chunkReader hands out data in pieces whose sizes come from cuts, then io.EOF.
type chunkReader struct {
	data []byte
	cuts []byte
	i    int
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := len(r.data)
	if len(r.cuts) > 0 {
		n = int(r.cuts[r.i%len(r.cuts)]) + 1
		r.i++
	}
	n = min(n, len(r.data), len(p))
	copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}

// refLines is what the splitter must produce: the newline-separated pieces of data that
// are not blank and at most max bytes, plus the final unterminated one.
func refLines(data []byte, max int) [][]byte {
	var out [][]byte
	parts := bytes.Split(data, []byte("\n"))
	for _, p := range parts {
		if len(p) <= max && len(bytes.TrimSpace(p)) > 0 {
			out = append(out, p)
		}
	}
	return out
}

func FuzzSplitter(f *testing.F) {
	f.Add([]byte("a\nb\n\n  \nccc"), []byte{0, 1, 2}, uint8(4))
	f.Add([]byte("toolong\nok\n"), []byte{2}, uint8(3))
	f.Add([]byte("\xff\xfe\n{}\n"), []byte{}, uint8(8))
	f.Fuzz(func(t *testing.T, data, cuts []byte, max uint8) {
		limit := int(max%32) + 1
		sp := splitter{max: limit}
		r := &chunkReader{data: data, cuts: cuts}
		buf := make([]byte, 64)
		var got [][]byte
		for {
			n, err := r.Read(buf)
			got = sp.split(got, buf[:n])
			if err != nil {
				break
			}
		}
		if rest := sp.rest(); rest != nil {
			got = append(got, rest)
		}
		want := refLines(data, limit)
		if len(got) != len(want) {
			t.Fatalf("got %d lines %q, want %d %q", len(got), got, len(want), want)
		}
		for i := range got {
			if !bytes.Equal(got[i], want[i]) {
				t.Fatalf("line %d = %q, want %q", i, got[i], want[i])
			}
		}
		if len(sp.partial) > limit {
			t.Fatalf("partial holds %d bytes, over the %d limit", len(sp.partial), limit)
		}
	})
}

// lockedBuffer is a bounded, concurrency-safe writer.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.buf.Len() > 1<<20 {
		return 0, errors.New("full")
	}
	return b.buf.Write(p)
}

func (b *lockedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.buf.Bytes())
}

var connSeeds = []string{
	`{"jsonrpc":"2.0","id":1,"method":"echo","params":{"a":1}}` + "\n",
	`{"jsonrpc":"2.0","method":"note","params":[1,2]}` + "\n",
	`{"jsonrpc":"2.0","id":"x","method":"panic"}` + "\n",
	`{"jsonrpc":"2.0","id":7,"result":{}}` + "\n",
	`[{"jsonrpc":"2.0","id":1,"method":"echo"}]` + "\n",
	`{"jsonrpc":2,"id":3,"method":"echo"}` + "\n",
	`{"jsonrpc":"2.0","id":{"a":1},"method":"echo"}` + "\n",
	`{"jsonrpc":"2.0","id":1,"error":{"code":"x"}}` + "\n",
	"\xff\xfe\n" + strings.Repeat("[", 20000) + "\n",
	`{"jsonrpc":"2.0","id":9,"method":"big"}`,
}

// expectedAnswers counts the complete lines of data a Conn must answer: JSON objects
// with a string method and an id that is not null (ids of at most 64 bytes, so the
// answer fits the line limit).
func expectedAnswers(data []byte, max int) int {
	n := 0
	lines := refLines(data, max)
	if len(data) > 0 && data[len(data)-1] != '\n' && len(lines) > 0 && bytes.HasSuffix(data, lines[len(lines)-1]) {
		lines = lines[:len(lines)-1] // the unterminated rest is read only at the end
	}
	for _, l := range lines {
		var m map[string]json.RawMessage
		if json.Unmarshal(l, &m) != nil {
			continue
		}
		var method string
		id := m["id"]
		if json.Unmarshal(m["method"], &method) != nil || method == "" || len(id) == 0 || string(id) == "null" || len(id) > 64 {
			continue
		}
		n++
	}
	return n
}

func FuzzConn(f *testing.F) {
	for _, s := range connSeeds {
		f.Add([]byte(s), []byte{3, 17, 200})
	}
	f.Fuzz(func(t *testing.T, data, cuts []byte) {
		const maxLine = 512
		out := &lockedBuffer{}
		pr, pw := io.Pipe()
		c := NewConn(pr, out, ConnOptions{
			MaxLine: maxLine,
			Handle: func(_ context.Context, method string, params json.RawMessage) (any, error) {
				switch method {
				case "panic":
					panic("handler panic")
				case "big":
					return strings.Repeat("x", 2*maxLine), nil
				case "fail":
					return nil, NewError(CodeInvalidParams, "no")
				}
				if len(params) == 0 {
					return nil, nil
				}
				return params, nil
			},
			Notify:  func(context.Context, string, json.RawMessage) {},
			OnIssue: func(string) {},
		})
		go func() {
			r := &chunkReader{data: data, cuts: cuts}
			buf := make([]byte, 256)
			for {
				n, err := r.Read(buf)
				if n > 0 {
					if _, werr := pw.Write(buf[:n]); werr != nil {
						return
					}
				}
				if err != nil {
					return
				}
			}
		}()
		// Every request gets an answer, while the input is still open.
		want := expectedAnswers(data, maxLine)
		deadline := time.Now().Add(5 * time.Second)
		for {
			got := bytes.Count(out.Bytes(), []byte("\n"))
			if got >= want {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%d of %d requests answered; output:\n%s", got, want, out.Bytes())
			}
			time.Sleep(time.Millisecond)
		}
		_ = pw.Close()
		select {
		case <-c.Done():
		case <-time.After(10 * time.Second):
			t.Fatal("the Conn did not close at the end of its input")
		}
		if !errors.Is(c.Err(), io.EOF) {
			t.Fatalf("Err = %v, want io.EOF", c.Err())
		}
		select {
		case <-c.Drained():
		case <-time.After(10 * time.Second):
			t.Fatal("the writer did not drain")
		}
		for _, line := range bytes.Split(out.Bytes(), []byte("\n")) {
			if len(line) == 0 {
				continue
			}
			var m wire
			if err := json.Unmarshal(line, &m); err != nil {
				t.Fatalf("wrote a line that does not parse: %q: %v", line, err)
			}
			if m.JSONRPC != "2.0" || len(m.ID) == 0 || m.Method != "" || (m.Error == nil) == (m.Result == nil) {
				t.Fatalf("wrote a malformed response: %s", line)
			}
			if len(line) > maxLine {
				t.Fatalf("wrote a %d byte line, over the %d byte limit", len(line), maxLine)
			}
		}
	})
}

// manifestSeeds are the real manifests in this repository, when the test runs inside it.
func manifestSeeds(f *testing.F) {
	for _, p := range []string{
		"../plugins/examples/hello/plugin.json", "../plugins/examples/minimal/plugin.json",
		"../internal/store/plugin/testdata/pyecho/plugin.json",
	} {
		if b, err := os.ReadFile(filepath.FromSlash(p)); err == nil {
			f.Add(b)
		}
	}
	b, _ := json.Marshal(validManifest())
	f.Add(b)
	f.Add([]byte(`{"name":"x","version":"1.0.0","protocol":1,"exec":["a"],"commands":[{"name":"n","title":"N","args":[{"name":"count","type":"int","default":"many"}]}]}`))
	f.Add([]byte(`{"name":"x","version":"1.0.0","protocol":1,"exec":["a"],"permissions":{"commands":["***",".."]}}`))
}

func FuzzParseManifest(f *testing.F) {
	manifestSeeds(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		m, _, err := ParseManifest(data)
		if err != nil {
			return
		}
		verr := m.Validate()
		p := m.Permissions
		if !p.Within(p) || !p.Equal(p.Normalize()) {
			t.Fatalf("permissions are not within or equal to themselves: %+v", p)
		}
		_ = p.Describe()
		_ = m.DisplayNameOr()
		for _, g := range p.Commands {
			_ = MatchCommand(g, "thread.send")
			_ = MatchCommand(g, g)
		}
		if verr != nil {
			return
		}
		for _, c := range m.Commands {
			if to := c.Timeout(); to < 1 || to > MaxTimeoutSeconds {
				t.Fatalf("command %s timeout %d", c.Name, to)
			}
			for _, a := range c.Args {
				if err := checkDefault(a); err != nil {
					t.Fatalf("command %s arg %s: a valid manifest's default does not parse: %v", c.Name, a.Name, err)
				}
			}
		}
		// A valid manifest survives its own encoding.
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		m2, warnings, err := ParseManifest(b)
		if err != nil || len(warnings) > 0 {
			t.Fatalf("re-parse: %v %v", err, warnings)
		}
		if err := m2.Validate(); err != nil {
			t.Fatalf("re-encoded manifest no longer validates: %v", err)
		}
		b2, _ := json.Marshal(m2)
		if !bytes.Equal(b, b2) {
			t.Fatalf("not byte-stable:\n%s\n%s", b, b2)
		}
	})
}

// checkDefault parses a default the way the host's command registry does.
func checkDefault(a ArgSpec) error {
	if a.Default == "" {
		return nil
	}
	return parseArgValue(a.Type, a.Enum, a.Default)
}

func FuzzMatchCommand(f *testing.F) {
	f.Add("thread.*", "thread.send")
	f.Add("**", "a.b.c")
	f.Add("a**b*", "a.x.b")
	f.Fuzz(func(t *testing.T, glob, name string) {
		got := MatchCommand(glob, name)
		if got && !globPattern.MatchString(glob) {
			t.Fatalf("an invalid glob %q matched", glob)
		}
		if globPattern.MatchString(glob) && !strings.Contains(glob, "*") && got != (glob == name) {
			t.Fatalf("literal glob %q vs %q = %v", glob, name, got)
		}
		if got && !strings.Contains(glob, "**") && strings.Count(name, ".") != strings.Count(glob, ".") {
			t.Fatalf("%q matched %q across segments", glob, name)
		}
	})
}
