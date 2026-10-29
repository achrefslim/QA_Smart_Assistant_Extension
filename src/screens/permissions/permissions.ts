/**
 * src/screens/permissions/permissions.ts
 *
 * Permissions page — shown before recording starts if the user enabled
 * microphone or camera. Requests the browser permissions and sends the
 * result back to the background worker which opens the recorder tab.
 */

const urlParams = new URLSearchParams(location.search);
const needMic   = urlParams.get('mic') === '1';
const needCam   = urlParams.get('cam') === '1';

// Track what was actually granted so we can send it to background
const grantResults = {
  mic: 'skipped' as 'granted' | 'denied' | 'skipped',
  cam: 'skipped' as 'granted' | 'denied' | 'skipped',
};

// ─── UI helpers ──────────────────────────────────────────────────────────────

function setItemState(
  id    : 'mic' | 'cam',
  state : 'granted' | 'denied' | 'requesting' | 'skipped',
  text  : string
): void {
  const item   = document.getElementById('item-' + id);
  const status = document.getElementById('status-' + id);
  const badge  = document.getElementById('badge-' + id);
  if (!item || !status || !badge) return;

  item.className     = 'perm-item ' + state;
  status.textContent = text;

  if (state === 'granted') {
    badge.className = 'perm-badge ok';
    badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none">
      <path d="M5 10l4 4 6-7" stroke="#6EE7B7" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  } else if (state === 'denied') {
    badge.className = 'perm-badge err';
    badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none">
      <path d="M6 6l8 8M14 6l-8 8" stroke="#FCA5A5" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  } else if (state === 'skipped') {
    badge.className = 'perm-badge wait';
    badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none">
      <path d="M8 6l4 4-4 4" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" opacity=".4"/>
    </svg>`;
  } else {
    // requesting — show a spinner
    badge.className = 'perm-badge wait';
    badge.innerHTML = `<div style="
      width:13px;height:13px;border-radius:50%;
      border:2px solid rgba(255,255,255,.2);
      border-top-color:white;
      animation:spin .7s linear infinite;">
    </div>`;
  }
}

function setButtonState(loading: boolean, label: string): void {
  const btn     = document.getElementById('btn-continue') as HTMLButtonElement | null;
  const spinner = document.getElementById('btn-spinner');
  const lbl     = document.getElementById('btn-label');
  if (!btn) return;

  if (spinner) spinner.style.display = loading ? 'block' : 'none';
  if (lbl)     lbl.textContent       = label;
  btn.disabled = loading;
}

// ─── Permission Requests ─────────────────────────────────────────────────────

async function requestMicrophone(): Promise<void> {
  // Check if already granted (avoids showing the browser prompt again)
  let alreadyGranted = false;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (status.state === 'granted') alreadyGranted = true;
  } catch (_) { /* some browsers don't support permissions.query for mic */ }

  if (alreadyGranted) {
    grantResults.mic = 'granted';
    setItemState('mic', 'granted', 'Microphone already allowed');
    return;
  }

  setItemState('mic', 'requesting', 'Check the top-left of your browser…');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach(t => t.stop()); // we only needed the permission grant
    grantResults.mic = 'granted';
    setItemState('mic', 'granted', 'Microphone access granted');
  } catch (_) {
    grantResults.mic = 'denied';
    setItemState('mic', 'denied', 'Denied, recording will have no audio');
  }
}

async function requestCamera(): Promise<void> {
  let alreadyGranted = false;
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    if (status.state === 'granted') alreadyGranted = true;
  } catch (_) {}

  if (alreadyGranted) {
    grantResults.cam = 'granted';
    setItemState('cam', 'granted', 'Camera already allowed');
    return;
  }

  setItemState('cam', 'requesting', 'Check the top-left of your browser…');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach(t => t.stop());
    grantResults.cam = 'granted';
    setItemState('cam', 'granted', 'Camera access granted');
  } catch (_) {
    grantResults.cam = 'denied';
    setItemState('cam', 'denied', 'Denied, no webcam overlay');
  }
}

// ─── Main Flow ───────────────────────────────────────────────────────────────

async function requestAll(): Promise<void> {
  const micWasAlreadyGranted = grantResults.mic === 'granted';
  const camWasAlreadyGranted = grantResults.cam === 'granted';

  if (needMic) await requestMicrophone();
  else         setItemState('mic', 'skipped', 'Not requested');

  if (needCam) await requestCamera();
  else         setItemState('cam', 'skipped', 'Not requested');

  const allWereAlreadyGranted =
    (!needMic || micWasAlreadyGranted) &&
    (!needCam || camWasAlreadyGranted);

  // Re-check after requesting
  const allNowGranted =
    (!needMic || grantResults.mic === 'granted') &&
    (!needCam || grantResults.cam === 'granted');

  if (allNowGranted && (needMic || needCam)) {
    // Everything was already granted — auto-proceed so the user doesn't
    // have to click Continue when permissions are cached
    setButtonState(false, 'All allowed, opening recorder…');
    setTimeout(proceed, 900);
  } else {
    setButtonState(false, 'Continue to Recording');
    document.getElementById('btn-continue')?.addEventListener('click', proceed, { once: true });
  }
}

function proceed(): void {
  setButtonState(true, 'Opening recorder…');

  // We send to BACKGROUND, not popup — the popup is closed by now.
  // Background uses the RecorderConfig it saved earlier to open the recorder tab.
  chrome.runtime.sendMessage(
    { type: 'PERMISSIONS_DONE', mic: grantResults.mic, cam: grantResults.cam },
    () => window.close()
  );
}

// ─── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', requestAll);
