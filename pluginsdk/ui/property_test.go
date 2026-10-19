package ui_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// TestGeneratedViews runs Validate over many generated views (viewgen_test.go) and checks
// properties every view must have:
//
//   - Validate never panics;
//   - every problem's path (and the path a duplicate names) exists in the view;
//   - the "N elements" problem appears exactly when an independent count of the
//     view's elements is over MaxElements, with that count;
//   - an accepted view round-trips through JSON (decodes, validates, re-encodes byte for
//     byte) and its nodes are all reached by NodeLists and Children.
func TestGeneratedViews(t *testing.T) {
	n := 20000
	if testing.Short() {
		n = 2000
	}
	accepted, kinds, deepest := 0, map[string]int{}, 0
	for seed := range uint64(n) {
		if checkGenerated(t, seed) {
			accepted++
			v := genView(seed)
			for _, l := range v.NodeLists() {
				countKinds(l, 0, kinds, &deepest)
			}
		}
		if t.Failed() {
			t.Fatalf("seed %d", seed)
		}
	}
	t.Logf("%d of %d generated views accepted; deepest node inside %d containers; kinds in accepted views: %v", accepted, n, deepest, kinds)
	for _, k := range []string{"columns", "pane", "grid", "group", "container", "masterDetail", "tabs", "divider", "spacer"} {
		if kinds[k] == 0 {
			t.Errorf("no accepted view has a %s node", k)
		}
	}
	if accepted < n/50 {
		t.Errorf("only %d of %d generated views are valid: the generator is too hostile to test acceptance", accepted, n)
	}
}

// FuzzGeneratedView explores generator seeds.
func FuzzGeneratedView(f *testing.F) {
	for _, s := range []uint64{0, 1, 2, 42, 1 << 40} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, seed uint64) { checkGenerated(t, seed) })
}

func checkGenerated(t *testing.T, seed uint64) bool {
	t.Helper()
	v := genView(seed)
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("seed %d: Validate panicked: %v", seed, r)
			}
		}()
		err = v.Validate()
	}()
	msgs := problems(err)
	for _, m := range msgs {
		for _, p := range pathsIn(m) {
			if !pathExists(v, p) {
				b, _ := json.Marshal(v)
				t.Errorf("seed %d: the problem %q names %q, which is not in the view\n%s", seed, m, p, b)
			}
		}
	}
	want := elementsOf(v)
	got := -1
	for _, m := range msgs {
		if sm := elementsRe.FindStringSubmatch(m); sm != nil {
			got, _ = strconv.Atoi(sm[1])
		}
	}
	truncated := len(msgs) > ui.MaxProblems // the view-wide problems come last and are only counted then
	switch {
	case truncated:
	case want > ui.MaxElements && got != want:
		t.Errorf("seed %d: %d elements by the count, Validate says %d (-1: nothing)", seed, want, got)
	case want <= ui.MaxElements && got != -1:
		t.Errorf("seed %d: %d elements by the count, Validate says %d over", seed, want, got)
	}
	if err != nil {
		return false
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("seed %d: a valid view does not encode: %v", seed, err)
	}
	var back ui.View
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("seed %d: a valid view does not decode: %v\n%s", seed, err, b)
	}
	if err := back.Validate(); err != nil {
		t.Fatalf("seed %d: a valid view is refused after a JSON round trip: %v\n%s", seed, err, b)
	}
	b2, _ := json.Marshal(back)
	if !bytes.Equal(b, b2) {
		t.Fatalf("seed %d: the round trip is not byte-stable:\n%s\n%s", seed, b, b2)
	}
	walked, reflected := walkedKeys(back), reflectedKeys(reflect.ValueOf(back))
	if !slicesEqualSorted(walked, reflected) {
		t.Fatalf("seed %d: NodeLists+Children reach %d nodes %v, the view has %d %v\n%s", seed, len(walked), walked, len(reflected), reflected, b)
	}
	return true
}

var elementsRe = regexp.MustCompile(`^view: (\d+) elements, at most`)

func problems(err error) []string {
	if err == nil {
		return nil
	}
	var j interface{ Unwrap() []error }
	if errors.As(err, &j) {
		var out []string
		for _, e := range j.Unwrap() {
			out = append(out, e.Error())
		}
		return out
	}
	return []string{err.Error()}
}

var (
	dupUsedRe = regexp.MustCompile(`is already used by (\S+)$`)
	dupNameRe = regexp.MustCompile(`is already the name of (\S+) in this form$`)
)

// pathsIn returns the paths a problem names: its own (before ": ") and the first use a
// duplicate names.
func pathsIn(msg string) []string {
	path, _, _ := strings.Cut(msg, ": ")
	out := []string{path}
	if m := dupUsedRe.FindStringSubmatch(msg); m != nil {
		out = append(out, m[1])
	}
	if m := dupNameRe.FindStringSubmatch(msg); m != nil {
		out = append(out, m[1])
	}
	return out
}

var segRe = regexp.MustCompile(`^([A-Za-z0-9_-]*)((?:\[\d+\])*)$`)
var idxRe = regexp.MustCompile(`\[(\d+)\]`)

// pathExists resolves a problem path ("nodes[2].form.fields[0].key", "view") against v by
// JSON field names, slice indexes and map keys.
func pathExists(v ui.View, path string) bool {
	if path == "view" {
		return true
	}
	cur := reflect.ValueOf(v)
	for _, seg := range strings.Split(path, ".") {
		m := segRe.FindStringSubmatch(seg)
		if m == nil {
			return false
		}
		next, ok := child(cur, m[1])
		if !ok {
			return false
		}
		cur = next
		for _, im := range idxRe.FindAllStringSubmatch(m[2], -1) {
			i, _ := strconv.Atoi(im[1])
			for cur.Kind() == reflect.Pointer {
				if cur.IsNil() {
					return false
				}
				cur = cur.Elem()
			}
			if cur.Kind() != reflect.Slice || i >= cur.Len() {
				return false
			}
			cur = cur.Index(i)
		}
	}
	return true
}

// child is the field of struct (or the map's entry) named by its JSON name.
func child(v reflect.Value, name string) (reflect.Value, bool) {
	for v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return reflect.Value{}, false
		}
		v = v.Elem()
	}
	switch v.Kind() {
	case reflect.Map:
		e := v.MapIndex(reflect.ValueOf(name))
		return e, e.IsValid()
	case reflect.Struct:
		t := v.Type()
		for i := range t.NumField() {
			f := t.Field(i)
			tag, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if f.Anonymous && tag == "" {
				if c, ok := child(v.Field(i), name); ok {
					return c, true
				}
				continue
			}
			if tag == "" {
				tag = strings.ToLower(f.Name)
			}
			if tag == name {
				return v.Field(i), true
			}
		}
	}
	return reflect.Value{}, false
}

// elementsOf counts a view's elements as the notes and the GUI describe them: nodes
// (strip nodes and group items too), columns, grid items, rows (a list's and a
// master-detail's), chips, pairs, fields, options, buttons, tabs (the view's and a tabs
// node's). Like Validate it does not look inside a node that has not exactly one kind, a
// group item of a kind a group does not hold, a field without exactly one control or a
// fieldset inside a fieldset.
func elementsOf(v ui.View) int {
	n := 0
	if v.Header != nil {
		n += len(v.Header.Actions)
	}
	if v.Tabs != nil {
		n += len(v.Tabs.Items)
	}
	for _, l := range v.NodeLists() {
		for _, x := range l {
			n += nodeElements(x)
		}
	}
	return n
}

func kindsOf(n ui.Node) []string {
	var out []string
	rv := reflect.ValueOf(n)
	for i := range rv.NumField() {
		if f := rv.Field(i); f.Kind() == reflect.Pointer && !f.IsNil() {
			name, _, _ := strings.Cut(rv.Type().Field(i).Tag.Get("json"), ",")
			out = append(out, name)
		}
	}
	return out
}

func rowsElements(rs []ui.Row) int {
	n := 0
	for _, r := range rs {
		n += 1 + len(r.Actions)
	}
	return n
}

func nodesElements(ns []ui.Node) int {
	n := 0
	for _, x := range ns {
		n += nodeElements(x)
	}
	return n
}

func nodeElements(x ui.Node) int {
	n := 1
	if len(kindsOf(x)) != 1 {
		return n
	}
	switch {
	case x.Pairs != nil:
		n += len(x.Pairs.Items)
	case x.List != nil:
		n += rowsElements(x.List.Rows)
	case x.Chips != nil:
		n += len(x.Chips.Chips)
	case x.Actions != nil:
		n += len(x.Actions.Buttons)
	case x.Notice != nil:
		n += len(x.Notice.Actions)
	case x.Empty != nil:
		n += len(x.Empty.Actions)
	case x.Section != nil:
		n += len(x.Section.Actions) + nodesElements(x.Section.Children)
	case x.Form != nil:
		for _, f := range x.Form.Fields {
			n += fieldElements(f, false)
		}
		if x.Form.Submit != nil {
			n++
		}
		n += len(x.Form.Secondary)
	case x.Terminal != nil:
		n += len(x.Terminal.Actions)
	case x.Columns != nil:
		for _, c := range x.Columns.Items {
			n += 1 + nodesElements(c.Children)
		}
	case x.Pane != nil:
		n += nodesElements(x.Pane.Children)
	case x.Container != nil:
		n += nodesElements(x.Container.Children)
	case x.Grid != nil:
		for _, it := range x.Grid.Items {
			n += 1 + nodesElements(it.Children)
		}
	case x.Group != nil:
		for _, it := range x.Group.Items {
			switch k := kindsOf(it); {
			case len(k) == 1 && !strings.Contains(" text chips actions progress ", " "+k[0]+" "):
				n++ // refused: its key counts, nothing inside
			default:
				n += nodeElements(it)
			}
		}
	case x.MasterDetail != nil:
		n += rowsElements(x.MasterDetail.List.Rows)
		if x.MasterDetail.EmptyDetail != nil {
			n += len(x.MasterDetail.EmptyDetail.Actions)
		}
		n += nodesElements(x.MasterDetail.Detail)
	case x.Tabs != nil:
		n += len(x.Tabs.Items) + nodesElements(x.Tabs.Children)
	}
	return n
}

func fieldElements(f ui.Field, inFieldset bool) int {
	n := 1
	controls := 0
	for _, set := range []bool{f.Input != nil, f.Select != nil, f.Toggle != nil, f.Fieldset != nil} {
		if set {
			controls++
		}
	}
	if controls != 1 {
		return n
	}
	switch {
	case f.Fieldset != nil:
		if inFieldset {
			return n
		}
		for _, sub := range f.Fieldset.Fields {
			n += fieldElements(sub, true)
		}
	case f.Select != nil:
		n += len(f.Select.Options)
	}
	return n
}

// walkedKeys lists the keys of every node NodeLists and Children reach (sorted).
func walkedKeys(v ui.View) []string {
	var out []string
	var walk func(ns []ui.Node)
	walk = func(ns []ui.Node) {
		for _, n := range ns {
			out = append(out, n.Key)
			for _, c := range n.Children() {
				walk(c)
			}
		}
	}
	for _, l := range v.NodeLists() {
		walk(l)
	}
	return sortStrings(out)
}

var nodeType = reflect.TypeFor[ui.Node]()

// reflectedKeys lists the keys of every ui.Node anywhere in v (sorted).
func reflectedKeys(v reflect.Value) []string {
	var out []string
	var walk func(v reflect.Value)
	walk = func(v reflect.Value) {
		switch v.Kind() {
		case reflect.Pointer, reflect.Interface:
			if !v.IsNil() {
				walk(v.Elem())
			}
		case reflect.Struct:
			if v.Type() == nodeType {
				out = append(out, v.FieldByName("Key").String())
			}
			for i := range v.NumField() {
				if v.Type().Field(i).IsExported() {
					walk(v.Field(i))
				}
			}
		case reflect.Slice, reflect.Array:
			for i := range v.Len() {
				walk(v.Index(i))
			}
		case reflect.Map:
			it := v.MapRange()
			for it.Next() {
				walk(it.Value())
			}
		}
	}
	walk(v)
	return sortStrings(out)
}

func sortStrings(s []string) []string {
	out := append([]string(nil), s...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func slicesEqualSorted(a, b []string) bool { return fmt.Sprint(a) == fmt.Sprint(b) }

// countKinds tallies the kinds of nodes and the deepest container nesting.
func countKinds(ns []ui.Node, depth int, kinds map[string]int, deepest *int) {
	for _, n := range ns {
		for _, k := range kindsOf(n) {
			kinds[k]++
		}
		*deepest = max(*deepest, depth)
		inner := depth + 1
		if n.Group != nil {
			inner = depth
		}
		for _, c := range n.Children() {
			countKinds(c, inner, kinds, deepest)
		}
	}
}
