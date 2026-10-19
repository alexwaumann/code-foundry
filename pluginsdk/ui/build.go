package ui

import "time"

// Plain returns an Inline of plain text.
func Plain(s string) *Inline { return &Inline{Text: s} }

// Spans returns an Inline of spans.
func Spans(spans ...Span) *Inline { return &Inline{Spans: spans} }

// T returns a text span.
func T(s string) Span { return Span{Text: s} }

// At returns a ticking time span.
func At(t time.Time, style TimeStyle) Span { return Span{Time: &Time{At: t, Style: style}} }

// For returns a duration span ("1m 40s").
func For(d time.Duration) Span { return Span{Duration: &Duration{Ms: d.Milliseconds()}} }

// WithTone returns s with a tone.
func (s Span) WithTone(t Tone) Span { s.Tone = t; return s }

// AsMono returns s in the monospace font.
func (s Span) AsMono() Span { s.Mono = true; return s }

// AsStrong returns s emphasised.
func (s Span) AsStrong() Span { s.Strong = true; return s }

// Link returns s as a link to url (http or https).
func (s Span) Link(url string) Span { s.URL = url; return s }

// NewPill returns a pill.
func NewPill(label string, tone Tone) *Pill { return &Pill{Label: label, Tone: tone} }

// StatusGlyph returns a status glyph.
func StatusGlyph(s Status) *Glyph { return &Glyph{Status: s} }

// IconGlyph returns an icon glyph.
func IconGlyph(icon string, tone Tone) *Glyph { return &Glyph{Icon: icon, Tone: tone} }

// EventAction sends event (with data) to the plugin.
func EventAction(event, data string) *Action { return &Action{Event: event, Data: data} }

// CommandAction runs a command.
func CommandAction(name string, args map[string]string) *Action {
	return &Action{Command: &Command{Name: name, Args: args}}
}

// URLAction opens url.
func URLAction(url string) *Action { return &Action{OpenURL: url} }

// CopyAction copies text.
func CopyAction(text string) *Action { return &Action{Copy: text} }

// EventButton returns a button sending event to the plugin.
func EventButton(key, label, event string) Button {
	return Button{Key: key, Label: label, Action: EventAction(event, "")}
}

// CommandButton returns a button running a command.
func CommandButton(key, label, name string, args map[string]string) Button {
	return Button{Key: key, Label: label, Action: CommandAction(name, args)}
}

// URLButton returns a button opening url.
func URLButton(key, label, url string) Button {
	return Button{Key: key, Label: label, Action: URLAction(url)}
}

// CopyButton returns a button copying text.
func CopyButton(key, label, text string) Button {
	return Button{Key: key, Label: label, Action: CopyAction(text)}
}

// WithIcon returns b with a lucide icon.
func (b Button) WithIcon(icon string) Button { b.Icon = icon; return b }

// WithStyle returns b with a style.
func (b Button) WithStyle(s ButtonStyle) Button { b.Style = s; return b }

// WithData returns b with data for its event (at most 1 KB; act.Data in Surface.Act),
// such as the id of the row the button is on.
func (b Button) WithData(data string) Button {
	if b.Action != nil {
		a := *b.Action
		a.Data = data
		b.Action = &a
	}
	return b
}

// AsIconOnly returns b drawn as its icon (the label becomes its tooltip).
func (b Button) AsIconOnly() Button { b.IconOnly = true; return b }

// NewView returns a view.
func NewView(header *Header, nodes ...Node) View { return View{Header: header, Nodes: nodes} }

// NewHeader returns a header with a title.
func NewHeader(title string) *Header { return &Header{Title: title} }

// NewTabs returns tabs with active selected.
func NewTabs(active string, tabs ...Tab) *Tabs { return &Tabs{Items: tabs, Active: active} }

// NewTab returns a tab.
func NewTab(key, label string) Tab { return Tab{Key: key, Label: label} }

// NewText returns a text node.
func NewText(key string, content *Inline) Node { return Node{Key: key, Text: &Text{Content: content}} }

// NewMarkdown returns a markdown node.
func NewMarkdown(key, source string) Node { return Node{Key: key, Markdown: &Markdown{Source: source}} }

// NewPairs returns a pairs node.
func NewPairs(key string, items ...Pair) Node { return Node{Key: key, Pairs: &Pairs{Items: items}} }

// NewPair returns one pair.
func NewPair(key, label string, value *Inline) Pair {
	return Pair{Key: key, Label: label, Value: value}
}

// NewList returns a list node.
func NewList(key string, rows ...Row) Node { return Node{Key: key, List: &List{Rows: rows}} }

// NewRow returns a list row.
func NewRow(key, title string) Row { return Row{Key: key, Title: title} }

// NewChips returns a chips node.
func NewChips(key string, chips ...Chip) Node { return Node{Key: key, Chips: &Chips{Chips: chips}} }

// NewChip returns a chip.
func NewChip(key, label string, status Status) Chip {
	return Chip{Key: key, Label: label, Status: status}
}

// NewLog returns a log node.
func NewLog(key, text string) Node { return Node{Key: key, Log: &Log{Text: text}} }

// NewActions returns an actions bar.
func NewActions(key string, buttons ...Button) Node {
	return Node{Key: key, Actions: &Actions{Buttons: buttons}}
}

// NewProgress returns a progress node; a nil value is indeterminate.
func NewProgress(key, label string, value *float64) Node {
	return Node{Key: key, Progress: &Progress{Label: label, Value: value}}
}

// Fraction returns a pointer for Progress.Value.
func Fraction(v float64) *float64 { return &v }

// NewNotice returns a notice.
func NewNotice(key string, tone Tone, title string, body *Inline) Node {
	return Node{Key: key, Notice: &Notice{Tone: tone, Title: title, Body: body}}
}

// NewEmpty returns an empty state.
func NewEmpty(key, title string, body *Inline) Node {
	return Node{Key: key, Empty: &Empty{Title: title, Body: body}}
}

// NewSection returns a section.
func NewSection(key, title string, children ...Node) Node {
	return Node{Key: key, Section: &Section{Title: title, Children: children}}
}

// NewForm returns a form submitting through submit.
func NewForm(key string, submit *Button, fields ...Field) Node {
	return Node{Key: key, Form: &Form{Fields: fields, Submit: submit}}
}

// TextField returns a text input field.
func TextField(key, name, label string) Field {
	return Field{Key: key, Name: name, Label: label, Input: &Input{}}
}

// SecretField returns a secret input field; store, when set, has the host keep the
// submitted value in the plugin's secrets under that key.
func SecretField(key, name, label, store string) Field {
	return Field{Key: key, Name: name, Label: label, Input: &Input{Kind: InputSecret, Store: store}}
}

// SelectField returns a select field.
func SelectField(key, name, label string, options ...Option) Field {
	return Field{Key: key, Name: name, Label: label, Select: &Select{Options: options}}
}

// ToggleField returns a switch field.
func ToggleField(key, name, label string, value bool) Field {
	return Field{Key: key, Name: name, Label: label, Toggle: &Toggle{Value: value}}
}

// NewFieldset returns a fieldset grouping fields.
func NewFieldset(key, label string, fields ...Field) Field {
	return Field{Key: key, Fieldset: &Fieldset{Label: label, Fields: fields}}
}

// Opt returns a select option.
func Opt(key, value, label string) Option { return Option{Key: key, Value: value, Label: label} }

// NewThread returns a node rendering a plugin-owned thread.
func NewThread(key, threadID string) Node { return Node{Key: key, Thread: &Thread{ThreadID: threadID}} }

// NewTerminal returns a node rendering a plugin-owned terminal.
func NewTerminal(key, terminalID string) Node {
	return Node{Key: key, Terminal: &Terminal{TerminalID: terminalID}}
}

// NewColumns returns a columns node of 2 to 4 columns that stacks them in order when its
// container is too narrow (always in the side panel).
func NewColumns(key string, columns ...Column) Node {
	return Node{Key: key, Columns: &Columns{Items: columns}}
}

// NewColumn returns a column of weight 1 (see Column.Weight and Column.Width).
func NewColumn(key string, children ...Node) Column { return Column{Key: key, Children: children} }

// WithWeight returns c sharing the free width by weight (1..6).
func (c Column) WithWeight(w int) Column { c.Weight, c.Width = w, 0; return c }

// WithWidth returns c with a fixed width in px (160..640).
func (c Column) WithWidth(px int) Column { c.Width, c.Weight = px, 0; return c }

// NewPane returns a pane of the given height (HeightAuto, HeightFill, HeightPx(n)) that
// scrolls its nodes when they are taller.
func NewPane(key string, height Height, children ...Node) Node {
	return Node{Key: key, Pane: &Pane{Height: height, Children: children}}
}

// NewGrid returns a grid of items in as many columns of at least GridMinWidth px as fit
// (one, stacked, in the side panel); set Grid.MinWidth for narrower or wider columns.
func NewGrid(key string, items ...GridItem) Node {
	return Node{Key: key, Grid: &Grid{Items: items}}
}

// NewGridItem returns a grid item one column wide.
func NewGridItem(key string, children ...Node) GridItem {
	return GridItem{Key: key, Children: children}
}

// WithSpan returns it spanning n columns (1..MaxGridSpan; fewer when the grid has fewer).
func (it GridItem) WithSpan(n int) GridItem { it.Span = n; return it }

// NewDivider returns a hairline, with a centred label unless label is "".
func NewDivider(key, label string) Node { return Node{Key: key, Divider: &Divider{Label: label}} }

// NewSpacer returns size px of extra space (0: SpacerSize).
func NewSpacer(key string, size int) Node { return Node{Key: key, Spacer: &Spacer{Size: size}} }

// NewFlexSpacer returns a spacer that pushes the nodes after it to the bottom of its box
// (see Spacer).
func NewFlexSpacer(key string) Node { return Node{Key: key, Spacer: &Spacer{Flex: true}} }

// NewGroup returns text, chips, actions and progress nodes on one wrapping line.
func NewGroup(key string, align Align, items ...Node) Node {
	return Node{Key: key, Group: &Group{Items: items, Align: align}}
}

// NewContainer returns a container capping its nodes at width (ContainerNarrow,
// ContainerWide, ContainerFull), centred.
func NewContainer(key string, width ContainerWidth, children ...Node) Node {
	return Node{Key: key, Container: &Container{Width: width, Children: children}}
}

// NewMasterDetail returns a list beside the detail of its selected row ("" for none; see
// MasterDetail).
func NewMasterDetail(key string, list List, selected string, detail ...Node) Node {
	return Node{Key: key, MasterDetail: &MasterDetail{List: list, Selected: selected, Detail: detail}}
}

// NewTabsNode returns a node's own tab strip (tabs: NewTabs) over the active tab's nodes.
func NewTabsNode(key string, tabs *Tabs, children ...Node) Node {
	n := Node{Key: key, Tabs: &TabsNode{Children: children}}
	if tabs != nil {
		n.Tabs.Tabs = *tabs
	}
	return n
}
