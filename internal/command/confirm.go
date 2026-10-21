package command

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

// ErrNeedsConfirmation is wrapped by *ConfirmError. internal/api maps it to
// FailedPrecondition with a codefoundry.v1.ConfirmationRequired detail.
var ErrNeedsConfirmation = errors.New("confirmation required")

// ConfirmError is returned by Invoke for a command with Confirm set when the caller did
// not pass Confirmed(). Message is the rendered Confirm template.
//
// A command's Run may return one too, with Args set, after the user confirmed it once: a
// second-stage confirmation (removing a worktree turned out to delete uncommitted work).
// If the user agrees, the client invokes again with Args merged over its args and
// confirmed set. Clients never accept one on the user's behalf: the CLI's --yes does
// not, so an agent passes the flag (--force) itself.
type ConfirmError struct {
	Command string
	Title   string
	Message string
	// Args are merged over the caller's args on the re-invoke (second stage only).
	Args map[string]string
	// Declined is what the command already did and answers when the user declines a
	// second-stage confirmation; nil when declining leaves nothing done (the CLI's
	// --yes then fails with Message).
	Declined *Result
	// Bind are args a command's own (first-stage) confirmation asks the re-invoke to
	// carry, binding the yes to what was shown (Command.BindConfirm). Unlike Args they are
	// not a second stage: clients still use the command's own presenter.
	Bind map[string]string
}

// ConfirmDigest is the digest of a confirmation message that Command.BindConfirm
// carries: a store compares it with the digest of what it would ask now.
func ConfirmDigest(message string) string {
	sum := sha256.Sum256([]byte(message))
	return hex.EncodeToString(sum[:16])
}

func (e *ConfirmError) Error() string { return e.Message }

// Unwrap makes errors.Is(err, ErrNeedsConfirmation) true.
func (e *ConfirmError) Unwrap() error { return ErrNeedsConfirmation }

// confirmPlaceholder matches {arg-name} in a Confirm template.
var confirmPlaceholder = regexp.MustCompile(`\{([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}`)

// validateConfirm checks that every placeholder in tmpl names one of specs.
func validateConfirm(tmpl string, specs []ArgSpec) error {
	for _, m := range confirmPlaceholder.FindAllStringSubmatch(tmpl, -1) {
		if !hasSpec(specs, m[1]) {
			return fmt.Errorf("confirm template names unknown arg %q", m[1])
		}
	}
	return nil
}

func hasSpec(specs []ArgSpec, name string) bool {
	for _, s := range specs {
		if s.Name == name {
			return true
		}
	}
	return false
}

// renderConfirm replaces each {arg} in tmpl with the arg's value (after defaults and
// context). Absent bools render as "false", other absent args as "(none)".
func renderConfirm(tmpl string, specs []ArgSpec, a Args) string {
	return confirmPlaceholder.ReplaceAllStringFunc(tmpl, func(m string) string {
		name := m[1 : len(m)-1]
		switch v := a.vals[name].(type) {
		case string:
			if v != "" {
				return v
			}
		case bool:
			return strconv.FormatBool(v)
		case int:
			return strconv.Itoa(v)
		case nil:
			for _, s := range specs {
				if s.Name == name && s.Type == Bool {
					return "false"
				}
			}
		}
		return "(none)"
	})
}

// InvokeOption modifies one Invoke call.
type InvokeOption func(*invokeOptions)

type invokeOptions struct {
	confirmed bool
}

// Confirmed marks the call as confirmed by the user, so commands with Confirm run.
func Confirmed(yes bool) InvokeOption {
	return func(o *invokeOptions) { o.confirmed = yes }
}

type confirmedKey struct{}

// ConfirmedIn reports whether the Invoke that runs a command was confirmed by the user
// (Confirmed(true)), for a command that runs another for the user and passes the
// confirmation on (plugin.act pressing a view's command button).
func ConfirmedIn(ctx context.Context) bool {
	yes, _ := ctx.Value(confirmedKey{}).(bool)
	return yes
}
