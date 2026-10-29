package dictation

import "time"

// Clock is the store's time: the real one, or dictationtest.Clock in tests, which only
// moves when told.
type Clock interface {
	Now() time.Time
	// AfterFunc calls f on its own goroutine once d has passed.
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a pending AfterFunc.
type Timer interface {
	// Stop cancels it; false when it already fired or was stopped.
	Stop() bool
}

type realClock struct{}

func (realClock) Now() time.Time                            { return time.Now() }
func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }
