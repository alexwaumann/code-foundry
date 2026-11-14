package thread

import "time"

// batchClock is the wake batch window's clock (subscriptions_batch.go): when a wake was
// queued, and a timer to the end of its window. It is the monotonic clock, not
// Options.Now (the wall clock). Tests swap in a manual one (Options.batchClock), so a
// window ends when the test moves the clock, not when a busy machine gets round to it.
type batchClock interface {
	Now() time.Time
	// After returns a channel that receives once d has passed, and a stop for it.
	After(d time.Duration) (<-chan time.Time, func())
}

// realClock is the monotonic clock.
type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) After(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTimer(d)
	return t.C, func() { t.Stop() }
}
