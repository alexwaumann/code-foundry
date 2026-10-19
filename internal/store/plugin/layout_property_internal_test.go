package plugin

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// TestGeneratedViewsInTheDaemon runs the generator's views (viewgen_test.go, shared with
// pluginsdk/ui) through the daemon: checkView (the daemon and the SDK agree, the canonical
// form is stable and has no null lists, appends reach every log), plus: no list the GUI
// iterates is null (detail included), and the action index holds exactly the acting
// elements the docs describe, each with the act kind and node the plugin will get.
func TestGeneratedViewsInTheDaemon(t *testing.T) {
	n := 5000
	if testing.Short() {
		n = 500
	}
	accepted := 0
	for seed := range uint64(n) {
		if checkGeneratedInDaemon(t, seed) {
			accepted++
		}
		if t.Failed() {
			t.Fatalf("seed %d", seed)
		}
	}
	t.Logf("%d of %d accepted", accepted, n)
}

func FuzzGeneratedViewInTheDaemon(f *testing.F) {
	for _, s := range []uint64{0, 1, 7, 99} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, seed uint64) { checkGeneratedInDaemon(t, seed) })
}

func checkGeneratedInDaemon(t *testing.T, seed uint64) bool {
	t.Helper()
	gv := genView(seed)
	raw, err := json.Marshal(gv)
	if err != nil {
		return false
	}
	checkView(t, raw)
	v, canon, errs := validateView(raw, "p", fuzzPerms)
	if len(errs) > 0 {
		return false
	}
	if p := nullListOf(canon, append(slices.Clone(requiredLists), "detail")); p != "" {
		t.Fatalf("seed %d: null %s in the canonical form\n%s", seed, p, canon)
	}
	idx := buildIndex(v)
	want := expectedElements(v)
	var got []string
	for _, k := range idx.order {
		el := idx.elements[k]
		got = append(got, fmt.Sprintf("%s %s %s", k, el.kind, el.node))
		if (el.kind == pluginsdk.ActTab || el.kind == pluginsdk.ActSelect) != (el.action == nil) {
			t.Errorf("seed %d: %s is a %s with action %v", seed, k, el.kind, el.action)
		}
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("seed %d: the index has\n%q\nthe view's acting elements are\n%q\n%s", seed, got, want, canon)
	}
	return true
}

// nullListOf is nullList with its own list of required keys.
func nullListOf(view []byte, required []string) string {
	var tree any
	if json.Unmarshal(view, &tree) != nil {
		return ""
	}
	var walk func(path string, v any) string
	walk = func(path string, v any) string {
		switch x := v.(type) {
		case map[string]any:
			for k, c := range x {
				if c == nil && slices.Contains(required, k) {
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

// expectedElements lists "key kind node" for every acting element of a valid view,
// found by reflection (not by the host's walk): every button, row and chip with an
// action, a master-detail's rows without one (select, naming it), the view's tabs and a
// tabs node's (tab, naming it), and fields with a change event.
func expectedElements(v *ui.View) []string {
	var out []string
	kind := func(a *ui.Action, event string) string {
		switch {
		case a.Event != "":
			return event
		case a.Command != nil:
			return "command"
		case a.OpenURL != "":
			return "open_url"
		}
		return "copy"
	}
	add := func(key, k, node string) { out = append(out, fmt.Sprintf("%s %s %s", key, k, node)) }
	var walk func(rv reflect.Value, owner string, submit bool)
	walk = func(rv reflect.Value, owner string, submit bool) {
		switch rv.Kind() {
		case reflect.Pointer:
			if !rv.IsNil() {
				walk(rv.Elem(), owner, submit)
			}
			return
		case reflect.Slice:
			for i := range rv.Len() {
				walk(rv.Index(i), owner, submit)
			}
			return
		case reflect.Struct:
		default:
			return
		}
		switch x := rv.Interface().(type) {
		case ui.Button:
			if x.Action != nil {
				ev := pluginsdk.ActClick
				if submit {
					ev = pluginsdk.ActSubmit
				}
				add(x.Key, kind(x.Action, ev), "")
			}
			return
		case ui.Chip:
			if x.Action != nil {
				add(x.Key, kind(x.Action, pluginsdk.ActClick), "")
			}
			return
		case ui.Row:
			switch {
			case x.Action != nil:
				add(x.Key, kind(x.Action, pluginsdk.ActClick), "")
			case owner != "":
				add(x.Key, pluginsdk.ActSelect, owner)
			}
			walk(reflect.ValueOf(x.Actions), "", false)
			return
		case ui.Field:
			// A fieldset's change is accepted by Validate but never acts (sdk.md: a
			// fieldset with change).
			if x.Change != nil && x.Change.Event != "" && x.Fieldset == nil {
				add(x.Key, pluginsdk.ActChange, "")
			}
			if x.Fieldset != nil {
				walk(reflect.ValueOf(x.Fieldset.Fields), "", false)
			}
			return
		case ui.Tabs:
			for _, tb := range x.Items {
				add(tb.Key, pluginsdk.ActTab, owner)
			}
			return
		case ui.Form:
			walk(reflect.ValueOf(x.Fields), "", false)
			walk(reflect.ValueOf(x.Submit), "", true)
			walk(reflect.ValueOf(x.Secondary), "", false)
			return
		case ui.Node:
			switch {
			case x.MasterDetail != nil:
				walk(reflect.ValueOf(x.MasterDetail.List.Rows), x.Key, false)
				walk(reflect.ValueOf(x.MasterDetail.EmptyDetail), "", false)
				walk(reflect.ValueOf(x.MasterDetail.Detail), "", false)
				return
			case x.Tabs != nil:
				walk(reflect.ValueOf(x.Tabs.Tabs), x.Key, false)
				walk(reflect.ValueOf(x.Tabs.Children), "", false)
				return
			}
		}
		for i := range rv.NumField() {
			if rv.Type().Field(i).IsExported() {
				walk(rv.Field(i), "", false)
			}
		}
	}
	walk(reflect.ValueOf(*v), "", false)
	return out
}

// The every view's acting elements as the reflection finds them match the index (a
// smoke test of expectedElements itself).
func TestExpectedElementsOnEvery(t *testing.T) {
	v, _, errs := validateView(json.RawMessage(every), "p", everyPerms)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	idx := buildIndex(v)
	if got, want := len(idx.order), len(expectedElements(v)); got != want || got == 0 {
		t.Fatalf("index %d elements, reflection %d", got, want)
	}
	if !strings.Contains(strings.Join(expectedElements(v), "\n"), " select ") {
		t.Error("the every view has no select element")
	}
}
