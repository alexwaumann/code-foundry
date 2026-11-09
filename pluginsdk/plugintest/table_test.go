package plugintest_test

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// sorter is a surface with one table of builds that it sorts by number on a sort act.
type sorter struct {
	h    *pluginsdk.Host
	inst string
	mu   sync.Mutex
	sort ui.TableSort
	acts []pluginsdk.SurfaceAct
}

func (s *sorter) view() ui.View {
	s.mu.Lock()
	defer s.mu.Unlock()
	nums := []string{"b-2", "b-3", "b-1"}
	if s.sort.Column == "num" {
		slices.Sort(nums)
		if s.sort.Dir == ui.SortDesc {
			slices.Reverse(nums)
		}
	}
	rows := make([]ui.TableRow, len(nums))
	for i, k := range nums {
		rows[i] = ui.NewTableRow(k, map[string]ui.Cell{"num": ui.TextCell("#" + strings.TrimPrefix(k, "b-"))})
	}
	t := ui.NewTable("builds", []ui.TableColumn{ui.TableCol("num", "#").AsSortable(ui.SortDesc), ui.TableCol("branch", "Branch")}, rows...)
	if s.sort.Column != "" {
		st := s.sort
		t.Table.Sort = &st
	}
	return ui.View{Nodes: []ui.Node{ui.NewSection("sec", "Builds", t)}}
}

func (s *sorter) Act(_ context.Context, a pluginsdk.SurfaceAct) error {
	s.mu.Lock()
	s.acts = append(s.acts, a)
	if a.Kind == pluginsdk.ActSort {
		s.sort = ui.TableSort{Column: a.Key, Dir: ui.SortAsc}
		if a.Descending() {
			s.sort.Dir = ui.SortDesc
		}
	}
	s.mu.Unlock()
	return s.h.UpdateView(s.inst, s.view())
}
func (*sorter) Visibility(bool)             {}
func (*sorter) Close(pluginsdk.CloseReason) {}

// Sort sends the sort act the GUI sends for a header click: the column's key, the table
// as the node, the direction asked for (the column's first, then the other one), and
// refuses a column that is not sortable or not there; TableRows reads the rows' order.
func TestSort(t *testing.T) {
	s := &sorter{}
	p := pluginsdk.Plugin{Surfaces: map[string]pluginsdk.SurfaceFactory{
		"s": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
			s.h, s.inst = h, open.Instance
			return s, h.UpdateView(open.Instance, s.view())
		},
	}}
	h := plugintest.Start(t, p, plugintest.Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.OpenSurface(ctx, "i", "s", pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { _, ok := h.View("i"); return ok })
	order := func() string {
		keys, ok := h.TableRows("i", "builds")
		if !ok {
			t.Fatal("no table builds")
		}
		return strings.Join(keys, ",")
	}
	if got := order(); got != "b-2,b-3,b-1" {
		t.Fatalf("unsorted: %s", got)
	}
	for _, c := range []struct {
		dir  ui.SortDir
		want string
	}{
		{"", "b-3,b-2,b-1"},          // the column's first direction: descending
		{"", "b-1,b-2,b-3"},          // the other one
		{ui.SortAsc, "b-1,b-2,b-3"},  // asked for
		{ui.SortDesc, "b-3,b-2,b-1"}, // asked for
	} {
		v := h.Version("i")
		if err := h.Sort(ctx, "i", "num", c.dir); err != nil {
			t.Fatal(err)
		}
		h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { return h.Version("i") > v })
		if got := order(); got != c.want {
			t.Errorf("sort %q: %s, want %s", c.dir, got, c.want)
		}
	}
	s.mu.Lock()
	first := s.acts[0]
	s.mu.Unlock()
	if first.Kind != pluginsdk.ActSort || first.Action != "sort" || first.Key != "num" || first.Node != "builds" || first.Value != "desc" || first.Data != "" || first.Values != nil {
		t.Errorf("the sort act: %+v", first)
	}
	for _, c := range []struct {
		column string
		dir    ui.SortDir
		want   string
	}{
		{"branch", "", `column "branch" of table "builds" is not sortable`},
		{"nope", "", `no table column "nope"`},
		{"num", "up", `a sort is asc or desc, not "up"`},
	} {
		if err := h.Sort(ctx, "i", c.column, c.dir); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s %q: %v, want %q", c.column, c.dir, err, c.want)
		}
	}
	if _, ok := h.TableRows("i", "sec"); ok {
		t.Error("TableRows of a section")
	}
}
