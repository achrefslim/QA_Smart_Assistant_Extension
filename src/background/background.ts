/**
 * src/background/background.ts
 *
 * Service worker for QA Smart Assistant.
 * Responsibilities:
 *  - Opens the recorder tab after permissions are granted
 *  - Injects the floating control bar into active tabs during recording
 *  - Injects the camera overlay into active tabs during recording
 *  - Relays messages between the recorder tab and content scripts
 *  - Captures screenshots on demand from the control bar
 */

import type { RecorderConfig } from '../shared/types';

// ─── State ───────────────────────────────────────────────────────────────────

let isRecording      = false;
let cameraEnabled    = false;
let ctrlBarEnabled   = true;  // decoupled from isRecording so shortcuts still work when the control bar is off
let pendingConfig    : RecorderConfig | null = null;
let recorderTabId    : number | null = null;
let micMuted         = false;
let isPaused         = false;
let currentSeconds   = 0;

// The tab the control bar is actually injected into right now. Broadcasts
// meant for the control bar (icon sync for pause/mic/cam) previously used
// chrome.tabs.query({active:true, currentWindow:true}) to guess this, which
// can disagree with reality (multiple windows, focus timing, DevTools) —
// targeting the exact tracked tab is reliable regardless of window focus.
let controlBarTabId  : number | null = null;

// Tracks the URL each tab had the last time we injected the control bar into
// it, so an SPA re-firing tabs.onUpdated('complete') via history.pushState
// (no real reload) doesn't re-inject and reset mic/pause/draw state.
const lastInjectedUrl = new Map<number, string>();

/**
 * Finds the recorder tab reliably. Prefers the tracked recorderTabId (set
 * when the tab was created) and falls back to a URL search only if that tab
 * is gone — searching by URL alone previously picked the FIRST tab matching
 * "recorder/recorder.html", which could be a stale leftover tab from an
 * earlier recording, silently stealing shortcut/annotation messages.
 */
function withRecorderTab(cb: (tabId: number) => void, onNotFound?: () => void): void {
  if (recorderTabId != null) {
    chrome.tabs.get(recorderTabId, tab => {
      if (!chrome.runtime.lastError && tab?.id) { cb(tab.id); return; }
      findRecorderTabByUrl(cb, onNotFound);
    });
    return;
  }
  findRecorderTabByUrl(cb, onNotFound);
}

function findRecorderTabByUrl(cb: (tabId: number) => void, onNotFound?: () => void): void {
  chrome.tabs.query({}, tabs => {
    const recTab = tabs.find(t => t.url?.includes('recorder/recorder.html'));
    if (recTab?.id) {
      recorderTabId = recTab.id; // self-heal the tracked id
      cb(recTab.id);
    } else {
      onNotFound?.();
    }
  });
}

// ─── Helpers: Is this a page we should skip? ─────────────────────────────────

function isSystemPage(url: string | undefined): boolean {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.includes('recorder.html') ||
    url.includes('review.html') ||
    url.includes('permissions.html')
  );
}

// ─── Control Bar ─────────────────────────────────────────────────────────────

// Serializes injectControlBar() calls per tab. Without this, two triggers
// firing close together (e.g. tabs.onActivated right as RECORDING_STARTED
// also injects) can interleave their "remove old bar → insert new bar"
// sequences: the second injection's script then finds a bar that's still
// there (from the first, still in flight) and bails out — leaving that
// control bar instance without its message listener ever registered, so its
// pause/mic icons silently stop responding to state updates even though the
// underlying pause/mute actions (handled entirely in the recorder tab) keep
// working. Chaining every call through this map's pending promise makes that
// race impossible.
const injectionQueue = new Map<number, Promise<void>>();

function injectControlBar(tabId: number): void {
  if (!tabId || !isRecording || !ctrlBarEnabled) return;

  const prior = injectionQueue.get(tabId) || Promise.resolve();
  const next  = prior.then(() => doInjectControlBar(tabId));
  injectionQueue.set(tabId, next.catch(() => {}));
}

function doInjectControlBar(tabId: number): Promise<void> {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (!tab?.url || isSystemPage(tab.url)) { resolve(); return; }

      lastInjectedUrl.set(tabId, tab.url);

      // Remove any existing control bar (and its draw canvas — left behind
      // canvases from a prior injection would otherwise stack up) before re-injecting
      chrome.scripting.executeScript({
        target: { tabId },
        func  : () => {
          document.getElementById('qa-controlbar-host')?.remove();
          document.getElementById('__qa_draw_canvas__')?.remove();
        },
      })
      .catch(() => {})
      .finally(() => {
        // Insert CSS *before* running the script (not in parallel) so the bar
        // never mounts unstyled even for a frame, and so a CSS failure is
        // logged instead of silently producing a broken-looking control bar.
        chrome.scripting.insertCSS({ target: { tabId }, files: ['controlbar/controlbar.css'] })
          .catch(e => console.warn('[QA] control bar CSS failed to inject:', e?.message))
          .then(() => chrome.scripting.executeScript({ target: { tabId }, files: ['controlbar/controlbar.js'] }))
          .then(() => {
            controlBarTabId = tabId;
            // Give the control bar a moment to mount, then sync timer, pause, mic, and camera state
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { type: 'TIMER_TICK', seconds: currentSeconds }).catch(() => {});
              chrome.tabs.sendMessage(tabId, { type: 'PAUSE_STATE', paused: isPaused }).catch(() => {});
              chrome.tabs.sendMessage(tabId, { type: 'MIC_MUTED_STATE', muted: micMuted }).catch(() => {});
              chrome.tabs.sendMessage(tabId, { type: 'CAM_STATE', enabled: cameraEnabled }).catch(() => {});
            }, 200);
          })
          .catch(e => console.warn('[QA] control bar script failed to inject:', e?.message))
          .finally(resolve);
      });
    });
  });
}

function removeControlBar(tabId: number): void {
  chrome.scripting.executeScript({
    target: { tabId },
    func  : () => {
      const bar = document.getElementById('qa-controlbar-host');
      if (bar) bar.remove();
    },
  }).catch(() => {});
}

function removeControlBarFromAllTabs(): void {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      if (tab.id && tab.url && !isSystemPage(tab.url)) {
        removeControlBar(tab.id);
      }
    });
  });
}

// ─── Recording State Broadcast (drives keyboard shortcuts in content.ts) ─────

/**
 * Sends a message to wherever the control bar actually lives right now.
 * Falls back to "the active tab in the current window" only if we don't yet
 * have a tracked control bar tab (e.g. before the first injection) — that
 * fallback is what previously caused mic/pause icon updates to silently miss
 * their target whenever Chrome's notion of "active tab" didn't match reality.
 */
function sendToControlBarTab(msg: Record<string, unknown>): void {
  if (controlBarTabId != null) {
    chrome.tabs.sendMessage(controlBarTabId, msg).catch(() => {});
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
  });
}

function notifyRecordingState(tabId: number, recording: boolean): void {
  chrome.tabs.sendMessage(tabId, { type: recording ? 'RECORDING_STARTED' : 'RECORDING_STOPPED' }).catch(() => {});
}

function broadcastRecordingStoppedToAllTabs(): void {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      if (tab.id && tab.url && !isSystemPage(tab.url)) {
        notifyRecordingState(tab.id, false);
      }
    });
  });
}

// ─── Camera Overlay ──────────────────────────────────────────────────────────

function injectCamera(tabId: number): void {
  if (!tabId || !cameraEnabled || !isRecording) return;

  chrome.tabs.get(tabId, tab => {
    if (!tab?.url || isSystemPage(tab.url)) return;

    chrome.scripting.executeScript({
      target: { tabId },
      func  : () => {
        // Don't inject twice
        if (document.getElementById('__qa_cam__')) return;

        const wrapper = document.createElement('div');
        wrapper.id = '__qa_cam__';
        wrapper.style.cssText = [
          'position:fixed', 'bottom:120px', 'right:20px',
          'width:200px', 'height:150px', 'border-radius:12px',
          'overflow:hidden', 'border:3px solid rgba(124,58,237,0.9)',
          'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
          'z-index:2147483646', 'background:#000',
        ].join(';');

        const video = document.createElement('video');
        video.autoplay   = true;
        video.muted      = true;
        video.playsInline = true;
        video.style.cssText = 'width:100%;height:100%;object-fit:cover;transform:scaleX(-1);';

        wrapper.appendChild(video);
        document.body.appendChild(wrapper);

        navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
          audio: false,
        })
        .then(stream => {
          video.srcObject = stream;
          (window as any).__qa_cam_stream__ = stream;
        })
        .catch(err => {
          console.warn('[QA cam]', err.message);
          wrapper.remove();
        });
      },
    }).catch(() => {});
  });
}

function removeCamera(tabId: number): void {
  chrome.scripting.executeScript({
    target: { tabId },
    func  : () => {
      const stream = (window as any).__qa_cam_stream__ as MediaStream | undefined;
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        (window as any).__qa_cam_stream__ = null;
      }
      document.getElementById('__qa_cam__')?.remove();
    },
  }).catch(() => {});
}

function removeCameraFromAllTabs(): void {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      if (tab.id && tab.url && !isSystemPage(tab.url)) {
        removeCamera(tab.id);
      }
    });
  });
}

// ─── Tab Events ──────────────────────────────────────────────────────────────

// When the user switches tabs during a recording, inject the control bar
// and camera into the newly focused tab
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!isRecording) return;
  chrome.tabs.get(tabId, tab => {
    if (!tab?.url || isSystemPage(tab.url)) return;
    injectControlBar(tabId);
    if (cameraEnabled) injectCamera(tabId);
    notifyRecordingState(tabId, true);
  });
});

// Also inject when a tab finishes loading (handles page navigation mid-recording).
// SPAs (History API navigation) can fire 'complete' repeatedly without an actual
// reload — only re-inject when the URL genuinely changed, otherwise the control
// bar (and its mic/pause/draw state) would reset every time the SPA re-renders.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isRecording || changeInfo.status !== 'complete') return;
  if (isSystemPage(tab.url)) return;
  if (lastInjectedUrl.get(tabId) === tab.url) return;

  chrome.tabs.query({ active: true, currentWindow: true }, activeTabs => {
    const activeTab = activeTabs[0];
    if (activeTab?.id === tabId) {
      injectControlBar(tabId);
      if (cameraEnabled) injectCamera(tabId);
      notifyRecordingState(tabId, true);
    }
  });
});

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  switch (msg.type) {

    // Popup saves its config before opening the permissions page
    case 'SAVE_RECORDER_CONFIG':
      pendingConfig = msg.config as RecorderConfig;
      sendResponse({ ok: true });
      return false;

    // Permissions page says the user is done granting access
    case 'PERMISSIONS_DONE': {
      if (!pendingConfig) { sendResponse({ ok: false }); return false; }

      const cfg = pendingConfig;
      pendingConfig = null;
      cameraEnabled = cfg.camOn;
      micMuted      = false;

      const params = new URLSearchParams({
        mode       : cfg.mode,
        quality    : cfg.quality,
        mic        : cfg.micOn     ? '1' : '0',
        cam        : cfg.camOn     ? '1' : '0',
        ctrlbar    : cfg.ctrlBarOn ? '1' : '0',
        countdown  : String(cfg.countdownSec),
        title      : cfg.title,
        tester     : cfg.tester,
        micg       : msg.mic === 'granted' ? '1' : '0',
        camg       : msg.cam === 'granted' ? '1' : '0',
        target     : cfg.targetTabId != null ? String(cfg.targetTabId) : '',
        priority   : cfg.priority    || 'medium',
        layer      : cfg.layer       || '',
        environment: cfg.environment || '',
        testType   : cfg.testType    || '',
        sprint     : cfg.sprint      || '',
        tags       : JSON.stringify(cfg.tags  || []),
        rules      : JSON.stringify(cfg.rules || []),
      });

      const recorderUrl = chrome.runtime.getURL('recorder/recorder.html') + '?' + params.toString();
      chrome.tabs.create({ url: recorderUrl }, tab => {
        recorderTabId = tab?.id ?? null;
      });

      sendResponse({ ok: true });
      return false;
    }

    // Recorder tab signals that recording has actually started.
    // This always fires (regardless of the Control Bar setting) so that
    // keyboard shortcuts keep working even when the control bar is hidden.
    case 'RECORDING_STARTED':
      isRecording    = true;
      currentSeconds = 0;
      micMuted       = false;
      isPaused       = false;
      ctrlBarEnabled = msg.ctrlBarOn !== false;

      // Reset the fallback screenshot bucket so a relay hiccup can never
      // resurface screenshots left over from a previous recording session.
      chrome.storage.session.set({ qa_screenshots: [] });

      if (msg.targetTabId) {
        if (ctrlBarEnabled) {
          injectControlBar(msg.targetTabId as number);
          if (cameraEnabled) injectCamera(msg.targetTabId as number);
        }
        notifyRecordingState(msg.targetTabId as number, true);
      }

      sendResponse({ ok: true });
      return false;

    // Manual camera injection request
    case 'CAM_INJECT':
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]?.id) injectCamera(tabs[0].id!);
      });
      sendResponse({ ok: true });
      return false;

    // Every second tick from the recorder — relay to the active tab's control bar
    case 'TIMER_TICK':
      currentSeconds = msg.seconds as number;
      sendToControlBarTab({ type: 'TIMER_TICK', seconds: msg.seconds });
      sendResponse({ ok: true });
      return false;

    // Relay pause/resume state to the active tab's control bar
    case 'RECORDING_PAUSED':
    case 'RECORDING_RESUMED':
      isPaused = msg.type === 'RECORDING_PAUSED';
      sendToControlBarTab(msg);
      sendResponse({ ok: true });
      return false;

    // Pause/resume shortcut (Alt+P) and control bar button both send this —
    // the recorder tab is the source of truth for whether it's currently paused.
    case 'CONTROLBAR_TOGGLE_PAUSE':
      withRecorderTab(
        tabId => chrome.tabs.sendMessage(tabId, msg).catch(() => {}),
        () => console.warn('[QA bg] CONTROLBAR_TOGGLE_PAUSE: no recorder tab found!')
      );
      sendResponse({ ok: true });
      return false;

    // Mic mute toggled from the control bar — relay to the recorder and
    // broadcast the resulting state so every surface (control bar icon,
    // future re-injections) stays in sync regardless of who triggered it
    case 'MIC_MUTE_TOGGLE':
      micMuted = msg.muted as boolean;
      withRecorderTab(tabId => {
        chrome.tabs.sendMessage(tabId, { type: 'MIC_MUTE_TOGGLE', muted: msg.muted }).catch(() => {});
      });
      sendToControlBarTab({ type: 'MIC_MUTED_STATE', muted: micMuted });
      sendResponse({ ok: true });
      return false;

    // Mic mute shortcut (Alt+M) — the recorder tab owns the mic stream and
    // is the only place that knows the current mute state, so it decides
    // whether to mute or unmute, then reports back via MIC_MUTE_TOGGLE above.
    case 'MIC_MUTE_SHORTCUT_TOGGLE':
      withRecorderTab(
        tabId => chrome.tabs.sendMessage(tabId, msg).catch(() => {}),
        () => console.warn('[QA bg] MIC_MUTE_SHORTCUT_TOGGLE: no recorder tab found!')
      );
      sendResponse({ ok: true });
      return false;

    // Camera toggle shortcut / control bar button
    case 'CAM_TOGGLE': {
      cameraEnabled = !cameraEnabled;

      const applyCamToggle = (tabId: number) => {
        if (cameraEnabled) {
          injectCamera(tabId);
        } else {
          removeCamera(tabId);
        }
        chrome.tabs.sendMessage(tabId, { type: 'CAM_STATE', enabled: cameraEnabled }).catch(() => {});
      };

      if (controlBarTabId != null) {
        applyCamToggle(controlBarTabId);
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (tabs[0]?.id) applyCamToggle(tabs[0].id);
        });
      }

      sendResponse({ ok: true });
      return false;
    }

    // Recording stopped cleanly from the recorder tab
    case 'RECORDING_STOPPED':
      isRecording   = false;
      cameraEnabled = false;
      recorderTabId   = null;
      controlBarTabId = null;
      lastInjectedUrl.clear();
      injectionQueue.clear();
      removeControlBarFromAllTabs();
      removeCameraFromAllTabs();
      broadcastRecordingStoppedToAllTabs();
      sendResponse({ ok: true });
      return false;

    // Screenshot requested from the control bar or the keyboard shortcut.
    // Capture from the tab that actually asked for it (sender.tab) rather
    // than "whatever tab is active" — those can differ across windows.
    case 'TAKE_SCREENSHOT': {
      // Respond immediately so the message channel stays open,
      // then do the async capture after the control bar has hidden itself
      sendResponse({ ok: true });

      const requestingTabId = sender.tab?.id ?? null;

      setTimeout(() => {
        const withWindow = (windowId: number | undefined, tabId: number | null) => {
          if (!windowId) return;

          chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, dataUrl => {
            if (chrome.runtime.lastError || !dataUrl) return;

            // Store in session storage so the review page can retrieve it
            // as a fallback — cleared at the start of every recording so it
            // can never resurface screenshots from a previous session.
            chrome.storage.session.get(['qa_screenshots'], result => {
              const existing = (result['qa_screenshots'] as unknown[]) || [];
              existing.push({ dataUrl, timestamp: msg.timestamp });
              chrome.storage.session.set({ qa_screenshots: existing });
            });

            // Send directly to the recorder tab (faster/primary path)
            withRecorderTab(recTabId => {
              chrome.tabs.sendMessage(recTabId, {
                type     : 'SCREENSHOT_TAKEN',
                dataUrl,
                timestamp: msg.timestamp,
              }).catch(() => {});
            });

            // Notify the tab that requested the screenshot (button or shortcut)
            // so it can restore the control bar's visibility and show feedback —
            // only after the capture has actually completed, not before.
            if (tabId) {
              chrome.tabs.sendMessage(tabId, {
                type     : 'SCREENSHOT_TAKEN',
                dataUrl,
                timestamp: msg.timestamp,
              }).catch(() => {});
            }
          });
        };

        if (requestingTabId) {
          chrome.tabs.get(requestingTabId, tab => withWindow(tab?.windowId, requestingTabId));
        } else {
          chrome.tabs.query({ active: true, currentWindow: true }, tabs => withWindow(tabs[0]?.windowId, tabs[0]?.id ?? null));
        }
      }, 100);

      return false;
    }

    // Control bar stop/pause/resume buttons — relay to the recorder tab
    case 'CONTROLBAR_STOP':
    case 'CONTROLBAR_PAUSE':
    case 'CONTROLBAR_RESUME':
      if (msg.type === 'CONTROLBAR_STOP') {
        isRecording   = false;
        cameraEnabled = false;
        recorderTabId = null;
        lastInjectedUrl.clear();
        removeControlBarFromAllTabs();
        removeCameraFromAllTabs();
        broadcastRecordingStoppedToAllTabs();
      }

      withRecorderTab(tabId => {
        chrome.tabs.sendMessage(tabId, msg).catch(() => {});
      });

      sendResponse({ ok: true });
      return false;

    // Draw-mode shortcut (Alt+D) — relay to the control bar in the active tab
    case 'TOGGLE_DRAW_MODE':
      sendToControlBarTab(msg);
      sendResponse({ ok: true });
      return false;

    // Quick Bug shortcut (Alt+B) — relay to the recorder tab along with the
    // tab that actually triggered it, so the mini form is injected into the
    // tab you're currently testing rather than whichever tab was active
    // when the recording started (those can easily differ mid-session).
    case 'QUICK_BUG_OPEN': {
      const sourceTabId = sender.tab?.id ?? null;
      withRecorderTab(tabId => {
        chrome.tabs.sendMessage(tabId, { type: 'QUICK_BUG_OPEN', sourceTabId }).catch(() => {});
      });
      sendResponse({ ok: true });
      return false;
    }

    // The Quick Bug mini form (injected into an arbitrary page) can't message
    // the recorder tab directly, so it round-trips through the background worker.
    case 'QUICK_BUG_GET_TIME':
      withRecorderTab(
        tabId => {
          chrome.tabs.sendMessage(tabId, { type: 'GET_CURRENT_TIME' }, resp => {
            sendResponse(resp || { timestamp: 0 });
          });
        },
        () => sendResponse({ timestamp: 0 })
      );
      return true;

    // Wait for the recorder tab to actually confirm the annotation was
    // stored, and forward that confirmation back to the mini form — a
    // fire-and-forget relay here would let a dropped message look like success.
    case 'QUICK_BUG_SUBMIT':
      withRecorderTab(
        tabId => {
          chrome.tabs.sendMessage(tabId, { type: 'QUICK_BUG_MARKED', annotation: msg.annotation }, resp => {
            sendResponse(resp || { ok: false });
          });
        },
        () => sendResponse({ ok: false })
      );
      return true;

    default:
      return false;
  }
});
