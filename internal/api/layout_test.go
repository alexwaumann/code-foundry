package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// layoutServer serves LayoutService and EventService over a layouttest.Fake.
func layoutServer(t *testing.T) (*layouttest.Fake, codefoundryv1connect.LayoutServiceClient, codefoundryv1connect.EventServiceClient) {
	t.Helper()
	b := bus.New()
	f := layouttest.New(b)
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	mux := http.NewServeMux()
	for _, r := range []Route{NewLayout(f).Route(), NewEvents(EventsDeps{Bus: b, Layout: f, Done: done}).Route()} {
		mux.Handle(r.Path, r.Handler)
	}
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return f, codefoundryv1connect.NewLayoutServiceClient(srv.Client(), srv.URL), codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)
}

func applyLayout(ctx context.Context, cl codefoundryv1connect.LayoutServiceClient, op *v1.LayoutOp) (*v1.ApplyLayoutResponse, error) {
	res, err := cl.Apply(ctx, connect.NewRequest(&v1.ApplyLayoutRequest{Op: op, ClientId: "win-1"}))
	if err != nil {
		return nil, err
	}
	return res.Msg, nil
}

func TestLayoutServiceApplyAndGet(t *testing.T) {
	_, cl, _ := layoutServer(t)
	ctx := context.Background()

	res, err := applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_AddTab{AddTab: &v1.AddTabOp{
		Tab:   &v1.LayoutTab{Kind: "file", Params: map[string]string{"path": "/r/a.go"}, Title: "a.go"},
		Focus: true,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if res.GetRev() != 1 || res.GetTabId() != "t-n1" || res.GetPaneId() != "p-n1" || res.GetSpaceId() != "sp-main" {
		t.Fatalf("add_tab = %v", res)
	}
	res, err = applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_SplitPane{SplitPane: &v1.SplitPaneOp{
		PaneId: "p-n1", Edge: v1.LayoutEdge_LAYOUT_EDGE_RIGHT, Tab: &v1.LayoutTab{Kind: "prs"}, Frac: 0.4,
	}}})
	if err != nil || res.GetRev() != 2 || res.GetPaneId() != "p-n2" {
		t.Fatalf("split_pane = %v, %v", res, err)
	}
	// The same file again is the open tab.
	res, err = applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_AddTab{AddTab: &v1.AddTabOp{
		PaneId: "p-n2", Tab: &v1.LayoutTab{Kind: "file", Params: map[string]string{"path": "/r/a.go"}}, Index: proto.Int32(0),
	}}})
	if err != nil || !res.GetExisting() || res.GetTabId() != "t-n1" {
		t.Fatalf("add_tab again = %v, %v; want the existing t-n1", res, err)
	}

	got, err := cl.Get(ctx, connect.NewRequest(&v1.GetLayoutRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	l := got.Msg.GetLayout()
	if l.GetRev() != res.GetRev() || l.GetCurrentSpaceId() != "sp-main" || l.GetDefaultSpaceId() != "sp-main" || len(l.GetSpaces()) != 1 {
		t.Fatalf("layout = %v", l)
	}
	split := l.GetSpaces()[0].GetRoot().GetSplit()
	if split.GetDir() != v1.LayoutDir_LAYOUT_DIR_ROW || len(split.GetChildren()) != 2 || split.GetSizes()[1] != 0.4 {
		t.Fatalf("root = %v", l.GetSpaces()[0].GetRoot())
	}
	left := split.GetChildren()[0].GetPane()
	if tb := left.GetTabs()[0]; tb.GetKey() == "" || tb.GetTitle() != "a.go" || tb.GetParams()["path"] != "/r/a.go" {
		t.Errorf("tab = %v", tb)
	}

	// Closing reports what went.
	res, err = applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_ClosePane{ClosePane: &v1.ClosePaneOp{PaneId: "p-n2"}}})
	if err != nil || len(res.GetClosed()) != 1 || res.GetClosed()[0].GetKind() != "prs" {
		t.Errorf("close_pane = %v, %v", res, err)
	}
}

func TestLayoutServiceErrors(t *testing.T) {
	f, cl, _ := layoutServer(t)
	ctx := context.Background()
	if _, err := applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_AddTab{AddTab: &v1.AddTabOp{Tab: &v1.LayoutTab{Kind: "prs"}}}}); err != nil {
		t.Fatal(err)
	}
	// A LayoutOp with a case added after this build: field 99, an empty message.
	unknownCase := &v1.LayoutOp{}
	unknownCase.ProtoReflect().SetUnknown(protowire.AppendBytes(protowire.AppendTag(nil, 99, protowire.BytesType), nil))

	tests := []struct {
		name string
		op   *v1.LayoutOp
		want connect.Code
	}{
		{"no op", nil, connect.CodeInvalidArgument},
		{"empty op", &v1.LayoutOp{}, connect.CodeInvalidArgument},
		{"a case from a newer client", unknownCase, connect.CodeUnimplemented},
		{"a thread with no tab open", &v1.LayoutOp{Op: &v1.LayoutOp_CloseThread{CloseThread: &v1.CloseThreadOp{ThreadId: "s-1"}}}, connect.CodeNotFound},
		{"missing tab", &v1.LayoutOp{Op: &v1.LayoutOp_FocusTab{FocusTab: &v1.FocusTabOp{TabId: "t-gone"}}}, connect.CodeNotFound},
		{"edge out of range", &v1.LayoutOp{Op: &v1.LayoutOp_SplitPane{SplitPane: &v1.SplitPaneOp{PaneId: "p-n1", Edge: 42, Tab: &v1.LayoutTab{Kind: "projects"}}}}, connect.CodeInvalidArgument},
		{"no edge", &v1.LayoutOp{Op: &v1.LayoutOp_SplitPane{SplitPane: &v1.SplitPaneOp{PaneId: "p-n1", Tab: &v1.LayoutTab{Kind: "projects"}}}}, connect.CodeInvalidArgument},
		{"unknown kind", &v1.LayoutOp{Op: &v1.LayoutOp_AddTab{AddTab: &v1.AddTabOp{Tab: &v1.LayoutTab{Kind: "nope"}}}}, connect.CodeInvalidArgument},
		{"surface already open", &v1.LayoutOp{Op: &v1.LayoutOp_SplitPane{SplitPane: &v1.SplitPaneOp{PaneId: "p-n1", Edge: v1.LayoutEdge_LAYOUT_EDGE_LEFT, Tab: &v1.LayoutTab{Kind: "prs"}}}}, connect.CodeAlreadyExists},
		{"last space", &v1.LayoutOp{Op: &v1.LayoutOp_RemoveSpace{RemoveSpace: &v1.RemoveSpaceOp{SpaceId: "sp-main"}}}, connect.CodeFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := applyLayout(ctx, cl, tt.op)
			if got := connect.CodeOf(err); got != tt.want {
				t.Errorf("code %v (%v); want %v", got, err, tt.want)
			}
		})
	}
	if f.Snapshot().Rev != 1 {
		t.Errorf("rev %d after refusals; want 1", f.Snapshot().Rev)
	}

	f.Err = layout.ErrClosed
	if _, err := applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_NewSpace{NewSpace: &v1.NewSpaceOp{}}}); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Errorf("closed store: %v; want unavailable", err)
	}
	f.Err = nil

	if _, err := cl.SetViewport(ctx, connect.NewRequest(&v1.SetViewportRequest{ClientId: "w", Width: 0, Height: 800})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("zero width: %v; want invalid argument", err)
	}
	if _, err := cl.SetViewport(ctx, connect.NewRequest(&v1.SetViewportRequest{ClientId: "w", Width: 1600, Height: 900})); err != nil {
		t.Fatal(err)
	}
	if got := f.Viewport(); got != (layout.Viewport{Width: 1600, Height: 900}) {
		t.Errorf("viewport %+v", got)
	}
}

// Every case of LayoutOp converts to the op of internal/layout with its own name.
func TestLayoutOpCasesConvert(t *testing.T) {
	oneof := (&v1.LayoutOp{}).ProtoReflect().Descriptor().Oneofs().ByName("op")
	for i := range oneof.Fields().Len() {
		fd := oneof.Fields().Get(i)
		m := (&v1.LayoutOp{}).ProtoReflect()
		m.Set(fd, protoreflect.ValueOfMessage(m.NewField(fd).Message()))
		op, err := layoutOpFromProto(m.Interface().(*v1.LayoutOp))
		if err != nil {
			t.Errorf("%s: %v", fd.Name(), err)
			continue
		}
		if op.OpName() != string(fd.Name()) {
			t.Errorf("%s converts to %s", fd.Name(), op.OpName())
		}
		if _, err := core.NewOp(op.OpName()); err != nil {
			t.Errorf("%s: %v", fd.Name(), err)
		}
	}
	// And every op of internal/layout has a case.
	for _, name := range core.OpNames() {
		if _, ok := layoutOps[protoreflect.Name(name)]; !ok {
			t.Errorf("op %s has no LayoutOp case", name)
		}
	}
}

// The layout source: the whole layout on connect, then a delta per commit, numbered by rev,
// with the calling window's id.
func TestLayoutEventSource(t *testing.T) {
	f, cl, ev := layoutServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := ev.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_LAYOUT}}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() *v1.LayoutEvent {
		t.Helper()
		for stream.Receive() {
			if m := stream.Msg(); m.GetHeartbeat() == nil {
				if m.GetLayout() == nil {
					t.Fatalf("not a layout event: %v", m)
				}
				return m.GetLayout()
			}
		}
		t.Fatalf("stream ended: %v", stream.Err())
		return nil
	}
	snap := next()
	if snap.GetRev() != 0 || snap.GetSnapshot() == nil || snap.GetSnapshot().GetSpaces()[0].GetName() != layout.FirstSpaceName {
		t.Fatalf("snapshot = %v", snap)
	}
	res, err := applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_NewSpace{NewSpace: &v1.NewSpaceOp{Name: "Review", MakeCurrent: true}}})
	if err != nil {
		t.Fatal(err)
	}
	d := next()
	delta := d.GetDelta()
	if d.GetRev() != res.GetRev() || d.GetClientId() != "win-1" || delta == nil {
		t.Fatalf("delta event = %v", d)
	}
	if len(delta.GetSpaces()) != 1 || delta.GetSpaces()[0].GetName() != "Review" || len(delta.GetSpaceOrder()) != 2 ||
		delta.GetCurrentSpaceId() != res.GetSpaceId() || delta.GetDefaultSpaceId() != "sp-main" {
		t.Errorf("delta = %v", delta)
	}
	// A commit the daemon makes on its own carries no client id.
	f.Put(core.NewState("sp-x", "X"))
	if d := next(); d.GetRev() != 2 || d.GetClientId() != "" || len(d.GetDelta().GetRemovedSpaceIds()) != 2 {
		t.Errorf("put = %v", d)
	}
}
