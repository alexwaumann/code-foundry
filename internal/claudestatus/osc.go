package claudestatus

import (
	"bytes"
	"encoding/base64"
	"strings"
	"unicode/utf8"
)

// oscKind is what an OSC payload means for status detection.
type oscKind uint8

const (
	oscIgnored       oscKind = iota
	oscTitle                 // OSC 0 / OSC 2
	oscNotify                // OSC 9 (iTerm2), OSC 777;notify (Ghostty, urxvt), OSC 99 (kitty)
	oscProgress              // OSC 9;4 (ConEmu/Windows Terminal/Ghostty progress)
	oscProgramStatus         // OSC 7501 (program status protocol)
)

// oscEvent is a parsed OSC payload.
type oscEvent struct {
	kind oscKind
	text string // title, or notification text, or program-status message

	// progressActive is set for oscProgress: true for states 1 (set), 3
	// (indeterminate), 4 (pause); false for 0 (remove) and 2 (error).
	progressActive bool

	// program status (OSC 7501) fields.
	psState string // idle, working, done, blocked, error, clear
	psKind  string // permission, question, auth (blocked only)
}

// parseOSC interprets an OSC payload (the bytes between ESC ] and the terminator).
func parseOSC(p []byte) oscEvent {
	num, rest, ok := bytes.Cut(p, []byte{';'})
	if !ok {
		return oscEvent{}
	}
	switch string(num) {
	case "0", "2":
		return oscEvent{kind: oscTitle, text: cleanText(rest)}
	case "9":
		// ConEmu-style OSC 9;<n>;... subcommands start with a number; 9;4 is progress.
		// Anything else is an iTerm2-style notification body.
		sub, args, _ := bytes.Cut(rest, []byte{';'})
		if isDigits(sub) {
			if string(sub) == "4" {
				st, _, _ := bytes.Cut(args, []byte{';'})
				switch string(st) {
				case "1", "3", "4":
					return oscEvent{kind: oscProgress, progressActive: true}
				default:
					return oscEvent{kind: oscProgress}
				}
			}
			return oscEvent{}
		}
		return oscEvent{kind: oscNotify, text: cleanText(rest)}
	case "777":
		// OSC 777;notify;<title>;<body>
		verb, args, _ := bytes.Cut(rest, []byte{';'})
		if string(verb) != "notify" {
			return oscEvent{}
		}
		title, body, _ := bytes.Cut(args, []byte{';'})
		text := cleanText(body)
		if text == "" {
			text = cleanText(title)
		}
		return oscEvent{kind: oscNotify, text: text}
	case "99":
		// OSC 99;<metadata>;<payload>. Payloads may be base64 (e=1); we only need to
		// know a notification happened, so the text is best effort.
		meta, payload, _ := bytes.Cut(rest, []byte{';'})
		if bytes.Contains(meta, []byte("e=1")) {
			if dec, err := base64.StdEncoding.DecodeString(string(payload)); err == nil {
				payload = dec
			}
		}
		return oscEvent{kind: oscNotify, text: cleanText(payload)}
	case "7501":
		ev := oscEvent{kind: oscProgramStatus}
		for _, field := range bytes.Split(rest, []byte{':'}) {
			k, v, _ := bytes.Cut(field, []byte{'='})
			switch string(k) {
			case "state":
				ev.psState = string(v)
			case "kind":
				ev.psKind = string(v)
			case "msg":
				if dec, err := base64.StdEncoding.DecodeString(string(v)); err == nil {
					ev.text = cleanText(dec)
				}
			}
		}
		return ev
	}
	return oscEvent{}
}

func isDigits(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	for _, c := range b {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// cleanText returns b as a string with invalid UTF-8 and control characters removed,
// trimmed of surrounding space.
func cleanText(b []byte) string {
	var sb strings.Builder
	sb.Grow(len(b))
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		b = b[n:]
		if (r == utf8.RuneError && n <= 1) || r < 0x20 || (r >= 0x7f && r < 0xa0) {
			continue
		}
		sb.WriteRune(r)
	}
	return strings.TrimSpace(sb.String())
}

// titleKind classifies Claude Code's terminal title.
type titleKind uint8

const (
	titleNone    titleKind = iota // no title (startup, or cleared on exit)
	titleIdle                     // "✳ <task>": not generating
	titleSpinner                  // "◐ <task>" / "◑ <task>": generating or running tools
	titleOther                    // something else (custom title, future format)
)

func (k titleKind) String() string {
	switch k {
	case titleIdle:
		return "idle"
	case titleSpinner:
		return "spinner"
	case titleOther:
		return "other"
	default:
		return "none"
	}
}

// Observed (2.1.294): the title is "✳ <task>" while waiting and alternates between
// "◐ <task>" and "◑ <task>" about once a second while a request is in flight (including
// tool execution). The spinner set below also accepts the other half-circle phases,
// braille spinners, and the body spinner glyphs, in case the title animation changes.
const (
	idleGlyphs    = "✳"
	spinnerGlyphs = "◐◑◒◓◴◵◶◷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠐·✢✶✻✽"
)

// classifyTitle splits a title into its kind, its leading glyph, and the task text.
func classifyTitle(title string) (kind titleKind, glyph rune, task string) {
	if title == "" {
		return titleNone, 0, ""
	}
	r, n := utf8.DecodeRuneInString(title)
	rest := strings.TrimSpace(title[n:])
	switch {
	case strings.ContainsRune(idleGlyphs, r):
		return titleIdle, r, rest
	case strings.ContainsRune(spinnerGlyphs, r):
		return titleSpinner, r, rest
	default:
		return titleOther, r, title
	}
}
