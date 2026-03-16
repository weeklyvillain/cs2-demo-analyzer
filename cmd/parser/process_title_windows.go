//go:build windows

package main

import (
	"runtime"
	"syscall"
	"unsafe"
)

var (
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	setConsoleTitleProc = kernel32.NewProc("SetConsoleTitleW")
)

// setProcessTitle sets the console window title on Windows.
func setProcessTitle(title string) {
	if runtime.GOOS != "windows" {
		return
	}

	utf16Title, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return
	}

	setConsoleTitleProc.Call(uintptr(unsafe.Pointer(utf16Title)))
}

