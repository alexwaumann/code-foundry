package plugintest_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// people is a surface with a multiple picker of people: it answers a search with the
// people whose name holds the query, and keeps the picked ones in a Selected group.
type people struct {
	h        *pluginsdk.Host
	inst     string
	mu       sync.Mutex
	query    string
	picked   []string
	acts     []pluginsdk.SurfaceAct
	everyone map[string]string
}

func (p *people) view() ui.View {
	p.mu.Lock()
	defer p.mu.Unlock()
	var opts, results []ui.Option
	for _, id := range p.picked {
		opts = append(opts, ui.Opt("sel-"+id, id, p.everyone[id]).InGroup("Selected"))
	}
	for _, id := range []string{"ada", "alan", "grace"} {
		if p.query != "" && strings.Contains(strings.ToLower(p.everyone[id]), strings.ToLower(p.query)) {
			o := ui.Opt("match-"+id, id, p.everyone[id])
			if id == "alan" {
				o = o.AsDisabled()
			}
			results = append(results, o)
		}
	}
	f := ui.PickerField("who", "who", "Who", "people", opts...).AsMultiple().WithValues(p.picked...).WithChange("picked").WithResults(p.query, results...)
	return ui.View{Nodes: []ui.Node{ui.NewForm("f", nil, f, ui.TextField("note", "note", "Note").WithValue("n"))}}
}

func (p *people) Act(_ context.Context, a pluginsdk.SurfaceAct) error {
	p.mu.Lock()
	p.acts = append(p.acts, a)
	switch a.Kind {
	case pluginsdk.ActSearch:
		p.query = a.Query()
	case pluginsdk.ActChange:
		p.picked = nil
		for _, v := range a.Values["who"].([]any) {
			p.picked = append(p.picked, v.(string))
		}
	}
	p.mu.Unlock()
	return p.h.UpdateView(p.inst, p.view())
}
func (*people) Visibility(bool)             {}
func (*people) Close(pluginsdk.CloseReason) {}

func TestSearchAndPick(t *testing.T) {
	var surf *people
	p := pluginsdk.Plugin{Surfaces: map[string]pluginsdk.SurfaceFactory{
		"s": func(_ context.Context, h *pluginsdk.Host, open pluginsdk.SurfaceOpen) (pluginsdk.Surface, error) {
			surf = &people{h: h, inst: open.Instance, everyone: map[string]string{"ada": "Ada Lovelace", "alan": "Alan Turing", "grace": "Grace Hopper"}}
			return surf, h.UpdateView(open.Instance, surf.view())
		},
	}}
	h := plugintest.Start(t, p, plugintest.Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.OpenSurface(ctx, "i", "s", pluginsdk.UiContext{}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { _, ok := h.View("i"); return ok })
	if _, ok := h.Results("i", "who", "la"); ok {
		t.Fatal("results before a search")
	}
	if err := h.Search(ctx, "i", "who", "a"); err == nil || !strings.Contains(err.Error(), "2 to 200 characters") {
		t.Errorf("a one-character search: %v", err)
	}
	if err := h.Search(ctx, "i", "who", " la "); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { _, ok := h.Results("i", "who", "la"); return ok })
	got, _ := h.Results("i", "who-search", "la")
	if len(got) != 2 || got[0].Value != "ada" || got[1].Value != "alan" {
		t.Fatalf("results %+v", got)
	}
	if a := surf.acts[0]; a.Kind != pluginsdk.ActSearch || a.Action != "people" || a.Key != "who-search" || a.Field != "who" || a.Query() != "la" || a.Values["note"] != "n" {
		t.Errorf("search act %+v", a)
	}
	if err := h.Pick(ctx, "i", "who", "alan"); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Errorf("picked a disabled option: %v", err)
	}
	if err := h.Pick(ctx, "i", "who", "nobody"); err == nil {
		t.Error("picked a value not shown")
	}
	if err := h.Pick(ctx, "i", "who", "ada"); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { return h.Version("i") >= 3 })
	// Ada stays picked (listed under Selected) when a new search does not find her.
	if err := h.Search(ctx, "i", "who", "grace"); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { _, ok := h.Results("i", "who", "grace"); return ok })
	if err := h.Pick(ctx, "i", "who", "ada", "grace"); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(2*time.Second, func(h *plugintest.Host) bool { return h.Version("i") >= 5 })
	surf.mu.Lock()
	defer surf.mu.Unlock()
	if strings.Join(surf.picked, ",") != "ada,grace" {
		t.Errorf("picked %v", surf.picked)
	}
	if a := surf.acts[len(surf.acts)-1]; a.Kind != pluginsdk.ActChange || a.Value != "ada,grace" || a.Field != "who" || a.Values["note"] != "n" {
		t.Errorf("change act %+v", a)
	}
}
