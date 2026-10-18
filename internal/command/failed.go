package command

import "errors"

// FailedError is a command's own failure, not the caller's mistake: a plugin's command
// answered with an error, or its plugin is not running. It wraps the error, which may
// wrap ErrInvalidArgs or ErrUnavailable to say what kind of failure it is. internal/api
// maps it to InvalidArgument (ErrInvalidArgs) or FailedPrecondition with a
// codefoundry.v1.CommandFailed detail, so the CLI prints the message as it is and exits 1
// rather than pointing at help with its usage status.
type FailedError struct{ Err error }

func (e *FailedError) Error() string { return e.Err.Error() }

func (e *FailedError) Unwrap() error { return e.Err }

// Failed marks err as the command's own failure (FailedError); nil stays nil.
func Failed(err error) error {
	if err == nil {
		return nil
	}
	return &FailedError{Err: err}
}

// IsFailed reports whether err is a command's own failure.
func IsFailed(err error) bool {
	var fe *FailedError
	return errors.As(err, &fe)
}
