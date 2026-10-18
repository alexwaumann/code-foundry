package command

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
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

// settleArg is plugin.surface's and plugin.act's --settle.
func settleArg(def, what string) ArgSpec {
	return withDefault(ArgSpec{Name: "settle", Type: String,
		Description: "Wait until no new view has come for this long (a Go duration: 2s, 500ms; at most 30s) " + what}, def)
}

// maxSettle bounds --settle (the daemon caps it too).
const maxSettle = 30 * time.Second

// settleOf parses --settle, clamped to maxSettle.
func settleOf(a Args) (time.Duration, error) {
	s := a.String("settle")
	if s == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < 0 {
		return 0, InvalidArg("settle", "%q is not a duration (2s, 500ms)", s)
	}
	return min(d, maxSettle), nil
}

// RegisterPluginSurface registers plugin.surface and plugin.act: a plugin surface
// without the GUI, for debugging and for agents. plugin.act presses a command button
// through r, as the GUI does.
func RegisterPluginSurface(r *Registry, b PluginSurfaceBackend) error {
	return r.RegisterAll(
		Command{
			Name:  "plugin.surface",
			Title: "Show Plugin Surface View",
			Description: "Open a plugin surface for a context (a thread for a thread scoped one: --context-thread) as the " +
				"side panel would, wait for its view, and print the view's JSON and the elements that act " +
				"(code-foundry plugin act). It returns at the first view; --settle 2s waits until no new view has " +
				"come for 2 s (a surface that shows \"Loading\" first). --watch keeps printing new views, log appends " +
				"and toasts (CLI).",
			Category:     "Plugin",
			NoKeybinding: true,
			Args: append(surfaceArgs(), settleArg("", "before printing"),
				ArgSpec{Name: "watch", Type: Bool, Description: "CLI: keep printing updates until interrupted"}),
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				settle, err := settleOf(a)
				if err != nil {
					return Result{}, err
				}
				res, err := b.GetSurface(ctx, connect.NewRequest(&v1.GetSurfaceRequest{Ref: surfaceRef(uctx, a), SettleMs: int32(settle.Milliseconds())}))
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
				"or command (the positional action) or --key (code-foundry plugin surface lists them). An event goes to the " +
				"plugin (its error is the command's); a command button runs its command with the panel's context, as the " +
				"side panel does (a form's values become its args; a command that asks first needs --yes). Then it prints " +
				"the view once no new one has come for --settle (default 500ms); --quiet prints only what happened.",
			Category:     "Plugin",
			NoKeybinding: true,
			Args: append(surfaceArgs(),
				ArgSpec{Name: "action", Type: String, Positional: true, Description: `The element's event or command name ("tab" for a tab)`},
				ArgSpec{Name: "key", Type: String, Description: "The element's key"},
				ArgSpec{Name: "value", Type: String, Description: "A change's new value"},
				ArgSpec{Name: "values", Type: String, Description: `Form values as a JSON object, e.g. {"name":"Ada","notify":true}`},
				ArgSpec{Name: "version", Type: Int, Description: "The view version acted on (default: the current one)"},
				settleArg("500ms", "before printing the view"),
				ArgSpec{Name: "quiet", Type: Bool, Description: "Print only what happened, not the view after it"},
			),
			// The confirmation is the pressed command's own (its ConfirmError comes back from
			// Run); listing plugin.act as confirming gives the CLI its --yes to pass on.
			Confirm:   "Run the command of {key}?",
			ConfirmIf: func(context.Context, Context, Args) bool { return false },
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				return pluginAct(ctx, r, b, uctx, a)
			},
		},
	)
}

// actResult is plugin.act's --json: what happened, then the view after it.
type actResult struct {
	// Version is the view version an event acted on.
	Version uint64 `json:"version,omitempty"`
	// Command is the command a command button ran, with its message and JSON result.
	Command string          `json:"command,omitempty"`
	Message string          `json:"message,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	// Surface is the instance after the settle (GetSurfaceResponse), unless --quiet.
	Surface json.RawMessage `json:"surface,omitempty"`
}

// pluginAct is plugin.act: an event goes to the plugin (PluginService.Act); a command
// element runs its command through r with the panel's context, as the GUI does.
func pluginAct(ctx context.Context, r *Registry, b PluginSurfaceBackend, uctx Context, a Args) (Result, error) {
	if a.String("action") == "" && a.String("key") == "" {
		return Result{}, InvalidArg("action", "name the element: its action or --key")
	}
	settle, err := settleOf(a)
	if err != nil {
		return Result{}, err
	}
	req := &v1.SurfaceActRequest{Ref: surfaceRef(uctx, a), Version: uint64(max(a.Int("version"), 0)),
		Key: a.String("key"), Action: a.String("action"), Context: UiContextToProto(uctx)}
	if a.Has("value") {
		v := a.String("value")
		req.Value = &v
	}
	var values map[string]any
	if s := a.String("values"); s != "" {
		if err := json.Unmarshal([]byte(s), &values); err != nil {
			return Result{}, InvalidArg("values", "not a JSON object: %v", err)
		}
		st, err := structpb.NewStruct(values)
		if err != nil {
			return Result{}, InvalidArg("values", "%v", err)
		}
		req.Values = st
	}
	// Open the instance (it stays open for the grace) and find the element in its view.
	got, err := b.GetSurface(ctx, connect.NewRequest(&v1.GetSurfaceRequest{Ref: req.GetRef()}))
	if err != nil {
		return Result{}, err
	}
	view := got.Msg.GetView()
	if view == nil {
		return Result{}, fmt.Errorf("%s %s sent no view yet (%s)", a.String("name"), a.String("surface"), surfaceStateWords(got.Msg.GetState()))
	}
	req.Instance = view.GetInstance()
	if req.Version == 0 {
		req.Version = view.GetVersion()
	}
	var out actResult
	var msg string
	if el := commandElement(got.Msg.GetElements(), req.GetKey(), req.GetAction()); el != nil && req.Version == view.GetVersion() {
		args := maps.Clone(el.GetArgs())
		if args == nil {
			args = map[string]string{}
		}
		if el.GetForm() != "" {
			for k, v := range values {
				args[k] = argString(v)
			}
		}
		res, err := r.Invoke(ctx, uctx, el.GetAction(), args, Confirmed(ConfirmedIn(ctx)))
		if err != nil {
			return Result{}, err
		}
		out.Command, out.Message = el.GetAction(), res.Message
		if js, err := res.EncodeJSON(); err == nil && js != "" {
			out.Result = json.RawMessage(js)
		}
		msg = fmt.Sprintf("ran %s (the command of %s)", el.GetAction(), el.GetKey())
		if res.Message != "" {
			msg += ": " + res.Message
		}
	} else {
		res, err := b.Act(ctx, connect.NewRequest(req))
		if err != nil {
			return Result{}, err
		}
		what := req.GetKey()
		if what == "" {
			what = req.GetAction()
		}
		out.Version = res.Msg.GetVersion()
		msg = fmt.Sprintf("acted on %s (view version %d)", what, res.Msg.GetVersion())
	}
	if a.Bool("quiet") {
		return Result{Message: msg, JSON: out}, nil
	}
	after, err := b.GetSurface(ctx, connect.NewRequest(&v1.GetSurfaceRequest{
		Ref: &v1.SurfaceRef{Instance: req.GetInstance()}, SettleMs: int32(settle.Milliseconds()),
	}))
	if err != nil {
		return Result{Message: msg + "\n(the view after it: " + err.Error() + ")", JSON: out}, nil
	}
	if js, err := protojson.Marshal(after.Msg); err == nil {
		out.Surface = js
	}
	return Result{Message: msg + "\n" + FormatSurface(after.Msg), JSON: out}, nil
}

// commandElement finds a command element by key, or by its command name when that names
// exactly one; nil otherwise (Act then refuses or forwards it).
func commandElement(els []*v1.SurfaceElement, key, action string) *v1.SurfaceElement {
	var found *v1.SurfaceElement
	for _, el := range els {
		switch {
		case key != "" && el.GetKey() == key:
			if el.GetKind() == "command" && (action == "" || action == el.GetAction()) {
				return el
			}
			return nil
		case key == "" && el.GetKind() == "command" && el.GetAction() == action:
			if found != nil {
				return nil
			}
			found = el
		}
	}
	return found
}

// argString is a form value as a command arg, as the GUI sends it: a toggle "true" or
// "false", a multiple select's values joined with ",".
func argString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = argString(e)
		}
		return strings.Join(parts, ",")
	case nil:
		return ""
	}
	b, _ := json.Marshal(v)
	return string(b)
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
			action := el.GetAction()
			for _, k := range slices.Sorted(maps.Keys(el.GetArgs())) {
				action += " " + k + "=" + el.GetArgs()[k]
			}
			_, _ = fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\n", el.GetKey(), el.GetKind(), action, el.GetLabel(), el.GetForm())
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
