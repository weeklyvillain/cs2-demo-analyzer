//go:build !windows

package main

// setProcessTitle is a no-op on non-Windows platforms.
func setProcessTitle(title string) {}

