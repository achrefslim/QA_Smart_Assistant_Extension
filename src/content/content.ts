/**
 * src/content/content.ts
 *
 * Content script — runs on every page the user visits.
 * Kept intentionally small. Its only jobs are:
 *  1. Answer GET_PAGE_INFO requests (used by the popup notes feature)
 *  2. Relay control bar button clicks to the background worker
 *
 * Speech recognition runs inside recorder.js (extension origin) because
 * content scripts in third-party pages cannot reliably start microphone
 * access without a user gesture in that page's context.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'GET_PAGE_INFO') {
    sendResponse({ url: window.location.href, title: document.title });
    return false;
  }

  // Control bar buttons are injected into the page, but chrome.runtime
  // is only available in the content script context, so the control bar
  // sends messages to the content script, which forwards them to background
  if (
    msg.type === 'CONTROLBAR_STOP'   ||
    msg.type === 'CONTROLBAR_PAUSE'  ||
    msg.type === 'CONTROLBAR_RESUME'
  ) {
    chrome.runtime.sendMessage(msg);
    sendResponse({ ok: true });
    return false;
  }

  // Background broadcasts recording state so the keyboard shortcuts below
  // only fire while a recording is actually running.
  if (msg.type === 'RECORDING_STARTED') { isRecording = true;  return false; }
  if (msg.type === 'RECORDING_STOPPED') { isRecording = false; return false; }

  return false;
});

// ─── Keyboard Shortcuts (during recording) ────────────────────────────────────

interface ShortcutMap {
  pause     : string;
  stop      : string;
  screenshot: string;
  draw      : string;
  bug       : string;
  mic       : string;
  camera    : string;
}

const DEFAULT_SHORTCUTS: ShortcutMap = {
  pause     : 'Alt+P',
  stop      : 'Alt+S',
  screenshot: 'Alt+C',
  draw      : 'Alt+D',
  bug       : 'Alt+B',
  mic       : 'Alt+M',
  camera    : 'Alt+K',
};

let isRecording = false;
let shortcuts   : ShortcutMap = { ...DEFAULT_SHORTCUTS };

const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Shift', 'Meta', 'AltGraph', 'OS']);

/** True if combo looks like a real shortcut (last part isn't itself a modifier). */
function isValidCombo(combo: string | undefined): combo is string {
  if (!combo) return false;
  const parts = combo.split('+');
  return !MODIFIER_KEYS.has(parts[parts.length - 1]);
}

function loadShortcuts(): void {
  chrome.storage.local.get(['qa_shortcuts'], result => {
    const saved = result['qa_shortcuts'] as Partial<ShortcutMap> | undefined;
    shortcuts = { ...DEFAULT_SHORTCUTS };

    // Self-heal shortcuts corrupted by a fixed bug where pressing Alt alone
    // (before the second key) got saved as the whole combo in Settings.
    (Object.keys(DEFAULT_SHORTCUTS) as (keyof ShortcutMap)[]).forEach(action => {
      const value = saved?.[action];
      if (isValidCombo(value)) shortcuts[action] = value;
    });
  });
}
loadShortcuts();

// Settings can be changed mid-recording — pick up edits without a page reload
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['qa_shortcuts']) loadShortcuts();
});

function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.altKey)   parts.push('Alt');
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join('+');
}

/**
 * Hide only the control bar's toolbar chrome before a screenshot — NOT the
 * draw canvas, which holds the user's actual pen/rectangle bug annotations.
 * Those should show up in the screenshot; only the floating buttons shouldn't.
 */
function hideControlBarForScreenshot(): void {
  const bar = document.getElementById('qa-controlbar-host');
  if (bar) bar.style.visibility = 'hidden';
}

// Restore visibility as a safety net in case the control bar was hidden by a
// screenshot shortcut but never received the SCREENSHOT_TAKEN broadcast
// (e.g. control bar disabled). The control bar's own listener handles the
// normal case; this just prevents a permanently-hidden bar on failure.
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'SCREENSHOT_TAKEN') {
    const bar = document.getElementById('qa-controlbar-host');
    if (bar) bar.style.visibility = 'visible';

    // If the control bar isn't present (disabled in settings), there's no
    // flash to show — fall back to a small toast so the shortcut always
    // gives the same feedback as the button.
    if (!bar) showScreenshotToast();
  }
});

function showScreenshotToast(): void {
  const toast = document.createElement('div');
  toast.textContent = '📸 Screenshot saved';
  toast.style.cssText = [
    'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
    'background:#101A2C', 'border:1px solid rgba(148,163,253,.3)',
    'color:white', 'padding:8px 16px', 'border-radius:10px',
    'font-size:12px', 'font-weight:600', 'z-index:2147483647',
    'font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.4)',
  ].join(';');
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1800);
}

// If the extension was reloaded (e.g. during development) after this page
// loaded, this tab's chrome.runtime connection is dead — sendMessage throws
// "Extension context invalidated" and the shortcut silently does nothing.
// Surface that instead of failing silently, once per page, so it's obvious
// the fix is to refresh the tab rather than a shortcut/logic bug.
let contextInvalidatedWarned = false;
function safeSend(msg: Record<string, unknown>): void {
  try {
    const result = chrome.runtime.sendMessage(msg);
    (result as Promise<unknown>)?.catch?.(() => warnContextInvalidated());
  } catch {
    warnContextInvalidated();
  }
}

function warnContextInvalidated(): void {
  if (contextInvalidatedWarned) return;
  contextInvalidatedWarned = true;
  const toast = document.createElement('div');
  toast.textContent = '⚠️ QA Assistant was updated — refresh this page for shortcuts to work';
  toast.style.cssText = [
    'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
    'background:#101A2C', 'border:1px solid rgba(255,120,120,.4)',
    'color:white', 'padding:8px 16px', 'border-radius:10px',
    'font-size:12px', 'font-weight:600', 'z-index:2147483647',
    'font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.4)',
  ].join(';');
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// Listen on the capture phase so pages that stopPropagation() on keydown
// (common on sites with their own shortcuts) can't swallow ours first.
document.addEventListener('keydown', e => {
  if (!isRecording) return;
  if (e.repeat) return; // ignore OS key-repeat while a key is held down

  const combo = comboFromEvent(e);

  if (combo === shortcuts.pause) {
    safeSend({ type: 'CONTROLBAR_TOGGLE_PAUSE' });
  } else if (combo === shortcuts.stop) {
    safeSend({ type: 'CONTROLBAR_STOP' });
  } else if (combo === shortcuts.screenshot) {
    hideControlBarForScreenshot();
    setTimeout(() => {
      safeSend({ type: 'TAKE_SCREENSHOT', timestamp: Date.now() });
    }, 80);
  } else if (combo === shortcuts.draw) {
    safeSend({ type: 'TOGGLE_DRAW_MODE' });
  } else if (combo === shortcuts.bug) {
    safeSend({ type: 'QUICK_BUG_OPEN' });
  } else if (combo === shortcuts.mic) {
    safeSend({ type: 'MIC_MUTE_SHORTCUT_TOGGLE' });
  } else if (combo === shortcuts.camera) {
    safeSend({ type: 'CAM_TOGGLE' });
  } else {
    return;
  }

  e.preventDefault();
}, true);
