package command

import (
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
type ConfirmError struct {
	Command string
	Title   string
	Message string
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
