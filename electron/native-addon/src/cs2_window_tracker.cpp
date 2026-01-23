#include <napi.h>
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <string>
#include <vector>
#include <map>
#include <algorithm>
#include <cctype>

// Win32 constants
#define EVENT_OBJECT_LOCATIONCHANGE 0x800B
#define EVENT_SYSTEM_MOVESIZESTART 0x000A
#define EVENT_SYSTEM_MOVESIZEEND 0x000B
#define EVENT_SYSTEM_MINIMIZESTART 0x0016
#define EVENT_SYSTEM_MINIMIZEEND 0x0017
#define EVENT_SYSTEM_FOREGROUND 0x0003
#define EVENT_OBJECT_DESTROY 0x8001
#define WINEVENT_OUTOFCONTEXT 0x0000
#define WINEVENT_SKIPOWNPROCESS 0x0002
#define GWL_EXSTYLE (-20)
// WS_EX_TOOLWINDOW is already defined in winuser.h

// Global state for WinEvent hook
struct HookState {
  DWORD targetPid;
  Napi::FunctionReference jsCallback;
  HWINEVENTHOOK hookHandle1; // Location change and destroy
  HWINEVENTHOOK hookHandle2; // Move/resize
  HWINEVENTHOOK hookHandle3; // Minimize
  HWINEVENTHOOK hookHandle4; // Foreground (focus)
};

static HookState* g_hookState = nullptr;

// WinEvent hook callback
VOID CALLBACK WinEventProc(
  HWINEVENTHOOK hWinEventHook,
  DWORD event,
  HWND hwnd,
  LONG idObject,
  LONG idChild,
  DWORD dwEventThread,
  DWORD dwmsTimeStamp
) {
  if (!g_hookState || idObject != OBJID_WINDOW || idChild != CHILDID_SELF) {
    return;
  }

  // Handle foreground events differently - they fire for ANY window becoming foreground
  if (event == EVENT_SYSTEM_FOREGROUND) {
    DWORD windowPid;
    GetWindowThreadProcessId(hwnd, &windowPid);
    
    // Emit a "foreground" event with the foreground window's PID
    // The JavaScript side will determine if it's CS2 or not
    if (!g_hookState->jsCallback.IsEmpty()) {
      Napi::Env env = g_hookState->jsCallback.Env();
      Napi::HandleScope scope(env);
      
      Napi::Object eventObj = Napi::Object::New(env);
      eventObj.Set("type", Napi::String::New(env, "foreground"));
      eventObj.Set("hwnd", Napi::BigInt::New(env, reinterpret_cast<int64_t>(hwnd)));
      eventObj.Set("pid", Napi::Number::New(env, windowPid));
      
      g_hookState->jsCallback.Call({ eventObj });
    }
    return;
  }

  // For other events, check if window belongs to target process
  DWORD windowPid;
  GetWindowThreadProcessId(hwnd, &windowPid);
  if (windowPid != g_hookState->targetPid) {
    return;
  }

  // Map event to string
  std::string eventType;
  switch (event) {
    case EVENT_OBJECT_LOCATIONCHANGE:
      eventType = "locationchange";
      break;
    case EVENT_SYSTEM_MOVESIZESTART:
      eventType = "movestart";
      break;
    case EVENT_SYSTEM_MOVESIZEEND:
      eventType = "moveend";
      break;
    case EVENT_SYSTEM_MINIMIZESTART:
      eventType = "minimizestart";
      break;
    case EVENT_SYSTEM_MINIMIZEEND:
      eventType = "minimizeend";
      break;
    case EVENT_OBJECT_DESTROY:
      eventType = "destroy";
      break;
    default:
      return; // Ignore other events
  }

  // Call JS callback
  if (!g_hookState->jsCallback.IsEmpty()) {
    Napi::Env env = g_hookState->jsCallback.Env();
    Napi::HandleScope scope(env);
    
    Napi::Object eventObj = Napi::Object::New(env);
    eventObj.Set("type", Napi::String::New(env, eventType));
    eventObj.Set("hwnd", Napi::BigInt::New(env, reinterpret_cast<int64_t>(hwnd)));
    
    g_hookState->jsCallback.Call({ eventObj });
  }
}

// Helper: Check if window is a tool window
bool IsToolWindow(HWND hwnd) {
  LONG_PTR exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
  return (exStyle & WS_EX_TOOLWINDOW) != 0;
}

// Helper: Get window area
int GetWindowArea(HWND hwnd) {
  RECT rect;
  if (GetWindowRect(hwnd, &rect)) {
    return (rect.right - rect.left) * (rect.bottom - rect.top);
  }
  return 0;
}

// EnumWindows callback data structure
struct EnumData {
  DWORD pid;
  HWND bestHwnd;
  int bestArea;
};

// EnumWindows callback function (must be at file scope, not local)
BOOL CALLBACK EnumProc(HWND hwnd, LPARAM lParam) {
  EnumData* ed = reinterpret_cast<EnumData*>(lParam);
  
  // Check visibility
  if (!IsWindowVisible(hwnd)) {
    return TRUE; // Continue
  }
  
  // Check process ID
  DWORD windowPid;
  GetWindowThreadProcessId(hwnd, &windowPid);
  if (windowPid != ed->pid) {
    return TRUE; // Continue
  }
  
  // Check if it's a tool window (skip those)
  LONG_PTR exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
  if (exStyle & WS_EX_TOOLWINDOW) {
    return TRUE; // Continue
  }
  
  // Check if window has a title (non-empty)
  wchar_t title[256];
  int titleLen = GetWindowTextW(hwnd, title, 256);
  if (titleLen == 0) {
    return TRUE; // Continue
  }
  
  // Calculate area
  RECT rect;
  int area = 0;
  if (GetWindowRect(hwnd, &rect)) {
    area = (rect.right - rect.left) * (rect.bottom - rect.top);
  }
  
  if (area > ed->bestArea) {
    ed->bestHwnd = hwnd;
    ed->bestArea = area;
  }
  
  return TRUE; // Continue
}

// findWindowByPid(pid: number): bigint | null
Napi::Value FindWindowByPid(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected number (pid)").ThrowAsJavaScriptException();
    return env.Null();
  }
  
  DWORD targetPid = info[0].As<Napi::Number>().Uint32Value();
  
  // EnumWindows callback data
  EnumData data = { targetPid, NULL, 0 };
  
  EnumWindows(EnumProc, reinterpret_cast<LPARAM>(&data));
  
  if (data.bestHwnd) {
    return Napi::BigInt::New(env, reinterpret_cast<int64_t>(data.bestHwnd));
  }
  
  return env.Null();
}

// findProcessIdByName(processName: string): number | null
Napi::Value FindProcessIdByName(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string (processName)").ThrowAsJavaScriptException();
    return env.Null();
  }
  
  std::string processName = info[0].As<Napi::String>().Utf8Value();
  
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    return env.Null();
  }
  
  PROCESSENTRY32 entry;
  entry.dwSize = sizeof(PROCESSENTRY32);
  
  if (Process32First(snapshot, &entry)) {
    do {
      // Compare process names case-insensitively
      std::string entryName = entry.szExeFile;
      std::string lowerEntryName;
      std::string lowerProcessName;
      for (char c : entryName) {
        lowerEntryName += std::tolower(static_cast<unsigned char>(c));
      }
      for (char c : processName) {
        lowerProcessName += std::tolower(static_cast<unsigned char>(c));
      }
      if (lowerEntryName == lowerProcessName) {
        CloseHandle(snapshot);
        return Napi::Number::New(env, entry.th32ProcessID);
      }
    } while (Process32Next(snapshot, &entry));
  }
  
  CloseHandle(snapshot);
  return env.Null();
}

// getClientBoundsOnScreen(hwnd: bigint): { x, y, width, height }
Napi::Value GetClientBoundsOnScreen(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 1 || !info[0].IsBigInt()) {
    Napi::TypeError::New(env, "Expected BigInt (hwnd)").ThrowAsJavaScriptException();
    return env.Null();
  }
  
  bool lossless;
  int64_t hwndValue = info[0].As<Napi::BigInt>().Int64Value(&lossless);
  HWND hwnd = reinterpret_cast<HWND>(hwndValue);
  
  RECT clientRect;
  if (!GetClientRect(hwnd, &clientRect)) {
    return env.Null();
  }
  
  POINT topLeft = { clientRect.left, clientRect.top };
  POINT bottomRight = { clientRect.right, clientRect.bottom };
  
  if (!ClientToScreen(hwnd, &topLeft) || !ClientToScreen(hwnd, &bottomRight)) {
    return env.Null();
  }
  
  Napi::Object result = Napi::Object::New(env);
  result.Set("x", Napi::Number::New(env, topLeft.x));
  result.Set("y", Napi::Number::New(env, topLeft.y));
  result.Set("width", Napi::Number::New(env, bottomRight.x - topLeft.x));
  result.Set("height", Napi::Number::New(env, bottomRight.y - topLeft.y));
  
  return result;
}

// isMinimized(hwnd: bigint): boolean
Napi::Value IsMinimized(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 1 || !info[0].IsBigInt()) {
    Napi::TypeError::New(env, "Expected BigInt (hwnd)").ThrowAsJavaScriptException();
    return env.Null();
  }
  
  bool lossless;
  int64_t hwndValue = info[0].As<Napi::BigInt>().Int64Value(&lossless);
  HWND hwnd = reinterpret_cast<HWND>(hwndValue);
  
  return Napi::Boolean::New(env, IsIconic(hwnd) != FALSE);
}

// getDpiScaleForHwnd(hwnd: bigint): number
Napi::Value GetDpiScaleForHwnd(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 1 || !info[0].IsBigInt()) {
    Napi::TypeError::New(env, "Expected BigInt (hwnd)").ThrowAsJavaScriptException();
    return env.Null();
  }
  
  bool lossless;
  int64_t hwndValue = info[0].As<Napi::BigInt>().Int64Value(&lossless);
  HWND hwnd = reinterpret_cast<HWND>(hwndValue);
  
  // GetDpiForWindow is available on Windows 10 1607+
  typedef UINT (WINAPI *GetDpiForWindowProc)(HWND);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (!user32) {
    return Napi::Number::New(env, 1.0); // Fallback to 100% scale
  }
  
  GetDpiForWindowProc GetDpiForWindow = 
    reinterpret_cast<GetDpiForWindowProc>(GetProcAddress(user32, "GetDpiForWindow"));
  
  if (GetDpiForWindow) {
    UINT dpi = GetDpiForWindow(hwnd);
    return Napi::Number::New(env, dpi / 96.0);
  }
  
  // Fallback: use system DPI
  HDC hdc = GetDC(hwnd);
  int dpi = GetDeviceCaps(hdc, LOGPIXELSX);
  ReleaseDC(hwnd, hdc);
  return Napi::Number::New(env, dpi / 96.0);
}

// getForegroundPid(): number
Napi::Value GetForegroundPid(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  HWND fgHwnd = GetForegroundWindow();
  if (!fgHwnd) {
    return env.Null();
  }
  
  DWORD pid;
  GetWindowThreadProcessId(fgHwnd, &pid);
  
  return Napi::Number::New(env, pid);
}

// forceActivateWindow(hwnd: bigint): boolean
Napi::Value ForceActivateWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 1 || !info[0].IsBigInt()) {
    Napi::TypeError::New(env, "Expected BigInt (hwnd)").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
  
  bool lossless;
  int64_t hwndValue = info[0].As<Napi::BigInt>().Int64Value(&lossless);
  HWND hwnd = reinterpret_cast<HWND>(hwndValue);
  
  if (!IsWindow(hwnd)) {
    return Napi::Boolean::New(env, false);
  }
  
  // Get current foreground window and its thread
  HWND fgHwnd = GetForegroundWindow();
  DWORD fgThreadId = 0;
  if (fgHwnd) {
    fgThreadId = GetWindowThreadProcessId(fgHwnd, NULL);
  }
  
  // Get target window's thread
  DWORD targetThreadId = GetWindowThreadProcessId(hwnd, NULL);
  DWORD currentThreadId = GetCurrentThreadId();
  
  // Attach to foreground thread if different from current thread
  bool attached = false;
  if (fgThreadId != 0 && fgThreadId != currentThreadId) {
    attached = AttachThreadInput(currentThreadId, fgThreadId, TRUE) != FALSE;
  }
  
  // Restore window if minimized
  if (IsIconic(hwnd)) {
    ShowWindow(hwnd, SW_RESTORE);
  }
  
  // Bring window to foreground
  SetForegroundWindow(hwnd);
  BringWindowToTop(hwnd);
  SetFocus(hwnd);
  
  // Detach if we attached
  if (attached) {
    AttachThreadInput(currentThreadId, fgThreadId, FALSE);
  }
  
  // Verify it worked
  HWND newFgHwnd = GetForegroundWindow();
  bool success = (newFgHwnd == hwnd);
  
  return Napi::Boolean::New(env, success);
}

// startWinEventHook(targetPid: number, cb: function): void
Napi::Value StartWinEventHook(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "Expected (number pid, function callback)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  
  // Stop existing hook if any
  if (g_hookState) {
    if (g_hookState->hookHandle1) {
      UnhookWinEvent(g_hookState->hookHandle1);
    }
    if (g_hookState->hookHandle2) {
      UnhookWinEvent(g_hookState->hookHandle2);
    }
    if (g_hookState->hookHandle3) {
      UnhookWinEvent(g_hookState->hookHandle3);
    }
    if (g_hookState->hookHandle4) {
      UnhookWinEvent(g_hookState->hookHandle4);
    }
    g_hookState->jsCallback.Reset();
    delete g_hookState;
    g_hookState = nullptr;
  }
  
  // Create new hook state
  g_hookState = new HookState();
  g_hookState->targetPid = info[0].As<Napi::Number>().Uint32Value();
  g_hookState->jsCallback = Napi::Persistent(info[1].As<Napi::Function>());
  g_hookState->hookHandle1 = NULL;
  g_hookState->hookHandle2 = NULL;
  g_hookState->hookHandle3 = NULL;
  g_hookState->hookHandle4 = NULL;
  
  // Set up WinEvent hooks for all events we care about
  // Hook 1: Location changes and destroy
  g_hookState->hookHandle1 = SetWinEventHook(
    EVENT_OBJECT_LOCATIONCHANGE,
    EVENT_OBJECT_DESTROY,
    NULL,
    WinEventProc,
    0,
    0,
    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
  );
  
  // Hook 2: Move/resize events
  g_hookState->hookHandle2 = SetWinEventHook(
    EVENT_SYSTEM_MOVESIZESTART,
    EVENT_SYSTEM_MOVESIZEEND,
    NULL,
    WinEventProc,
    0,
    0,
    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
  );
  
  // Hook 3: Minimize events
  g_hookState->hookHandle3 = SetWinEventHook(
    EVENT_SYSTEM_MINIMIZESTART,
    EVENT_SYSTEM_MINIMIZEEND,
    NULL,
    WinEventProc,
    0,
    0,
    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
  );

  // Hook 4: Foreground events (focus)
  g_hookState->hookHandle4 = SetWinEventHook(
    EVENT_SYSTEM_FOREGROUND,
    EVENT_SYSTEM_FOREGROUND,
    NULL,
    WinEventProc,
    0,
    0,
    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
  );

  // Check if at least one hook was set successfully
  // Note: SetWinEventHook returns NULL on failure, but GetLastError() might have more info
  if (!g_hookState->hookHandle1 && !g_hookState->hookHandle2 && !g_hookState->hookHandle3 && !g_hookState->hookHandle4) {
    DWORD error = GetLastError();
    g_hookState->jsCallback.Reset();
    delete g_hookState;
    g_hookState = nullptr;
    std::string errorMsg = "Failed to set WinEvent hooks. Error code: " + std::to_string(error);
    Napi::Error::New(env, errorMsg).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  
  // Log which hooks were successfully set
  // (We can't easily log from C++, but at least we know it succeeded if we get here)
  
  return env.Undefined();
}

// stopWinEventHook(): void
Napi::Value StopWinEventHook(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (g_hookState) {
    if (g_hookState->hookHandle1) {
      UnhookWinEvent(g_hookState->hookHandle1);
      g_hookState->hookHandle1 = NULL;
    }
    if (g_hookState->hookHandle2) {
      UnhookWinEvent(g_hookState->hookHandle2);
      g_hookState->hookHandle2 = NULL;
    }
    if (g_hookState->hookHandle3) {
      UnhookWinEvent(g_hookState->hookHandle3);
      g_hookState->hookHandle3 = NULL;
    }
    if (g_hookState->hookHandle4) {
      UnhookWinEvent(g_hookState->hookHandle4);
      g_hookState->hookHandle4 = NULL;
    }
    g_hookState->jsCallback.Reset();
    delete g_hookState;
    g_hookState = nullptr;
  }
  
  return env.Undefined();
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "findWindowByPid"),
              Napi::Function::New(env, FindWindowByPid));
  exports.Set(Napi::String::New(env, "findProcessIdByName"),
              Napi::Function::New(env, FindProcessIdByName));
  exports.Set(Napi::String::New(env, "getClientBoundsOnScreen"),
              Napi::Function::New(env, GetClientBoundsOnScreen));
  exports.Set(Napi::String::New(env, "isMinimized"),
              Napi::Function::New(env, IsMinimized));
  exports.Set(Napi::String::New(env, "getDpiScaleForHwnd"),
              Napi::Function::New(env, GetDpiScaleForHwnd));
  exports.Set(Napi::String::New(env, "getForegroundPid"),
              Napi::Function::New(env, GetForegroundPid));
  exports.Set(Napi::String::New(env, "forceActivateWindow"),
              Napi::Function::New(env, ForceActivateWindow));
  exports.Set(Napi::String::New(env, "startWinEventHook"),
              Napi::Function::New(env, StartWinEventHook));
  exports.Set(Napi::String::New(env, "stopWinEventHook"),
              Napi::Function::New(env, StopWinEventHook));
  
  return exports;
}

NODE_API_MODULE(cs2_window_tracker, Init)
