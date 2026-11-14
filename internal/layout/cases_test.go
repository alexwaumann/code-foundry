package layout

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// -update rewrites the expected parts of the JSON cases (want, result, rects, ...) from what
// the code does now. Read the diff before committing it.
var update = flag.Bool("update", false, "rewrite the expected parts of testdata cases")

// opCase is one testdata/ops/*.json file (docs/notes/shell-1-layout-model.md).
type opCase struct {
	Doc   string          `json:"doc"`
	State json.RawMessage `json:"state"`
	Op    json.RawMessage `json:"op"`
	// Options are the settings the op runs with (ApplyWith); absent means the defaults.
	Options *Options        `json:"options,omitempty"`
	Want    json.RawMessage `json:"want,omitempty"`
	Error   string          `json:"error,omitempty"`
	Result  *caseResult     `json:"result,omitempty"`
}

// caseResult is Result as a case states it: closed tabs by id.
type caseResult struct {
	Space    string   `json:"space,omitempty"`
	Pane     string   `json:"pane,omitempty"`
	Tab      string   `json:"tab,omitempty"`
	Existing bool     `json:"existing,omitempty"`
	Closed   []string `json:"closed,omitempty"`
	Rule     string   `json:"rule,omitempty"`
	Kept     []string `json:"kept,omitempty"`
	Ended    []string `json:"ended,omitempty"`
	Back     []string `json:"back,omitempty"`
	Placed   []string `json:"placed,omitempty"`
	Fresh    []string `json:"fresh,omitempty"`
	Swapped  []string `json:"swapped,omitempty"`
	Draft    string   `json:"draft,omitempty"`
	// Collapsed: a reopened pane came back collapsed (fit.go).
	Collapsed bool `json:"collapsed,omitempty"`
}

func toCaseResult(r Result) *caseResult {
	ids := func(tabs []*Tab) []string {
		var out []string
		for _, t := range tabs {
			out = append(out, t.ID)
		}
		return out
	}
	return &caseResult{
		Space: r.Space, Pane: r.Pane, Tab: r.Tab, Existing: r.Existing, Closed: ids(r.Closed),
		Rule: r.Rule, Kept: ids(r.Kept), Ended: ids(r.Ended), Back: r.Back, Placed: r.Placed,
		Fresh: r.Fresh, Swapped: r.Swapped, Draft: r.Draft, Collapsed: r.Collapsed,
	}
}

// errorCodes names the errors a case may expect.
var errorCodes = map[string]error{
	"not_found":           ErrNotFound,
	"invalid_argument":    ErrInvalidArgument,
	"already_exists":      ErrAlreadyExists,
	"failed_precondition": ErrFailedPrecondition,
}

func errorCode(err error) string {
	for code, e := range errorCodes {
		if errors.Is(err, e) {
			return code
		}
	}
	return "other: " + err.Error()
}

// decodeExact decodes a case's state, which must already be in normal form.
func decodeExact(t *testing.T, what string, data []byte) *State {
	t.Helper()
	st, repairs, err := Decode(data, &SeqIDs{})
	if err != nil {
		t.Fatalf("%s: %v", what, err)
	}
	if len(repairs) > 0 {
		t.Fatalf("%s is not in normal form: %s", what, strings.Join(repairs, "; "))
	}
	return st
}

// canonical is a state's JSON with sizes rounded to 1e-9, for comparing.
func canonical(t *testing.T, st *State) string {
	t.Helper()
	c := st.Clone()
	for _, sp := range c.Spaces {
		walk(sp.Root, func(n *Node) {
			for i, s := range n.Sizes {
				n.Sizes[i] = math.Round(s*1e9) / 1e9
			}
		})
	}
	b, err := Encode(c)
	if err != nil {
		t.Fatal(err)
	}
	return string(pretty(b))
}

func TestOpCases(t *testing.T) {
	files, err := filepath.Glob("testdata/ops/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no cases: %v", err)
	}
	seen := map[string]bool{}
	for _, file := range files {
		t.Run(strings.TrimSuffix(filepath.Base(file), ".json"), func(t *testing.T) {
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var c opCase
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&c); err != nil {
				t.Fatalf("read case: %v", err)
			}
			if c.Doc == "" {
				t.Error("case has no doc")
			}
			st := decodeExact(t, "state", c.State)
			before := canonical(t, st)
			op, err := DecodeOp(c.Op)
			if err != nil {
				t.Fatal(err)
			}
			seen[op.OpName()] = true
			var opts Options
			if c.Options != nil {
				opts = *c.Options
			}
			next, res, err := ApplyWith(st, op, &SeqIDs{}, opts)
			if *update {
				c.Want, c.Result, c.Error = nil, nil, ""
				if err != nil {
					c.Error = errorCode(err)
				} else {
					c.Want = encodeWithoutKeys(t, next)
					c.Result = toCaseResult(res)
				}
				writeCase(t, file, &c)
				return
			}
			if c.Error != "" {
				if err == nil {
					t.Fatalf("want error %s, got none", c.Error)
				}
				if got := errorCode(err); got != c.Error {
					t.Fatalf("error %s (%v), want %s", got, err, c.Error)
				}
				if next != st || canonical(t, st) != before {
					t.Fatal("a failed op changed the state")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if canonical(t, st) != before {
				t.Fatal("the op changed the state it was given")
			}
			want := decodeExact(t, "want", c.Want)
			if got, w := canonical(t, next), canonical(t, want); got != w {
				t.Errorf("state:\n got %s\nwant %s", got, w)
			}
			if c.Result != nil {
				if got := toCaseResult(res); !reflect.DeepEqual(got, c.Result) {
					t.Errorf("result %+v, want %+v", got, c.Result)
				}
			}
		})
	}
	if !*update {
		for _, name := range OpNames() {
			if !seen[name] {
				t.Errorf("op %s has no case under testdata/ops", name)
			}
		}
	}
}

// encodeWithoutKeys is a state's JSON without the tab keys, which Decode derives: a case
// states only what a person would write.
func encodeWithoutKeys(t *testing.T, st *State) []byte {
	t.Helper()
	c := st.Clone()
	for _, sp := range c.Spaces {
		for _, p := range Panes(sp.Root) {
			for _, tb := range p.Tabs {
				tb.Key = ""
			}
		}
	}
	for _, ts := range c.Threads {
		if ts.Remembered != nil {
			for _, rt := range ts.Remembered.Tabs {
				rt.Tab.Key = ""
			}
		}
	}
	b, err := Encode(c)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func writeCase(t *testing.T, file string, c *opCase) {
	t.Helper()
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, append(pretty(b), '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// pretty formats JSON for people: a value that fits in prettyWidth columns stays on one line,
// a longer one is broken into one member per line. Key order is kept.
func pretty(data []byte) []byte {
	var v ordered
	if err := json.Unmarshal(data, &v); err != nil {
		return data
	}
	var b bytes.Buffer
	v.write(&b, "", 0)
	return b.Bytes()
}

const prettyWidth = 100

// ordered is a JSON value that remembers its object key order.
type ordered struct {
	keys []string
	vals []ordered
	arr  []ordered
	kind byte // 'o' object, 'a' array, 's' scalar
	raw  json.RawMessage
}

func (o *ordered) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	switch {
	case len(data) > 0 && data[0] == '{':
		o.kind = 'o'
		dec := json.NewDecoder(bytes.NewReader(data))
		if _, err := dec.Token(); err != nil {
			return err
		}
		for dec.More() {
			tok, err := dec.Token()
			if err != nil {
				return err
			}
			var v ordered
			if err := dec.Decode(&v); err != nil {
				return err
			}
			o.keys = append(o.keys, tok.(string))
			o.vals = append(o.vals, v)
		}
		return nil
	case len(data) > 0 && data[0] == '[':
		o.kind = 'a'
		return json.Unmarshal(data, &o.arr)
	default:
		o.kind = 's'
		o.raw = append(json.RawMessage(nil), data...)
		return nil
	}
}

func (o ordered) compact() string {
	switch o.kind {
	case 'o':
		parts := make([]string, len(o.keys))
		for i, k := range o.keys {
			kb, _ := json.Marshal(k)
			parts[i] = string(kb) + ":" + o.vals[i].compact()
		}
		return "{" + strings.Join(parts, ",") + "}"
	case 'a':
		parts := make([]string, len(o.arr))
		for i, v := range o.arr {
			parts[i] = v.compact()
		}
		return "[" + strings.Join(parts, ",") + "]"
	default:
		return string(o.raw)
	}
}

func (o ordered) write(b *bytes.Buffer, indent string, used int) {
	c := o.compact()
	if o.kind == 's' || len(indent)+used+len(c) <= prettyWidth {
		b.WriteString(c)
		return
	}
	in := indent + "  "
	if o.kind == 'o' {
		b.WriteString("{\n")
		for i, k := range o.keys {
			kb, _ := json.Marshal(k)
			fmt.Fprintf(b, "%s%s: ", in, kb)
			o.vals[i].write(b, in, len(kb)+2)
			if i < len(o.keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent + "}")
		return
	}
	b.WriteString("[\n")
	for i, v := range o.arr {
		b.WriteString(in)
		v.write(b, in, 0)
		if i < len(o.arr)-1 {
			b.WriteByte(',')
		}
		b.WriteByte('\n')
	}
	b.WriteString(indent + "]")
}
