package plugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Fuzz targets for the daemon side of plugins (docs/notes/plugins-9-fuzz.md). `make fuzz`
// runs each briefly; regression inputs live in testdata/fuzz/<target>/.

// fuzzPerms grants every command a view may name and secrets, so the host's own checks
// refuse only management verbs.
var fuzzPerms = pluginsdk.Permissions{Commands: []string{"**"}, Secrets: true}

// viewSeeds are the hello demo's views and every.
func viewSeeds(tb testing.TB) [][]byte {
	files, err := filepath.Glob(filepath.Join("testdata", "hello-demo", "*.json"))
	if err != nil || len(files) == 0 {
		tb.Fatalf("no hello-demo views: %v", err)
	}
	slices.Sort(files)
	var out [][]byte
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			tb.Fatal(err)
		}
		out = append(out, b)
	}
	return append(out, []byte(every))
}

// hostOnly reports a daemon problem pluginsdk/ui's Validate cannot know about.
func hostOnly(msg string) bool {
	return strings.Contains(msg, "is neither plugin.") || strings.Contains(msg, "store needs")
}

// checkView runs one raw view through the daemon and compares with the SDK: the same
// problems (besides the host's own), and for an accepted view a canonical form that
// validates again and re-encodes byte for byte; then installs it in an instance and
// renders, indexes and appends to it.
func checkView(t *testing.T, raw []byte) {
	v, canon, errs := validateView(raw, "p", fuzzPerms)
	trimmed := bytes.TrimSpace(raw)
	if len(raw) <= maxRawView && len(trimmed) > 0 && trimmed[0] == '{' {
		var sdk ui.View
		if json.Unmarshal(trimmed, &sdk) == nil {
			var want []string
			if err := sdk.Validate(); err != nil {
				want = splitJoined(err)
			}
			var got []string
			for _, e := range errs {
				if !hostOnly(e) {
					got = append(got, e)
				}
			}
			if !slices.Equal(got, want) {
				t.Fatalf("the daemon and the SDK disagree:\ndaemon: %q\nsdk:    %q", got, want)
			}
		}
	}
	if len(errs) > 0 {
		if v != nil || canon != nil {
			t.Fatal("a rejected view came back")
		}
		in := newFuzzInstance()
		in.reject("P", errs, true)
		if !json.Valid(in.renderLocked()) {
			t.Fatal("the invalid-view notice is not JSON")
		}
		return
	}
	if path := nullList(canon); path != "" {
		t.Fatalf("the canonical form has null for the list %s:\n%s", path, canon)
	}
	v2, canon2, errs2 := validateView(canon, "p", fuzzPerms)
	if len(errs2) > 0 {
		t.Fatalf("the canonical form of an accepted view is refused: %q\n%s", errs2, canon)
	}
	if !bytes.Equal(canon, canon2) {
		t.Fatalf("the canonical form is not byte-stable:\n%s\n%s", canon, canon2)
	}
	in := newFuzzInstance()
	ver, _ := in.accept(v2, canon2, time.Unix(0, 0))
	if ver != 1 {
		t.Fatalf("version %d", ver)
	}
	if out := in.renderLocked(); !json.Valid(out) || !utf8.Valid(out) {
		t.Fatalf("render is not UTF-8 JSON: %q", out)
	}
	idx := in.index[ver]
	for _, k := range idx.order {
		el := idx.elements[k]
		_ = el.actionName()
		if _, err := idx.find(k, ""); err != nil {
			t.Fatalf("find %s: %v", k, err)
		}
	}
	// Appends: to every node key; only log nodes take them.
	walkView(v2, func(n *ui.Node) {
		_, err := in.appendLog(pluginsdk.ViewAppendParams{Instance: in.key, Key: n.Key, Text: "more\n"})
		if (err == nil) != (n.Log != nil) {
			t.Fatalf("append to %s (log %v): %v", n.Key, n.Log != nil, err)
		}
	})
	if out := in.renderLocked(); !json.Valid(out) {
		t.Fatalf("render after appends is not JSON: %q", out)
	}
	w := &watcher{}
	_ = in.pull(w)
}

// requiredLists are the view model's lists without omitempty: viewers expect arrays.
var requiredLists = []string{"nodes", "items", "rows", "chips", "buttons", "children", "fields"}

// nullList returns the path of a required list that is null in the view's JSON.
func nullList(view []byte) string {
	var tree any
	if json.Unmarshal(view, &tree) != nil {
		return ""
	}
	var walk func(path string, v any) string
	walk = func(path string, v any) string {
		switch x := v.(type) {
		case map[string]any:
			for k, c := range x {
				if c == nil && slices.Contains(requiredLists, k) {
					return path + "." + k
				}
				if p := walk(path+"."+k, c); p != "" {
					return p
				}
			}
		case []any:
			for i, c := range x {
				if p := walk(fmt.Sprintf("%s[%d]", path, i), c); p != "" {
					return p
				}
			}
		}
		return ""
	}
	return walk("", tree)
}

func newFuzzInstance() *instance {
	return &instance{key: "p/s/x", plugin: "p", surfaceID: "s", watchers: map[*watcher]struct{}{}, index: map[uint64]*actionIndex{}}
}

func FuzzValidateView(f *testing.F) {
	for _, s := range viewSeeds(f) {
		f.Add(s)
	}
	f.Add([]byte(`{"nodes":[{"key":"a","log":{"text":"x"}}],"nodes":null}`))
	f.Add([]byte(`  {"Nodes":[{"KEY":"a","TEXT":{"content":"x"}}]}`))
	f.Add([]byte(`{}`))
	// Generated views (viewgen_test.go): every layout node, both strips, deep and valid.
	for seed := range uint64(24) {
		if b, err := json.Marshal(genView(seed)); err == nil {
			f.Add(b)
		}
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		checkView(t, raw)
	})
}

// FuzzViewMutate mutates the hello demo's views structurally: ops pick a value by
// walking the JSON tree and replace, drop, retype, inflate or duplicate it.
func FuzzViewMutate(f *testing.F) {
	seeds := viewSeeds(f)
	for i := range seeds {
		f.Add(uint8(i), []byte{})
		f.Add(uint8(i), []byte{1, 2, 0, 7, 3, 1, 0, 9})
	}
	f.Fuzz(func(t *testing.T, seed uint8, ops []byte) {
		var tree any
		if err := json.Unmarshal(seeds[int(seed)%len(seeds)], &tree); err != nil {
			t.Fatal(err)
		}
		raw := mutateView(tree, ops)
		checkView(t, raw)
	})
}

// mutateView applies ops to tree and encodes it. Each op is a path (bytes, until one is
// 0 mod 4 or a leaf is reached) and a mutation byte.
func mutateView(tree any, ops []byte) []byte {
	dup, inflated := "", false
	for len(ops) > 0 {
		var path []any
		cur := tree
	walk:
		for len(ops) > 0 {
			b := ops[0]
			ops = ops[1:]
			if b%4 == 0 {
				break
			}
			switch x := cur.(type) {
			case map[string]any:
				if len(x) == 0 {
					break walk
				}
				keys := make([]string, 0, len(x))
				for k := range x {
					keys = append(keys, k)
				}
				slices.Sort(keys)
				k := keys[int(b/4)%len(keys)]
				path, cur = append(path, k), x[k]
			case []any:
				if len(x) == 0 {
					break walk
				}
				i := int(b/4) % len(x)
				path, cur = append(path, i), x[i]
			default:
				break walk
			}
		}
		if len(ops) == 0 {
			break
		}
		op := ops[0]
		ops = ops[1:]
		set := func(v any) { tree = edit(tree, path, func(any) (any, bool) { return v, true }) }
		switch op % 16 {
		case 0:
			set(nil)
		case 1: // drop
			tree = edit(tree, path, func(any) (any, bool) { return nil, false })
		case 2:
			set(1)
		case 3:
			set("")
		case 4:
			set(strings.Repeat("x", 70000))
		case 5:
			set(-1)
		case 6:
			set(math.MaxFloat64)
		case 7: // a huge array of it (once: arrays of arrays grow past any memory)
			if inflated {
				break
			}
			inflated = true
			l := make([]any, 500)
			for i := range l {
				l[i] = cur
			}
			set(l)
		case 8: // deep sections
			v := cur
			for i := range 40 {
				v = map[string]any{"key": fmt.Sprintf("deep-%d", i), "section": map[string]any{"children": []any{v}}}
			}
			set(v)
		case 9: // an unknown kind
			set(map[string]any{"key": "zz", "bogus": map[string]any{"a": 1}})
		case 10: // a copy of it beside it in its array (duplicate keys)
			if len(path) > 0 {
				if _, ok := path[len(path)-1].(int); ok {
					tree = edit(tree, path[:len(path)-1], func(p any) (any, bool) {
						l, _ := p.([]any)
						return append(l, copyJSON(cur)), true
					})
				}
			}
		case 11:
			set(true)
		case 12:
			set("\u0000\u2028é\U0001F600<script>")
		case 13:
			set(1.5)
		case 14: // a duplicate key in the encoded object
			if m, ok := cur.(map[string]any); ok && dup == "" {
				for k := range m {
					m["__dup__"] = map[string]any{"text": map[string]any{"content": "dup"}}
					dup = k
					break
				}
			}
		case 15: // a number JSON can write but Go cannot hold
			set("__inf__")
		}
	}
	b, err := json.Marshal(tree)
	if err != nil {
		return []byte(`{}`)
	}
	if dup != "" {
		b = bytes.Replace(b, []byte(`"__dup__":`), []byte(fmt.Sprintf("%q:", dup)), 1)
	}
	return bytes.ReplaceAll(b, []byte(`"__inf__"`), []byte(`1e999`))
}

// edit applies fn to the value at path in node (map keys and list indexes); fn returns
// the new value, or false to drop it.
func edit(node any, path []any, fn func(any) (any, bool)) any {
	if len(path) == 0 {
		v, keep := fn(node)
		if !keep {
			return nil
		}
		return v
	}
	switch x := node.(type) {
	case map[string]any:
		k := path[0].(string)
		if len(path) == 1 {
			if v, keep := fn(x[k]); keep {
				x[k] = v
			} else {
				delete(x, k)
			}
			return x
		}
		x[k] = edit(x[k], path[1:], fn)
		return x
	case []any:
		i := path[0].(int)
		if len(path) == 1 {
			if v, keep := fn(x[i]); keep {
				x[i] = v
				return x
			}
			return append(x[:i:i], x[i+1:]...)
		}
		x[i] = edit(x[i], path[1:], fn)
		return x
	}
	return node
}

func copyJSON(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// FuzzPredicate compiles random when clauses and evaluates them over facts drawn from
// the fuzz input: no panic, bounded compile time, and three-valued logic that agrees
// with itself (!p is not p; p && p and p || p are p).
func FuzzPredicate(f *testing.F) {
	for _, s := range []string{
		"thread && !project", "thread.status == 'busy' || pr.checks.provider in ['github-actions']",
		"pr.checks.name =~ /^(a+)+$/", "jenkins.tags in [1, true, \"x\"]", "((((thread))))",
		"view != null", "!!!!thread", "jenkins.x =~ /é\\/ü/", "x.y == -1.5",
	} {
		f.Add(s, []byte{1, 2, 3})
	}
	f.Fuzz(func(t *testing.T, src string, facts []byte) {
		start := time.Now()
		p, err := CompilePredicate(src)
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("compile took %s", d)
		}
		if err != nil {
			return
		}
		lookup := fuzzFacts(facts)
		got := p.eval(lookup)
		if got != triTrue && got != triFalse && got != triUnknown {
			t.Fatalf("eval = %d", got)
		}
		if len(src) > MaxPredicate-20 {
			return
		}
		for _, tt := range []struct {
			src  string
			want tri
		}{
			{"!(" + src + ")", got.not()},
			{"(" + src + ") && (" + src + ")", got},
			{"(" + src + ") || (" + src + ")", got},
		} {
			q, err := CompilePredicate(tt.src)
			if err != nil {
				continue // nested one level too deep
			}
			if g := q.eval(lookup); g != tt.want {
				t.Fatalf("%s = %s, want %s", tt.src, g, tt.want)
			}
		}
	})
}

// fuzzFacts is a lookup whose answers come from b: each fact name hashes to a byte that
// picks a kind and a value.
func fuzzFacts(b []byte) func(string) value {
	return func(name string) value {
		if len(b) == 0 {
			return nullValue
		}
		h := 0
		for _, c := range []byte(name) {
			h = h*31 + int(c)
		}
		x := b[(h&0x7fffffff)%len(b)]
		switch x % 6 {
		case 0:
			return nullValue
		case 1:
			return unknownValue
		case 2:
			return boolValue(x&8 != 0)
		case 3:
			return stringValue(strings.Repeat("a", int(x/6)) + "b")
		case 4:
			return numberValue(float64(x) - 128)
		}
		return stringsValue([]string{"github-actions", strings.Repeat("a", int(x/6))})
	}
}

// FuzzActValues sends random values with every acting element of the form demo: no
// panic, unknown names refused, and what is sent has its control's type.
func FuzzActValues(f *testing.F) {
	f.Add(uint8(0), []byte(`{"name":"Ada","token":"s3cret"}`))
	f.Add(uint8(1), []byte(`{"tags":["a","b"],"fail":"true"}`))
	f.Add(uint8(2), []byte(`{"tags":"a,b","fail":1,"project":null}`))
	f.Add(uint8(3), []byte(`{"name":{"x":1}}`))
	f.Fuzz(func(t *testing.T, pick uint8, values []byte) {
		v, _, errs := validateView(json.RawMessage(every), "p", fuzzPerms)
		if len(errs) > 0 {
			t.Fatal(errs)
		}
		idx := buildIndex(v)
		el := idx.elements[idx.order[int(pick)%len(idx.order)]]
		var in map[string]any
		if json.Unmarshal(values, &in) != nil {
			return
		}
		out, stores, err := idx.values(el, in)
		if err != nil {
			return
		}
		for name, val := range out {
			f := slices.IndexFunc(idx.fields, func(f fieldInfo) bool { return f.name == name })
			if f < 0 {
				t.Fatalf("sent %q, not a field", name)
			}
			switch idx.fields[f].control {
			case "toggle":
				if _, ok := val.(bool); !ok {
					t.Fatalf("toggle %s = %T", name, val)
				}
			case "multiselect":
				if _, ok := val.([]string); !ok {
					t.Fatalf("multiselect %s = %T", name, val)
				}
			default:
				if s, ok := val.(string); !ok || !utf8.ValidString(s) {
					t.Fatalf("%s %s = %T", idx.fields[f].control, name, val)
				}
			}
			if idx.fields[f].control == "secret" && el.kind != pluginsdk.ActSubmit {
				t.Fatalf("a secret went with a %s", el.kind)
			}
		}
		for name, key := range stores {
			if !secretKeyPattern.MatchString(key) {
				t.Fatalf("field %s stores under %q, which the secret store refuses", name, key)
			}
		}
	})
}

// FuzzValidateEnvironment checks session/setEnvironment's (and thread/create's and
// terminal/create's env) rules hold for anything pushed.
func FuzzValidateEnvironment(f *testing.F) {
	f.Add([]byte(`{"env":{"A":"1","PATH":"x","CODE_FOUNDRY_X":"y","1BAD":"z"},"pathPrepend":["~/bin","/etc","rel"],"addDirs":["~"],"scope":{"projects":["p"," p ",""]}}`))
	f.Add([]byte(`{"env":{"A":"a\u0000b"},"pathPrepend":["~/a:b","~/../.."]}`))
	home := f.TempDir()
	f.Fuzz(func(t *testing.T, data []byte) {
		var in pluginsdk.Environment
		if json.Unmarshal(data, &in) != nil {
			return
		}
		e, issues := validateEnvironment("p", in, home)
		if len(issues) > maxEnvIssues+1 {
			t.Fatalf("%d issues", len(issues))
		}
		if len(e.Env) > maxEnvKeys {
			t.Fatalf("%d env keys", len(e.Env))
		}
		for k, v := range e.Env {
			if reservedEnvKey(k) || !envKeyPattern.MatchString(k) || len(v) > MaxEnvValue || strings.ContainsRune(v, 0) {
				t.Fatalf("env %q=%q passed", k, v)
			}
		}
		for _, list := range [][]string{e.PathPrepend, e.AddDirs} {
			if len(list) > maxEnvDirs {
				t.Fatalf("%d dirs", len(list))
			}
			for _, d := range list {
				if !filepath.IsAbs(d) || strings.ContainsAny(d, ":\x00\n") || !strings.HasPrefix(d+"/", home+"/") {
					t.Fatalf("dir %q passed", d)
				}
			}
		}
		if len(e.Projects) > maxScopeEntries {
			t.Fatalf("%d projects", len(e.Projects))
		}
	})
}

// FuzzManifestCommands checks that a manifest pluginsdk's Validate accepts registers:
// its commands and show commands are valid registry commands (a refusal there leaves
// every command of the plugin unregistered).
func FuzzManifestCommands(f *testing.F) {
	for _, p := range []string{"../../../plugins/examples/hello/plugin.json", "../../../plugins/examples/minimal/plugin.json", "testdata/pyecho/plugin.json"} {
		if b, err := os.ReadFile(filepath.FromSlash(p)); err == nil {
			f.Add(b)
		}
	}
	f.Add([]byte(`{"name":"x","version":"1.0.0","protocol":1,"exec":["a"],"commands":[{"name":"n","title":"N","args":[{"name":"count","type":"int","default":"many"}]}]}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		mf, _, err := pluginsdk.LoadManifest(data)
		if err != nil {
			return
		}
		m := &Manager{}
		reg := command.NewRegistry()
		if err := m.replaceCommands(reg, mf.Name, m.commandsFor(mf.Name, mf)); err != nil {
			t.Fatalf("a valid manifest's commands do not register: %v", err)
		}
	})
}
