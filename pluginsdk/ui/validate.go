package ui

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// Limits every view must respect. The host refuses a view
// that breaks one and keeps the previous one.
const (
	MaxElements      = 400       // nodes, rows, chips, pairs, fields, options, buttons, tabs
	MaxDepth         = 3         // section > section > node
	MaxViewBytes     = 256 << 10 // encoded, log text excluded
	MaxLabel         = 200
	MaxHeaderTitle   = 120
	MaxTabTitle      = 40
	MaxPairLabel     = 40
	MaxChipLabel     = 32
	MaxSectionTitle  = 60
	MaxTextContent   = 4 << 10
	MaxMarkdown      = 16 << 10
	MaxNoticeDetail  = 2 << 10
	MaxLogText       = 64 << 10
	MaxLogNodes      = 4
	MaxEventData     = 1 << 10
	MaxCopy          = 64 << 10
	MaxOptions       = 200
	MaxTabs          = 8
	MaxHeaderButtons = 2
	MaxRowButtons    = 3
	MaxNoticeButtons = 3
	MaxSectionButton = 2
	MaxEmptyButtons  = 2
	// MaxTerminalButtons is a terminal node's own buttons (the host adds "Open in bottom
	// panel").
	MaxTerminalButtons = 2
	MaxBarButtons      = 6
	// A command action's args: how many, their names and values together (bytes), and
	// one value (bytes). Pass ids in args, not text: the command looks the rest up.
	MaxCommandArgs      = 16
	MaxCommandArgsBytes = 4 << 10
	MaxCommandArgValue  = 2 << 10
	// MaxActValues bounds an action's form values as the host gets them (encoded JSON):
	// a bigger submit is refused before it reaches the plugin.
	MaxActValues = 64 << 10
	// MaxProblems is how many problems Validate names; the rest are counted.
	MaxProblems = 50
)

// KeyPattern is the shape of every key. Keys share one namespace across the view.
var KeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

// StorePattern is the shape of a secret input's store: a key the host's secret store
// takes (a key without ":").
var StorePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

var iconPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// Validate checks v against the schema's rules and limits. The error joins one error per
// problem, each with its path ("nodes[2].form.fields[0]: …").
func (v View) Validate() error {
	c := &checker{keys: map[string]string{}}
	if rv := reflect.ValueOf(v); !validUTF8(rv) {
		c.utf8("", rv)
	}
	if v.Header != nil {
		c.header("header", v.Header)
	}
	if v.Tabs != nil {
		c.tabs("tabs", v.Tabs)
	}
	for i, n := range v.Nodes {
		c.node(fmt.Sprintf("nodes[%d]", i), n, 1)
	}
	if c.elements > MaxElements {
		c.bad("view", "%d elements, at most %d", c.elements, MaxElements)
	}
	if c.logs > MaxLogNodes {
		c.bad("view", "%d log nodes, at most %d", c.logs, MaxLogNodes)
	}
	if b, err := json.Marshal(v); err == nil {
		if n := len(b) - c.logBytes; n > MaxViewBytes {
			c.bad("view", "%d bytes encoded (logs excluded), at most %d", n, MaxViewBytes)
		}
	} else {
		c.bad("view", "does not encode: %v", err)
	}
	if more := c.problems - len(c.errs); more > 0 {
		c.errs = append(c.errs, fmt.Errorf("view: %d more problems", more))
	}
	return errors.Join(c.errs...)
}

type checker struct {
	errs      []error
	problems  int
	formNames map[string]string // the current form's field names → path
	keys      map[string]string // key → path of its first use
	elements  int
	logs      int
	logBytes  int
}

// bad records a problem; past MaxProblems it only counts it (a view of thousands of bad
// nodes would otherwise cost megabytes of messages).
func (c *checker) bad(path, format string, a ...any) {
	c.problems++
	if len(c.errs) < MaxProblems {
		c.errs = append(c.errs, fmt.Errorf("%s: %s", path, fmt.Sprintf(format, a...)))
	}
}

func (c *checker) key(path, k string) {
	c.elements++
	if !KeyPattern.MatchString(k) {
		c.bad(path+".key", "%q must match %s", k, KeyPattern)
		return
	}
	if first, dup := c.keys[k]; dup {
		c.bad(path+".key", "%q is already used by %s", k, first)
		return
	}
	c.keys[k] = path
}

func (c *checker) str(path, s string, max int) {
	if n := utf8.RuneCountInString(s); n > max {
		c.bad(path, "%d characters, at most %d", n, max)
	}
}

func (c *checker) required(path, s string) {
	if strings.TrimSpace(s) == "" {
		c.bad(path, "required")
	}
}

func (c *checker) icon(path, s string) {
	if s != "" && !iconPattern.MatchString(s) {
		c.bad(path, "%q is not a lucide icon name", s)
	}
}

func (c *checker) tone(path string, t Tone) {
	if !slices.Contains([]Tone{ToneNeutral, "neutral", ToneMuted, ToneAttention, ToneError, ToneOK}, t) {
		c.bad(path, "unknown tone %q", t)
	}
}

func (c *checker) status(path string, s Status) {
	if !slices.Contains([]Status{StatusNone, StatusOK, StatusFailed, StatusAttention, StatusRunning, StatusPending, StatusSkipped, StatusOff}, s) {
		c.bad(path, "unknown status %q", s)
	}
}

func (c *checker) url(path, u string) {
	if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		c.bad(path, "%q is not an http or https URL", u)
	}
}

func (c *checker) pill(path string, p *Pill) {
	if p == nil {
		return
	}
	c.required(path+".label", p.Label)
	c.str(path+".label", p.Label, MaxLabel)
	c.tone(path+".tone", p.Tone)
}

func (c *checker) glyph(path string, g *Glyph) {
	if g == nil {
		return
	}
	switch {
	case g.Status != "" && g.Icon != "":
		c.bad(path, "a glyph is a status or an icon, not both")
	case g.Status == "" && g.Icon == "":
		c.bad(path, "a glyph needs a status or an icon")
	}
	c.status(path+".status", g.Status)
	c.icon(path+".icon", g.Icon)
	c.tone(path+".tone", g.Tone)
}

func (c *checker) inline(path string, in *Inline, max int) {
	if in == nil {
		return
	}
	n := utf8.RuneCountInString(in.Text)
	c.str(path+".text", in.Text, max)
	for i, s := range in.Spans {
		sp := fmt.Sprintf("%s.spans[%d]", path, i)
		kinds := 0
		if s.Text != "" {
			kinds++
		}
		if s.Time != nil {
			kinds++
			if s.Time.At.IsZero() {
				c.bad(sp+".time.at", "required")
			}
			if !slices.Contains([]TimeStyle{"", TimeRelative, TimeElapsed, TimeCountdown}, s.Time.Style) {
				c.bad(sp+".time.style", "unknown style %q", s.Time.Style)
			}
		}
		if s.Duration != nil {
			kinds++
			if s.Duration.Ms < 0 {
				c.bad(sp+".duration.ms", "negative")
			}
		}
		if kinds > 1 {
			c.bad(sp, "a span is text, a time or a duration, not several")
		}
		n += utf8.RuneCountInString(s.Text)
		c.tone(sp+".tone", s.Tone)
		if s.URL != "" {
			c.url(sp+".url", s.URL)
		}
	}
	if n > max {
		c.bad(path, "%d characters, at most %d", n, max)
	}
}

func (c *checker) action(path string, a *Action) {
	if a == nil {
		return
	}
	kinds := 0
	if a.Event != "" {
		kinds++
		c.str(path+".event", a.Event, 64)
	}
	if a.Command != nil {
		kinds++
		c.required(path+".command.name", a.Command.Name)
		c.commandArgs(path+".command.args", a.Command.Args)
	}
	if a.OpenURL != "" {
		kinds++
		c.url(path+".openUrl", a.OpenURL)
	}
	if a.Copy != "" {
		kinds++
		if len(a.Copy) > MaxCopy {
			c.bad(path+".copy", "%d bytes, at most %d", len(a.Copy), MaxCopy)
		}
	}
	if kinds != 1 {
		c.bad(path, "an action is exactly one of event, command, openUrl or copy")
	}
	if a.Data != "" && a.Event == "" {
		c.bad(path+".data", "only an event carries data")
	}
	if len(a.Data) > MaxEventData {
		c.bad(path+".data", "%d bytes, at most %d", len(a.Data), MaxEventData)
	}
}

// commandArgs checks a command action's args against MaxCommandArgs,
// MaxCommandArgsBytes and MaxCommandArgValue.
func (c *checker) commandArgs(path string, args map[string]string) {
	if len(args) > MaxCommandArgs {
		c.bad(path, "%d args, at most %d", len(args), MaxCommandArgs)
	}
	total := 0
	for _, k := range slices.Sorted(maps.Keys(args)) {
		v := args[k]
		total += len(k) + len(v)
		if len(v) > MaxCommandArgValue {
			c.bad(path+"."+k, "%d bytes, at most %d", len(v), MaxCommandArgValue)
		}
	}
	if total > MaxCommandArgsBytes {
		c.bad(path, "%d bytes of names and values, at most %d (pass ids, not text)", total, MaxCommandArgsBytes)
	}
}

func (c *checker) buttons(path string, bs []Button, max int) {
	if len(bs) > max {
		c.bad(path, "%d buttons, at most %d", len(bs), max)
	}
	for i, b := range bs {
		c.button(fmt.Sprintf("%s[%d]", path, i), &b)
	}
}

func (c *checker) button(path string, b *Button) {
	if b == nil {
		return
	}
	c.key(path, b.Key)
	c.required(path+".label", b.Label)
	c.str(path+".label", b.Label, MaxLabel)
	c.icon(path+".icon", b.Icon)
	if b.IconOnly && b.Icon == "" {
		c.bad(path+".icon", "an icon-only button needs an icon")
	}
	switch b.Style {
	case "", ButtonMuted, ButtonOutline, ButtonAttention, ButtonDestructive, ButtonLink:
	case "primary":
		c.bad(path+".style", `no filled buttons: use "attention" for the main action`)
	default:
		c.bad(path+".style", "unknown style %q", b.Style)
	}
	if b.Action == nil {
		c.bad(path+".action", "required")
	}
	c.action(path+".action", b.Action)
}

func (c *checker) header(path string, h *Header) {
	c.icon(path+".icon", h.Icon)
	c.str(path+".title", h.Title, MaxHeaderTitle)
	c.inline(path+".trailing", h.Trailing, MaxLabel)
	c.pill(path+".pill", h.Pill)
	c.inline(path+".subline", h.Subline, MaxLabel)
	c.icon(path+".sublineIcon", h.SublineIcon)
	c.buttons(path+".actions", h.Actions, MaxHeaderButtons)
	c.str(path+".tabTitle", h.TabTitle, MaxTabTitle)
}

func (c *checker) tabs(path string, t *Tabs) {
	if len(t.Items) == 0 {
		c.bad(path+".items", "at least one tab")
	}
	if len(t.Items) > MaxTabs {
		c.bad(path+".items", "%d tabs, at most %d", len(t.Items), MaxTabs)
	}
	found := false
	for i, tab := range t.Items {
		p := fmt.Sprintf("%s.items[%d]", path, i)
		c.key(p, tab.Key)
		c.required(p+".label", tab.Label)
		c.str(p+".label", tab.Label, MaxTabTitle)
		c.pill(p+".badge", tab.Badge)
		found = found || tab.Key == t.Active
	}
	if !found {
		c.bad(path+".active", "%q is not one of the tabs", t.Active)
	}
}

// height checks a thread or terminal node's height.
func (c *checker) height(path string, h Height) {
	if px := h.Px(); h.mode == "px" && (px < MinHeightPx || px > MaxHeightPx) {
		c.bad(path, "%d px is outside %d..%d", px, MinHeightPx, MaxHeightPx)
	}
}

// node checks one node at depth (1 = top level).
func (c *checker) node(path string, n Node, depth int) {
	c.key(path, n.Key)
	if depth > MaxDepth {
		c.bad(path, "nested deeper than %d", MaxDepth)
	}
	kinds := 0
	for _, set := range []bool{n.Text != nil, n.Markdown != nil, n.Pairs != nil, n.List != nil, n.Chips != nil,
		n.Log != nil, n.Actions != nil, n.Progress != nil, n.Notice != nil, n.Empty != nil, n.Section != nil,
		n.Form != nil, n.Thread != nil, n.Terminal != nil} {
		if set {
			kinds++
		}
	}
	if kinds != 1 {
		c.bad(path, "a node has exactly one kind (text, markdown, pairs, list, chips, log, actions, progress, notice, empty, section, form, thread, terminal); this one has %d", kinds)
		return
	}
	switch {
	case n.Text != nil:
		p := path + ".text"
		if n.Text.Content == nil {
			c.bad(p+".content", "required")
		}
		c.inline(p+".content", n.Text.Content, MaxTextContent)
		if !slices.Contains([]TextSize{TextBase, "base", TextSm, TextLg}, n.Text.Size) {
			c.bad(p+".size", "unknown size %q", n.Text.Size)
		}
	case n.Markdown != nil:
		if len(n.Markdown.Source) > MaxMarkdown {
			c.bad(path+".markdown.source", "%d bytes, at most %d", len(n.Markdown.Source), MaxMarkdown)
		}
		c.str(path+".markdown.source", n.Markdown.Source, MaxMarkdown)
	case n.Pairs != nil:
		for i, it := range n.Pairs.Items {
			p := fmt.Sprintf("%s.pairs.items[%d]", path, i)
			c.key(p, it.Key)
			c.required(p+".label", it.Label)
			c.str(p+".label", it.Label, MaxPairLabel)
			c.inline(p+".value", it.Value, MaxTextContent)
			c.pill(p+".pill", it.Pill)
		}
	case n.List != nil:
		c.list(path+".list", n.List)
	case n.Chips != nil:
		for i, ch := range n.Chips.Chips {
			p := fmt.Sprintf("%s.chips.chips[%d]", path, i)
			c.key(p, ch.Key)
			c.required(p+".label", ch.Label)
			c.str(p+".label", ch.Label, MaxChipLabel)
			c.status(p+".status", ch.Status)
			c.inline(p+".meta", ch.Meta, MaxLabel)
			c.action(p+".action", ch.Action)
		}
	case n.Log != nil:
		c.log(path+".log", n.Log)
	case n.Actions != nil:
		c.buttons(path+".actions.buttons", n.Actions.Buttons, MaxBarButtons)
		if !slices.Contains([]Align{"", AlignStart, AlignEnd}, n.Actions.Align) {
			c.bad(path+".actions.align", "unknown align %q", n.Actions.Align)
		}
	case n.Progress != nil:
		p := path + ".progress"
		if v := n.Progress.Value; v != nil && (*v < 0 || *v > 1) {
			c.bad(p+".value", "%g is outside 0..1", *v)
		}
		c.str(p+".label", n.Progress.Label, MaxLabel)
		c.inline(p+".meta", n.Progress.Meta, MaxLabel)
		c.tone(p+".tone", n.Progress.Tone)
	case n.Notice != nil:
		p := path + ".notice"
		c.tone(p+".tone", n.Notice.Tone)
		c.str(p+".title", n.Notice.Title, MaxLabel)
		c.inline(p+".body", n.Notice.Body, MaxTextContent)
		if len(n.Notice.Detail) > MaxNoticeDetail {
			c.bad(p+".detail", "%d bytes, at most %d", len(n.Notice.Detail), MaxNoticeDetail)
		}
		c.icon(p+".icon", n.Notice.Icon)
		c.buttons(p+".actions", n.Notice.Actions, MaxNoticeButtons)
	case n.Empty != nil:
		p := path + ".empty"
		c.glyph(p+".glyph", n.Empty.Glyph)
		c.str(p+".title", n.Empty.Title, MaxLabel)
		c.inline(p+".body", n.Empty.Body, MaxTextContent)
		c.buttons(p+".actions", n.Empty.Actions, MaxEmptyButtons)
	case n.Section != nil:
		p := path + ".section"
		s := n.Section
		c.str(p+".title", s.Title, MaxSectionTitle)
		c.inline(p+".meta", s.Meta, MaxLabel)
		c.pill(p+".pill", s.Pill)
		c.buttons(p+".actions", s.Actions, MaxSectionButton)
		c.tone(p+".tone", s.Tone)
		for i, ch := range s.Children {
			c.node(fmt.Sprintf("%s.children[%d]", p, i), ch, depth+1)
		}
	case n.Form != nil:
		c.form(path+".form", n.Form)
	case n.Thread != nil:
		c.required(path+".thread.threadId", n.Thread.ThreadID)
		c.str(path+".thread.threadId", n.Thread.ThreadID, MaxLabel)
		c.str(path+".thread.placeholder", n.Thread.Placeholder, MaxLabel)
		c.height(path+".thread.height", n.Thread.Height)
	case n.Terminal != nil:
		c.required(path+".terminal.terminalId", n.Terminal.TerminalID)
		c.str(path+".terminal.terminalId", n.Terminal.TerminalID, MaxLabel)
		if r := n.Terminal.Rows; r != 0 && (r < 4 || r > 60) {
			c.bad(path+".terminal.rows", "%d is outside 4..60", r)
		}
		c.str(path+".terminal.title", n.Terminal.Title, MaxLabel)
		c.height(path+".terminal.height", n.Terminal.Height)
		c.buttons(path+".terminal.actions", n.Terminal.Actions, MaxTerminalButtons)
	}
}

func (c *checker) list(path string, l *List) {
	if !slices.Contains([]GlyphStyle{"", GlyphDot, GlyphIcon}, l.GlyphStyle) {
		c.bad(path+".glyphStyle", "unknown style %q", l.GlyphStyle)
	}
	c.str(path+".emptyText", l.EmptyText, MaxLabel)
	for i, r := range l.Rows {
		p := fmt.Sprintf("%s.rows[%d]", path, i)
		c.key(p, r.Key)
		c.glyph(p+".glyph", r.Glyph)
		c.required(p+".title", r.Title)
		c.str(p+".title", r.Title, MaxLabel)
		c.inline(p+".titleMeta", r.TitleMeta, MaxLabel)
		c.pill(p+".pill", r.Pill)
		c.inline(p+".line2", r.Line2, MaxTextContent)
		c.inline(p+".trailing", r.Trailing, MaxLabel)
		c.buttons(p+".actions", r.Actions, MaxRowButtons)
		c.action(p+".action", r.Action)
	}
}

func (c *checker) log(path string, l *Log) {
	c.logs++
	if l.Text != "" && len(l.Lines) > 0 {
		c.bad(path, "text or lines, not both")
	}
	size := len(l.Text)
	for i, ln := range l.Lines {
		size += len(ln.Text) + 1
		c.tone(fmt.Sprintf("%s.lines[%d].tone", path, i), ln.Tone)
	}
	c.logBytes += size
	if size > MaxLogText {
		c.bad(path, "%d bytes of log text, at most %d per render", size, MaxLogText)
	}
	if r := l.Rows; r != 0 && (r < 4 || r > 40) {
		c.bad(path+".rows", "%d is outside 4..40", r)
	}
	c.str(path+".title", l.Title, MaxLabel)
}

func (c *checker) form(path string, f *Form) {
	c.formNames = map[string]string{}
	secret := false
	for i, fl := range f.Fields {
		if c.field(fmt.Sprintf("%s.fields[%d]", path, i), fl, false) {
			secret = true
		}
	}
	if f.Submit != nil {
		c.button(path+".submit", f.Submit)
		if secret && f.Submit.Action != nil && f.Submit.Action.Event == "" {
			c.bad(path+".submit.action", "a form with a secret field submits through an event, never a command (args reach argv and logs)")
		}
	}
	c.buttons(path+".secondary", f.Secondary, MaxBarButtons)
	c.str(path+".error", f.Error, MaxLabel)
}

// field checks one field and reports whether it holds a secret input.
func (c *checker) field(path string, f Field, inFieldset bool) bool {
	c.key(path, f.Key)
	controls := 0
	for _, set := range []bool{f.Input != nil, f.Select != nil, f.Toggle != nil, f.Fieldset != nil} {
		if set {
			controls++
		}
	}
	if controls != 1 {
		c.bad(path, "a field has exactly one of input, select, toggle or fieldset")
		return false
	}
	c.str(path+".label", f.Label, MaxLabel)
	c.inline(path+".description", f.Description, MaxTextContent)
	c.str(path+".error", f.Error, MaxLabel)
	if f.Change != nil {
		if f.Change.Event == "" {
			c.bad(path+".change", "a change action is an event")
		}
		c.action(path+".change", f.Change)
	}
	if f.Fieldset != nil {
		if inFieldset {
			c.bad(path+".fieldset", "fieldsets do not nest")
			return false
		}
		fs := f.Fieldset
		c.str(path+".fieldset.label", fs.Label, MaxLabel)
		c.inline(path+".fieldset.hint", fs.Hint, MaxTextContent)
		c.str(path+".fieldset.error", fs.Error, MaxLabel)
		if len(fs.Fields) == 0 {
			c.bad(path+".fieldset.fields", "at least one field")
		}
		secret := false
		for i, sub := range fs.Fields {
			if c.field(fmt.Sprintf("%s.fieldset.fields[%d]", path, i), sub, true) {
				secret = true
			}
		}
		return secret
	}
	c.required(path+".name", f.Name)
	if first, dup := c.formNames[f.Name]; dup && f.Name != "" {
		// The values are keyed by name: one field's value (or a secret's store) would
		// silently stand for the other's.
		c.bad(path+".name", "%q is already the name of %s in this form", f.Name, first)
	} else {
		c.formNames[f.Name] = path
	}
	switch {
	case f.Input != nil:
		in := f.Input
		p := path + ".input"
		if !slices.Contains([]InputKind{"", InputText, InputSecret}, in.Kind) {
			c.bad(p+".kind", "unknown kind %q", in.Kind)
		}
		if in.MaxLength < 0 {
			c.bad(p+".maxLength", "negative")
		}
		if in.Pattern != "" {
			if _, err := regexp.Compile(in.Pattern); err != nil {
				c.bad(p+".pattern", "%v", err)
			}
		}
		c.str(p+".placeholder", in.Placeholder, MaxLabel)
		c.str(p+".patternMessage", in.PatternMessage, MaxLabel)
		if in.Kind == InputSecret {
			if in.Value != "" {
				c.bad(p+".value", "a secret input never carries its value")
			}
			if in.Store != "" && !StorePattern.MatchString(in.Store) {
				c.bad(p+".store", "%q must match %s", in.Store, StorePattern)
			}
			if f.Change != nil {
				c.bad(path+".change", "a secret input sends no change events")
			}
			return true
		}
		if in.HasValue || in.Store != "" {
			c.bad(p, "hasValue and store are for secret inputs")
		}
		c.str(p+".value", in.Value, MaxTextContent)
	case f.Select != nil:
		s := f.Select
		p := path + ".select"
		if len(s.Options) > MaxOptions {
			c.bad(p+".options", "%d options, at most %d", len(s.Options), MaxOptions)
		}
		if !slices.Contains([]SelectStyle{"", SelectDropdown, SelectList}, s.Style) {
			c.bad(p+".style", "unknown style %q", s.Style)
		}
		if !slices.Contains([]OptionsSource{"", OptionsProjects, OptionsThreads}, s.OptionsSource) {
			c.bad(p+".optionsSource", "unknown source %q", s.OptionsSource)
		}
		if s.OptionsSource != "" && len(s.Options) > 0 {
			c.bad(p+".options", "the host fills the options of a select with optionsSource")
		}
		if !s.Multiple && len(s.Value) > 1 {
			c.bad(p+".value", "one value unless multiple")
		}
		c.str(p+".placeholder", s.Placeholder, MaxLabel)
		for i, o := range s.Options {
			op := fmt.Sprintf("%s.options[%d]", p, i)
			c.key(op, o.Key)
			c.required(op+".label", o.Label)
			c.str(op+".label", o.Label, MaxLabel)
			c.str(op+".value", o.Value, MaxLabel)
			c.inline(op+".description", o.Description, MaxLabel)
		}
	}
	return false
}

// validUTF8 reports whether every string in v is valid UTF-8 (utf8 then names the ones
// that are not; most views have none, and paths cost).
func validUTF8(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		return v.IsNil() || validUTF8(v.Elem())
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Type().Field(i).IsExported() && !validUTF8(v.Field(i)) {
				return false
			}
		}
	case reflect.Slice, reflect.Array:
		for i := range v.Len() {
			if !validUTF8(v.Index(i)) {
				return false
			}
		}
	case reflect.Map:
		iter := v.MapRange()
		for iter.Next() {
			if !validUTF8(iter.Key()) || !validUTF8(iter.Value()) {
				return false
			}
		}
	case reflect.String:
		return utf8.ValidString(v.String())
	}
	return true
}

// utf8 reports every string in v that is not valid UTF-8 (struct fields by their JSON
// names, slice elements, map keys and values). JSON replaces each invalid byte with
// U+FFFD, so the host would check (and show) other text, of another size, than the
// plugin did: a log or event data under its byte limit here could be over it there.
func (c *checker) utf8(path string, v reflect.Value) {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			c.utf8(path, v.Elem())
		}
	case reflect.Struct:
		t := v.Type()
		for i := range t.NumField() {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "" {
				name = strings.ToLower(f.Name)
			}
			if path != "" {
				name = path + "." + name
			}
			c.utf8(name, v.Field(i))
		}
	case reflect.Slice, reflect.Array:
		for i := range v.Len() {
			c.utf8(fmt.Sprintf("%s[%d]", path, i), v.Index(i))
		}
	case reflect.Map:
		iter := v.MapRange()
		for iter.Next() {
			k := fmt.Sprint(iter.Key().Interface())
			c.utf8(path+" key", iter.Key())
			c.utf8(path+"."+k, iter.Value())
		}
	case reflect.String:
		if !utf8.ValidString(v.String()) {
			c.bad(path, "not valid UTF-8")
		}
	}
}
