//go:build !darwin

package fsx

// locked reports whether p has a flag that refuses changes; Stat_t carries none here.
func locked(string) bool { return false }
