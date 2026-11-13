package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// fakeImporter runs the fake store's import with one thread and two shells, and records
// what it was given.
type fakeImporter struct {
	store              *layouttest.Fake
	panel, bottom, cid string
}

func (f *fakeImporter) ImportLegacy(ctx context.Context, panel, bottom, clientID string) (layout.ImportCommit, error) {
	f.panel, f.bottom, f.cid = panel, bottom, clientID
	return f.store.ImportLegacy(ctx, core.LegacyInput{
		Panel: []byte(panel), Bottom: []byte(bottom),
		Threads: []core.LegacyThread{{ID: "s-1"}},
		Terminals: []core.LegacyTerminal{
			{ID: "t-a", Labels: map[string]string{"kind": "shell", "thread": "s-1"}, StartedAt: time.Unix(1, 0)},
			{ID: "t-b", Labels: map[string]string{"kind": "shell", "thread": "s-1"}, StartedAt: time.Unix(2, 0)},
		},
	}, layout.ApplyOptions{ClientID: clientID})
}

func importServer(t *testing.T, imp LegacyImporter) (*layouttest.Fake, codefoundryv1connect.LayoutServiceClient) {
	t.Helper()
	f := layouttest.New(nil)
	if fi, ok := imp.(*fakeImporter); ok {
		fi.store = f
	}
	mux := http.NewServeMux()
	r := NewLayout(f).WithImporter(imp).Route()
	mux.Handle(r.Path, r.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return f, codefoundryv1connect.NewLayoutServiceClient(srv.Client(), srv.URL)
}

func TestLayoutServiceImportLegacy(t *testing.T) {
	imp := &fakeImporter{}
	_, cl := importServer(t, imp)
	ctx := context.Background()
	panel := `{"version":6,"state":{"byKey":{"thread:s-1":{"open":true,"groups":[{"tabs":[{"id":"mcp","kind":"mcp","title":"MCP","params":{}},{"id":"w","kind":"weather","title":"W","params":{}}],"activeTabId":"mcp"}]}}}}`
	res, err := cl.ImportLegacy(ctx, connect.NewRequest(&v1.ImportLegacyRequest{PanelJson: panel, BottomJson: "{}", ClientId: "win-1"}))
	if err != nil {
		t.Fatal(err)
	}
	m := res.Msg
	if imp.panel != panel || imp.bottom != "{}" || imp.cid != "win-1" {
		t.Errorf("importer got %q %q %q", imp.panel, imp.bottom, imp.cid)
	}
	if !m.GetImported() || !m.GetLayout().GetLegacyImported() || m.GetLayout().GetRev() != 1 {
		t.Fatalf("response %v", m)
	}
	if th := m.GetThreads(); len(th) != 1 || th[0].GetThreadId() != "s-1" || th[0].GetQuickTerminalId() != "t-a" || len(th[0].GetTabIds()) != 2 {
		t.Errorf("threads %v", th)
	}
	if len(m.GetDropped()) != 1 || len(m.GetLayout().GetThreads()) != 1 || len(m.GetLayout().GetThreads()[0].GetRemembered()) != 2 {
		t.Errorf("dropped %v, threads %v", m.GetDropped(), m.GetLayout().GetThreads())
	}
	if m.GetLayout().GetSpaces()[0].GetRoot() != nil {
		t.Errorf("the space is not empty: %v", m.GetLayout().GetSpaces()[0])
	}

	again, err := cl.ImportLegacy(ctx, connect.NewRequest(&v1.ImportLegacyRequest{PanelJson: panel}))
	if err != nil || again.Msg.GetImported() || again.Msg.GetLayout().GetRev() != 1 || len(again.Msg.GetThreads()) != 0 {
		t.Fatalf("second import %v, %v", again.Msg, err)
	}
	got, err := cl.Get(ctx, connect.NewRequest(&v1.GetLayoutRequest{}))
	if err != nil || !got.Msg.GetLayout().GetLegacyImported() {
		t.Fatalf("get %v, %v", got.Msg, err)
	}
}

func TestLayoutServiceImportLegacyUnimplemented(t *testing.T) {
	f := layouttest.New(nil)
	mux := http.NewServeMux()
	r := NewLayout(f).Route()
	mux.Handle(r.Path, r.Handler)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cl := codefoundryv1connect.NewLayoutServiceClient(srv.Client(), srv.URL)
	_, err := cl.ImportLegacy(context.Background(), connect.NewRequest(&v1.ImportLegacyRequest{}))
	if connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("err %v, want unimplemented", err)
	}
}

func TestLayoutDeltaCarriesTheImportMark(t *testing.T) {
	if !layoutDeltaToProto(layout.Delta{LegacyImported: true}).GetLegacyImported() {
		t.Error("the delta lost legacy_imported")
	}
}

// A layout a newer build wrote reaches the window, which tells the user nothing is saved.
func TestLayoutCarriesWhatANewerBuildWrote(t *testing.T) {
	snap := &layout.Snapshot{Rev: 3, State: core.NewState("sp-a", "Main"), Newer: []string{`space sp-a: tab t-2 of kind "notebook"`}}
	if got := layoutToProto(snap).GetNewer(); len(got) != 1 || got[0] != snap.Newer[0] {
		t.Errorf("newer = %v, want %v", got, snap.Newer)
	}
	snap.Newer = nil
	if got := layoutToProto(snap).GetNewer(); len(got) != 0 {
		t.Errorf("newer = %v, want none", got)
	}
}
