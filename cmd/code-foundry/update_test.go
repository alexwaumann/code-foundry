package main

import "testing"

// After an update the CLI counts only the threads a restart would cut off (working or
// waiting on an answer, command.ActiveSession); idle and stopped ones start again with
// their next message.
func TestActiveThreads(t *testing.T) {
	tests := []struct {
		n    int
		want string
	}{
		{0, "no thread working"},
		{1, "1 thread working or waiting on you"},
		{3, "3 threads working or waiting on you"},
	}
	for _, tt := range tests {
		if got := activeThreads(tt.n); got != tt.want {
			t.Errorf("activeThreads(%d) = %q, want %q", tt.n, got, tt.want)
		}
	}
}
