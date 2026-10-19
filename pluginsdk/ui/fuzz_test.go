package ui

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// FuzzView checks Validate against what the host does with a view: a view Validate
// accepts encodes, the host decodes it into a view Validate accepts too (the SDK and
// the daemon agree), and the host's re-encoding is byte-stable. corrupt adds invalid
// UTF-8 to string fields (a Go plugin can build such strings; JSON cannot carry them).
func FuzzView(f *testing.F) {
	for _, seed := range viewSeeds() {
		f.Add(seed.view, seed.corrupt)
	}
	f.Fuzz(func(t *testing.T, data, corrupt []byte) {
		var v View
		if json.Unmarshal(data, &v) != nil {
			return
		}
		if len(corrupt) > 0 {
			i := 0
			corruptStrings(reflect.ValueOf(&v).Elem(), corrupt, &i)
		}
		if v.Validate() != nil {
			return
		}
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("a valid view does not encode: %v", err)
		}
		var host View
		if err := json.Unmarshal(b, &host); err != nil {
			t.Fatalf("the host cannot decode a valid view: %v\n%s", err, b)
		}
		if err := host.Validate(); err != nil {
			t.Fatalf("the host refuses a view the SDK accepts: %v\n%s", err, b)
		}
		canon, _ := json.Marshal(host)
		var again View
		if err := json.Unmarshal(canon, &again); err != nil {
			t.Fatal(err)
		}
		canon2, _ := json.Marshal(again)
		if !bytes.Equal(canon, canon2) {
			t.Fatalf("the host's encoding is not stable:\n%s\n%s", canon, canon2)
		}
	})
}

// layoutSeed nests every container (section, columns, pane, container) to the depth
// limit, with a fill pane, a fixed and a weighted column, live nodes in a pane, a narrow
// container, and a toolbar and footer of every strip kind.
const layoutSeed = `{"toolbar":[
  {"key":"tb-q","form":{"fields":[{"key":"tb-qf","name":"q","input":{"placeholder":"Filter"}},
    {"key":"tb-sel","name":"s","select":{"options":[{"key":"tb-o1","value":"a","label":"A"}]}},
    {"key":"tb-tg","name":"t","label":"Mine","toggle":{"value":true}}],
    "submit":{"key":"tb-go","label":"Filter","icon":"search","iconOnly":true,"action":{"event":"filter"}}}},
  {"key":"tb-dv","divider":{}},
  {"key":"tb-sp","spacer":{"size":8,"flex":true}},
  {"key":"tb-ch","chips":{"chips":[{"key":"tb-c1","label":"All","selected":true,"action":{"event":"status","data":"all"}}]}}],
 "footer":[
  {"key":"ft-t","text":{"content":"3 runs","size":"sm"}},
  {"key":"ft-p","progress":{"label":"Syncing"}},
  {"key":"ft-g","group":{"align":"end","items":[{"key":"ft-a","actions":{"buttons":[{"key":"ft-b","label":"Run","action":{"event":"run"}}]}}]}}],
 "nodes":[{"key":"s","section":{"title":"S","children":[
  {"key":"cols","columns":{"collapse":"first","items":[
    {"key":"c1","weight":2,"children":[{"key":"p1","pane":{"height":"fill","minHeight":200,"children":[
      {"key":"s2","section":{"children":[{"key":"deep","text":{"content":"x"}}]}},
      {"key":"lg","log":{"text":"a\nb\n"}}]}}]},
    {"key":"c2","width":320,"children":[{"key":"p2","pane":{"height":480,"noScroll":true,"children":[
      {"key":"th","thread":{"threadId":"s-1","height":"fill"}}]}}]},
    {"key":"c3","children":[{"key":"md","markdown":{"source":"**m**"}}]}]}}]}},
 {"key":"ct","container":{"width":"narrow","children":[{"key":"ct-t","text":{"content":"centred"}}]}}]}`

// gridSeed has a grid nested to the depth limit (with a span and a min width), a group of
// every kind it holds at that depth, labelled and bare dividers, and fixed and flex
// spacers in a box and outside one.
const gridSeed = `{"nodes":[{"key":"g","grid":{"minWidth":200,"items":[
  {"key":"g1","span":2,"children":[{"key":"s","section":{"card":true,"title":"Card","children":[
    {"key":"p","pane":{"height":240,"children":[
      {"key":"cols","columns":{"items":[{"key":"c1","children":[
        {"key":"grp","group":{"align":"between","noWrap":true,"items":[
          {"key":"gt","text":{"content":"3 checks"}},
          {"key":"gc","chips":{"chips":[{"key":"gc1","label":"Build","status":"ok"}]}},
          {"key":"ga","actions":{"buttons":[{"key":"gb","label":"Run","action":{"event":"run"}}]}},
          {"key":"gp","progress":{"value":0.5}}]}}]},
        {"key":"c2","children":[{"key":"sp-flex","spacer":{"flex":true}}]}]}},
      {"key":"sp-box","spacer":{"size":64,"flex":true}},
      {"key":"pa","actions":{"buttons":[{"key":"pb","label":"Go","action":{"event":"go"}}]}}]}}]}}]},
  {"key":"g2","children":[]}]}},
  {"key":"dv","divider":{"label":"Next"}},{"key":"dv2","divider":{}},
  {"key":"sp","spacer":{"size":4}},{"key":"sp0","spacer":{}}]}`

type viewSeed struct{ view, corrupt []byte }

// viewSeeds are FuzzView's seeds: the hello demo's captured views, the walkthrough, a log,
// a thread, and the layout and grid seeds.
func viewSeeds() []viewSeed {
	var out []viewSeed
	files, _ := filepath.Glob(filepath.FromSlash("../../internal/store/plugin/testdata/hello-demo/*.json"))
	for _, file := range files {
		if b, err := os.ReadFile(file); err == nil {
			out = append(out, viewSeed{b, []byte{}})
		}
	}
	return append(out,
		viewSeed{[]byte(jenkinsFailed), []byte{0, 0, 3}},
		viewSeed{[]byte(`{"nodes":[{"key":"l","log":{"text":"x"}}]}`), []byte{0, 1}},
		viewSeed{[]byte(`{"nodes":[{"key":"t","thread":{"threadId":"x","height":""}}]}`), []byte{}},
		viewSeed{[]byte(layoutSeed), []byte{0, 0, 0, 2}},
		viewSeed{[]byte(gridSeed), []byte{0, 0, 1}},
	)
}

// The fuzz seeds hold every node kind (and each seed that should validate does), so a new
// kind is fuzzed from the start.
func TestFuzzSeedsCoverEveryKind(t *testing.T) {
	seen := map[string]bool{}
	for _, seed := range viewSeeds() {
		var v View
		if err := json.Unmarshal(seed.view, &v); err != nil {
			t.Fatalf("seed does not decode: %v\n%s", err, seed.view)
		}
		if err := v.Validate(); err != nil {
			t.Errorf("seed does not validate: %v\n%.200s", err, seed.view)
		}
		var walk func(ns []Node)
		walk = func(ns []Node) {
			for _, n := range ns {
				seen[nodeKindOf(n)] = true
				for _, ch := range n.Children() {
					walk(ch)
				}
			}
		}
		for _, l := range v.NodeLists() {
			walk(l)
		}
		if len(v.Toolbar) > 0 {
			seen["toolbar"] = true
		}
		if len(v.Footer) > 0 {
			seen["footer"] = true
		}
	}
	for _, k := range append(nodeKinds(), "toolbar", "footer") {
		if !seen[k] {
			t.Errorf("no fuzz seed has a %s node", k)
		}
	}
}

// corruptStrings appends invalid UTF-8 to the string fields that corrupt picks: byte i
// (cycling) decides field i; its value is how many 0xff bytes (times 512) to add.
func corruptStrings(v reflect.Value, corrupt []byte, i *int) {
	switch v.Kind() {
	case reflect.Pointer:
		if !v.IsNil() {
			corruptStrings(v.Elem(), corrupt, i)
		}
	case reflect.Struct:
		for j := range v.NumField() {
			if v.Type().Field(j).IsExported() {
				corruptStrings(v.Field(j), corrupt, i)
			}
		}
	case reflect.Slice:
		for j := range v.Len() {
			corruptStrings(v.Index(j), corrupt, i)
		}
	case reflect.String:
		n := int(corrupt[*i%len(corrupt)])
		*i++
		if n > 0 && v.CanSet() {
			v.SetString(v.String() + strings.Repeat("\xff", n*512))
		}
	}
}
