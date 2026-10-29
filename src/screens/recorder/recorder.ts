/**
 * src/screens/recorder/recorder.ts
 *
 * Runs in the recorder tab (chrome-extension:// origin).
 * Responsibilities:
 *  - Read session config from URL params
 *  - Run the countdown overlay (in this tab + the user's tab)
 *  - Start screen + mic recording via MediaRecorder
 *  - Run Web Speech API for live transcription (mic permission already granted here)
 *  - Collect screenshots taken via the control bar
 *  - On stop: fix duration metadata, open review tab, send recording data
 *  - Save the session to IndexedDB so the Results screen can find it later
 */

import { saveSession } from '../../shared/db/database';
import type { TranscriptEntry, Screenshot, TestRule, Priority, BugAnnotation } from '../../shared/types';

// ─── Parse URL Config ─────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);

function parseJsonSafely<T>(raw: string | null, fallback: T): T {
  try { return JSON.parse(raw || '') as T; }
  catch { return fallback; }
}

const cfg = {
  mode       : params.get('mode')     || 'desktop',
  quality    : params.get('quality')  || '720',
  micOn      : params.get('mic')      === '1',
  camOn      : params.get('cam')      === '1',
  ctrlBarOn  : params.get('ctrlbar')  === '1',
  countdown  : parseInt(params.get('countdown') || '3', 10),
  title      : decodeURIComponent(params.get('title')  || 'QA Session'),
  tester     : decodeURIComponent(params.get('tester') || 'Tester'),
  micGranted : params.get('micg') === '1',
  camGranted : params.get('camg') === '1',
  targetTabId: (() => {
    const raw = params.get('target');
    return raw !== null && raw !== '' ? parseInt(raw, 10) : null;
  })(),
  priority   : (params.get('priority') || 'medium') as Priority,
  layer      : params.get('layer')       || '',
  environment: params.get('environment') || '',
  testType   : params.get('testType')    || '',
  sprint     : params.get('sprint')      || '',
  tags       : parseJsonSafely<string[]>(params.get('tags'),  []),
  rules      : parseJsonSafely<string[]>(params.get('rules'), []),
};

// ─── Recording State ──────────────────────────────────────────────────────────

let mediaRecorder: MediaRecorder | null = null;
let screenStream : MediaStream   | null = null;
let micStream    : MediaStream   | null = null;
let chunks       : Blob[]              = [];
let seconds      = 0;
let paused       = false;
let micMuted     = false;
let timerInterval: ReturnType<typeof setInterval> | null = null;

// Speech Recognition
let srRunning     = false;
let srInstance   : any = null;
let srNetErrCount = 0;
const transcript : TranscriptEntry[]       = [];
const screenshots: Screenshot[]            = [];
const quickBugs  : BugAnnotation[]         = []; // marked via Alt+B during recording

// Session timer warning (Feature: configurable threshold in Settings)
let maxWarnMinutes = 15;
let warnedLongSession = false;

// Tab IDs
let userTabId    : number | null = null;
let userTabTitle  = '';
let recorderTabId: number | null = null;
let localSkip     = false;

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  return bytes < 1_048_576
    ? (bytes / 1024).toFixed(0) + ' KB'
    : (bytes / 1_048_576).toFixed(1) + ' MB';
}

function escapeHtml(str: string): string {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}

/** Show an amber warning banner in the user's tab (session timer warning). */
function notifyUserTabWarning(message: string): void {
  if (!userTabId) return;
  chrome.scripting.executeScript({
    target: { tabId: userTabId },
    func  : (msg: string) => {
      document.getElementById('__qa_timer_warning__')?.remove();
      const banner = document.createElement('div');
      banner.id = '__qa_timer_warning__';
      banner.style.cssText = [
        'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
        'background:#F59E0B', 'color:#101A2C', 'padding:10px 18px', 'border-radius:10px',
        'font-size:12.5px', 'font-weight:700', 'z-index:2147483648',
        'font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif',
        'max-width:80vw', 'text-align:center', 'box-shadow:0 8px 24px rgba(0,0,0,.35)',
      ].join(';');
      banner.textContent = msg;
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 8000);
    },
    args: [message],
  }).catch(() => {});
}

/** Show a brief on-screen toast in the user's tab via scripting. */
function notifyUserTab(message: string, durationMs = 5000): void {
  if (!userTabId) return;
  chrome.scripting.executeScript({
    target: { tabId: userTabId },
    func  : (msg: string, dur: number) => {
      const toast = document.createElement('div');
      toast.style.cssText = [
        'position:fixed', 'bottom:140px', 'left:50%', 'transform:translateX(-50%)',
        'background:#16223A', 'border:1px solid rgba(148,163,253,.3)',
        'color:white', 'padding:9px 16px', 'border-radius:10px',
        'font-size:12px', 'z-index:2147483648', 'font-family:sans-serif',
        'max-width:80vw', 'text-align:center', 'box-shadow:0 8px 24px rgba(0,0,0,.45)',
      ].join(';');
      toast.textContent = msg;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), dur);
    },
    args: [message, durationMs],
  }).catch(() => {});
}

// ─── Tab IDs ──────────────────────────────────────────────────────────────────

/**
 * userTabId comes from cfg.targetTabId, captured by popup.ts at the one
 * moment this was unambiguous (the tab active when the user clicked Launch).
 * It is threaded through permissions.html / background.ts as a URL param
 * rather than being re-guessed here, which would be unreliable.
 */
async function resolveTabIds(): Promise<void> {
  return new Promise(resolve => {
    chrome.tabs.getCurrent(myTab => {
      recorderTabId = myTab?.id ?? null;

      if (cfg.targetTabId == null) {
        console.warn('[QA] No target tab passed to recorder — countdown/control bar skipped.');
        userTabId = null;
        resolve();
        return;
      }

      chrome.tabs.get(cfg.targetTabId, tab => {
        if (chrome.runtime.lastError || !tab) {
          console.warn('[QA] Target tab no longer exists — countdown/control bar skipped.');
          userTabId = null;
        } else {
          userTabId    = tab.id ?? null;
          userTabTitle = tab.title || '';
        }
        resolve();
      });
    });
  });
}

// ─── UI Shell ─────────────────────────────────────────────────────────────────

const LOGO_SVG = `<svg viewBox="0 0 20 20" fill="none">
  <rect x="5" y="3" width="5" height="9" rx="2.5" fill="white"/>
  <path d="M3 9a7 7 0 0014 0" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
  <line x1="10" y1="16" x2="10" y2="18.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

function renderShell(innerHtml: string): void {
  document.body.innerHTML = `<div class="rc-shell"><div class="rc-card">${innerHtml}</div></div>`;
}

function showPreparingUI(): void {
  document.title = 'QA Smart Assistant: Recording';
  renderShell(`
    <div class="rc-logo">${LOGO_SVG}</div>
    <div class="rc-spinner"></div>
    <p class="rc-title">Getting ready</p>
    <p class="rc-sub">Preparing your recording session.</p>`);
}

function showCountdownUI(): void {
  document.title = 'QA Smart Assistant: Starting';
  renderShell(`
    <div class="rc-logo">${LOGO_SVG}</div>
    <p class="rc-status-text">Recording starts in</p>
    <p class="rc-timer" id="rc-cd-num">${cfg.countdown}</p>
    <p class="rc-sub" id="rc-cd-hint">Get ready</p>
    <button class="rc-btn rc-btn-ghost" id="rc-cd-skip" style="width:100%;">Skip</button>`);
  document.getElementById('rc-cd-skip')?.addEventListener('click', () => { localSkip = true; });
}

function updateCountdownUI(remaining: number, hint: string): void {
  const numEl  = document.getElementById('rc-cd-num');
  const hintEl = document.getElementById('rc-cd-hint');
  if (numEl)  numEl.textContent  = String(Math.ceil(remaining) || '');
  if (hintEl) hintEl.textContent = hint;
}

function showRecordingUI(): void {
  document.title = 'QA Smart Assistant: Recording';

  const micIcon   = `<svg viewBox="0 0 20 20" fill="none"><rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor"/><path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>`;
  const camIcon   = `<svg viewBox="0 0 20 20" fill="none"><path d="M3 6h9a2 2 0 012 2v4a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2z" stroke="currentColor" stroke-width="1.4"/><path d="M14 8.5l4-2v5l-4-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const barIcon   = `<svg viewBox="0 0 20 20" fill="none"><rect x="2" y="7" width="16" height="6" rx="3" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="10" r="1.3" fill="currentColor"/><circle cx="10" cy="10" r="1.3" fill="currentColor"/></svg>`;
  const pauseIcon = `<svg viewBox="0 0 20 20" fill="none"><rect x="6" y="4" width="3" height="12" rx="1.5" fill="currentColor"/><rect x="11" y="4" width="3" height="12" rx="1.5" fill="currentColor"/></svg>`;
  const stopIcon  = `<svg viewBox="0 0 20 20" fill="none"><rect x="5" y="5" width="10" height="10" rx="2" fill="white"/></svg>`;

  renderShell(`
    <div class="rc-status-row">
      <span class="rc-dot" id="rc-dot"></span>
      <span class="rc-status-text" id="rc-status-text">Recording</span>
    </div>
    <p class="rc-timer" id="rc-timer">0:00</p>
    <p class="rc-session">${escapeHtml(cfg.title)}</p>
    <div class="rc-meta-row">
      <span class="rc-meta-pill ${cfg.micOn ? 'active' : ''}">${micIcon} Mic</span>
      <span class="rc-meta-pill ${cfg.camOn ? 'active' : ''}">${camIcon} Camera</span>
      <span class="rc-meta-pill ${cfg.ctrlBarOn ? 'active' : ''}">${barIcon} Control Bar</span>
    </div>
    <div class="rc-actions">
      <button class="rc-btn rc-btn-pause" id="rc-btn-pause">${pauseIcon}Pause</button>
      <button class="rc-btn rc-btn-stop"  id="rc-btn-stop">${stopIcon}Stop</button>
    </div>
    <p class="rc-hint">
      Switch back to your test tab — recording continues in the background.
      The floating control bar also lets you pause or stop.
    </p>`);

  document.getElementById('rc-btn-pause')?.addEventListener('click', () => {
    paused ? doResume() : doPause();
  });
  document.getElementById('rc-btn-stop')?.addEventListener('click', doStop);
}

function updatePauseUI(): void {
  const btn  = document.getElementById('rc-btn-pause');
  const dot  = document.getElementById('rc-dot');
  const text = document.getElementById('rc-status-text');

  if (btn) {
    btn.innerHTML = paused
      ? `<svg viewBox="0 0 20 20" fill="none"><path d="M7 5l9 5-9 5V5z" fill="currentColor"/></svg>Resume`
      : `<svg viewBox="0 0 20 20" fill="none"><rect x="6" y="4" width="3" height="12" rx="1.5" fill="currentColor"/><rect x="11" y="4" width="3" height="12" rx="1.5" fill="currentColor"/></svg>Pause`;
  }
  if (dot)  (dot as HTMLElement).style.animationPlayState = paused ? 'paused' : '';
  if (text) text.textContent = paused ? 'Paused' : 'Recording';
}

function updateOverlayTimer(): void {
  const timerEl = document.getElementById('rc-timer');
  if (timerEl) timerEl.textContent = formatTime(seconds);
}

function showSavingUI(size: number): void {
  renderShell(`
    <div class="rc-spinner"></div>
    <p class="rc-title">Opening review page</p>
    <p class="rc-sub">File size: ${formatSize(size)}. Do not close this tab yet.</p>`);
}

function showKeepOpenUI(size: number, blobURL: string, ext: string, title: string): void {
  renderShell(`
    <div class="rc-success-icon">
      <svg viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2.5"/>
        <path d="M14 24l8 8 12-14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <p class="rc-title">Review page is ready</p>
    <p class="rc-sub"><strong>Keep this tab open</strong> until you download the video. File size: ${formatSize(size)}</p>
    <button class="rc-btn rc-btn-primary" id="direct-download" style="width:100%;">
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M10 3v10M6 9l4 4 4-4" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 15v1a2 2 0 002 2h10a2 2 0 002-2v-1" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      Download Here Too
    </button>
    <p class="rc-hint">This tab closes automatically after download.</p>`);

  document.getElementById('direct-download')?.addEventListener('click', () => {
    const a   = document.createElement('a');
    a.href     = blobURL;
    a.download = `${title || 'QA_Session'}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => window.close(), 1500);
  });
}

function showRecorderError(message: string): void {
  renderShell(`
    <div class="rc-error-icon">
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
        <path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
    <p class="rc-error-title">Something went wrong</p>
    <p class="rc-sub">${escapeHtml(message)}</p>
    <button class="rc-btn rc-btn-ghost" id="rc-err-close" style="width:100%;">Close</button>`);
  document.getElementById('rc-err-close')?.addEventListener('click', () => window.close());
}

// ─── Countdown ────────────────────────────────────────────────────────────────

async function runCountdown(): Promise<void> {
  if (cfg.countdown <= 0) return;

  showCountdownUI();
  localSkip = false;

  // Inject overlay into user's tab
  if (userTabId) {
    await chrome.scripting.executeScript({
      target: { tabId: userTabId },
      func  : (sec: number) => {
        document.getElementById('__qa_overlay__')?.remove();
        const ov = document.createElement('div');
        ov.id = '__qa_overlay__';
        ov.style.cssText = [
          'position:fixed', 'inset:0', 'z-index:2147483647',
          'background:rgba(7,11,20,0.86)',
          'display:flex', 'flex-direction:column',
          'align-items:center', 'justify-content:center',
          'gap:18px', 'font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif',
        ].join(';');
        ov.innerHTML = `
          <p style="font-size:15px;font-weight:500;color:rgba(248,250,252,.55);margin:0;">Recording starts in</p>
          <div style="position:relative;width:156px;height:156px;display:flex;align-items:center;justify-content:center;">
            <svg style="position:absolute;inset:0;width:100%;height:100%;" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(59,130,246,.2)" stroke-width="7"/>
              <circle id="__qa_arc__" cx="60" cy="60" r="52" fill="none" stroke="#3B82F6" stroke-width="7"
                stroke-linecap="round" stroke-dasharray="327" stroke-dashoffset="0" transform="rotate(-90 60 60)"
                style="transition:stroke-dashoffset .18s linear;"/>
            </svg>
            <span id="__qa_num__" style="font-size:78px;font-weight:800;color:white;line-height:1;position:relative;">${sec}</span>
          </div>
          <p id="__qa_hint__" style="font-size:13px;color:rgba(248,250,252,.4);margin:0;">Get ready</p>
          <button id="__qa_skip__" style="padding:10px 32px;border:1.5px solid rgba(148,163,253,.3);border-radius:100px;color:rgba(248,250,252,.7);font-size:13px;font-weight:500;cursor:pointer;background:none;font-family:inherit;">Skip</button>`;
        document.body.appendChild(ov);
        (window as any).__qa_skip__ = false;
        document.getElementById('__qa_skip__')!.onclick = () => { (window as any).__qa_skip__ = true; };
      },
      args: [cfg.countdown],
    }).catch(() => {});
  }

  const CIRCUMFERENCE  = 327;
  const startTime      = Date.now();
  const pickerHint     = userTabTitle
    ? `Pick "${userTabTitle.length > 40 ? userTabTitle.slice(0, 40) + '…' : userTabTitle}" in the picker`
    : 'Screen picker will open next';
  const hints          = ['Get ready', pickerHint, 'Starting'];

  return new Promise(resolve => {
    const interval = setInterval(async () => {
      const elapsed   = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, cfg.countdown - elapsed);
      const hintIndex = Math.min(Math.floor(elapsed / (cfg.countdown / hints.length)), hints.length - 1);

      updateCountdownUI(remaining, hints[hintIndex]);

      // Check if the user clicked Skip in the user's tab
      let remoteSkipped = false;
      if (userTabId) {
        try {
          const result = await chrome.scripting.executeScript({
            target: { tabId: userTabId },
            func  : () => !!(window as any).__qa_skip__,
          });
          remoteSkipped = result?.[0]?.result ?? false;
        } catch { /* tab may have navigated */ }
      }

      if (elapsed >= cfg.countdown || localSkip || remoteSkipped) {
        clearInterval(interval);
        if (userTabId) {
          chrome.scripting.executeScript({
            target: { tabId: userTabId },
            func  : () => document.getElementById('__qa_overlay__')?.remove(),
          }).catch(() => {});
        }
        resolve();
        return;
      }

      // Update the arc and number in the user's tab overlay
      if (userTabId) {
        const arcOffset = Math.min(CIRCUMFERENCE, (elapsed / cfg.countdown) * CIRCUMFERENCE);
        chrome.scripting.executeScript({
          target: { tabId: userTabId },
          func  : (num: number, arc: number, hint: string) => {
            const numEl  = document.getElementById('__qa_num__');
            const arcEl  = document.getElementById('__qa_arc__');
            const hintEl = document.getElementById('__qa_hint__');
            if (numEl)  numEl.textContent  = String(Math.ceil(num) || '');
            if (arcEl)  arcEl.style.strokeDashoffset = String(arc);
            if (hintEl) hintEl.textContent = hint;
          },
          args: [remaining, arcOffset, hints[hintIndex]],
        }).catch(() => { clearInterval(interval); resolve(); });
      }
    }, 200);
  });
}

// ─── Start Recording ──────────────────────────────────────────────────────────

async function startRecording(): Promise<void> {
  try {
    const videoConstraints: MediaTrackConstraints = cfg.quality === '1080'
      ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
      : cfg.quality === '4k'
      ? { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }
      : { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30 } };

    if (cfg.mode === 'tab') {
      (videoConstraints as any).displaySurface = 'browser';
    }

    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: true,
    });

    // Microphone
    if (cfg.micOn) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
          video: false,
        });
      } catch (err: any) {
        console.warn('[QA] Mic getUserMedia failed:', err.name, err.message);
        notifyUserTab(`Microphone not available (${err.name}), recording screen only`, 4000);
      }
    }

    // Camera overlay managed by background.ts across all tabs
    if (cfg.camOn) {
      chrome.runtime.sendMessage({ type: 'CAM_INJECT' });
    }

    // Combine all tracks into one stream
    const tracks: MediaStreamTrack[] = [...screenStream.getVideoTracks()];
    micStream?.getAudioTracks().forEach(t => tracks.push(t));
    screenStream.getAudioTracks().forEach(t => { if (!tracks.includes(t)) tracks.push(t); });
    const combined = new MediaStream(tracks);

    // Try MP4 first, fall back to WebM
    const mp4Mime = ['video/mp4;codecs=h264,aac', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
      .find(t => MediaRecorder.isTypeSupported(t));
    const webmMime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const mimeType = mp4Mime || webmMime;

    const bitrate = cfg.quality === '4k' ? 8_000_000 : cfg.quality === '1080' ? 4_000_000 : 2_500_000;
    console.log('[QA] Recording MIME:', mimeType);

    chunks.length      = 0;
    transcript.length  = 0;
    mediaRecorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: bitrate });
    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop          = onRecordingStop;
    mediaRecorder.start(1000);

    // Stop recording if the user stops sharing their screen from Chrome's UI
    screenStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (mediaRecorder?.state !== 'inactive') doStop();
    });

    showRecordingUI();

    // Always tell background a recording has started — even with the control
    // bar disabled — so keyboard shortcuts (which depend on background
    // broadcasting recording state to content scripts) keep working.
    // ctrlBarOn only controls whether the visual control bar gets injected.
    if (userTabId) {
      chrome.runtime.sendMessage({ type: 'RECORDING_STARTED', targetTabId: userTabId, ctrlBarOn: cfg.ctrlBarOn });
    }

    seconds = 0;
    paused  = false;

    chrome.storage.local.get(['qa_session_timer'], result => {
      const cfg = result['qa_session_timer'] as { maxMinutes?: number } | undefined;
      maxWarnMinutes = cfg?.maxMinutes ?? 15;
    });

    timerInterval = setInterval(() => {
      if (!paused) {
        seconds++;
        updateOverlayTimer();
        chrome.runtime.sendMessage({ type: 'TIMER_TICK', seconds }).catch(() => {});

        if (!warnedLongSession && seconds === maxWarnMinutes * 60) {
          warnedLongSession = true;

          chrome.notifications.create({
            type   : 'basic',
            iconUrl: chrome.runtime.getURL('assets/icons/icon48.png'),
            title  : 'QA Smart Assistant — Long Session',
            message: `Your session has exceeded ${maxWarnMinutes} minutes. Consider stopping and starting a new session for better AI report quality.`,
          });

          notifyUserTabWarning(`⚠ Session over ${maxWarnMinutes} min — shorter sessions give better AI reports`);
        }
      }
    }, 1000);

    startSpeechRecognition();

    // Switch back to the user's tab so they can start testing
    if (userTabId) chrome.tabs.update(userTabId, { active: true });

  } catch (err: any) {
    console.error('[QA recorder]', err.name, err.message);
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      chrome.runtime.sendMessage({ type: 'RECORDER_CANCELLED' });
    }
    window.close();
  }
}

// ─── Pause / Resume / Stop ───────────────────────────────────────────────────

function doPause(): void {
  if (mediaRecorder?.state !== 'recording') {
    console.warn('[QA rec] doPause() no-op — state is not "recording", was:', mediaRecorder?.state);
    return;
  }

  // Some codecs (notably MP4 in some Chrome versions) can throw on pause().
  // paused must only flip AFTER a successful call — setting it first and
  // then having pause() throw left `paused` permanently stuck at true while
  // mediaRecorder.state stayed 'recording', so every future toggle called
  // doResume() instead (which also no-ops, since state was never 'paused'),
  // deadlocking pause/resume forever with no visible error.
  try {
    mediaRecorder.pause();
  } catch (e: any) {
    console.warn('[QA] mediaRecorder.pause() failed:', e?.message);
    notifyUserTab('Pause is not supported for this recording format.', 4000);
    return;
  }

  paused = true;
  chrome.runtime.sendMessage({ type: 'RECORDING_PAUSED' }).catch(() => {});
  updatePauseUI();
}

function doResume(): void {
  if (mediaRecorder?.state !== 'paused') {
    console.warn('[QA rec] doResume() no-op — state is not "paused", was:', mediaRecorder?.state);
    return;
  }

  try {
    mediaRecorder.resume();
  } catch (e: any) {
    console.warn('[QA] mediaRecorder.resume() failed:', e?.message);
    notifyUserTab('Resume failed — try stopping and starting a new recording.', 4000);
    return;
  }

  paused = false;
  chrome.runtime.sendMessage({ type: 'RECORDING_RESUMED' }).catch(() => {});
  updatePauseUI();
}

function doStop(): void {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  if (timerInterval) clearInterval(timerInterval);
  stopSpeechRecognition();
  chrome.runtime.sendMessage({ type: 'RECORDING_STOPPED' }).catch(() => {});
  mediaRecorder.requestData();
  mediaRecorder.stop();
}

// ─── After Stop ──────────────────────────────────────────────────────────────

async function onRecordingStop(): Promise<void> {
  // Stop all streams
  [screenStream, micStream].forEach(s => s?.getTracks().forEach(t => t.stop()));

  const mimeType  = mediaRecorder?.mimeType || 'video/webm';
  const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
  let   blob      = new Blob(chunks, { type: mimeType });

  if (blob.size === 0) {
    showRecorderError('Recording was empty — no data captured. Try selecting "Entire Screen" in the screen picker.');
    return;
  }

  showSavingUI(blob.size);

  // Fix container duration so seeking works in media players
  try {
    const durationMs = seconds * 1000;
    const fixed = mimeType.includes('mp4')
      ? await fixMp4Duration(blob, durationMs)
      : await fixWebmDuration(blob, durationMs);
    if (fixed) blob = fixed;
  } catch (e: any) {
    console.warn('[QA] Duration fix failed, using original blob:', e.message);
  }

  const blobURL   = URL.createObjectURL(blob);
  const sessionId = Date.now() + '-' + Math.random().toString(36).slice(2, 7);

  const rules: TestRule[] = cfg.rules.map(text => ({ text, checked: false }));

  const sessionData = {
    blobURL,
    extension,
    sessionId,
    duration   : seconds,
    title      : cfg.title,
    tester     : cfg.tester,
    size       : blob.size,
    timestamp  : Date.now(),
    transcript : [...transcript],
    screenshots: [...screenshots],
    annotations: [...quickBugs],
    priority   : cfg.priority,
    layer      : cfg.layer,
    environment: cfg.environment,
    testType   : cfg.testType,
    sprint     : cfg.sprint,
    tags       : cfg.tags,
    rules,
  };

  // Persist to IndexedDB — video blob included — so the Results tab
  // can re-download the video later, not just right after recording.
  try {
    await saveSession({
      id         : sessionId,
      sessionId,
      title      : cfg.title,
      tester     : cfg.tester,
      duration   : seconds,
      size       : blob.size,
      extension,
      timestamp  : Date.now(),
      videoBlob  : blob,
      transcript : [...transcript],
      screenshots: [...screenshots],
      annotations: [...quickBugs],
      rules,
      priority   : cfg.priority,
      layer      : cfg.layer,
      environment: cfg.environment,
      testType   : cfg.testType,
      sprint     : cfg.sprint,
      tags       : cfg.tags,
    });
  } catch (e: any) {
    console.warn('[QA] Could not save session to IndexedDB:', e.message);
  }

  // Open the review tab and send it the recording data
  chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') }, reviewTab => {
    let sent = false;

    function trySend(attemptsLeft: number): void {
      if (sent || !reviewTab.id) return;

      chrome.tabs.sendMessage(reviewTab.id, { type: 'RECORDING_DATA', data: sessionData }, resp => {
        if (chrome.runtime.lastError || !resp?.ok) {
          if (attemptsLeft > 0) {
            setTimeout(() => trySend(attemptsLeft - 1), 400);
          } else {
            showRecorderError('Could not send the recording to the review page. Keep this tab open and try refreshing the review page.');
          }
          return;
        }
        sent = true;
        showKeepOpenUI(blob.size, blobURL, extension, cfg.title);
      });
    }

    // Give the review page half a second to load before first attempt
    setTimeout(() => trySend(15), 500);
  });
}

// ─── Duration Fix: WebM ───────────────────────────────────────────────────────

async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  const buffer      = await blob.arrayBuffer();
  const bytes       = new Uint8Array(buffer);
  const view        = new DataView(buffer);
  const durationSec = durationMs / 1000;
  const limit       = Math.min(bytes.length - 12, 262_144); // search first 256 KB

  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89) {
      if (bytes[i + 2] === 0x88) {
        view.setFloat64(i + 3, durationSec, false);
        return new Blob([buffer], { type: blob.type });
      }
      if (bytes[i + 2] === 0x84) {
        view.setFloat32(i + 3, durationSec, false);
        return new Blob([buffer], { type: blob.type });
      }
    }
  }

  console.warn('[QA] WebM Duration element not found — file returned unchanged');
  return blob;
}

// ─── Duration Fix: MP4 ───────────────────────────────────────────────────────

async function fixMp4Duration(blob: Blob, durationMs: number): Promise<Blob> {
  const buffer      = await blob.arrayBuffer();
  const view        = new DataView(buffer);
  const fileSize    = buffer.byteLength;
  const durationSec = durationMs / 1000;

  function boxTypeAt(offset: number): string {
    return String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7),
    );
  }

  function findBox(type: string, start: number, end: number): { start: number; end: number } | null {
    let offset = start;
    while (offset + 8 <= end) {
      let boxSize    = view.getUint32(offset);
      let headerSize = 8;
      if (boxSize === 1) {
        if (offset + 16 > end) break;
        boxSize    = Number(view.getBigUint64(offset + 8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - offset;
      }
      if (boxSize < headerSize || offset + boxSize > end) break;
      if (boxTypeAt(offset) === type) return { start: offset + headerSize, end: offset + boxSize };
      offset += boxSize;
    }
    return null;
  }

  const moov = findBox('moov', 0, fileSize);
  const mvhd = moov ? findBox('mvhd', moov.start, moov.end) : null;
  if (!mvhd) {
    console.warn('[QA] MP4 mvhd box not found — file returned unchanged');
    return blob;
  }

  const version        = view.getUint8(mvhd.start);
  const fieldWidth     = version === 1 ? 8 : 4;
  const timescaleOff   = mvhd.start + 4 + fieldWidth + fieldWidth;
  const durationOff    = timescaleOff + 4;
  const timescale      = view.getUint32(timescaleOff);

  if (!timescale) {
    console.warn('[QA] MP4 mvhd timescale is 0 — file returned unchanged');
    return blob;
  }

  const units = Math.round(durationSec * timescale);
  if (version === 1) view.setBigUint64(durationOff, BigInt(units));
  else               view.setUint32(durationOff, units);

  return new Blob([buffer], { type: blob.type });
}

// ─── Speech Recognition ───────────────────────────────────────────────────────

/**
 * Runs Web Speech API in THIS tab (chrome-extension:// origin).
 * Mic permission is already granted here via the permissions page.
 * Content scripts on third-party pages can't use SR without a separate grant.
 */
function startSpeechRecognition(): void {
  if (!cfg.micOn) return;

  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) {
    console.warn('[QA SR] Web Speech API not available in this browser');
    return;
  }

  srRunning     = true;
  srNetErrCount = 0;

  function launch(): void {
    if (!srRunning) return;

    const r = new SR() as any;
    r.continuous     = true;
    r.interimResults = false; // final results only — cleaner transcript
    r.lang           = 'en-US';

    r.onresult = (event: any) => {
      srNetErrCount = 0;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim();
          if (text) {
            transcript.push({ ts: seconds, text });
            console.log('[QA SR] Captured:', text, 'at', seconds + 's');
          }
        }
      }
    };

    r.onerror = (e: any) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return;

      if (e.error === 'not-allowed') {
        console.warn('[QA SR] Mic permission denied — voice transcript disabled');
        srRunning = false;
        return;
      }

      if (e.error === 'network') {
        srNetErrCount++;
        console.warn(`[QA SR] Network error (attempt ${srNetErrCount}) — recognition service unreachable`);
        return;
      }

      console.warn('[QA SR] Error:', e.error);
    };

    r.onend = () => {
      srInstance = null;
      if (!srRunning) return;
      // Back off after repeated network errors to avoid hammering the service
      const delay = srNetErrCount > 0 ? Math.min(1000 * srNetErrCount, 10_000) : 100;
      setTimeout(launch, delay);
    };

    try {
      r.start();
      srInstance = r;
    } catch {
      srInstance = null;
      if (srRunning) setTimeout(launch, 500);
    }
  }

  launch();
}

function stopSpeechRecognition(): void {
  srRunning = false;
  if (srInstance) {
    try { srInstance.abort(); } catch { /* already stopped */ }
    srInstance = null;
  }
}

// ─── Quick Bug (Alt+B) ────────────────────────────────────────────────────────

/**
 * Injected into the active tab that triggered Alt+B. Runs in an isolated
 * world, so it has access to chrome.runtime but not to any variables from
 * this module — everything the form needs must be self-contained here.
 */
function quickBugFormInjector(): void {
  if (document.getElementById('__qa_quick_bug__')) return;

  const SEVERITIES = [
    { key: 'critical', label: 'Critical', color: '#EF4444' },
    { key: 'high',     label: 'High',     color: '#F97316' },
    { key: 'medium',   label: 'Medium',   color: '#EAB308' },
    { key: 'low',      label: 'Low',      color: '#22C55E' },
  ];

  let severity = 'medium';

  const host = document.createElement('div');
  host.id = '__qa_quick_bug__';
  host.style.cssText = [
    'position:fixed', 'bottom:150px', 'right:20px', 'width:260px',
    'background:#101A2C', 'border:1px solid rgba(148,163,253,0.2)',
    'border-radius:14px', 'padding:14px', 'z-index:2147483647',
    'box-shadow:0 12px 36px rgba(0,0,0,0.55)',
    'font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif',
    'color:white',
  ].join(';');

  host.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <span style="font-size:13px;font-weight:700;">Quick Bug</span>
      <button id="__qa_qb_close__" style="background:none;border:none;color:rgba(248,250,252,.5);font-size:16px;line-height:1;cursor:pointer;">×</button>
    </div>
    <input id="__qa_qb_text__" type="text" placeholder="Describe the bug..." style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(148,163,253,0.25);background:rgba(255,255,255,.06);color:white;font-size:12.5px;outline:none;margin-bottom:10px;" />
    <div id="__qa_qb_sevs__" style="display:flex;gap:6px;margin-bottom:12px;"></div>
    <button id="__qa_qb_submit__" style="width:100%;height:36px;border:none;border-radius:8px;background:linear-gradient(135deg,#3B82F6,#6366F1);color:white;font-size:12.5px;font-weight:700;cursor:pointer;">Mark Bug</button>
  `;

  document.body.appendChild(host);

  const sevRow = host.querySelector('#__qa_qb_sevs__')!;
  SEVERITIES.forEach(s => {
    const btn = document.createElement('button');
    btn.textContent = s.label;
    btn.dataset['key'] = s.key;
    const isSelected = s.key === severity;
    btn.style.cssText = [
      'flex:1', 'padding:6px 0', 'border-radius:7px', 'font-size:10.5px', 'font-weight:700',
      'cursor:pointer', 'transition:all .12s',
      `border:1.5px solid ${isSelected ? s.color : 'rgba(148,163,253,0.25)'}`,
      `background:${isSelected ? s.color + '26' : 'transparent'}`,
      `color:${isSelected ? s.color : 'rgba(248,250,252,.6)'}`,
    ].join(';');
    btn.addEventListener('click', () => {
      severity = s.key;
      Array.from(sevRow.children).forEach(child => {
        const b   = child as HTMLButtonElement;
        const sev = SEVERITIES.find(x => x.key === b.dataset['key'])!;
        const sel = b.dataset['key'] === severity;
        b.style.border     = `1.5px solid ${sel ? sev.color : 'rgba(148,163,253,0.25)'}`;
        b.style.background = sel ? sev.color + '26' : 'transparent';
        b.style.color       = sel ? sev.color : 'rgba(248,250,252,.6)';
      });
      resetInactivityTimer();
    });
    sevRow.appendChild(btn);
  });

  const textInput  = host.querySelector('#__qa_qb_text__') as HTMLInputElement;
  const closeBtn   = host.querySelector('#__qa_qb_close__') as HTMLButtonElement;
  const submitBtn  = host.querySelector('#__qa_qb_submit__') as HTMLButtonElement;

  let inactivityTimer: ReturnType<typeof setTimeout>;
  function resetInactivityTimer(): void {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => host.remove(), 30_000);
  }

  function close(): void {
    clearTimeout(inactivityTimer);
    host.remove();
  }

  function formatMs(sec: number): string {
    return `${Math.floor(sec / 60)}:${(Math.floor(sec) % 60).toString().padStart(2, '0')}`;
  }

  function submit(): void {
    const text = textInput.value.trim();
    if (!text) { textInput.focus(); return; }

    submitBtn.disabled    = true;
    submitBtn.textContent = 'Marking…';

    chrome.runtime.sendMessage({ type: 'QUICK_BUG_GET_TIME' }, resp => {
      if (chrome.runtime.lastError) { showSubmitError(); return; }

      const ts = (resp && typeof resp.timestamp === 'number') ? resp.timestamp : 0;
      const annotation = { ts, text, severity };

      // Wait for the recorder tab to actually confirm it stored the
      // annotation before telling the user it was marked — previously this
      // showed a success message unconditionally, so a dropped relay (closed
      // recorder tab, message hiccup, etc.) looked identical to success and
      // the bug silently never made it into the review page.
      chrome.runtime.sendMessage({ type: 'QUICK_BUG_SUBMIT', annotation }, submitResp => {
        if (chrome.runtime.lastError || !submitResp?.ok) { showSubmitError(); return; }

        host.innerHTML = `<p style="font-size:13px;font-weight:700;color:#22C55E;text-align:center;margin:6px 0;">✓ Bug marked at ${formatMs(ts)}</p>`;
        setTimeout(close, 1500);
      });
    });
  }

  function showSubmitError(): void {
    submitBtn.disabled    = false;
    submitBtn.textContent = 'Mark Bug';
    let errEl = host.querySelector('#__qa_qb_err__') as HTMLElement | null;
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.id = '__qa_qb_err__';
      errEl.style.cssText = 'font-size:11px;color:#F87171;margin-top:6px;text-align:center;';
      host.appendChild(errEl);
    }
    errEl.textContent = 'Could not save the bug — recording may have stopped. Try again.';
    resetInactivityTimer();
  }

  closeBtn.addEventListener('click', close);
  submitBtn.addEventListener('click', submit);
  textInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); close();  }
    resetInactivityTimer();
  });

  textInput.focus();
  resetInactivityTimer();
}

// Prefer the tab that actually sent the shortcut — the user may have
// switched tabs since the recording started, and userTabId (fixed at launch)
// would otherwise silently inject the form into a tab that isn't even visible.
function openQuickBugForm(sourceTabId?: number | null): void {
  const targetTabId = sourceTabId ?? userTabId;
  if (!targetTabId) return;
  chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func  : quickBugFormInjector,
  }).catch(() => {});
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CONTROLBAR_STOP')   { doStop();   sendResponse({ ok: true }); }
  if (msg.type === 'CONTROLBAR_PAUSE')  { doPause();  sendResponse({ ok: true }); }
  if (msg.type === 'CONTROLBAR_RESUME') { doResume(); sendResponse({ ok: true }); }

  // Control bar button and Alt+P shortcut both send this — this tab is the
  // only place that knows whether the recording is actually paused right now.
  if (msg.type === 'CONTROLBAR_TOGGLE_PAUSE') {
    paused ? doResume() : doPause();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'SCREENSHOT_TAKEN') {
    const index = screenshots.length + 1;
    screenshots.push({ dataUrl: msg.dataUrl as string, timestamp: msg.timestamp as number, index });
    console.log('[QA] Screenshot', index, 'stored');
    return false;
  }

  if (msg.type === 'MIC_MUTE_TOGGLE') {
    console.log('[QA rec] MIC_MUTE_TOGGLE received. micStream=', !!micStream, 'muted=', msg.muted);
    if (micStream) {
      micMuted = msg.muted as boolean;
      const enabled = !micMuted;
      micStream.getAudioTracks().forEach(track => { track.enabled = enabled; });
    } else {
      console.warn('[QA rec] MIC_MUTE_TOGGLE ignored — no micStream (mic was not enabled for this recording)');
    }
    sendResponse({ ok: true });
  }

  // Alt+M shortcut — this tab owns the mic stream and is the only place
  // that knows the real mute state, so it decides and reports the result.
  if (msg.type === 'MIC_MUTE_SHORTCUT_TOGGLE') {
    console.log('[QA rec] MIC_MUTE_SHORTCUT_TOGGLE received. micStream=', !!micStream, 'micMuted=', micMuted);
    if (micStream) {
      micMuted = !micMuted;
      micStream.getAudioTracks().forEach(track => { track.enabled = !micMuted; });
      chrome.runtime.sendMessage({ type: 'MIC_MUTE_TOGGLE', muted: micMuted }).catch(() => {});
      sendResponse({ ok: true });
    } else {
      console.warn('[QA rec] MIC_MUTE_SHORTCUT_TOGGLE ignored — no micStream (mic was not enabled for this recording)');
      sendResponse({ ok: false, reason: 'no-mic-stream' });
    }
    return false;
  }

  if (msg.type === 'QUICK_BUG_OPEN') {
    openQuickBugForm(msg.sourceTabId as number | null | undefined);
    return false;
  }

  if (msg.type === 'GET_CURRENT_TIME') {
    sendResponse({ timestamp: seconds });
    return false;
  }

  if (msg.type === 'QUICK_BUG_MARKED' && msg.annotation) {
    quickBugs.push(msg.annotation as BugAnnotation);
    console.log('[QA] Quick bug marked at', (msg.annotation as BugAnnotation).ts);
    sendResponse({ ok: true });
    return false;
  }

  return true;
});

// ─── Entry Point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await resolveTabIds();
  showPreparingUI();
  await runCountdown();
  await startRecording();
}

main();
