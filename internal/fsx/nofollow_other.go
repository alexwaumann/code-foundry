//go:build !darwin

package fsx

// NoFollowAny is 0 where the system has no such flag: a path is opened as it stands.
const NoFollowAny = 0
