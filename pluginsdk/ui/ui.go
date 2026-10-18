// Package ui is the typed view model of plugin surfaces: Go structs for every v1 node
// and value type of the surface schema (header, tabs, text, markdown, pairs, list,
// chips, log, actions, progress, notice, empty, section, form with fieldsets and option
// sources, thread, terminal; inline spans with times and durations), builders, and
// Validate, which checks a view against the host's rules and limits before it leaves
// the plugin. The code-foundry-plugin skill's reference/primitives.md shows every node
// as JSON and Go.
//
// The view travels as JSON. Field names are lowerCamel; enums are short lowercase
// strings ("error", "running"); an Inline whose only content is plain text encodes as a
// bare string. A node is an object with a key and exactly one kind field:
//
//	{"key": "stages", "chips": {"chips": [{"key": "c1", "label": "Build", "status": "ok"}]}}
//
// The host never renders a filled button (no "primary" style; the main action is
// ButtonAttention), shows emerald only for ToneOK in pills and status glyphs, and sends
// destructive commands through its own confirm dialog.
package ui

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// Tone colours text, pills, borders and notices. The zero value is neutral.
type Tone string

const (
	ToneNeutral   Tone = ""
	ToneMuted     Tone = "muted"
	ToneAttention Tone = "attention" // amber: needs the user
	ToneError     Tone = "error"     // red
	ToneOK        Tone = "ok"        // emerald, in pills and status glyphs only
)

// Status is a step's or a row's state; the host draws it as a dot or an icon.
type Status string

const (
	StatusNone      Status = ""
	StatusOK        Status = "ok"
	StatusFailed    Status = "failed"
	StatusAttention Status = "attention"
	StatusRunning   Status = "running" // a spinner
	StatusPending   Status = "pending" // queued, not started
	StatusSkipped   Status = "skipped"
	StatusOff       Status = "off" // aborted, disabled
)

// TimeStyle is how a Time span ticks.
type TimeStyle string

const (
	TimeRelative  TimeStyle = "relative"  // "12s ago", "in 3 days" (the default)
	TimeElapsed   TimeStyle = "elapsed"   // "4m 12s" since At, counting up
	TimeCountdown TimeStyle = "countdown" // "9:41" until At, then "expired"
)

// TextSize is a text node's size.
type TextSize string

const (
	TextBase TextSize = ""   // 13 px
	TextSm   TextSize = "sm" // 12 px, muted unless the spans say otherwise
	TextLg   TextSize = "lg" // 18 px mono: codes
)

// GlyphStyle is how a list draws row glyphs.
type GlyphStyle string

const (
	GlyphDot  GlyphStyle = "dot" // the default
	GlyphIcon GlyphStyle = "icon"
)

// Align places an actions bar.
type Align string

const (
	AlignStart Align = "start" // the default
	AlignEnd   Align = "end"
)

// InputKind is a text input's kind.
type InputKind string

const (
	InputText   InputKind = "text" // the default
	InputSecret InputKind = "secret"
)

// SelectStyle is how a select renders.
type SelectStyle string

const (
	SelectDropdown SelectStyle = "dropdown" // the default
	SelectList     SelectStyle = "list"     // radio (or checkbox) rows with descriptions
)

// OptionsSource makes the host fill a select's options and keep them current.
type OptionsSource string

const (
	OptionsProjects OptionsSource = "projects"
	OptionsThreads  OptionsSource = "threads"
)

// ButtonStyle is a button's look. There is no filled style.
type ButtonStyle string

const (
	ButtonMuted       ButtonStyle = "muted" // the default: borderless
	ButtonOutline     ButtonStyle = "outline"
	ButtonAttention   ButtonStyle = "attention"   // amber outline: the one thing that needs the user next
	ButtonDestructive ButtonStyle = "destructive" // red on hover; pair with a command that confirms
	ButtonLink        ButtonStyle = "link"
)

// View is everything a surface instance shows: the header, optional tabs, and the
// body's nodes (the active tab's, when there are tabs).
type View struct {
	Header *Header `json:"header,omitempty"`
	Tabs   *Tabs   `json:"tabs,omitempty"`
	Nodes  []Node  `json:"nodes"`
}

// Header is the surface's identity and freshness line. The title is one line; the
// sub-line (after SublineIcon, a neutral icon from Icons) wraps to two and is cut after
// that, never revealed: longer guidance belongs in a Text node.
type Header struct {
	Icon        string   `json:"icon,omitempty"`  // empty: the manifest's
	Title       string   `json:"title,omitempty"` // empty: the manifest's
	Trailing    *Inline  `json:"trailing,omitempty"`
	Pill        *Pill    `json:"pill,omitempty"`
	Subline     *Inline  `json:"subline,omitempty"`
	SublineIcon string   `json:"sublineIcon,omitempty"`
	Actions     []Button `json:"actions,omitempty"` // icon-only, at most 2
	TabTitle    string   `json:"tabTitle,omitempty"`
}

// Tabs are navigation tabs inside the surface (styled like the PR view's). The host
// sends a "tab" act when the user switches and keeps form drafts per tab; the plugin
// answers with the view of the new Active tab.
type Tabs struct {
	Items  []Tab  `json:"items"`
	Active string `json:"active"`
}

// Tab is one tab.
type Tab struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Badge *Pill  `json:"badge,omitempty"`
}

// Glyph is a status or an allowlisted lucide icon.
type Glyph struct {
	Status Status `json:"status,omitempty"`
	Icon   string `json:"icon,omitempty"`
	Tone   Tone   `json:"tone,omitempty"` // icon only
}

// Inline is text that may mix tones, links and ticking times. With only Text set it
// encodes as a bare JSON string.
type Inline struct {
	Text  string
	Spans []Span
}

type inlineJSON struct {
	Text  string `json:"text,omitempty"`
	Spans []Span `json:"spans,omitempty"`
}

// MarshalJSON encodes a plain Inline as a string.
func (in Inline) MarshalJSON() ([]byte, error) {
	if len(in.Spans) == 0 {
		return json.Marshal(in.Text)
	}
	return json.Marshal(inlineJSON(in))
}

// UnmarshalJSON accepts a string or {text, spans}.
func (in *Inline) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*in = Inline{Text: s}
		return nil
	}
	var j inlineJSON
	if err := json.Unmarshal(b, &j); err != nil {
		return errors.New("inline: want a string or {text, spans}")
	}
	*in = Inline(j)
	return nil
}

// Span is one piece of an Inline: text, a ticking time, or a duration.
type Span struct {
	Text     string    `json:"text,omitempty"`
	Time     *Time     `json:"time,omitempty"`
	Duration *Duration `json:"duration,omitempty"`
	Tone     Tone      `json:"tone,omitempty"`
	Mono     bool      `json:"mono,omitempty"`
	Strong   bool      `json:"strong,omitempty"`
	// URL makes the span a link the host opens (http and https only).
	URL string `json:"url,omitempty"`
}

// Time is a moment the host formats and ticks on its own clock.
type Time struct {
	At    time.Time `json:"at"`
	Style TimeStyle `json:"style,omitempty"`
}

// Duration is a fixed length the host formats like an elapsed time ("1m 40s"), so
// finished and running durations read alike.
type Duration struct {
	Ms int64 `json:"ms"`
}

// Pill is a small tinted label.
type Pill struct {
	Label string `json:"label"`
	Tone  Tone   `json:"tone,omitempty"`
}

// Command names a command and its args.
type Command struct {
	Name string            `json:"name"`
	Args map[string]string `json:"args,omitempty"`
}

// Action is what an element does: exactly one of Event (sent to the plugin as a
// surface act, with Data), Command (run with the panel's context, through the host's
// confirm dialog when it asks), OpenURL or Copy (handled by the host).
type Action struct {
	Event   string   `json:"event,omitempty"`
	Command *Command `json:"command,omitempty"`
	OpenURL string   `json:"openUrl,omitempty"`
	Copy    string   `json:"copy,omitempty"`
	Data    string   `json:"data,omitempty"` // event only, at most 1 KB
}

// Button is a button inside a header, row, section, notice, empty state, actions bar or
// form. Buttons are never free nodes.
type Button struct {
	Key      string      `json:"key"`
	Label    string      `json:"label"` // required, also when IconOnly (aria-label)
	Icon     string      `json:"icon,omitempty"`
	Style    ButtonStyle `json:"style,omitempty"`
	Action   *Action     `json:"action,omitempty"`
	Disabled bool        `json:"disabled,omitempty"`
	Busy     bool        `json:"busy,omitempty"` // plugin-owned pending
	IconOnly bool        `json:"iconOnly,omitempty"`
}

// Node is one body element: a key unique in the view and exactly one kind.
type Node struct {
	Key      string    `json:"key"`
	Text     *Text     `json:"text,omitempty"`
	Markdown *Markdown `json:"markdown,omitempty"`
	Pairs    *Pairs    `json:"pairs,omitempty"`
	List     *List     `json:"list,omitempty"`
	Chips    *Chips    `json:"chips,omitempty"`
	Log      *Log      `json:"log,omitempty"`
	Actions  *Actions  `json:"actions,omitempty"`
	Progress *Progress `json:"progress,omitempty"`
	Notice   *Notice   `json:"notice,omitempty"`
	Empty    *Empty    `json:"empty,omitempty"`
	Section  *Section  `json:"section,omitempty"`
	Form     *Form     `json:"form,omitempty"`
	Thread   *Thread   `json:"thread,omitempty"`
	Terminal *Terminal `json:"terminal,omitempty"`
}

// Text is a sentence or a value to copy.
type Text struct {
	Content  *Inline  `json:"content"`
	Size     TextSize `json:"size,omitempty"`
	Copyable bool     `json:"copyable,omitempty"`
}

// Markdown is explanatory copy (GFM, at most 16 KB; raw HTML shows as text).
type Markdown struct {
	Source string `json:"source"`
}

// Pairs are facts about one thing.
type Pairs struct {
	Items []Pair `json:"items"`
}

// Pair is one fact.
type Pair struct {
	Key      string  `json:"key"`
	Label    string  `json:"label"`
	Value    *Inline `json:"value,omitempty"`
	Pill     *Pill   `json:"pill,omitempty"`
	Copyable bool    `json:"copyable,omitempty"`
}

// List is a list of things.
type List struct {
	Rows       []Row      `json:"rows"`
	GlyphStyle GlyphStyle `json:"glyphStyle,omitempty"`
	// Dense draws 24 px single-line rows: a row's line2 and its labelled buttons are
	// not shown (icon-only buttons and trailing are). For steps, env vars, short names.
	Dense     bool   `json:"dense,omitempty"`
	EmptyText string `json:"emptyText,omitempty"`
}

// Row is one list row.
type Row struct {
	Key       string   `json:"key"`
	Glyph     *Glyph   `json:"glyph,omitempty"`
	Title     string   `json:"title"`
	TitleMeta *Inline  `json:"titleMeta,omitempty"`
	Pill      *Pill    `json:"pill,omitempty"`
	Line2     *Inline  `json:"line2,omitempty"`
	Trailing  *Inline  `json:"trailing,omitempty"`
	Actions   []Button `json:"actions,omitempty"` // at most 3
	Action    *Action  `json:"action,omitempty"`  // the whole row
	Selected  bool     `json:"selected,omitempty"`
}

// Chips is a strip of stages or steps.
type Chips struct {
	Chips []Chip `json:"chips"`
}

// Chip is one stage.
type Chip struct {
	Key      string  `json:"key"`
	Label    string  `json:"label"`
	Status   Status  `json:"status,omitempty"`
	Meta     *Inline `json:"meta,omitempty"`
	Selected bool    `json:"selected,omitempty"`
	Action   *Action `json:"action,omitempty"`
}

// Log is a monospace tail. Text (or Lines, each with its own tone) is replaced by a
// render.
type Log struct {
	Text      string    `json:"text,omitempty"`
	Lines     []LogLine `json:"lines,omitempty"`
	NoFollow  bool      `json:"noFollow,omitempty"`
	Rows      int       `json:"rows,omitempty"` // 4..40, 0 = 16
	Wrap      bool      `json:"wrap,omitempty"`
	Truncated bool      `json:"truncated,omitempty"`
	Title     string    `json:"title,omitempty"`
}

// LogLine is a log line with a tone (warnings amber, errors red). ANSI is not parsed.
type LogLine struct {
	Text string `json:"text"`
	Tone Tone   `json:"tone,omitempty"`
}

// Actions is a bar of buttons.
type Actions struct {
	Buttons []Button `json:"buttons"` // at most 6
	Align   Align    `json:"align,omitempty"`
}

// Progress is one operation's progress; a nil Value is indeterminate.
type Progress struct {
	Value *float64 `json:"value,omitempty"` // 0..1
	Label string   `json:"label,omitempty"`
	Meta  *Inline  `json:"meta,omitempty"`
	Tone  Tone     `json:"tone,omitempty"` // ToneError when it failed
}

// Notice is a state the user should know about.
type Notice struct {
	Tone    Tone     `json:"tone,omitempty"` // neutral, attention or error
	Title   string   `json:"title,omitempty"`
	Body    *Inline  `json:"body,omitempty"`
	Detail  string   `json:"detail,omitempty"` // mono, at most 2 KB
	Icon    string   `json:"icon,omitempty"`
	Actions []Button `json:"actions,omitempty"` // at most 3
}

// Empty is the whole body when there is nothing yet.
type Empty struct {
	Glyph   *Glyph   `json:"glyph,omitempty"`
	Title   string   `json:"title,omitempty"`
	Body    *Inline  `json:"body,omitempty"`
	Actions []Button `json:"actions,omitempty"` // at most 2
}

// Section groups nodes under a title, optionally as a card or collapsible.
type Section struct {
	Title       string   `json:"title,omitempty"`
	Meta        *Inline  `json:"meta,omitempty"`
	Pill        *Pill    `json:"pill,omitempty"`
	Actions     []Button `json:"actions,omitempty"` // at most 2
	Collapsible bool     `json:"collapsible,omitempty"`
	Collapsed   bool     `json:"collapsed,omitempty"` // initial; the user's toggle wins
	Card        bool     `json:"card,omitempty"`
	Tone        Tone     `json:"tone,omitempty"` // card border: attention or error
	// Stale marks last-known data (the backend is unreachable): the host dims it.
	Stale    bool   `json:"stale,omitempty"`
	Children []Node `json:"children"`
}

// Form is the one way values travel to the plugin.
type Form struct {
	Fields     []Field  `json:"fields"`
	Submit     *Button  `json:"submit,omitempty"` // event, or command when no secret field
	Secondary  []Button `json:"secondary,omitempty"`
	Error      string   `json:"error,omitempty"`
	Busy       bool     `json:"busy,omitempty"`       // disables the form (no spinner: Submit.Busy) for work past the act
	ResetToken string   `json:"resetToken,omitempty"` // a change drops every draft
}

// Field is a form field: exactly one of Input, Select, Toggle or Fieldset.
type Field struct {
	Key         string    `json:"key"`
	Name        string    `json:"name,omitempty"` // payload key and command arg name
	Label       string    `json:"label,omitempty"`
	Description *Inline   `json:"description,omitempty"`
	Error       string    `json:"error,omitempty"`
	Required    bool      `json:"required,omitempty"`
	Disabled    bool      `json:"disabled,omitempty"`
	Change      *Action   `json:"change,omitempty"` // event only; on a committed edit (blur, pick), not per keystroke
	Input       *Input    `json:"input,omitempty"`
	Select      *Select   `json:"select,omitempty"`
	Toggle      *Toggle   `json:"toggle,omitempty"`
	Fieldset    *Fieldset `json:"fieldset,omitempty"`
}

// Input is a one-line text or secret input.
type Input struct {
	Kind           InputKind `json:"kind,omitempty"`
	Value          string    `json:"value,omitempty"` // never for a secret
	Placeholder    string    `json:"placeholder,omitempty"`
	MaxLength      int       `json:"maxLength,omitempty"`
	Pattern        string    `json:"pattern,omitempty"`
	PatternMessage string    `json:"patternMessage,omitempty"`
	Mono           bool      `json:"mono,omitempty"`
	// HasValue (secret): a value is stored; the host shows "Saved · type to replace".
	HasValue bool `json:"hasValue,omitempty"`
	// Store (secret): on submit the host writes the value into the plugin's secret
	// namespace under this key and the submit carries {key, stored: true} instead.
	Store string `json:"store,omitempty"`
}

// Select picks one or more options.
type Select struct {
	Options       []Option      `json:"options,omitempty"` // at most 200
	Value         []string      `json:"value,omitempty"`   // one unless Multiple
	Multiple      bool          `json:"multiple,omitempty"`
	Style         SelectStyle   `json:"style,omitempty"` // with Multiple: a checkbox menu or checkbox rows
	Placeholder   string        `json:"placeholder,omitempty"`
	OptionsSource OptionsSource `json:"optionsSource,omitempty"` // host-filled options
}

// Option is one select option.
type Option struct {
	Key         string  `json:"key"`
	Value       string  `json:"value"`
	Label       string  `json:"label"`
	Description *Inline `json:"description,omitempty"` // list style only
	Disabled    bool    `json:"disabled,omitempty"`
}

// Toggle is a switch.
type Toggle struct {
	Value bool `json:"value"`
}

// Fieldset groups inputs under one label, hint and error (a checkbox group, a pair of
// related inputs). Fieldsets do not nest.
type Fieldset struct {
	Label  string  `json:"label,omitempty"`
	Hint   *Inline `json:"hint,omitempty"`
	Error  string  `json:"error,omitempty"`
	Fields []Field `json:"fields"`
}

// Thread renders a plugin-owned Claude thread (permission threads; Host.CreateThread)
// with the host's rendered thread view and its composer. A thread that is gone (removed,
// or not the plugin's) shows a muted empty state; an archived one still renders. Each
// Thread or Terminal node is a live stream the GUI attaches while it is on screen, at
// most two per view.
type Thread struct {
	ThreadID string `json:"threadId"`
	// ReadOnly leaves the composer out: the plugin alone sends (Host.SendThread).
	ReadOnly bool `json:"readOnly,omitempty"`
	// Placeholder is the composer's empty text ("Ask the assistant…").
	Placeholder string `json:"placeholder,omitempty"`
	// Height: HeightAuto (the zero value: about 420 px), HeightFill (the rest of the
	// panel's height, at least 240 px) or HeightPx(n).
	Height Height `json:"height,omitzero"`
}

// Terminal renders a plugin-owned terminal (permission terminals; Host.CreateTerminal)
// with the host's terminal view and an "Open in bottom panel" button, which shows it as a
// tab of the bottom panel of what the user is looking at. A terminal that is gone shows a
// muted empty state.
type Terminal struct {
	TerminalID string `json:"terminalId"`
	// Rows is the height in text rows (4..60, 0 = 16) when Height is HeightAuto.
	Rows  int    `json:"rows,omitempty"`
	Title string `json:"title,omitempty"`
	// Height: HeightAuto (the zero value: Rows), HeightFill or HeightPx(n).
	Height Height `json:"height,omitzero"`
	// Actions are up to 2 more buttons beside "Open in bottom panel" (Restart, Stop).
	Actions []Button `json:"actions,omitempty"`
}

// Height is a thread or terminal node's height: HeightAuto (the zero value), HeightFill or
// HeightPx(n). It travels as "auto", "fill" or a number of pixels.
type Height struct {
	mode string // "", "auto", "fill", "px"
	px   int
}

// Heights.
var (
	// HeightAuto is the host's default height for the node.
	HeightAuto = Height{mode: "auto"}
	// HeightFill takes the rest of the panel's height (at least 240 px).
	HeightFill = Height{mode: "fill"}
)

// HeightPx is a fixed height in CSS pixels (MinHeightPx..MaxHeightPx).
func HeightPx(n int) Height { return Height{mode: "px", px: n} }

// Pixel bounds of HeightPx.
const (
	MinHeightPx = 120
	MaxHeightPx = 1600
)

// IsZero reports whether h is unset (the host's default, like HeightAuto).
func (h Height) IsZero() bool { return h.mode == "" }

// Fill reports whether h is HeightFill.
func (h Height) Fill() bool { return h.mode == "fill" }

// Px is a HeightPx height's pixels, 0 for any other.
func (h Height) Px() int {
	if h.mode == "px" {
		return h.px
	}
	return 0
}

// String is "auto", "fill" or the pixels.
func (h Height) String() string {
	switch h.mode {
	case "fill":
		return "fill"
	case "px":
		return strconv.Itoa(h.px)
	default:
		return "auto"
	}
}

// MarshalJSON encodes "auto", "fill" or a number.
func (h Height) MarshalJSON() ([]byte, error) {
	if h.mode == "px" {
		return []byte(strconv.Itoa(h.px)), nil
	}
	return json.Marshal(h.String())
}

// UnmarshalJSON accepts "auto", "fill" or a whole number of pixels.
func (h *Height) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		switch s {
		case "auto", "":
			*h = HeightAuto
		case "fill":
			*h = HeightFill
		default:
			return fmt.Errorf("height %q: want \"auto\", \"fill\" or a number of pixels", s)
		}
		return nil
	}
	var n float64
	if err := json.Unmarshal(b, &n); err != nil || n != float64(int(n)) {
		return fmt.Errorf("height %s: want \"auto\", \"fill\" or a whole number of pixels", b)
	}
	*h = HeightPx(int(n))
	return nil
}
