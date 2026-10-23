const path = require('path')
const { EventEmitter } = require('events')

// Accelerators that would dismiss / inspect / minimize the overlay. We
// disable them at two layers: a window-local before-input-event filter and
// system-wide globalShortcut registrations active only while the overlay
// is visible. Alt+F4 is the obvious one — on fullscreen BrowserWindows in
// Electron 33, closable:false alone doesn't reliably veto WM_CLOSE, so
// without these the kid can dismiss the block screen with one key combo.
const BLOCKED_GLOBAL_SHORTCUTS = [
  'Alt+F4',           // Win32 close-window accelerator
  'CommandOrControl+W',  // Chromium close-tab; harmless but consistent
  'CommandOrControl+R',  // Reload — must not refresh past the PIN gate
  'CommandOrControl+Shift+R',
  'F11',              // Toggle fullscreen — kid could un-fullscreen us
  'F12',              // DevTools (already disabled in webPreferences, defense in depth)
  'CommandOrControl+Shift+I',  // DevTools alternative binding
]

// True when the key chord would dismiss / inspect / minimize the overlay.
// Keep narrow: PIN digits, Backspace, Enter, arrow keys etc. must NOT match
// so the kid can still type the PIN. Module-level so tests can call it
// without instantiating OverlayManager (which needs the Electron ipcMain).
function isDismissShortcut(input) {
  if (!input) return false
  const key = (input.key || '').toLowerCase()
  if (input.alt && key === 'f4') return true
  if (input.control || input.meta) {
    if (key === 'w' || key === 'r') return true
    if (input.shift && key === 'r') return true
    if (input.shift && key === 'i') return true
  }
  if (key === 'f11' || key === 'f12') return true
  return false
}

// Manages the blocking-overlay BrowserWindows, one per connected display.
// Covering only the primary display let a child drag the blocked app onto a
// second monitor and keep using it (#292). Every window loads the full
// overlay page, so the child can request time or enter the PIN from any
// screen. Displays plugged in or removed while the overlay is up get a window
// added or destroyed to match.
//
// The windows are intentionally disposable: show() creates them on demand,
// hide() destroys them. Holding state across show/hide cycles isn't worth the
// complexity, and a fresh window guarantees the renderer state is clean.
//
// Hardening for kid-bypass attempts (best-effort; full anti-bypass is Phase 5):
//  - frameless, fullscreen, alwaysOnTop at screen-saver level
//  - closable: false (Alt+F4 is still possible on Windows but the window
//    immediately reopens on the next foreground tick, since enforcement keeps
//    re-evaluating)
//  - skipTaskbar so the overlay doesn't show as a separate task
//
// The electron modules are injectable so tests can drive the manager with
// fakes; production passes nothing and gets the real ones.
class OverlayManager extends EventEmitter {
  constructor({ rendererDir, electron } = {}) {
    super()
    const e = electron || require('electron')
    this._BrowserWindow = e.BrowserWindow
    this._screen = e.screen
    this._globalShortcut = e.globalShortcut
    this._rendererDir = rendererDir
    this._wins = new Map() // display id -> BrowserWindow
    this._currentPayload = null
    // webContents of the window that sent the latest request, so its result
    // goes back to the screen the child is actually using.
    this._lastSender = null
    this._shortcutsRegistered = false

    const forward = (event) => (e, payload) => {
      this._lastSender = e && e.sender
      this.emit(event, payload)
    }
    e.ipcMain.on('overlay:request-time', forward('request-time'))
    e.ipcMain.on('overlay:verify-pin', forward('verify-pin'))
    e.ipcMain.on('overlay:apply-pin-override', forward('apply-pin-override'))

    this._onDisplaysChanged = () => this._syncDisplays()
  }

  // payload: { packageName, appName, reason, category }
  show(payload) {
    this._currentPayload = payload
    if (this._wins.size === 0) {
      this._screen.on('display-added', this._onDisplaysChanged)
      this._screen.on('display-removed', this._onDisplaysChanged)
      this._screen.on('display-metrics-changed', this._onDisplaysChanged)
    } else {
      for (const win of this._wins.values()) {
        if (win.isDestroyed()) continue
        win.webContents.send('overlay:payload', payload)
        win.show()
      }
    }
    this._syncDisplays()
    this._focusPrimary()
  }

  // Make the set of overlay windows match the connected displays: one window
  // per display, sized to its full bounds.
  _syncDisplays() {
    if (this._currentPayload === null) return
    const displays = this._screen.getAllDisplays()
    const ids = new Set(displays.map((d) => d.id))
    for (const [id, win] of this._wins) {
      if (!ids.has(id)) {
        this._wins.delete(id)
        if (!win.isDestroyed()) win.destroy()
      }
    }
    for (const display of displays) {
      const existing = this._wins.get(display.id)
      if (existing && !existing.isDestroyed()) {
        const b = display.bounds
        const cur = existing.getBounds()
        if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
          existing.setBounds(b)
        }
        continue
      }
      this._wins.set(display.id, this._createWindow(display))
    }
    if (this._wins.size > 0) this._registerGlobalShortcuts()
  }

  _createWindow(display) {
    const { x, y, width, height } = display.bounds
    const win = new this._BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      fullscreen: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      closable: false,
      minimizable: false,
      maximizable: false,
      resizable: false,
      title: 'PearGuard',
      webPreferences: {
        preload: path.join(this._rendererDir, 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setMenuBarVisibility(false)

    win.loadFile(path.join(this._rendererDir, 'overlay.html'))
    win.webContents.once('did-finish-load', () => {
      if (this._currentPayload && !win.isDestroyed()) {
        win.webContents.send('overlay:payload', this._currentPayload)
      }
    })

    // Block Alt+F4 / WM_CLOSE. closable:false is unreliable on fullscreen Win32
    // windows in Electron 33, so we also veto the close event here. hide() goes
    // through destroy() which skips the close event entirely, so this veto only
    // catches kid-initiated closes.
    win.on('close', (event) => {
      event.preventDefault()
    })

    // Defense in depth against the kid Alt+F4'ing or F11'ing out of the
    // overlay. The before-input-event filter runs first and is window-local;
    // globalShortcut is the system-wide fallback for when Chromium's
    // accelerator path skips the renderer entirely (Win32 sends WM_CLOSE on
    // Alt+F4 before keyboard input reaches the page). Only specific window-
    // control combos are filtered — PIN digits still flow through normally.
    win.webContents.on('before-input-event', (event, input) => {
      if (isDismissShortcut(input)) event.preventDefault()
    })

    win.on('closed', () => {
      for (const [id, w] of this._wins) {
        if (w === win) this._wins.delete(id)
      }
      if (this._wins.size === 0) this._teardown()
    })
    return win
  }

  _focusPrimary() {
    let primaryId = null
    try { primaryId = this._screen.getPrimaryDisplay().id } catch (_) {}
    const win = this._wins.get(primaryId) || this._wins.values().next().value
    if (win && !win.isDestroyed()) win.focus()
  }

  _registerGlobalShortcuts() {
    if (this._shortcutsRegistered) return
    this._shortcutsRegistered = true
    for (const accel of BLOCKED_GLOBAL_SHORTCUTS) {
      try {
        // No-op callback; registration alone is enough to swallow the key
        // chord at the OS level while the overlay is up.
        this._globalShortcut.register(accel, () => {})
      } catch (e) {
        // Another app may already hold this shortcut. Not fatal — the
        // before-input-event filter still catches keys that reach the
        // renderer. Log so a debugger has a breadcrumb.
        try { console.warn('[overlay] globalShortcut register failed for', accel, ':', e.message) } catch (_) {}
      }
    }
  }

  _unregisterGlobalShortcuts() {
    if (!this._shortcutsRegistered) return
    this._shortcutsRegistered = false
    for (const accel of BLOCKED_GLOBAL_SHORTCUTS) {
      try { this._globalShortcut.unregister(accel) } catch (_) {}
    }
  }

  _teardown() {
    this._unregisterGlobalShortcuts()
    this._screen.removeListener('display-added', this._onDisplaysChanged)
    this._screen.removeListener('display-removed', this._onDisplaysChanged)
    this._screen.removeListener('display-metrics-changed', this._onDisplaysChanged)
  }

  hide() {
    this._currentPayload = null
    this._lastSender = null
    const wins = [...this._wins.values()]
    this._wins.clear()
    for (const win of wins) {
      if (!win.isDestroyed()) win.destroy()
    }
    this._teardown()
  }

  // Push a transient result back to the renderer so it can show success/error
  // (e.g., wrong PIN). result: { ok: bool, error?: string }. Goes to the
  // window that sent the request; the other screens keep their own view.
  notifyResult(channel, result) {
    const sender = this._lastSender
    for (const win of this._wins.values()) {
      if (win.isDestroyed()) continue
      if (sender && win.webContents !== sender) continue
      win.webContents.send(channel, result)
      return
    }
  }

  // OS pids of the renderer processes backing the overlay windows; empty when
  // no overlay is shown. Used by the enforcement controller to ignore the
  // overlay's own foreground events.
  getRendererPids() {
    const pids = []
    for (const win of this._wins.values()) {
      if (win.isDestroyed()) continue
      try {
        const pid = win.webContents.getOSProcessId()
        if (pid) pids.push(pid)
      } catch (_) {}
    }
    return pids
  }
}

module.exports = { OverlayManager, BLOCKED_GLOBAL_SHORTCUTS, isDismissShortcut }
