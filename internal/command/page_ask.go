package command

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// PageClass is what a page's call to a command may do without asking the user
// (docs/notes/page-verb-gate.md). A page's script is not the user, and one click in it is
// not a yes to running a program. The rule is the daemon's, so the page's own script, the
// GUI and a caller that did not say who it is all meet it.
type PageClass int

const (
	// PageRuns is a command that runs a program, installs or runs code, or writes outside
	// the app's state: a page asks the user first, showing the call. It is the zero value,
	// so a new command, and every plugin's, asks until someone classifies it.
	PageRuns PageClass = iota
	// PageDrives is a command that drives a Claude thread: a page runs it as the CLI in its
	// thread would.
	PageDrives
	// PageState is a command on the app's own state, which a page runs freely (with its
	// Confirm, if it has one). ArgSpec.PageAsks marks a flag that takes it out of this class.
	PageState
)

// pageAskMax bounds the question so all of it fits the dialog without scrolling: what runs
// is never below the fold. Past it the call is refused, not cut, since a cut call is not
// what the user would be agreeing to.
const pageAskMax = 800

// Untrusted reports whether the caller may not run a PageRuns command unasked: a page, or
// a caller that did not say who it is (internal/api marks those OriginUnknown). The GUI's
// controls, a CLI and a plugin, which runs as the user with their consent, stay as they are.
func (c Context) Untrusted() bool {
	switch c.Origin {
	case originApp, OriginCLI, OriginPlugin:
		return false
	}
	return true
}

// asksPage reports whether a call with args needs the user's yes when uctx.Untrusted.
func (c *Command) asksPage(a Args) bool {
	switch {
	case c.ReadOnly:
		return false
	case c.Page == PageRuns:
		return true
	}
	for _, s := range c.Args {
		if s.PageAsks && (a.String(s.Name) != "" || a.Bool(s.Name)) {
			return true
		}
	}
	return false
}

// pageQuestion is the confirmation a page's call needs: the call as it will run, every
// value quoted, so a value cannot draw lines of its own in the dialog.
func (c *Command) pageQuestion(ctx context.Context, uctx Context, a Args) error {
	msg := "Run this?\n" + c.pageCall(a)
	if c.PageDetail != nil {
		detail, err := c.PageDetail(ctx, uctx, a)
		if err != nil {
			return err
		}
		if detail != "" {
			msg += "\n" + detail
		}
	}
	if err := c.pageAskFits(msg); err != nil {
		return err
	}
	return &ConfirmError{Command: c.Name, Title: c.Title, Message: msg, Label: "Allow"}
}

// pageConfirm is a Confirm command's question to an untrusted caller: its own words, in
// which a value that would draw lines of its own shows quoted, and then the call, since
// the words alone need not say what its flags do.
func (c *Command) pageConfirm(msg string, a Args) (string, error) {
	for _, s := range c.Args {
		v, ok := a.vals[s.Name].(string)
		if !ok || v == "" {
			continue
		}
		if q := strconv.Quote(v); q[1:len(q)-1] != v {
			msg = strings.ReplaceAll(msg, v, q)
		}
	}
	msg += "\n" + c.pageCall(a)
	return msg, c.pageAskFits(msg)
}

// pageAskFits refuses a question too long to show whole (pageAskMax).
func (c *Command) pageAskFits(msg string) error {
	if n := utf8.RuneCountInString(msg); n > pageAskMax {
		return Failed(fmt.Errorf("%s: this call is too long to show the user (%d characters, at most %d)", c.Name, n, pageAskMax))
	}
	return nil
}

// pageCall is the call in the CLI's words: the verb and each arg with a value, defaults
// and context included, since they are part of what runs.
func (c *Command) pageCall(a Args) string {
	var sb strings.Builder
	sb.WriteString(c.Name)
	for _, s := range c.Args {
		v, ok := a.vals[s.Name]
		if !ok {
			continue
		}
		switch x := v.(type) {
		case bool:
			if x {
				sb.WriteString(" --" + s.Name)
			} else {
				sb.WriteString(" --" + s.Name + "=false")
			}
		case int:
			sb.WriteString(" --" + s.Name + " " + strconv.Itoa(x))
		case string:
			switch {
			case s.PageShowsSize && a.Given(s.Name):
				sb.WriteString(" --" + s.Name + " <" + byteSize(len(x)) + ">")
			case x != "":
				sb.WriteString(" --" + s.Name + " " + strconv.Quote(x))
			}
		}
	}
	return sb.String()
}
