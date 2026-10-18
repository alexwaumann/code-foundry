package command

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// PluginSurfaceBackend is the slice of PluginService plugin.surface and plugin.act
// need, in generated Connect signatures (see TerminalBackend).
type PluginSurfaceBackend interface {
	GetSurface(context.Context, *connect.Request[v1.GetSurfaceRequest]) (*connect.Response[v1.GetSurfaceResponse], error)
	Act(context.Context, *connect.Request[v1.SurfaceActRequest]) (*connect.Response[v1.SurfaceActResponse], error)
}

var (
	_ PluginSurfaceBackend = codefoundryv1connect.PluginServiceHandler(nil)
	_ PluginSurfaceBackend = codefoundryv1connect.PluginServiceClient(nil)
)

// UiContextToProto is c as the wire's UiContext.
func UiContextToProto(c Context) *v1.UiContext {
	return &v1.UiContext{
		ActiveTerminalId: c.ActiveTerminalID, ActiveThreadId: c.ActiveThreadID, ActiveProjectId: c.ActiveProjectID,
		ActiveWorktreePath: c.ActiveWorktreePath, ActiveView: c.ActiveView, ActiveWorkspaceId: c.ActiveWorkspaceID,
	}
}

// surfaceArgs are the args naming a surface instance: plugin, surface, and the
// context its scope reads (thread or project; --context-* work too).
func surfaceArgs() []ArgSpec {
	return []ArgSpec{
		{Name: "name", Type: String, Required: true, Positional: true, Description: "Plugin name (code-foundry plugin list)"},
		{Name: "surface", Type: String, Required: true, Positional: true, Description: "Surface id (code-foundry plugin list shows them)"},
		{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID, Description: "Thread a thread or pr scoped surface is for" + IDHelp},
		{Name: "project", Type: String, Context: ContextProject, Description: "Project a project scoped surface is for"},
	}
}

func surfaceRef(uctx Context, a Args) *v1.SurfaceRef {
	return &v1.SurfaceRef{Plugin: a.String("name"), Surface: a.String("surface"), Context: UiContextToProto(uctx)}
}

// RegisterPluginSurface registers plugin.surface and plugin.act: a plugin surface
// without the GUI, for debugging and for agents.
func RegisterPluginSurface(r *Registry, b PluginSurfaceBackend) error {
	return r.RegisterAll(
		Command{
			Name:  "plugin.surface",
			Title: "Show Plugin Surface View",
			Description: "Open a plugin surface for a context (a thread for a thread scoped one: --context-thread) as the " +
				"side panel would, wait for its view, and print the view's JSON and the elements that act " +
				"(code-foundry plugin act). --watch keeps printing new views, log appends and toasts (CLI).",
			Category:     "Plugin",
			NoKeybinding: true,
			Args:         append(surfaceArgs(), ArgSpec{Name: "watch", Type: Bool, Description: "CLI: keep printing updates until interrupted"}),
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				res, err := b.GetSurface(ctx, connect.NewRequest(&v1.GetSurfaceRequest{Ref: surfaceRef(uctx, a)}))
				if err != nil {
					return Result{}, err
				}
				if a.Bool("watch") {
					// The CLI streams PluginService.WatchSurface itself.
					return Result{JSON: res.Msg}, nil
				}
				return Result{Message: FormatSurface(res.Msg), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "plugin.act",
			Title: "Act on Plugin Surface",
			Description: "Act on an element of a plugin surface's current view as a click would: a button, row, chip, tab, a " +
				"field's change, or a form's submit with --values '{\"field\": \"value\"}'. Name the element by its event " +
				"(the positional action) or --key (code-foundry plugin surface lists them). The plugin's error is the " +
				"command's.",
			Category:     "Plugin",
			NoKeybinding: true,
			Args: append(surfaceArgs(),
				ArgSpec{Name: "action", Type: String, Positional: true, Description: `The element's event name ("tab" for a tab)`},
				ArgSpec{Name: "key", Type: String, Description: "The element's key"},
				ArgSpec{Name: "value", Type: String, Description: "A change's new value"},
				ArgSpec{Name: "values", Type: String, Description: `Form values as a JSON object, e.g. {"name":"Ada","notify":true}`},
				ArgSpec{Name: "version", Type: Int, Description: "The view version acted on (default: the current one)"},
			),
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if a.String("action") == "" && a.String("key") == "" {
					return Result{}, InvalidArg("action", "name the element: its action or --key")
				}
				req := &v1.SurfaceActRequest{Ref: surfaceRef(uctx, a), Version: uint64(max(a.Int("version"), 0)),
					Key: a.String("key"), Action: a.String("action"), Context: UiContextToProto(uctx)}
				if a.Has("value") {
					v := a.String("value")
					req.Value = &v
				}
				if s := a.String("values"); s != "" {
					var m map[string]any
					if err := json.Unmarshal([]byte(s), &m); err != nil {
						return Result{}, InvalidArg("values", "not a JSON object: %v", err)
					}
					st, err := structpb.NewStruct(m)
					if err != nil {
						return Result{}, InvalidArg("values", "%v", err)
					}
					req.Values = st
				}
				if req.Version == 0 {
					// Open the instance (it stays open for the grace) and act on its view.
					got, err := b.GetSurface(ctx, connect.NewRequest(&v1.GetSurfaceRequest{Ref: req.GetRef()}))
					if err != nil {
						return Result{}, err
					}
					if got.Msg.GetView() == nil {
						return Result{}, fmt.Errorf("%s %s sent no view yet (%s)", a.String("name"), a.String("surface"), surfaceStateWords(got.Msg.GetState()))
					}
					req.Instance, req.Version = got.Msg.GetView().GetInstance(), got.Msg.GetView().GetVersion()
				}
				res, err := b.Act(ctx, connect.NewRequest(req))
				if err != nil {
					return Result{}, err
				}
				what := req.GetKey()
				if what == "" {
					what = req.GetAction()
				}
				return Result{Message: fmt.Sprintf("acted on %s (view version %d)", what, res.Msg.GetVersion()), JSON: res.Msg}, nil
			},
		},
	)
}

// surfaceStateWords is a surface's state in words.
func surfaceStateWords(s *v1.SurfaceState) string {
	w := strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(s.GetPhase().String(), "SURFACE_PHASE_")), "_", " ")
	if s.GetMessage() != "" {
		w += ": " + s.GetMessage()
	}
	return w
}

// FormatSurface is plugin.surface's output: the instance, its state, the view's JSON
// (indented) and the elements that act.
func FormatSurface(res *v1.GetSurfaceResponse) string {
	var sb strings.Builder
	st := res.GetState()
	fmt.Fprintf(&sb, "instance %s: %s\n", st.GetInstance(), surfaceStateWords(st))
	v := res.GetView()
	if v == nil {
		sb.WriteString("(no view yet)")
		return sb.String()
	}
	fmt.Fprintf(&sb, "view version %d", v.GetVersion())
	if v.GetHostRendered() {
		sb.WriteString(" (made by Code Foundry: the plugin's view was invalid)")
	}
	sb.WriteString(":\n")
	var buf bytes.Buffer
	if json.Indent(&buf, []byte(v.GetViewJson()), "", "  ") == nil {
		sb.Write(buf.Bytes())
	} else {
		sb.WriteString(v.GetViewJson())
	}
	if len(res.GetElements()) > 0 {
		sb.WriteString("\nelements:\n")
		tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
		_, _ = fmt.Fprintln(tw, "  KEY\tKIND\tACTION\tLABEL\tFORM")
		for _, el := range res.GetElements() {
			_, _ = fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\n", el.GetKey(), el.GetKind(), el.GetAction(), el.GetLabel(), el.GetForm())
		}
		_ = tw.Flush()
	}
	return strings.TrimRight(sb.String(), "\n")
}

// FormatSurfaceUpdate is one WatchSurface update as plugin.surface --watch prints it;
// "" for a heartbeat.
func FormatSurfaceUpdate(u *v1.SurfaceUpdate) string {
	switch {
	case u.GetState() != nil:
		return "state: " + surfaceStateWords(u.GetState())
	case u.GetView() != nil:
		v := u.GetView()
		return fmt.Sprintf("view version %d: %s", v.GetVersion(), v.GetViewJson())
	case u.GetAppend() != nil:
		a := u.GetAppend()
		text := a.GetText()
		for _, l := range a.GetLines() {
			text += l.GetText() + "\n"
		}
		return fmt.Sprintf("append to %s (version %d): %q", a.GetKey(), a.GetVersion(), text)
	case u.GetToast() != nil:
		return fmt.Sprintf("toast %s: %s", u.GetToast().GetLevel(), u.GetToast().GetText())
	}
	return ""
}
