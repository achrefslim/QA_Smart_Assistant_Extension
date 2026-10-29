/**
 * src/controlbar/controlbar.ts
 *
 * Floating control bar injected into the user's active tab during recording.
 * Contains: timer, pause/resume, stop, mic mute, pen draw, rectangle draw,
 * color picker, erase, screenshot, and collapse button.
 *
 * This script is injected by background.ts using chrome.scripting.executeScript.
 * It runs in the page context so it can overlay the page content.
 */

// Guard: don't inject twice into the same tab. This is a safety net only —
// background.ts serializes injections per tab so this shouldn't normally
// trigger. A silent return (rather than throwing) matters here: an uncaught
// throw would still abort this script before it reaches its message-listener
// registration further down, which is only harmless if a fully-initialized
// older instance is still alive underneath — bailing out quietly avoids an
// uncaught error either way. The whole bundle is wrapped in an IIFE by
// esbuild, so a top-level `return` here is valid and exits cleanly.
if (document.getElementById('qa-controlbar-host')) {
  console.warn('[QA] Control bar already injected, skipping');
  // eslint-disable-next-line no-restricted-syntax
  // @ts-expect-error top-level return is valid in esbuild's IIFE output
  return;
}

// ─── Draw State ───────────────────────────────────────────────────────────────

type DrawMode = 'pen' | 'rect' | null;

interface Position {
  left: number; // percentage of viewport width
  top : number; // percentage of viewport height
}

const COLORS = [
  { hex: '#FB3A5D', label: 'Red'    },
  { hex: '#3B82F6', label: 'Blue'   },
  { hex: '#22C55E', label: 'Green'  },
  { hex: '#F59E0B', label: 'Yellow' },
  { hex: '#FFFFFF', label: 'White'  },
];

let micMuted    = false;
let recPaused   = false;
let camOn       = false;
let drawMode    : DrawMode = null;
let collapsed   = false;
let isDragging  = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

let position: Position = { left: 50, top: 92 };

// Canvas drawing
let canvas     : HTMLCanvasElement | null = null;
let ctx        : CanvasRenderingContext2D | null = null;
let drawing    = false;
let lastX      = 0;
let lastY      = 0;
let rectStartX = 0;
let rectStartY = 0;
let rectSnapshot: ImageData | null = null; // snapshot before rect preview
let drawColor   = '#FB3A5D';

// ─── Build the HTML ───────────────────────────────────────────────────────────

const host = document.createElement('div');
host.id = 'qa-controlbar-host';
host.style.visibility = 'hidden'; // shown after position is loaded from storage

host.innerHTML = `
<div class="qa-bar" id="qa-bar">
  <div class="qa-grip" id="qa-grip" title="Drag to move">
    <svg viewBox="0 0 10 16" fill="none">
      <circle cx="2" cy="2"  r="1.4" fill="currentColor"/>
      <circle cx="8" cy="2"  r="1.4" fill="currentColor"/>
      <circle cx="2" cy="8"  r="1.4" fill="currentColor"/>
      <circle cx="8" cy="8"  r="1.4" fill="currentColor"/>
      <circle cx="2" cy="14" r="1.4" fill="currentColor"/>
      <circle cx="8" cy="14" r="1.4" fill="currentColor"/>
    </svg>
  </div>

  <div class="qa-bar-left">
    <span class="qa-rec-dot" id="qa-dot"></span>
    <span class="qa-timer"   id="qa-timer">0:00</span>
  </div>

  <div class="qa-bar-center" id="qa-center">
    <button class="qa-btn qa-btn-pause" id="qa-pause" title="Pause / Resume">
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="5" y="4"  width="3" height="12" rx="1.5" fill="currentColor"/>
        <rect x="12" y="4" width="3" height="12" rx="1.5" fill="currentColor"/>
      </svg>
    </button>

    <button class="qa-btn qa-btn-stop" id="qa-stop" title="Stop Recording">
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/>
      </svg>
    </button>

    <div class="qa-divider"></div>

    <button class="qa-btn" id="qa-mic" title="Mute / Unmute Microphone">
      <svg id="qa-mic-svg" viewBox="0 0 20 20" fill="none">
        <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor"/>
        <path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
        <line x1="10" y1="16" x2="10" y2="18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>

    <button class="qa-btn" id="qa-cam" title="Turn Camera On / Off">
      <svg id="qa-cam-svg" viewBox="0 0 20 20" fill="none">
        <path d="M3 6h9a2 2 0 012 2v4a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2z" stroke="currentColor" stroke-width="1.5"/>
        <path d="M14 8.5l4-2v5l-4-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <div class="qa-divider"></div>

    <button class="qa-btn" id="qa-draw" title="Freehand Draw">
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M14 3l3 3-9.5 9.5L4 17l1.5-3.5L14 3z"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <button class="qa-btn" id="qa-rect" title="Draw Rectangle">
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="3" y="5" width="14" height="10" rx="1.5"
          stroke="currentColor" stroke-width="1.8" fill="none"/>
      </svg>
    </button>

    <button class="qa-btn qa-color-btn" id="qa-color" title="Pick annotation color">
      <span class="qa-color-dot" id="qa-color-dot" style="background:#FB3A5D;"></span>
    </button>

    <div class="qa-color-popup hidden" id="qa-color-popup">
      ${COLORS.map(c =>
        `<button class="qa-color-opt" data-color="${c.hex}"
          title="${c.label}" style="background:${c.hex};"></button>`
      ).join('')}
    </div>

    <button class="qa-btn" id="qa-erase" title="Clear all drawings">
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M3 17l4-4 7-7-3-3-7 7-1.5 7.5L6 17"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M15 17H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>

    <div class="qa-divider"></div>

    <button class="qa-btn" id="qa-screenshot" title="Take Screenshot">
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M7 4l1-2h4l1 2"
          stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <span class="qa-screenshot-flash hidden" id="qa-ss-flash">📸 Saved</span>
  </div>

  <button class="qa-btn qa-btn-collapse" id="qa-collapse" title="Collapse">
    <svg id="qa-collapse-icon" viewBox="0 0 20 20" fill="none">
      <path d="M13 8l-3 4-4-4"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>
</div>
`;

document.body.appendChild(host);

// ─── Element References ───────────────────────────────────────────────────────

const timerEl       = document.getElementById('qa-timer')!;
const dotEl         = document.getElementById('qa-dot')!;
const pauseBtn      = document.getElementById('qa-pause')!;
const stopBtn       = document.getElementById('qa-stop')!;
const micBtn        = document.getElementById('qa-mic')!;
const micSvg        = document.getElementById('qa-mic-svg')!;
const camBtn        = document.getElementById('qa-cam')!;
const camSvg        = document.getElementById('qa-cam-svg')!;
const drawBtn       = document.getElementById('qa-draw')!;
const rectBtn       = document.getElementById('qa-rect')!;
const colorBtn      = document.getElementById('qa-color')!;
const colorDot      = document.getElementById('qa-color-dot')!;
const colorPopup    = document.getElementById('qa-color-popup')!;
const eraseBtn      = document.getElementById('qa-erase')!;
const screenshotBtn = document.getElementById('qa-screenshot')!;
const ssFlash       = document.getElementById('qa-ss-flash')!;
const collapseBtn   = document.getElementById('qa-collapse')!;
const collapseIcon  = document.getElementById('qa-collapse-icon')!;
const centerEl      = document.getElementById('qa-center')!;
const barEl         = document.getElementById('qa-bar')!;
const gripEl        = document.getElementById('qa-grip')!;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function applyPosition(): void {
  host.style.left = position.left + '%';
  host.style.top  = position.top  + '%';
}

function clampPosition(): void {
  position.left = Math.max(4, Math.min(96, position.left));
  position.top  = Math.max(4, Math.min(96, position.top));
}

// ─── Load Saved Position from Storage ────────────────────────────────────────

try {
  chrome.storage.local.get(['qa_controlbar_pos'], result => {
    const saved = result['qa_controlbar_pos'] as Position | undefined;
    if (saved) {
      position = saved;
      clampPosition();
    }
    applyPosition();
    host.style.visibility = 'visible';
  });
} catch {
  applyPosition();
  host.style.visibility = 'visible';
}

// ─── Message Listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'TIMER_TICK' && timerEl) {
    timerEl.textContent = formatTime(msg.seconds as number);
  }

  if (msg.type === 'RECORDING_PAUSED') applyPauseUI(true);
  if (msg.type === 'RECORDING_RESUMED') applyPauseUI(false);
  if (msg.type === 'PAUSE_STATE') applyPauseUI(msg.paused as boolean);

  if (msg.type === 'MIC_MUTED_STATE') {
    micMuted = msg.muted as boolean;
    updateMicIcon();
  }

  if (msg.type === 'CAM_STATE') {
    camOn = msg.enabled as boolean;
    updateCamIcon();
  }

  // Broadcast after the capture actually completes (not the initial ack),
  // so the control bar reappears and flashes only once the screenshot is done —
  // fires for both the button and the keyboard shortcut.
  if (msg.type === 'SCREENSHOT_TAKEN') {
    host.style.visibility = 'visible';
    ssFlash.classList.remove('hidden');
    setTimeout(() => ssFlash.classList.add('hidden'), 1800);
  }

  if (msg.type === 'TOGGLE_DRAW_MODE') {
    if (drawMode === 'pen') {
      drawMode = null;
      deactivateAllTools();
    } else {
      deactivateAllTools();
      drawMode = 'pen';
      drawBtn.classList.add('qa-btn-active');
      enablePen();
    }
  }
});

// ─── Pause / Stop ────────────────────────────────────────────────────────────

function applyPauseUI(paused: boolean): void {
  recPaused = paused;

  if (paused) {
    dotEl.style.animationPlayState = 'paused';
    dotEl.style.opacity            = '0.35';
    pauseBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none">
      <path d="M7 5l7 5-7 5V5z" fill="currentColor"/>
    </svg>`;
    (pauseBtn as HTMLButtonElement).style.background = '#374151';
  } else {
    dotEl.style.animationPlayState = '';
    dotEl.style.opacity            = '';
    pauseBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none">
      <rect x="5" y="4" width="3" height="12" rx="1.5" fill="currentColor"/>
      <rect x="12" y="4" width="3" height="12" rx="1.5" fill="currentColor"/>
    </svg>`;
    (pauseBtn as HTMLButtonElement).style.background = '';
  }
}

pauseBtn.addEventListener('click', () => {
  // Decide PAUSE vs RESUME from this button's own last-known state (same
  // pattern as the mic button, which updates its icon immediately on click
  // rather than waiting on a round trip) instead of asking the recorder tab
  // to guess via a toggle — sending the explicit, unambiguous action is more
  // reliable than a toggle that can drift out of sync with reality.
  const type = recPaused ? 'CONTROLBAR_RESUME' : 'CONTROLBAR_PAUSE';
  applyPauseUI(!recPaused); // optimistic immediate feedback, corrected by the real broadcast below
  chrome.runtime.sendMessage({ type });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CONTROLBAR_STOP' });
  canvas?.remove();
  host.remove();
});

// ─── Microphone ──────────────────────────────────────────────────────────────

function updateMicIcon(): void {
  if (micMuted) {
    (micBtn as HTMLButtonElement).style.opacity = '0.5';
    micSvg.innerHTML = `
      <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor" opacity="0.3"/>
      <path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" opacity="0.3"/>
      <line x1="3" y1="3" x2="17" y2="17" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>`;
  } else {
    (micBtn as HTMLButtonElement).style.opacity = '';
    micSvg.innerHTML = `
      <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor"/>
      <path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      <line x1="10" y1="16" x2="10" y2="18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
  }
}

micBtn.addEventListener('click', () => {
  micMuted = !micMuted;
  updateMicIcon();
  chrome.runtime.sendMessage({ type: 'MIC_MUTE_TOGGLE', muted: micMuted });
});

// ─── Camera ──────────────────────────────────────────────────────────────────

function updateCamIcon(): void {
  (camBtn as HTMLButtonElement).style.opacity = camOn ? '' : '0.5';
  camSvg.style.color = camOn ? '#3B82F6' : '';
}

camBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CAM_TOGGLE' });
});

// ─── Canvas Drawing ───────────────────────────────────────────────────────────

function ensureCanvas(): void {
  if (canvas) return;

  canvas = document.createElement('canvas');
  canvas.id        = '__qa_draw_canvas__';
  canvas.width     = window.innerWidth;
  canvas.height    = window.innerHeight;
  canvas.style.cssText = [
    'position:fixed', 'inset:0',
    'z-index:2147483645',
    'pointer-events:none',
    'cursor:crosshair',
  ].join(';');

  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d')!;
  applyCtxStyle();

  window.addEventListener('resize', () => {
    if (!canvas || !ctx) return;
    const snapshot = canvas.toDataURL();
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    applyCtxStyle();
    const img = new Image();
    img.onload = () => ctx!.drawImage(img, 0, 0);
    img.src = snapshot;
  });
}

function applyCtxStyle(): void {
  if (!ctx) return;
  ctx.strokeStyle = drawColor;
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
}

// Pen drawing
function onPenDown (e: MouseEvent): void { drawing = true; lastX = e.clientX; lastY = e.clientY; ctx!.beginPath(); ctx!.moveTo(lastX, lastY); }
function onPenMove (e: MouseEvent): void { if (!drawing) return; ctx!.lineTo(e.clientX, e.clientY); ctx!.stroke(); lastX = e.clientX; lastY = e.clientY; }
function onPenEnd  (): void              { drawing = false; ctx?.closePath(); }

// Rectangle drawing
function onRectDown(e: MouseEvent): void {
  drawing    = true;
  rectStartX = e.clientX;
  rectStartY = e.clientY;
  rectSnapshot = ctx!.getImageData(0, 0, canvas!.width, canvas!.height);
}
function onRectMove(e: MouseEvent): void {
  if (!drawing || !rectSnapshot) return;
  ctx!.putImageData(rectSnapshot, 0, 0);
  applyCtxStyle();
  ctx!.strokeRect(rectStartX, rectStartY, e.clientX - rectStartX, e.clientY - rectStartY);
}
function onRectEnd(e: MouseEvent): void {
  if (!drawing) return;
  drawing = false;
  if (rectSnapshot) {
    ctx!.putImageData(rectSnapshot, 0, 0);
    rectSnapshot = null;
    applyCtxStyle();
    ctx!.strokeRect(rectStartX, rectStartY, e.clientX - rectStartX, e.clientY - rectStartY);
  }
}

function enablePen(): void {
  ensureCanvas();
  canvas!.style.pointerEvents = 'all';
  canvas!.addEventListener('mousedown',  onPenDown);
  canvas!.addEventListener('mousemove',  onPenMove);
  canvas!.addEventListener('mouseup',    onPenEnd);
  canvas!.addEventListener('mouseleave', onPenEnd);
}

function disablePen(): void {
  if (!canvas) return;
  canvas.style.pointerEvents = 'none';
  canvas.removeEventListener('mousedown',  onPenDown);
  canvas.removeEventListener('mousemove',  onPenMove);
  canvas.removeEventListener('mouseup',    onPenEnd);
  canvas.removeEventListener('mouseleave', onPenEnd);
}

function enableRect(): void {
  ensureCanvas();
  canvas!.style.pointerEvents = 'all';
  canvas!.addEventListener('mousedown',  onRectDown);
  canvas!.addEventListener('mousemove',  onRectMove);
  canvas!.addEventListener('mouseup',    onRectEnd);
  canvas!.addEventListener('mouseleave', onRectEnd);
}

function disableRect(): void {
  if (!canvas) return;
  canvas.style.pointerEvents = 'none';
  canvas.removeEventListener('mousedown',  onRectDown);
  canvas.removeEventListener('mousemove',  onRectMove);
  canvas.removeEventListener('mouseup',    onRectEnd);
  canvas.removeEventListener('mouseleave', onRectEnd);
}

function deactivateAllTools(): void {
  disablePen();
  disableRect();
  drawBtn.classList.remove('qa-btn-active');
  rectBtn.classList.remove('qa-btn-active');
}

// Pen button
drawBtn.addEventListener('click', () => {
  if (drawMode === 'pen') { drawMode = null; deactivateAllTools(); return; }
  deactivateAllTools();
  drawMode = 'pen';
  drawBtn.classList.add('qa-btn-active');
  enablePen();
});

// Rect button
rectBtn.addEventListener('click', () => {
  if (drawMode === 'rect') { drawMode = null; deactivateAllTools(); return; }
  deactivateAllTools();
  drawMode = 'rect';
  rectBtn.classList.add('qa-btn-active');
  enableRect();
});

// Erase
eraseBtn.addEventListener('click', () => {
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawMode = null;
  deactivateAllTools();
});

// ─── Color Picker ─────────────────────────────────────────────────────────────

colorBtn.addEventListener('click', e => {
  e.stopPropagation();
  colorPopup.classList.toggle('hidden');
});

colorPopup.querySelectorAll('.qa-color-opt').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    drawColor = (btn as HTMLElement).dataset['color'] || '#FB3A5D';
    colorDot.style.background = drawColor;
    applyCtxStyle();
    colorPopup.classList.add('hidden');
    colorPopup.querySelectorAll('.qa-color-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.addEventListener('click', () => colorPopup.classList.add('hidden'));

// ─── Screenshot ───────────────────────────────────────────────────────────────

screenshotBtn.addEventListener('click', () => {
  // Only hide the toolbar chrome — NOT the draw canvas. The canvas holds the
  // user's actual pen/rectangle bug annotations, which should show up in the
  // screenshot; only the floating control bar itself should be excluded.
  host.style.visibility = 'hidden';

  // Visibility is restored and the flash shown by the SCREENSHOT_TAKEN
  // listener above, once the capture actually completes — not by this
  // message's immediate ack, which fires well before the real capture.
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT', timestamp: Date.now() });
  }, 80);
});

// ─── Collapse ─────────────────────────────────────────────────────────────────

collapseBtn.addEventListener('click', () => {
  collapsed = !collapsed;
  (centerEl as HTMLElement).style.display = collapsed ? 'none' : '';
  collapseIcon.innerHTML = collapsed
    ? `<path d="M7 12l3-4 4 4"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M13 8l-3 4-4-4"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
});

// ─── Drag to Reposition ───────────────────────────────────────────────────────

function startDrag(e: MouseEvent): void {
  if ((e.target as Element).closest('button')) return;

  isDragging = true;
  barEl.classList.add('qa-dragging');

  const rect  = host.getBoundingClientRect();
  dragOffsetX = e.clientX - (rect.left + rect.width  / 2);
  dragOffsetY = e.clientY - (rect.top  + rect.height / 2);

  e.preventDefault();
}

barEl.addEventListener('mousedown', startDrag);
gripEl.addEventListener('mousedown', startDrag);

document.addEventListener('mousemove', e => {
  if (!isDragging) return;
  position.left = ((e.clientX - dragOffsetX) / window.innerWidth)  * 100;
  position.top  = ((e.clientY - dragOffsetY) / window.innerHeight) * 100;
  clampPosition();
  applyPosition();
});

document.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  barEl.classList.remove('qa-dragging');
  try {
    chrome.storage.local.set({ qa_controlbar_pos: position });
  } catch { /* storage not available in all contexts */ }
});
