package claudestatus

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// DialogKind identifies a blocking UI that Claude Code shows in place of its prompt.
type DialogKind int

// Dialog kinds, most specific first.
const (
	DialogNone       DialogKind = iota
	DialogTrust                 // "Quick safety check ... Yes, I trust this folder"
	DialogPlan                  // ExitPlanMode: "Would you like to proceed?"
	DialogPermission            // tool permission: "Do you want to proceed?" + numbered options
	DialogQuestion              // AskUserQuestion: "Enter to select · ↑/↓ to navigate"
	DialogContinue              // "Press Enter to continue"
	DialogMenu                  // any other selection list ("❯ 1. ...", "Esc to cancel")
)

func (k DialogKind) String() string {
	switch k {
	case DialogTrust:
		return "trust"
	case DialogPlan:
		return "plan"
	case DialogPermission:
		return "permission"
	case DialogQuestion:
		return "question"
	case DialogContinue:
		return "continue"
	case DialogMenu:
		return "menu"
	default:
		return "none"
	}
}

// ScreenInfo is what the plain-text screen says about Claude Code's state.
type ScreenInfo struct {
	// PromptBox is set when the input row ("❯ ...") is visible between two horizontal
	// rules. Claude hides it while a dialog is shown.
	PromptBox bool
	// Input is the text on the prompt row. Plain text cannot tell typed input from the
	// dimmed placeholder or prompt suggestion, so this is informational only.
	Input string
	// Dialog is the blocking dialog below the last prompt box (or anywhere near the
	// bottom when there is no prompt box).
	Dialog DialogKind
	// DialogText is a short human description of the dialog (usually its question).
	DialogText string
	// Spinner is set when the "✻ Verbing… (12s · ↓ 3 tokens)" row (or the older "esc to
	// interrupt" hint) is visible above the prompt.
	Spinner     bool
	SpinnerText string
}

const (
	screenTailLines  = 80 // only the bottom of the screen matters
	dialogScanLines  = 25 // dialogs sit at the bottom; ignore older transcript text
	spinnerScanLines = 10 // the spinner row sits just above the prompt box
	promptBoxMaxRows = 15 // multi-line input between the two rules
)

// ClassifyScreen inspects the plain-text screen (rows separated by '\n'). Only the last
// rows are examined, so passing scrollback as well is harmless.
func ClassifyScreen(screen string) ScreenInfo {
	lines := tailLines(screen, screenTailLines)
	var info ScreenInfo

	// The last prompt box: rule, "❯" row, up to promptBoxMaxRows rows, rule.
	boxTop, boxBottom := -1, -1
	for i := 0; i+1 < len(lines); i++ {
		if !isRule(lines[i]) {
			continue
		}
		input, ok := promptRow(lines[i+1])
		if !ok {
			continue
		}
		for j := i + 2; j < len(lines) && j <= i+1+promptBoxMaxRows; j++ {
			if isRule(lines[j]) {
				boxTop, boxBottom = i, j
				info.PromptBox = true
				info.Input = input
				break
			}
		}
	}

	// Dialogs: below the prompt box if there is one, else the bottom of the screen.
	region := lines
	if boxBottom >= 0 {
		region = lines[boxBottom+1:]
	}
	region = lastNonEmpty(region, dialogScanLines)
	info.Dialog, info.DialogText = classifyDialog(region)

	// Spinner: just above the prompt box, else near the bottom.
	above := lines
	if boxTop >= 0 {
		above = lines[:boxTop]
	}
	for _, l := range lastNonEmpty(above, spinnerScanLines) {
		if isSpinnerRow(l) {
			info.Spinner = true
			info.SpinnerText = strings.TrimSpace(l)
		}
	}
	return info
}

func classifyDialog(region []string) (DialogKind, string) {
	kind, matched := DialogNone, ""
	set := func(k DialogKind, line string) {
		if kind == DialogNone || k < kind {
			kind, matched = k, line
		}
	}
	question := ""
	for _, l := range region {
		t := strings.TrimSpace(l)
		lower := strings.ToLower(t)
		switch {
		case strings.Contains(lower, "trust this folder"), strings.Contains(lower, "do you trust the files"),
			strings.Contains(lower, "quick safety check"):
			set(DialogTrust, t)
		case strings.Contains(lower, "would you like to proceed"), strings.Contains(lower, "ready to code?"),
			strings.Contains(lower, "exit plan mode?"):
			set(DialogPlan, t)
		case strings.HasPrefix(lower, "do you want to "), strings.Contains(lower, "tab to amend"):
			set(DialogPermission, t)
		case strings.Contains(lower, "enter to select"), strings.Contains(lower, "↑/↓ to navigate"),
			strings.HasPrefix(t, "☐ "), strings.HasPrefix(t, "☒ "), strings.HasPrefix(t, "✔ "),
			strings.Contains(lower, "chat about this"):
			set(DialogQuestion, t)
		case strings.Contains(lower, "press enter to continue"), strings.Contains(lower, "press any key"):
			set(DialogContinue, t)
		case isSelectedOption(t), strings.Contains(lower, "esc to cancel"), strings.Contains(lower, "enter to confirm"):
			set(DialogMenu, t)
		}
		if strings.HasSuffix(t, "?") {
			question = t
		}
	}
	switch {
	case kind == DialogNone:
		return DialogNone, ""
	case kind == DialogTrust:
		return kind, "trust this folder?"
	case question != "":
		return kind, question
	default:
		return kind, matched
	}
}

// isRule reports whether l is a horizontal rule: mostly '─' (a label such as
// "──── my-session ─" is allowed). Dashed '╌' rules inside dialogs do not count.
func isRule(l string) bool {
	total, rule := 0, 0
	for _, r := range l {
		if r == ' ' {
			continue
		}
		total++
		if r == '─' || r == '━' {
			rule++
		}
	}
	return rule >= 10 && rule*10 >= total*6
}

// promptRow reports whether l is the input row ("❯ text", or "> text" in older
// versions) and returns the text. A numbered option ("❯ 1. Yes") is not an input row.
func promptRow(l string) (string, bool) {
	t := strings.TrimLeft(l, " ")
	var rest string
	switch {
	case strings.HasPrefix(t, "❯"):
		rest = t[len("❯"):]
	case strings.HasPrefix(t, ">"):
		rest = t[1:]
	default:
		return "", false
	}
	if rest != "" && rest[0] != ' ' && !strings.HasPrefix(rest, " ") {
		return "", false
	}
	rest = strings.TrimSpace(strings.ReplaceAll(rest, " ", " "))
	if isNumberedOption(rest) {
		return "", false
	}
	return rest, true
}

// isSelectedOption matches the highlighted row of a numbered list: "❯ 1. Yes".
func isSelectedOption(t string) bool {
	if !strings.HasPrefix(t, "❯") {
		return false
	}
	return isNumberedOption(strings.TrimSpace(t[len("❯"):]))
}

func isNumberedOption(s string) bool {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return i > 0 && i < len(s) && s[i] == '.'
}

// isSpinnerRow matches Claude's activity row: a glyph, a space, a capitalised verb
// ending in "…" ("✻ Ruminating… (12s · ↓ 566 tokens)"). The finished row ("✻ Brewed for
// 4s · done 1:59 AM") has no ellipsis and does not match. "esc to interrupt" (older
// versions) matches anywhere.
func isSpinnerRow(l string) bool {
	t := strings.TrimSpace(l)
	if strings.Contains(strings.ToLower(t), "esc to interrupt") {
		return true
	}
	g, n := utf8.DecodeRuneInString(t)
	if g == utf8.RuneError || unicode.IsLetter(g) || unicode.IsDigit(g) || g == '❯' || g == '⎿' || g == '>' {
		return false
	}
	rest := t[n:]
	if !strings.HasPrefix(rest, " ") {
		return false
	}
	rest = strings.TrimLeft(rest, " ")
	first, _ := utf8.DecodeRuneInString(rest)
	if !unicode.IsUpper(first) {
		return false
	}
	verb, _, _ := strings.Cut(rest, " ")
	return strings.HasSuffix(verb, "…")
}

// tailLines returns the last n lines of s, right-trimmed, without splitting all of s.
func tailLines(s string, n int) []string {
	s = strings.TrimRight(s, "\n")
	start, found := len(s), false
	for k := 0; k < n; k++ {
		i := strings.LastIndexByte(s[:start], '\n')
		if i < 0 {
			start, found = 0, false
			break
		}
		start, found = i, true
	}
	if found {
		start++
	}
	lines := strings.Split(s[start:], "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t\r")
	}
	return lines
}

// lastNonEmpty returns up to n trailing non-blank lines of ls, in order.
func lastNonEmpty(ls []string, n int) []string {
	out := make([]string, 0, n)
	for i := len(ls) - 1; i >= 0 && len(out) < n; i-- {
		if strings.TrimSpace(ls[i]) != "" {
			out = append(out, ls[i])
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}
