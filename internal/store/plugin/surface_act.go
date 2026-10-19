package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The plugin → host surface methods are entries in host.go's registries, added from
// here so this feature is its own file.
func init() {
	hostMethods[pluginsdk.MethodViewUpdate] = hostMethod{handle: (*actor).viewUpdate}
	hostMethods[pluginsdk.MethodViewAppend] = hostMethod{handle: (*actor).viewAppend}
	hostNotifications[pluginsdk.MethodViewUpdate] = func(a *actor, p json.RawMessage) { _, _ = a.viewUpdate(context.Background(), p) }
	hostNotifications[pluginsdk.MethodViewAppend] = func(a *actor, p json.RawMessage) { _, _ = a.viewAppend(context.Background(), p) }
	hostNotifications[pluginsdk.MethodViewToast] = (*actor).viewToast
	hostNotifications[pluginsdk.MethodContextSet] = (*actor).contextSet
	hostCapabilities = append(hostCapabilities, surfaceCapabilities...)
}

// surfaceCapabilities are announced in initialize: surfaces and the view model's v1 node
// kinds a GUI renders (view.node.thread and view.node.terminal come with plugin threads
// and terminals: threads.go, terminals.go).
var surfaceCapabilities = []string{
	"surfaces", "view.v1", "view.append", "context", "invoke.ask",
	"view.node.text", "view.node.markdown", "view.node.pairs", "view.node.list", "view.node.chips",
	"view.node.log", "view.node.actions", "view.node.progress", "view.node.notice", "view.node.empty",
	"view.node.section", "view.node.form", "view.node.columns", "view.node.pane", "view.node.container",
	"view.node.grid", "view.node.divider", "view.node.spacer", "view.node.group", "view.node.masterDetail", "view.node.tabs", "view.tabs", "view.toolbar", "view.footer", "view.fieldset", "view.optionsSource", "view.duration",
}

// viewUpdate serves view/update: validate, number and install a view.
func (a *actor) viewUpdate(_ context.Context, params json.RawMessage) (any, error) {
	var p pluginsdk.ViewUpdateParams
	if err := json.Unmarshal(params, &p); err != nil {
		a.hostLog("bad view/update: %v", err)
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "view/update: %v", err)
	}
	in, err := a.m.surf.instanceFor(a, p.Instance)
	if err != nil {
		a.hostLog("refused view/update: %v", err)
		return nil, err
	}
	v, canon, errs := validateView(p.View, a.name, a.permissions())
	if len(errs) == 0 {
		errs = a.ownedNodeProblems(v) // threads.go
	}
	if len(errs) > 0 {
		pl, _ := a.m.Snapshot().Plugin(a.name)
		in.reject(pl.DisplayName(), errs, pl.Dev)
		first := errs[0]
		a.hostLog("view for %s rejected (%d problems): %s", p.Instance, len(errs), strings.Join(errs, "; "))
		a.m.surf.setIssue(a.name, in.surfaceID, "its last view was rejected: "+first)
		shown := errs
		if len(shown) > 10 {
			shown = append(slices.Clone(shown[:10]), fmt.Sprintf("… and %d more", len(errs)-10))
		}
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "view rejected: %s", strings.Join(shown, "; "))
	}
	ver, flooding := in.accept(v, canon, a.m.opts.Now())
	a.m.surf.setIssue(a.name, in.surfaceID, "")
	if flooding {
		a.hostLog("%s sends more than %d views a second: showing at most one a second", p.Instance, floodRate)
		a.m.surf.setIssue(a.name, in.surfaceID+" flood", fmt.Sprintf("more than %d views a second for %ds; shown at most one a second", floodRate, floodSeconds))
	}
	return pluginsdk.ViewUpdateResult{Version: ver}, nil
}

// viewAppend serves view/append.
func (a *actor) viewAppend(_ context.Context, params json.RawMessage) (any, error) {
	var p pluginsdk.ViewAppendParams
	if err := json.Unmarshal(params, &p); err != nil {
		a.hostLog("bad view/append: %v", err)
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "view/append: %v", err)
	}
	in, err := a.m.surf.instanceFor(a, p.Instance)
	if err != nil {
		a.hostLog("refused view/append: %v", err)
		return nil, err
	}
	if !utf8.ValidString(p.Text) {
		p.Text = strings.ToValidUTF8(p.Text, "�")
	}
	ver, err := in.appendLog(p)
	if err != nil {
		a.hostLog("refused view/append: %v", err)
		return nil, err
	}
	return pluginsdk.ViewUpdateResult{Version: ver}, nil
}

// maxToastsPerSecond bounds a plugin's toasts.
const maxToastsPerSecond = 1

// viewToast serves view/toast: to an instance's viewers, or (no instance) to the GUI as
// a notification.
func (a *actor) viewToast(params json.RawMessage) {
	var p pluginsdk.ToastParams
	if err := json.Unmarshal(params, &p); err != nil {
		a.hostLog("bad view/toast: %v", err)
		return
	}
	text := strings.TrimSpace(p.Text)
	if text == "" {
		return
	}
	if utf8.RuneCountInString(text) > maxToastText {
		text = string([]rune(text)[:maxToastText-1]) + "…"
	}
	level := p.Level
	if !slices.Contains([]string{pluginsdk.ToastInfo, pluginsdk.ToastAttention, pluginsdk.ToastError}, level) {
		level = pluginsdk.ToastInfo
	}
	h := a.m.surf
	h.toastMu.Lock()
	rl := h.toasts[a.name]
	if rl == nil {
		rl = &rateLimiter{}
		h.toasts[a.name] = rl
	}
	h.toastMu.Unlock()
	if !rl.allow(a.m.opts.Now(), maxToastsPerSecond) {
		a.hostLog("dropped a toast: at most %d a second", maxToastsPerSecond)
		return
	}
	if p.Instance != "" {
		in, err := h.instanceFor(a, p.Instance)
		if err != nil {
			a.hostLog("dropped a toast: %v", err)
			return
		}
		in.toast(SurfaceToast{Instance: p.Instance, Level: level, Text: text})
		return
	}
	if a.m.opts.Emitter == nil {
		return
	}
	pl, _ := a.m.Snapshot().Plugin(a.name)
	lv := map[string]v1.UiIntent_Notify_Level{
		pluginsdk.ToastInfo: v1.UiIntent_Notify_LEVEL_INFO, pluginsdk.ToastAttention: v1.UiIntent_Notify_LEVEL_WARNING,
		pluginsdk.ToastError: v1.UiIntent_Notify_LEVEL_ERROR,
	}[level]
	a.m.opts.Emitter.Emit(&v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{Level: lv, Title: pl.DisplayName(), Body: text}}})
}

// validateView decodes and checks a plugin's view: the raw size, the schema and limits
// (pluginsdk/ui's Validate), and what only the host can check: command actions name
// the plugin's own commands or ones it may invoke, and a secret input's store needs
// the secrets permission. It returns the view and its canonical JSON (what viewers get:
// unknown fields dropped), or the problems.
func validateView(raw json.RawMessage, plugin string, perms pluginsdk.Permissions) (*ui.View, []byte, []string) {
	if len(raw) > maxRawView {
		return nil, nil, []string{fmt.Sprintf("view: %d bytes, at most %d", len(raw), maxRawView)}
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return nil, nil, []string{"view: must be a JSON object"}
	}
	var v ui.View
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, nil, []string{"view: " + err.Error()}
	}
	var errs []string
	if err := v.Validate(); err != nil {
		errs = splitJoined(err)
	}
	idx := buildIndex(&v)
	for _, k := range idx.order {
		el := idx.elements[k]
		if el.action == nil || el.action.Command == nil {
			continue
		}
		name := el.action.Command.Name
		if !strings.HasPrefix(name, Prefix(plugin)) && (managementVerb(name) || !perms.AllowsCommand(name)) {
			errs = append(errs, fmt.Sprintf("%s: command %q is neither plugin.%s.* nor in plugin.json's permissions.commands", el.key, name, plugin))
		}
	}
	for _, f := range idx.fields {
		if f.store != "" && !perms.Secrets {
			errs = append(errs, fmt.Sprintf("%s: a secret input's store needs \"secrets\": true in plugin.json's permissions", f.key))
		}
	}
	if len(errs) > 0 {
		return nil, nil, errs
	}
	fillLists(&v)
	canon, err := json.Marshal(v)
	if err != nil {
		return nil, nil, []string{"view: " + err.Error()}
	}
	return &v, canon, nil
}

// fillLists makes the view's required lists empty instead of nil, so the canonical JSON
// has [] where viewers expect a list: a Go plugin's Section{} or Chips{} (and a view
// without "nodes") would otherwise reach the GUI as null and break its renderer. The
// toolbar and footer are optional (left out when empty); their nodes are filled too.
func fillLists(v *ui.View) {
	if v.Nodes == nil {
		v.Nodes = []ui.Node{}
	}
	var fields func(fs []ui.Field)
	fields = func(fs []ui.Field) {
		for i := range fs {
			if fs[i].Fieldset != nil {
				if fs[i].Fieldset.Fields == nil {
					fs[i].Fieldset.Fields = []ui.Field{}
				}
				fields(fs[i].Fieldset.Fields)
			}
		}
	}
	walkView(v, func(n *ui.Node) {
		switch {
		case n.Pairs != nil && n.Pairs.Items == nil:
			n.Pairs.Items = []ui.Pair{}
		case n.List != nil && n.List.Rows == nil:
			n.List.Rows = []ui.Row{}
		case n.Chips != nil && n.Chips.Chips == nil:
			n.Chips.Chips = []ui.Chip{}
		case n.Actions != nil && n.Actions.Buttons == nil:
			n.Actions.Buttons = []ui.Button{}
		case n.Section != nil && n.Section.Children == nil:
			n.Section.Children = []ui.Node{}
		case n.Columns != nil:
			if n.Columns.Items == nil {
				n.Columns.Items = []ui.Column{}
			}
			for i := range n.Columns.Items {
				if n.Columns.Items[i].Children == nil {
					n.Columns.Items[i].Children = []ui.Node{}
				}
			}
		case n.Pane != nil && n.Pane.Children == nil:
			n.Pane.Children = []ui.Node{}
		case n.Grid != nil:
			if n.Grid.Items == nil {
				n.Grid.Items = []ui.GridItem{}
			}
			for i := range n.Grid.Items {
				if n.Grid.Items[i].Children == nil {
					n.Grid.Items[i].Children = []ui.Node{}
				}
			}
		case n.Group != nil && n.Group.Items == nil:
			n.Group.Items = []ui.Node{}
		case n.Container != nil && n.Container.Children == nil:
			n.Container.Children = []ui.Node{}
		case n.MasterDetail != nil:
			if n.MasterDetail.List.Rows == nil {
				n.MasterDetail.List.Rows = []ui.Row{}
			}
			if n.MasterDetail.Detail == nil {
				n.MasterDetail.Detail = []ui.Node{}
			}
		case n.Tabs != nil:
			if n.Tabs.Items == nil {
				n.Tabs.Items = []ui.Tab{}
			}
			if n.Tabs.Children == nil {
				n.Tabs.Children = []ui.Node{}
			}
		case n.Form != nil:
			if n.Form.Fields == nil {
				n.Form.Fields = []ui.Field{}
			}
			fields(n.Form.Fields)
		}
	})
}

// splitJoined turns an errors.Join into its messages.
func splitJoined(err error) []string {
	if j, ok := err.(interface{ Unwrap() []error }); ok {
		var out []string
		for _, e := range j.Unwrap() {
			out = append(out, e.Error())
		}
		return out
	}
	return strings.Split(err.Error(), "\n")
}

// element is one acting element of a view.
type element struct {
	key, kind, label string
	form             string     // the enclosing form's key
	action           *ui.Action // nil for a tab or a select
	field            string     // a change's field name
	node             string     // a node tab's tabs node, a select's master-detail
}

func (e element) actionName() string {
	switch {
	case e.kind == pluginsdk.ActTab:
		return "tab"
	case e.kind == pluginsdk.ActSelect:
		return "select"
	case e.action == nil:
		return ""
	case e.action.Event != "":
		return e.action.Event
	case e.action.Command != nil:
		return e.action.Command.Name
	case e.action.OpenURL != "":
		return e.action.OpenURL
	}
	return "copy"
}

// fieldInfo is one form field.
type fieldInfo struct {
	key, name, form string
	control         string // text, secret, select, multiselect, toggle
	store           string
}

// actionIndex is what Act needs of one view version.
type actionIndex struct {
	elements map[string]element
	order    []string
	fields   []fieldInfo
}

// buildIndex walks a view for its acting elements and form fields.
func buildIndex(v *ui.View) *actionIndex {
	idx := &actionIndex{elements: map[string]element{}}
	add := func(el element) {
		if _, dup := idx.elements[el.key]; dup || el.key == "" {
			return
		}
		idx.elements[el.key] = el
		idx.order = append(idx.order, el.key)
	}
	kindOf := func(a *ui.Action, event string) string {
		switch {
		case a == nil:
			return ""
		case a.Event != "":
			return event
		case a.Command != nil:
			return "command"
		case a.OpenURL != "":
			return "open_url"
		}
		return "copy"
	}
	buttons := func(bs []ui.Button, form string) {
		for i := range bs {
			b := &bs[i]
			if b.Action != nil {
				add(element{key: b.Key, kind: kindOf(b.Action, pluginsdk.ActClick), label: b.Label, form: form, action: b.Action})
			}
		}
	}
	var fields func(fs []ui.Field, form string)
	fields = func(fs []ui.Field, form string) {
		for i := range fs {
			f := &fs[i]
			if f.Fieldset != nil {
				fields(f.Fieldset.Fields, form)
				continue
			}
			fi := fieldInfo{key: f.Key, name: f.Name, form: form}
			switch {
			case f.Input != nil && f.Input.Kind == ui.InputSecret:
				fi.control, fi.store = "secret", f.Input.Store
			case f.Input != nil:
				fi.control = "text"
			case f.Select != nil && f.Select.Multiple:
				fi.control = "multiselect"
			case f.Select != nil:
				fi.control = "select"
			case f.Toggle != nil:
				fi.control = "toggle"
			}
			idx.fields = append(idx.fields, fi)
			if f.Change != nil && f.Change.Event != "" {
				add(element{key: f.Key, kind: pluginsdk.ActChange, label: f.Label, form: form, action: f.Change, field: f.Name})
			}
		}
	}
	if v.Header != nil {
		buttons(v.Header.Actions, "")
	}
	if v.Tabs != nil {
		for _, t := range v.Tabs.Items {
			add(element{key: t.Key, kind: pluginsdk.ActTab, label: t.Label})
		}
	}
	rows := func(rs []ui.Row, selectIn string) {
		for i := range rs {
			r := &rs[i]
			switch {
			case r.Action != nil:
				add(element{key: r.Key, kind: kindOf(r.Action, pluginsdk.ActClick), label: r.Title, action: r.Action})
			case selectIn != "":
				// A master-detail's row without an action of its own selects it.
				add(element{key: r.Key, kind: pluginsdk.ActSelect, label: r.Title, node: selectIn})
			}
			buttons(r.Actions, "")
		}
	}
	walkView(v, func(n *ui.Node) {
		switch {
		case n.List != nil:
			rows(n.List.Rows, "")
		case n.MasterDetail != nil:
			rows(n.MasterDetail.List.Rows, n.Key)
			if e := n.MasterDetail.EmptyDetail; e != nil {
				buttons(e.Actions, "")
			}
		case n.Tabs != nil:
			for _, t := range n.Tabs.Items {
				add(element{key: t.Key, kind: pluginsdk.ActTab, label: t.Label, node: n.Key})
			}
		case n.Chips != nil:
			for i := range n.Chips.Chips {
				c := &n.Chips.Chips[i]
				if c.Action != nil {
					add(element{key: c.Key, kind: kindOf(c.Action, pluginsdk.ActClick), label: c.Label, action: c.Action})
				}
			}
		case n.Actions != nil:
			buttons(n.Actions.Buttons, "")
		case n.Notice != nil:
			buttons(n.Notice.Actions, "")
		case n.Empty != nil:
			buttons(n.Empty.Actions, "")
		case n.Section != nil:
			buttons(n.Section.Actions, "")
		case n.Terminal != nil:
			buttons(n.Terminal.Actions, "")
		case n.Form != nil:
			fields(n.Form.Fields, n.Key)
			if s := n.Form.Submit; s != nil && s.Action != nil {
				add(element{key: s.Key, kind: kindOf(s.Action, pluginsdk.ActSubmit), label: s.Label, form: n.Key, action: s.Action})
			}
			buttons(n.Form.Secondary, n.Key)
		}
	})
	return idx
}

// indexLocked records the acting elements of the new version, keeping the last few.
func (in *instance) indexLocked(v *ui.View) {
	in.index[in.version] = buildIndex(v)
	for ver := range in.index {
		if ver+keptVersions <= in.version {
			delete(in.index, ver)
		}
	}
}

// Act implements Surfaces.
func (m *Manager) Act(ctx context.Context, req ActRequest) (uint64, error) {
	key := req.Instance
	if key == "" {
		in, err := m.surf.resolve(req.Ref)
		if err != nil {
			return 0, err
		}
		key = in.key
	}
	in := m.surf.lookup(key)
	if in == nil {
		return 0, fmt.Errorf("%w: no surface instance %q (watch it first)", ErrNotFound, key)
	}
	conn := m.conn(in.plugin)
	if conn == nil {
		_, why := m.whyDown(in.plugin)
		return 0, fmt.Errorf("%w: %s", ErrFailedPrecondition, why)
	}
	in.mu.Lock()
	if in.openConn != conn {
		in.mu.Unlock()
		return 0, fmt.Errorf("%w: %s is not open (watch it first)", ErrFailedPrecondition, key)
	}
	ver := req.Version
	if ver == 0 {
		ver = in.version
	}
	idx := in.index[ver]
	cur := in.version
	in.mu.Unlock()
	if idx == nil {
		return 0, fmt.Errorf("%w: version %d of %s's view is gone (the current one is %d)", ErrFailedPrecondition, ver, key, cur)
	}
	el, err := idx.find(req.Key, req.Action)
	if err != nil {
		return 0, err
	}
	viewer := req.Context
	if viewer == (command.Context{}) && req.Instance == "" {
		viewer = req.Ref.Context
	}
	act := pluginsdk.SurfaceAct{Instance: key, Version: ver, Kind: el.kind, Action: el.actionName(), Key: el.key, Node: el.node, Context: UiContextOf(viewer)}
	switch el.kind {
	case pluginsdk.ActClick, pluginsdk.ActSubmit, pluginsdk.ActChange:
		act.Data = el.action.Data
	case pluginsdk.ActTab, pluginsdk.ActSelect:
		act.Value = el.key
	default:
		return 0, fmt.Errorf("%w: %s is a %s action: the host runs it, not the plugin", ErrInvalidArgument, el.key, el.kind)
	}
	if el.kind == pluginsdk.ActChange {
		act.Field = el.field
	}
	if req.Value != nil && el.kind != pluginsdk.ActTab && el.kind != pluginsdk.ActSelect {
		act.Value = *req.Value
	}
	if len(req.Values) > 0 {
		if b, err := json.Marshal(req.Values); err != nil || len(b) > ui.MaxActValues {
			return 0, fmt.Errorf("%w: the action's values are over %d bytes", ErrInvalidArgument, ui.MaxActValues)
		}
	}
	vals, stores, err := idx.values(el, req.Values)
	if err != nil {
		return 0, err
	}
	if req.Value != nil {
		if vals, err = idx.withChange(el, *req.Value, vals); err != nil {
			return 0, err
		}
	}
	secrets := map[string]string{}
	for name, store := range stores {
		s, _ := vals[name].(string)
		if s == "" {
			delete(vals, name)
			continue
		}
		secrets[store] = s
		vals[name] = pluginsdk.StoredSecret{Key: store, Stored: true}
	}
	if len(vals) > 0 {
		act.Values = vals
	}
	if b, err := json.Marshal(act); err != nil || len(b) > maxActPayload {
		return 0, fmt.Errorf("%w: the action's payload is over %d bytes", ErrInvalidArgument, maxActPayload)
	}
	// Stored only once the act is known to go out.
	for store, s := range secrets {
		if err := m.storeSecret(ctx, in.plugin, store, s); err != nil {
			return 0, err
		}
	}
	m.surfLog(in.plugin, "%s %s on %s (version %d)", act.Kind, act.Key, key, ver)
	cctx, cancel := context.WithTimeout(ctx, surfaceActTimeout)
	defer cancel()
	if err := conn.Call(cctx, pluginsdk.MethodSurfaceAct, act, nil); err != nil {
		var perr *pluginsdk.Error
		switch {
		case errors.As(err, &perr):
			return ver, fmt.Errorf("%w: %s", ErrPluginRefused, perr.Message)
		case errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil:
			return ver, fmt.Errorf("plugin %s did not answer within %s", in.plugin, surfaceActTimeout)
		case errors.Is(err, pluginsdk.ErrClosed):
			return ver, fmt.Errorf("plugin %s stopped while handling the action", in.plugin)
		}
		return ver, fmt.Errorf("plugin %s: %w", in.plugin, err)
	}
	return ver, nil
}

// storeSecret writes a form's secret into the plugin's namespace (a secret input with
// store).
func (m *Manager) storeSecret(ctx context.Context, plugin, key, value string) error {
	if !secretKeyPattern.MatchString(key) {
		return fmt.Errorf("%w: secret key %q", ErrInvalidArgument, key)
	}
	if len(value) > MaxSecretBytes {
		return fmt.Errorf("%w: a secret is at most %d bytes", ErrInvalidArgument, MaxSecretBytes)
	}
	if err := m.opts.Secrets.Set(ctx, plugin, key, value); err != nil {
		return err
	}
	if err := putSecret(ctx, m.opts.DB, plugin, key, m.opts.Now()); err != nil {
		return err
	}
	m.surfLog(plugin, "secret set from a form: %s", key)
	return nil
}

// find resolves an element by key (checked against action when given) or, without a
// key, by its action name.
func (idx *actionIndex) find(key, action string) (element, error) {
	if key != "" {
		el, ok := idx.elements[key]
		if !ok {
			return element{}, fmt.Errorf("%w: no acting element %q in the view", ErrInvalidArgument, key)
		}
		if action != "" && action != el.actionName() {
			return element{}, fmt.Errorf("%w: element %q's action is %q, not %q", ErrInvalidArgument, key, el.actionName(), action)
		}
		return el, nil
	}
	if action == "" {
		return element{}, fmt.Errorf("%w: name the element (key) or its action", ErrInvalidArgument)
	}
	var found []element
	for _, k := range idx.order {
		if el := idx.elements[k]; el.actionName() == action && el.kind != pluginsdk.ActTab && el.kind != pluginsdk.ActSelect {
			found = append(found, el)
		}
	}
	switch len(found) {
	case 0:
		return element{}, fmt.Errorf("%w: no element acts %q in the view", ErrInvalidArgument, action)
	case 1:
		return found[0], nil
	}
	keys := make([]string, len(found))
	for i, el := range found {
		keys[i] = el.key
	}
	return element{}, fmt.Errorf("%w: %d elements act %q (%s): pass a key", ErrInvalidArgument, len(found), action, strings.Join(keys, ", "))
}

// values checks an action's values against the view's fields: a submit or a click in a
// form carries that form's fields, any other click every field of the view, a change
// its form's fields without secrets (as does any non-submit). Unknown names are
// refused. It returns the values to send and the secret fields to store.
func (idx *actionIndex) values(el element, in map[string]any) (map[string]any, map[string]string, error) {
	if len(in) == 0 {
		return nil, nil, nil
	}
	allowed := map[string]fieldInfo{}
	for _, f := range idx.fields {
		if f.name == "" || (el.form != "" && f.form != el.form) {
			continue
		}
		if f.control == "secret" && el.kind != pluginsdk.ActSubmit {
			continue
		}
		allowed[f.name] = f
	}
	out := map[string]any{}
	stores := map[string]string{}
	for name, v := range in {
		f, ok := allowed[name]
		if !ok {
			return nil, nil, fmt.Errorf("%w: %q is not a field this action sends", ErrInvalidArgument, name)
		}
		cv, err := coerceValue(f.control, v)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: field %q: %v", ErrInvalidArgument, name, err)
		}
		out[name] = cv
		if f.control == "secret" && f.store != "" {
			stores[name] = f.store
		}
	}
	return out, stores, nil
}

// withChange adds a change's value to its values under the field's name, typed by the
// field's control (a toggle's "false" is false), unless the values carry the field
// already. The GUI sends both; a client that sends only the value (plugin act --value)
// then reaches the plugin the same way, so a plugin may read either.
func (idx *actionIndex) withChange(el element, value string, vals map[string]any) (map[string]any, error) {
	if el.kind != pluginsdk.ActChange || el.field == "" {
		return vals, nil
	}
	if _, ok := vals[el.field]; ok {
		return vals, nil
	}
	for _, f := range idx.fields {
		if f.name != el.field || f.form != el.form || f.control == "secret" {
			continue
		}
		cv, err := coerceValue(f.control, value)
		if err != nil {
			return nil, fmt.Errorf("%w: field %q: %v", ErrInvalidArgument, el.field, err)
		}
		if vals == nil {
			vals = map[string]any{}
		}
		vals[el.field] = cv
		return vals, nil
	}
	return vals, nil
}

// coerceValue checks a value against its control: a string for text, secret and select;
// a boolean (or "true"/"false") for a toggle; a list of strings for a multiple select.
func coerceValue(control string, v any) (any, error) {
	switch control {
	case "toggle":
		switch x := v.(type) {
		case bool:
			return x, nil
		case string:
			b, err := strconv.ParseBool(x)
			if err != nil {
				return nil, errors.New("want true or false")
			}
			return b, nil
		}
		return nil, errors.New("want a boolean")
	case "multiselect":
		switch x := v.(type) {
		case []any:
			out := make([]string, 0, len(x))
			for _, e := range x {
				s, ok := e.(string)
				if !ok {
					return nil, errors.New("want a list of strings")
				}
				out = append(out, s)
			}
			return out, nil
		case []string:
			return x, nil
		case string:
			if x == "" {
				return []string{}, nil
			}
			return strings.Split(x, ","), nil
		}
		return nil, errors.New("want a list of strings")
	}
	s, ok := v.(string)
	if !ok {
		return nil, errors.New("want a string")
	}
	if !utf8.ValidString(s) {
		return nil, errors.New("not UTF-8")
	}
	return s, nil
}
