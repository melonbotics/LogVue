/** Where the Control Hub keeps its `.rlog` files (spec §7.2). */
export const RLOG_ROOT = '/sdcard/FIRST/SpiderKit'

/** Extension we treat as a hub log. */
export const RLOG_EXT = '.rlog'

/** Default wireless Control Hub address used by the Connect action. */
export const DEFAULT_ADB_ADDRESS = '192.168.43.1:5555'

/**
 * Shown when `adb` isn't on PATH (ARCHITECTURE §7: no bundled binary, no configurable
 * path — we wrap the system `adb`). Keep it a friendly hint, not a stack trace.
 */
export const ADB_NOT_FOUND_HINT =
  'adb was not found on your PATH. Install Android Platform Tools and make sure ' +
  '`adb` runs from a terminal, then reconnect the Control Hub.'
