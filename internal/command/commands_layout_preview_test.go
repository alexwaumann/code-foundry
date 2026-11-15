package command_test

import (
	"errors"
	"strings"
	"testing"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// thread.open --preview (docs/notes/preview-tabs-1-daemon.md): the user's open of an archived
// or snoozed thread is a preview, any other thread's a kept tab; a thread or a page cannot ask
// for one, nor can an open with a place. tab.keep keeps one, and the read verbs mark it.
func TestThreadOpenPreview(t *testing.T) {
	archived := &v1.Thread{Id: "s-arch00000001", ArchivedAt: timestamppb.Now()}
	snoozed := &v1.Thread{Id: "s-snoz00000001", SnoozedUntil: timestamppb.Now()}
	saved := &v1.Thread{Id: "s-save00000001", SavedAt: timestamppb.Now()}
	tests := []struct {
		name    string
		uctx    command.Context
		args    map[string]string
		preview bool
		err     bool
	}{
		{"an archived thread", fromApp, map[string]string{"id": archived.Id, "preview": "true"}, true, false},
		{"a snoozed thread", fromCLI, map[string]string{"id": snoozed.Id, "preview": "true"}, true, false},
		{"a thread saved for later", fromApp, map[string]string{"id": saved.Id, "preview": "true"}, true, false},
		{"an active thread is kept", fromApp, map[string]string{"id": "s-live00000001", "preview": "true"}, false, false},
		{"without --preview, kept", fromApp, map[string]string{"id": archived.Id}, false, false},
		{"from a thread, refused", fromThread, map[string]string{"id": archived.Id, "preview": "true"}, false, true},
		{"with a place, refused", fromApp, map[string]string{"id": archived.Id, "preview": "true", "pane": "p-left"}, false, true},
		{"with --outer, refused", fromApp, map[string]string{"id": archived.Id, "preview": "true", "outer": "right"}, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t)
			f.thread.Others = []*v1.Thread{archived, snoozed, saved}
			res, err := f.run(t, tt.uctx, "thread.open", tt.args)
			if tt.err {
				if !errors.Is(err, command.ErrInvalidArgs) {
					t.Fatalf("err %v, want invalid args", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			_, _, tb := f.state().FindTab(openThreadTab(f.state(), tt.args["id"]))
			if tb == nil || tb.Preview != tt.preview {
				t.Fatalf("tab %+v, want preview %v", tb, tt.preview)
			}
			if got := strings.Contains(res.Message, "as preview tab"); tt.uctx.ActiveView == "" && got != tt.preview {
				t.Errorf("message %q", res.Message)
			}
		})
	}
}

func TestTabKeepAndTheReadVerbs(t *testing.T) {
	f := newLayoutFixture(t)
	arch := &v1.Thread{Id: "s-arch00000001", ArchivedAt: timestamppb.Now()}
	f.thread.Others = []*v1.Thread{arch}
	f.must(t, fromApp, "thread.open", map[string]string{"id": arch.Id, "preview": "true"})
	tab := openThreadTab(f.state(), arch.Id)
	for _, verb := range []string{"tab.list", "layout.show"} {
		if res := f.must(t, fromCLI, verb, nil); !strings.Contains(res.Message, arch.Id+" (preview)") {
			t.Errorf("%s does not mark the preview:\n%s", verb, res.Message)
		}
	}
	if res := f.must(t, fromCLI, "tab.keep", map[string]string{"tab": "t-prs"}); !strings.Contains(res.Message, "no preview") {
		t.Errorf("tab.keep on a kept tab: %q", res.Message)
	}
	if res := f.must(t, fromCLI, "tab.keep", map[string]string{"tab": tab}); res.Message != "kept tab "+tab {
		t.Errorf("tab.keep: %q", res.Message)
	}
	if _, _, tb := f.state().FindTab(tab); tb.Preview {
		t.Error("still a preview after tab.keep")
	}
	if res := f.must(t, fromCLI, "tab.list", nil); strings.Contains(res.Message, "(preview)") {
		t.Errorf("tab.list still marks a preview:\n%s", res.Message)
	}
}

func openThreadTab(st *core.State, thread string) string {
	for _, sp := range st.Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "thread" && tb.Thread == thread {
					return tb.ID
				}
			}
		}
	}
	return ""
}
