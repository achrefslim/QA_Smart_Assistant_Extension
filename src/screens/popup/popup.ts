/**
 * src/screens/popup/popup.ts
 *
 * Main popup script for QA Smart Assistant.
 * Handles screen navigation, recording setup, notes, results, and settings.
 */

import type { RecorderConfig, JiraConfig, ClickUpConfig, QASession, TestRule, BugAnnotation, TranscriptEntry, QaSessionManifest } from '../../shared/types';
import { getAllSessions, getSession, deleteSession } from '../../shared/db/database';
import {
  initAuth, getCurrentUser, signInWithEmail, signUpWithEmail, signInWithGoogle, signOut,
  sendPasswordReset, resendVerificationEmail, reloadCurrentUser, isVerified, isGoogleUser,
  type QAUser,
} from './auth';
import { SKILL_MD, REPORT_PLAYBOOK_MD, README_MD } from '../../shared/skill/templates';
import QRCode from 'qrcode';

// ─── Session Templates ────────────────────────────────────────────────────────

interface Template {
  layer      : string;
  testType   : string;
  environment: string;
  rules      : string[];
}

const TEMPLATES: Record<string, Template> = {
  login: {
    layer: 'Frontend', testType: 'Functional', environment: 'Staging',
    rules: [
      'Verify login with valid credentials',
      'Test invalid password shows error',
      'Test empty fields validation',
      'Test forgot password link',
      'Check remember me option',
      'Test login on mobile viewport',
    ],
  },
  checkout: {
    layer: 'Frontend', testType: 'Functional', environment: 'Staging',
    rules: [
      'Add item to cart',
      'Apply discount code',
      'Fill shipping details',
      'Test invalid card number',
      'Complete payment flow',
      'Verify order confirmation email',
    ],
  },
  api: {
    layer: 'API', testType: 'Functional', environment: 'Development',
    rules: [
      'Check endpoint returns 200 OK',
      'Test with invalid token returns 401',
      'Verify response schema matches docs',
      'Test rate limiting behavior',
      'Check error messages are descriptive',
      'Test pagination parameters',
    ],
  },
  mobile: {
    layer: 'Mobile', testType: 'Functional', environment: 'Staging',
    rules: [
      'Test on 375px viewport',
      'Verify touch targets are large enough',
      'Check horizontal scroll is absent',
      'Test landscape orientation',
      'Verify images scale correctly',
      'Check font sizes are readable',
    ],
  },
  regression: {
    layer: 'Full Stack', testType: 'Regression', environment: 'Staging',
    rules: [
      'Verify all previous bugs are fixed',
      'Test core user flows end to end',
      'Check no new regressions introduced',
      'Validate database consistency',
      'Test third party integrations',
    ],
  },
  smoke: {
    layer: 'Full Stack', testType: 'Smoke', environment: 'Production',
    rules: [
      'App loads without errors',
      'User can log in',
      'Core navigation works',
      'Main feature is accessible',
      'No critical console errors',
    ],
  },
  accessibility: {
    layer: 'Frontend', testType: 'Functional', environment: 'Staging',
    rules: [
      'All images have alt text',
      'Keyboard navigation works',
      'Color contrast meets WCAG AA',
      'Screen reader announces elements',
      'Focus indicators are visible',
      'Forms have proper labels',
    ],
  },
  performance: {
    layer: 'Full Stack', testType: 'Functional', environment: 'Production',
    rules: [
      'Page load under 3 seconds',
      'No layout shift on load',
      'Images are optimized',
      'API response under 500ms',
      'Check for memory leaks',
      'Lighthouse score above 80',
    ],
  },
};

// ─── UI State ─────────────────────────────────────────────────────────────────

interface PopupState {
  micOn       : boolean;
  camOn       : boolean;
  ctrlBarOn   : boolean;
  quality     : string;
  mode        : string;
  countdownSec: number;
  priority    : string;
  layer       : string;
  environment : string;
  testType    : string;
  sprint      : string;
  tags        : string[];
  rules       : string[];
}

const state: PopupState = {
  micOn      : true,
  camOn      : false,
  ctrlBarOn  : true,
  quality    : '720',
  mode       : 'desktop',
  countdownSec: 3,
  priority   : 'medium',
  layer      : '',
  environment: '',
  testType   : '',
  sprint     : '',
  tags       : [],
  rules      : [],
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds || 0);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  const b = bytes || 0;
  return b < 1_048_576
    ? (b / 1024).toFixed(0) + ' KB'
    : (b / 1_048_576).toFixed(1) + ' MB';
}

function formatMinutes(seconds: number): string {
  return seconds < 60
    ? seconds + 's'
    : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

function showToast(message: string, durationMs = 4000): void {
  let toast = document.getElementById('qa-toast');

  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'qa-toast';
    toast.style.cssText = [
      'position:fixed', 'bottom:14px', 'left:50%', 'transform:translateX(-50%)',
      'background:#16223A', 'border:1px solid rgba(148,163,253,.25)',
      'color:white', 'padding:9px 16px', 'border-radius:10px',
      'font-size:11.5px', 'font-weight:500', 'z-index:9999',
      'white-space:nowrap', 'box-shadow:0 8px 24px rgba(0,0,0,.5)',
      'pointer-events:none', 'transition:opacity .3s',
    ].join(';');
    document.body.appendChild(toast);
  }

  toast.textContent   = message;
  toast.style.opacity = '1';
  clearTimeout((toast as any)._timer);
  (toast as any)._timer = setTimeout(() => {
    (toast as HTMLElement).style.opacity = '0';
  }, durationMs);
}

// ─── Screen Router ────────────────────────────────────────────────────────────

function showScreen(screenId: string): void {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el(   'screen-' + screenId)?.classList.add('active');

  document.querySelectorAll('.tab-btn[data-screen]').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset['screen'] === screenId);
  });

  if (screenId === 'results') void loadResults();
  if (screenId === 'notes')   void loadNotes();
}

// ─── Form Validation ──────────────────────────────────────────────────────────

function getFormValues(): { name: string; title: string; isValid: boolean } {
  const name  = (el<HTMLInputElement>('tester-name')?.value  || '').trim();
  const title = (el<HTMLInputElement>('session-title')?.value || '').trim();
  return { name, title, isValid: name.length > 0 && title.length > 0 };
}

function shakeInvalidFields(): void {
  ['tester-name', 'session-title'].forEach(id => {
    const input = el<HTMLInputElement>(id);
    if (!input?.value.trim()) {
      input?.classList.add('input-error');
      input?.focus();
      setTimeout(() => input?.classList.remove('input-error'), 2000);
    }
  });
}

// ─── Current Tab ─────────────────────────────────────────────────────────────

function getCurrentTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0] || null);
    });
  });
}

function getHostname(tab: chrome.tabs.Tab | null): string | null {
  if (!tab?.url) return null;
  try {
    return new URL(tab.url).hostname || tab.url;
  } catch {
    return null;
  }
}

// ─── Navigation ──────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn[data-screen]').forEach(btn => {
  btn.addEventListener('click', () => {
    const screenId = (btn as HTMLElement).dataset['screen']!;
    if (screenId === 'record-setup' && !getFormValues().isValid) {
      showScreen('idle');
      showToast('Please enter your name and session title first');
      shakeInvalidFields();
      return;
    }
    showScreen(screenId);
  });
});

document.querySelectorAll('[data-screen]:not(.tab-btn)').forEach(btn => {
  btn.addEventListener('click', () => {
    showScreen((btn as HTMLElement).dataset['screen']!);
  });
});

el('btn-start')?.addEventListener('click', () => {
  if (!getFormValues().isValid) {
    showToast('Please enter your name and session title first');
    shakeInvalidFields();
    return;
  }
  showScreen('record-setup');
});

el('btn-back')?.addEventListener('click', () => showScreen('idle'));

// ─── Quality Selector ────────────────────────────────────────────────────────

document.querySelectorAll('.q-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    const t = tag as HTMLElement;
    if (t.dataset['q'] === 'mp4') {
      t.classList.toggle('selected');
      return;
    }
    document.querySelectorAll('.q-tag:not([data-q="mp4"])').forEach(x => x.classList.remove('selected'));
    t.classList.add('selected');
    state.quality = t.dataset['q'] || '720';
  });
});

// ─── Countdown Stepper ───────────────────────────────────────────────────────

el('cnt-minus')?.addEventListener('click', () => {
  if (state.countdownSec > 0) state.countdownSec--;
  const display = el('cnt-value');
  if (display) display.textContent = String(state.countdownSec);
});

el('cnt-plus')?.addEventListener('click', () => {
  if (state.countdownSec < 10) state.countdownSec++;
  const display = el('cnt-value');
  if (display) display.textContent = String(state.countdownSec);
});

// ─── Toggle Switches ─────────────────────────────────────────────────────────

function wireToggle(toggleId: string, stateKey: keyof PopupState, iconSelector?: string): void {
  el(toggleId)?.addEventListener('click', () => {
    (state as any)[stateKey] = !(state as any)[stateKey];
    el(toggleId)?.classList.toggle('on', (state as any)[stateKey]);
    if (iconSelector) {
      document.querySelector(iconSelector)?.classList.toggle('on', (state as any)[stateKey]);
    }
  });
}

wireToggle('toggle-mic',     'micOn',     '#opt-mic .option-icon');
wireToggle('toggle-cam',     'camOn',     '#icon-cam');
wireToggle('toggle-ctrlbar', 'ctrlBarOn', '#icon-ctrlbar');

// ─── Priority Selector ───────────────────────────────────────────────────────

document.querySelectorAll('.priority-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.priority = (btn as HTMLElement).dataset['priority'] || 'medium';
  });
});

// ─── Session Templates ───────────────────────────────────────────────────────

el<HTMLSelectElement>('session-template')?.addEventListener('change', function () {
  const key = this.value;
  if (!key || !TEMPLATES[key]) return;

  const template = TEMPLATES[key];

  if (template.layer) {
    el<HTMLSelectElement>('ctx-layer').value = template.layer;
    state.layer = template.layer;
  }
  if (template.testType) {
    el<HTMLSelectElement>('ctx-type').value = template.testType;
    state.testType = template.testType;
  }
  if (template.environment) {
    el<HTMLSelectElement>('ctx-env').value = template.environment;
    state.environment = template.environment;
  }

  state.rules = [...template.rules];
  renderRules();

  const label = this.options[this.selectedIndex].text.replace(/^.+? /, '');
  showToast('Template applied: ' + label);
});

// ─── Context Fields ──────────────────────────────────────────────────────────

el<HTMLSelectElement>('ctx-layer')?.addEventListener('change', e => {
  state.layer = (e.target as HTMLSelectElement).value;
});
el<HTMLSelectElement>('ctx-env')?.addEventListener('change', e => {
  state.environment = (e.target as HTMLSelectElement).value;
});
el<HTMLSelectElement>('ctx-type')?.addEventListener('change', e => {
  state.testType = (e.target as HTMLSelectElement).value;
});
el<HTMLInputElement>('ctx-sprint')?.addEventListener('input', e => {
  state.sprint = (e.target as HTMLInputElement).value.trim();
});

// ─── Tags ────────────────────────────────────────────────────────────────────

function renderTags(): void {
  const list = el('tags-list');
  if (!list) return;
  list.innerHTML = '';

  state.tags.forEach((tag, index) => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    chip.innerHTML = `<span>${tag}</span><button class="tag-chip-del" title="Remove">×</button>`;
    chip.querySelector('.tag-chip-del')?.addEventListener('click', () => {
      state.tags.splice(index, 1);
      renderTags();
    });
    list.appendChild(chip);
  });
}

function addTag(): void {
  const input = el<HTMLInputElement>('tag-input');
  if (!input) return;

  const value = input.value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!value || state.tags.includes(value)) { input.value = ''; return; }

  state.tags.push(value);
  input.value = '';
  renderTags();
}

el('btn-add-tag')?.addEventListener('click', addTag);
el<HTMLInputElement>('tag-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addTag(); }
});

// ─── Rules Checklist ─────────────────────────────────────────────────────────

function renderRules(): void {
  const list = el('rules-list');
  if (!list) return;
  list.innerHTML = '';

  state.rules.forEach((rule, index) => {
    const item = document.createElement('div');
    item.className = 'rule-item';
    item.innerHTML = `
      <span class="rule-item-text"></span>
      <button class="rule-item-del" title="Remove">
        <svg viewBox="0 0 20 20" fill="none">
          <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>`;
    (item.querySelector('.rule-item-text') as HTMLElement).textContent = rule;
    item.querySelector('.rule-item-del')?.addEventListener('click', () => {
      state.rules.splice(index, 1);
      renderRules();
    });
    list.appendChild(item);
  });
}

function addRule(): void {
  const input = el<HTMLInputElement>('rule-input');
  if (!input) return;

  const value = input.value.trim();
  if (!value) { input.focus(); return; }

  state.rules.push(value);
  input.value = '';
  renderRules();
}

el('btn-add-rule')?.addEventListener('click', addRule);
el<HTMLInputElement>('rule-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addRule(); }
});

// ─── Notes ───────────────────────────────────────────────────────────────────

interface Note {
  id  : string;
  text: string;
  ts  : number;
}

function formatNoteDate(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' at '
    + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function refreshNotesCount(): void {
  getCurrentTab().then(tab => {
    const countEl = el('notes-count');
    if (!countEl) return;

    const host = getHostname(tab);
    if (!host) { countEl.textContent = 'Not available on this page'; return; }

    chrome.storage.local.get(['qa_notes'], result => {
      const allNotes = result['qa_notes'] as Record<string, Note[]> || {};
      const notes    = allNotes[host] || [];
      countEl.textContent = notes.length > 0
        ? `${notes.length} note${notes.length > 1 ? 's' : ''} on this page`
        : 'No notes on this page';
    });
  });
}

async function loadNotes(): Promise<void> {
  const tab  = await getCurrentTab();
  const host = getHostname(tab);

  const hostEl    = el('notes-host');
  const composeEl = document.querySelector<HTMLElement>('.note-compose');
  if (hostEl) hostEl.textContent = host || 'This page';
  if (composeEl) composeEl.style.display = host ? '' : 'none';

  renderNotesList(host);
}

function renderNotesList(host: string | null): void {
  const list = el('notes-list');
  if (!list) return;

  if (!host) {
    list.innerHTML = '<p class="notes-empty">Notes are not available on this kind of page.</p>';
    return;
  }

  chrome.storage.local.get(['qa_notes'], result => {
    const allNotes = result['qa_notes'] as Record<string, Note[]> || {};
    const notes    = allNotes[host] || [];

    if (notes.length === 0) {
      list.innerHTML = '<p class="notes-empty">No notes yet for this page.</p>';
      return;
    }

    list.innerHTML = '';

    notes.slice().reverse().forEach(note => {
      const row = document.createElement('div');
      row.className = 'note-item';
      row.innerHTML = `
        <div class="note-item-body">
          <p class="note-item-text"></p>
          <p class="note-item-meta">${formatNoteDate(note.ts)}</p>
        </div>
        <button class="note-item-del" title="Delete note">
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M4 6h12M8 6V4.5a1 1 0 011-1h2a1 1 0 011 1V6m-7 0l.6 9.4a1.5 1.5 0 001.5 1.6h4.8a1.5 1.5 0 001.5-1.6L15 6"
              stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>`;
      (row.querySelector('.note-item-text') as HTMLElement).textContent = note.text;
      row.querySelector('.note-item-del')?.addEventListener('click', () => deleteNote(host, note.id));
      list.appendChild(row);
    });
  });
}

function deleteNote(host: string, noteId: string): void {
  chrome.storage.local.get(['qa_notes'], result => {
    const allNotes = result['qa_notes'] as Record<string, Note[]> || {};
    allNotes[host] = (allNotes[host] || []).filter(n => n.id !== noteId);
    chrome.storage.local.set({ qa_notes: allNotes }, () => {
      renderNotesList(host);
      refreshNotesCount();
    });
  });
}

el('btn-add-note')?.addEventListener('click', () => {
  const input = el<HTMLInputElement>('note-input');
  const text  = input?.value.trim() || '';
  if (!text) { input?.focus(); return; }

  getCurrentTab().then(tab => {
    const host = getHostname(tab);
    if (!host) { showToast("Notes aren't available on this page"); return; }

    chrome.storage.local.get(['qa_notes'], result => {
      const allNotes = result['qa_notes'] as Record<string, Note[]> || {};
      allNotes[host] = allNotes[host] || [];
      allNotes[host].push({
        id  : Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        text,
        ts  : Date.now(),
      });
      chrome.storage.local.set({ qa_notes: allNotes }, () => {
        if (input) input.value = '';
        renderNotesList(host);
        refreshNotesCount();
        showToast('Note saved');
      });
    });
  });
});

// ─── Restricted Page Warning ──────────────────────────────────────────────────

function showRestrictedPageWarning(): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:rgba(5,8,16,.95)',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center',
      'gap:16px', 'padding:28px', 'text-align:center',
    ].join(';');
    overlay.innerHTML = `
      <p style="font-size:14px;font-weight:700;color:white;margin:0;">
        Control bar won't appear on this page
      </p>
      <p style="font-size:12px;color:rgba(248,250,252,.62);line-height:1.6;margin:0;max-width:260px;">
        Chrome blocks extensions from showing UI here. Recording still captures
        your screen, but the countdown and control bar won't be visible.
      </p>
      <div style="display:flex;gap:10px;margin-top:4px;">
        <button id="restricted-cancel"
          style="padding:10px 18px;border-radius:10px;border:1.5px solid rgba(148,163,253,.28);
          background:none;color:rgba(248,250,252,.7);font-size:12.5px;cursor:pointer;font-family:inherit;">
          Go Back
        </button>
        <button id="restricted-continue"
          style="padding:10px 18px;border-radius:10px;border:none;
          background:linear-gradient(135deg,#2563EB,#7C3AED);
          color:white;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;">
          Continue Anyway
        </button>
      </div>`;
    document.body.appendChild(overlay);

    el('restricted-cancel')?.addEventListener('click',   () => { overlay.remove(); resolve(false); });
    el('restricted-continue')?.addEventListener('click', () => { overlay.remove(); resolve(true);  });
  });
}

// ─── Launch Recording ────────────────────────────────────────────────────────

el('btn-launch')?.addEventListener('click', async () => {
  const { name, title, isValid } = getFormValues();
  if (!isValid) {
    showScreen('idle');
    showToast('Please fill in your name and session title');
    shakeInvalidFields();
    return;
  }

  const targetTab   = await getCurrentTab();
  const targetTabId = targetTab?.id ?? null;
  const targetUrl   = targetTab?.url || '';

  // Chrome blocks extension injection on system pages
  const isSystemPage = (
    !targetUrl ||
    targetUrl.startsWith('chrome://') ||
    targetUrl.startsWith('chrome-extension://') ||
    targetUrl.startsWith('edge://') ||
    targetUrl.startsWith('about:')
  );

  if (isSystemPage) {
    const shouldContinue = await showRestrictedPageWarning();
    if (!shouldContinue) { showScreen('record-setup'); return; }
  }

  const config: RecorderConfig = {
    mode        : state.mode as RecorderConfig['mode'],
    quality     : state.quality as RecorderConfig['quality'],
    micOn       : state.micOn,
    camOn       : state.camOn,
    ctrlBarOn   : state.ctrlBarOn,
    countdownSec: state.countdownSec,
    title,
    tester      : name,
    targetTabId,
    priority    : state.priority as RecorderConfig['priority'],
    layer       : state.layer,
    environment : state.environment,
    testType    : state.testType,
    sprint      : state.sprint,
    tags        : state.tags,
    rules       : state.rules,
  };

  if (state.micOn || state.camOn) {
    // Save config in background BEFORE opening permissions tab
    // because the popup closes when the new tab opens
    chrome.runtime.sendMessage({ type: 'SAVE_RECORDER_CONFIG', config }, () => {
      const permUrl = chrome.runtime.getURL('permissions/permissions.html')
        + `?mic=${state.micOn ? 1 : 0}&cam=${state.camOn ? 1 : 0}`;
      chrome.tabs.create({ url: permUrl });
      showScreen('waiting-perms');
    });
  } else {
    openRecorderDirectly(false, false, targetTabId);
  }
});

function openRecorderDirectly(
  micGranted : boolean,
  camGranted : boolean,
  targetTabId: number | null
): void {
  const { name, title } = getFormValues();

  const params = new URLSearchParams({
    mode       : state.mode,
    quality    : state.quality,
    mic        : state.micOn     ? '1' : '0',
    cam        : state.camOn     ? '1' : '0',
    ctrlbar    : state.ctrlBarOn ? '1' : '0',
    countdown  : String(state.countdownSec),
    title,
    tester     : name,
    micg       : micGranted ? '1' : '0',
    camg       : camGranted ? '1' : '0',
    target     : targetTabId != null ? String(targetTabId) : '',
    priority   : state.priority,
    layer      : state.layer,
    environment: state.environment,
    testType   : state.testType,
    sprint     : state.sprint,
    tags       : JSON.stringify(state.tags),
    rules      : JSON.stringify(state.rules),
  });

  const recorderUrl = chrome.runtime.getURL('recorder/recorder.html') + '?' + params.toString();
  chrome.tabs.create({ url: recorderUrl });
  showScreen('recording-active');
}

el('cancel-perms')?.addEventListener('click', () => showScreen('record-setup'));

el('btn-stop-from-popup')?.addEventListener('click', e => {
  (e.currentTarget as HTMLButtonElement).disabled = true;
  chrome.runtime.sendMessage({ type: 'CONTROLBAR_STOP' });
  showToast('Stopping recording…');
});

// ─── Connector Settings ───────────────────────────────────────────────────────

function loadConnectorSettings(): void {
  chrome.storage.local.get(['qa_jira', 'qa_clickup'], result => {
    const jira    = (result['qa_jira']    as Partial<JiraConfig>)    || {};
    const clickup = (result['qa_clickup'] as Partial<ClickUpConfig>) || {};

    if (jira.url)      el<HTMLInputElement>('jira-url').value      = jira.url;
    if (jira.email)    el<HTMLInputElement>('jira-email').value    = jira.email;
    if (jira.token)    el<HTMLInputElement>('jira-token').value    = jira.token;
    if (jira.project)  el<HTMLInputElement>('jira-project').value  = jira.project;
    if (clickup.token) el<HTMLInputElement>('clickup-token').value = clickup.token;
    if (clickup.listId) el<HTMLInputElement>('clickup-list').value  = clickup.listId;

    updateConnectorBadges(jira, clickup);
  });
}

function updateConnectorBadges(
  jira   : Partial<JiraConfig>,
  clickup: Partial<ClickUpConfig> | null
): void {
  const jiraBadge    = el('jira-status-badge');
  const clickupBadge = el('clickup-status-badge');

  if (jiraBadge) {
    const isConfigured = !!(jira?.url && jira?.token);
    jiraBadge.textContent = isConfigured ? '✓ Configured' : 'Not configured';
    jiraBadge.classList.toggle('configured', isConfigured);
  }

  if (clickupBadge) {
    const isConfigured = !!(clickup?.token);
    clickupBadge.textContent = isConfigured ? '✓ Configured' : 'Not configured';
    clickupBadge.classList.toggle('configured', isConfigured);
  }
}

el('btn-save-jira')?.addEventListener('click', () => {
  const jira: JiraConfig = {
    url    : el<HTMLInputElement>('jira-url').value.trim().replace(/\/$/, ''),
    email  : el<HTMLInputElement>('jira-email').value.trim(),
    token  : el<HTMLInputElement>('jira-token').value.trim(),
    project: el<HTMLInputElement>('jira-project').value.trim().toUpperCase(),
  };
  chrome.storage.local.set({ qa_jira: jira }, () => {
    updateConnectorBadges(jira, null);
    showToast('Jira settings saved');
  });
});

el('btn-save-clickup')?.addEventListener('click', () => {
  const clickup: ClickUpConfig = {
    token : el<HTMLInputElement>('clickup-token').value.trim(),
    listId: el<HTMLInputElement>('clickup-list').value.trim(),
  };
  chrome.storage.local.set({ qa_clickup: clickup }, () => {
    updateConnectorBadges({}, clickup);
    showToast('ClickUp settings saved');
  });
});

loadConnectorSettings();

// ─── Results: Session List ────────────────────────────────────────────────────

function buildReportText(session: QASession & { pageNotes?: Note[] }): string {
  const priorityLabels: Record<string, string> = {
    critical: 'P1 Critical',
    high    : 'P2 High',
    medium  : 'P3 Medium',
    low     : 'P4 Low',
  };

  const lines: string[] = [];

  lines.push('===========================================');
  lines.push('   QA Smart Assistant - Session Report');
  lines.push('===========================================');
  lines.push('');
  lines.push(`Session     : ${session.title     || 'QA Session'}`);
  lines.push(`Tester      : ${session.tester    || 'Tester'}`);
  lines.push(`Date        : ${new Date(session.timestamp).toLocaleString()}`);
  lines.push(`Duration    : ${formatDuration(session.duration)}`);
  if (session.priority)    lines.push(`Priority    : ${priorityLabels[session.priority] || session.priority}`);
  if (session.layer)       lines.push(`Layer       : ${session.layer}`);
  if (session.environment) lines.push(`Environment : ${session.environment}`);
  if (session.testType)    lines.push(`Test Type   : ${session.testType}`);
  if (session.sprint)      lines.push(`Sprint      : ${session.sprint}`);
  if (session.tags?.length) lines.push(`Tags        : ${session.tags.join(', ')}`);
  lines.push('');

  if (session.pageNotes?.length) {
    lines.push('-------------------------------------------');
    lines.push('  PAGE NOTES');
    lines.push('-------------------------------------------');
    session.pageNotes.forEach(n => {
      lines.push(`  [${new Date(n.ts).toLocaleTimeString()}] ${n.text}`);
    });
    lines.push('');
  }

  if (session.rules?.length) {
    lines.push('-------------------------------------------');
    lines.push('  TEST RULES');
    lines.push('-------------------------------------------');
    session.rules.forEach(r => lines.push(`  ${r.checked ? '[x]' : '[ ]'} ${r.text}`));
    const completed = session.rules.filter(r => r.checked).length;
    lines.push(`  Completed: ${completed}/${session.rules.length}`);
    lines.push('');
  }

  if (session.annotations?.length) {
    lines.push('-------------------------------------------');
    lines.push('  BUG ANNOTATIONS');
    lines.push('-------------------------------------------');
    session.annotations.forEach(a => {
      lines.push(`  [${formatDuration(a.ts)}] [${a.severity.toUpperCase()}] ${a.text}`);
    });
    lines.push('');
  }

  lines.push('-------------------------------------------');
  lines.push('  VOICE TRANSCRIPT');
  lines.push('-------------------------------------------');
  lines.push('');

  if (session.transcript?.length) {
    session.transcript.forEach((entry, i) => {
      const text = entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
      lines.push(`[${formatDuration(entry.ts)}]  ${text}`);
      if (i < session.transcript.length - 1) lines.push('');
    });
    lines.push('');
    lines.push(`Total entries: ${session.transcript.length}`);
  } else {
    lines.push('(No voice notes were recorded for this session)');
  }

  lines.push('');
  lines.push('Generated by QA Smart Assistant');
  lines.push('===========================================');

  return lines.join('\n');
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function downloadSessionVideo(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session?.videoBlob) { showToast('Video not available for this session'); return; }
  downloadBlob(session.videoBlob, `${session.title || 'QA_Session'}.${session.extension || 'webm'}`);
}

/**
 * Same package shape as the Review page's "ZIP Bundle" download —
 * session.json, README, recording, screenshots/, skill/ instructions,
 * and a plain-text report — so a package downloaded from the Results tab
 * is identical to one downloaded from Review for the same session.
 */
function buildSessionManifest(session: QASession): QaSessionManifest {
  const screenshotEntries = (session.screenshots || []).map((s, i) => ({
    file     : `screenshots/screenshot-${String(s.index || i + 1).padStart(3, '0')}.png`,
    timestamp: '',
  }));

  return {
    id            : session.sessionId || session.id,
    schemaVersion : 1,
    title         : session.title  || 'QA Session',
    tester        : session.tester || 'Tester',
    createdAt     : new Date(session.timestamp).toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }),
    createdAtIso  : new Date(session.timestamp).toISOString(),
    durationSec   : Math.round(session.duration || 0),
    priority      : session.priority    || 'medium',
    layer         : session.layer       || '',
    environment   : session.environment || '',
    testType      : session.testType    || '',
    sprint        : session.sprint      || '',
    tags          : session.tags || [],
    rules         : (session.rules || []).map(r => ({ text: r.text, checked: r.checked })),
    annotations   : (session.annotations || []).map(a => ({
      timestamp: formatDuration(a.ts),
      severity : a.severity,
      text     : a.text,
    })),
    transcript    : (session.transcript || []).map(t => ({
      timestamp: formatDuration(t.ts),
      text     : t.text,
    })),
    screenshots   : screenshotEntries,
    hasRecording  : !!session.videoBlob,
    hasScreenshots: (session.screenshots || []).length > 0,
    hasTranscript : (session.transcript  || []).length > 0,
    recordingFile : session.videoBlob ? `recording.${session.extension || 'webm'}` : undefined,
  };
}

async function populateZipFolder(folder: any, session: QASession, titleSlug: string): Promise<void> {
  folder.file('session.json', JSON.stringify(buildSessionManifest(session), null, 2));
  folder.file('README.md', README_MD);

  if (session.videoBlob) folder.file(`recording.${session.extension || 'webm'}`, session.videoBlob);

  const shots = session.screenshots || [];
  if (shots.length) {
    const shotsFolder = folder.folder('screenshots')!;
    for (let i = 0; i < shots.length; i++) {
      const shot     = shots[i];
      const shotBlob = await fetch(shot.dataUrl).then(r => r.blob());
      const numbered = String(shot.index || i + 1).padStart(3, '0');
      shotsFolder.file(`screenshot-${numbered}.png`, shotBlob);
    }
  }

  const skillFolder = folder.folder('skill')!;
  skillFolder.file('QA-REPORT-SKILL.md', SKILL_MD);
  skillFolder.folder('playbooks')!.file('report.md', REPORT_PLAYBOOK_MD);

  folder.file(`${titleSlug}_report.txt`, buildReportText(session as any));
}

async function downloadSessionZip(sessionId: string): Promise<void> {
  const JSZip = (window as any).JSZip;
  if (!JSZip) { showToast('JSZip library not loaded'); return; }

  const session = await getSession(sessionId);
  if (!session) { showToast('Session not available'); return; }

  try {
    const zip       = new JSZip();
    const titleSlug = (session.title || 'QA_Session').replace(/[^a-zA-Z0-9_-]/g, '_');
    const root      = zip.folder(titleSlug)!;

    await populateZipFolder(root, session, titleSlug);

    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(zipBlob, `${titleSlug}_qa_package.zip`);
  } catch (e) {
    console.warn('[QA] downloadSessionZip:', (e as Error).message);
    showToast('Could not build zip');
  }
}

async function downloadAllSessionsZip(sessions: QASession[]): Promise<void> {
  const btn = el<HTMLButtonElement>('btn-download-all');
  const JSZip = (window as any).JSZip;
  if (!JSZip) { showToast('JSZip library not loaded'); return; }
  if (btn) btn.disabled = true;

  try {
    const zip = new JSZip();

    for (const session of sessions) {
      const full = await getSession(session.id);
      if (!full) continue;

      const titleSlug = (full.title || 'QA_Session').replace(/[^a-zA-Z0-9_-]/g, '_');
      const folder     = zip.folder(`${titleSlug}_${full.id}`)!;
      await populateZipFolder(folder, full, titleSlug);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(zipBlob, `QA_Sessions_${new Date().toISOString().slice(0, 10)}.zip`);
    showToast('All sessions downloaded');
  } catch (e) {
    console.warn('[QA] downloadAllSessionsZip:', (e as Error).message);
    showToast('Could not build zip');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── Results Dashboard ────────────────────────────────────────────────────────

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildWeekBars(sessions: QASession[]): void {
  const container = el('dash-week-bars');
  if (!container) return;

  const today = startOfDay(Date.now());
  const days: { label: string; count: number; isToday: boolean }[] = [];

  for (let i = 6; i >= 0; i--) {
    const dayStart = today - i * 86_400_000;
    const dayEnd   = dayStart + 86_400_000;
    const count    = sessions.filter(s => s.timestamp >= dayStart && s.timestamp < dayEnd).length;
    days.push({ label: DAY_LABELS[new Date(dayStart).getDay()], count, isToday: i === 0 });
  }

  const max = Math.max(1, ...days.map(d => d.count));

  container.innerHTML = days.map(d => `
    <div class="dash-week-col">
      <span class="dash-week-count">${d.count || ''}</span>
      <div class="dash-week-bar-track">
        <div class="dash-week-bar${d.isToday ? ' today' : ''}" style="height:${Math.max(4, (d.count / max) * 100)}%"></div>
      </div>
      <span class="dash-week-label">${d.label}</span>
    </div>`).join('');
}

function buildSeverityBar(sessions: QASession[]): void {
  const container = el('dash-severity');
  if (!container) return;

  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  sessions.forEach(s => (s.annotations || []).forEach(a => {
    if (counts[a.severity] !== undefined) counts[a.severity]++;
  }));

  const total = counts['critical'] + counts['high'] + counts['medium'] + counts['low'];

  if (!total) {
    container.innerHTML = '<p class="dash-sev-empty">No bugs recorded yet</p>';
    return;
  }

  const colors: Record<string, string> = { critical: '#EF4444', high: '#F97316', medium: '#EAB308', low: '#22C55E' };
  const order = ['critical', 'high', 'medium', 'low'];
  const active = order.filter(k => counts[k] > 0);

  container.innerHTML = `
    <div class="dash-sev-labels">
      ${active.map(k => `<span class="dash-sev-label" style="color:${colors[k]}">${counts[k]} ${k}</span>`).join('')}
    </div>
    <div class="dash-sev-bar">
      ${active.map(k => `<span class="dash-sev-seg" style="width:${(counts[k] / total) * 100}%;background:${colors[k]}"></span>`).join('')}
    </div>`;
}

function buildPriorityChart(sessions: QASession[]): void {
  const container = el('dash-priority');
  if (!container) return;

  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  sessions.forEach(s => { if (counts[s.priority] !== undefined) counts[s.priority]++; });

  const total = sessions.length;
  if (!total) {
    container.innerHTML = '<p class="dash-sev-empty">No sessions recorded yet</p>';
    return;
  }

  const colors: Record<string, string> = { critical: '#EF4444', high: '#F97316', medium: '#EAB308', low: '#22C55E' };
  const order = ['critical', 'high', 'medium', 'low'];
  const active = order.filter(k => counts[k] > 0);

  container.innerHTML = `
    <div class="dash-sev-labels">
      ${active.map(k => `<span class="dash-sev-label" style="color:${colors[k]}">${counts[k]} ${k}</span>`).join('')}
    </div>
    <div class="dash-sev-bar">
      ${active.map(k => `<span class="dash-sev-seg" style="width:${(counts[k] / total) * 100}%;background:${colors[k]}"></span>`).join('')}
    </div>`;
}

function buildTopTags(sessions: QASession[]): void {
  const container = el('dash-top-tags');
  if (!container) return;

  const freq: Record<string, number> = {};
  sessions.forEach(s => (s.tags || []).forEach(tag => { freq[tag] = (freq[tag] || 0) + 1; }));

  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);

  if (!top.length) {
    container.innerHTML = '<span class="dash-tags-empty">No tags used yet</span>';
    return;
  }

  container.innerHTML = top.map(([tag, count]) =>
    `<span class="dash-tag-chip">${tag}<span class="dash-tag-count">${count}</span></span>`
  ).join('');
}

function buildSeverityTrend(sessions: QASession[]): void {
  const container = el('dash-trend');
  if (!container) return;

  const now      = Date.now();
  const weekMs   = 7 * 86_400_000;
  const thisWeek = sessions.filter(s => now - s.timestamp < weekMs);
  const lastWeek = sessions.filter(s => now - s.timestamp >= weekMs && now - s.timestamp < weekMs * 2);

  function highSevCount(list: QASession[]): number {
    return list.reduce((sum, s) =>
      sum + (s.annotations || []).filter(a => a.severity === 'critical' || a.severity === 'high').length, 0);
  }

  const diff = highSevCount(thisWeek) - highSevCount(lastWeek);

  if (diff > 0) {
    container.innerHTML = `<span class="dash-trend-text dash-trend-up">↑ ${diff} more high-severity bug${diff !== 1 ? 's' : ''} this week</span>`;
  } else if (diff < 0) {
    container.innerHTML = `<span class="dash-trend-text dash-trend-down">↓ ${-diff} fewer high-severity bug${-diff !== 1 ? 's' : ''} this week</span>`;
  } else {
    container.innerHTML = `<span class="dash-trend-text dash-trend-flat">Same as last week</span>`;
  }
}

function buildDashboard(sessions: QASession[]): void {
  buildWeekBars(sessions);
  buildSeverityBar(sessions);
  buildPriorityChart(sessions);
  buildTopTags(sessions);
  buildSeverityTrend(sessions);
}

// ─── Session Sharing (link + QR code) ─────────────────────────────────────────

interface ShareManifest {
  title         : string;
  tester        : string;
  createdAt     : string;
  durationSec   : number;
  priority      : string;
  layer         : string;
  environment   : string;
  testType      : string;
  sprint        : string;
  tags          : string[];
  rules         : Array<{ text: string; checked: boolean }>;
  annotations   : Array<{ ts: number; text: string; severity: string }>;
  transcript    : Array<{ ts: number; text: string }>;
  hasRecording  : boolean;
  hasScreenshots: boolean;
  screenshotCount: number;
}

function buildShareManifest(session: QASession): ShareManifest {
  return {
    title          : session.title  || 'QA Session',
    tester         : session.tester || 'Tester',
    createdAt      : new Date(session.timestamp).toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }),
    durationSec    : Math.round(session.duration || 0),
    priority       : session.priority,
    layer          : session.layer,
    environment    : session.environment,
    testType       : session.testType,
    sprint         : session.sprint,
    tags           : session.tags || [],
    rules          : (session.rules || []).map(r => ({ text: r.text, checked: r.checked })),
    annotations    : (session.annotations || []).map(a => ({ ts: a.ts, text: a.text, severity: a.severity })),
    transcript     : (session.transcript || []).slice(0, 20).map(t => ({ ts: t.ts, text: t.text })),
    hasRecording   : !!session.videoBlob,
    hasScreenshots : (session.screenshots || []).length > 0,
    screenshotCount: (session.screenshots || []).length,
  };
}

async function openShareModal(id: string): Promise<void> {
  const session = await getSession(id);
  if (!session) { showToast('Session not available'); return; }

  const manifest = buildShareManifest(session);
  const encoded  = btoa(unescape(encodeURIComponent(JSON.stringify(manifest))));
  const url      = `https://loquacious-squirrel-5a8cf6.netlify.app/?session=${encoded}`;

  const overlay = document.createElement('div');
  overlay.className = 'share-modal-overlay';
  overlay.innerHTML = `
    <div class="share-modal">
      <div class="share-modal-head">
        <span class="share-modal-title">Share Session</span>
        <button class="share-modal-close" id="share-modal-close">×</button>
      </div>
      <div class="share-qr-wrap" id="share-qr-wrap"></div>
      <div class="share-url-row">
        <input class="share-url-input" id="share-url-input" readonly value="${url}" />
        <button class="share-copy-btn" id="share-copy-btn">Copy</button>
      </div>
      <p class="share-note">Share this link with your supervisor or teammate. The session data is encoded in the URL — no server needed.</p>
      <button class="btn-ghost" id="share-close-btn">Close</button>
    </div>`;
  document.body.appendChild(overlay);

  function close(): void { overlay.remove(); }
  overlay.querySelector('#share-modal-close')?.addEventListener('click', close);
  overlay.querySelector('#share-close-btn')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.querySelector('#share-copy-btn')?.addEventListener('click', () => {
    const input = overlay.querySelector<HTMLInputElement>('#share-url-input');
    input?.select();
    navigator.clipboard.writeText(url).then(() => {
      const btn = overlay.querySelector('#share-copy-btn');
      if (btn) { btn.textContent = 'Copied!'; btn.classList.add('copied'); }
    }).catch(() => showToast('Could not copy link'));
  });

  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    const qrWrap = overlay.querySelector('#share-qr-wrap');
    if (qrWrap) qrWrap.innerHTML = `<img src="${qrDataUrl}" alt="QR code for session link" />`;
  } catch {
    const qrWrap = overlay.querySelector('#share-qr-wrap');
    if (qrWrap) qrWrap.innerHTML = '<p style="font-size:11px;color:var(--text-lo);">Could not generate QR code</p>';
  }
}

function buildSessionCard(session: QASession): HTMLElement {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.innerHTML = `
    <div class="session-card-head">
      <p class="session-card-title"></p>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="session-card-priority"></span>
        <span class="session-card-date"></span>
        <button class="btn-session-del" title="Delete session">
          <svg viewBox="0 0 20 20" fill="none" width="14" height="14">
            <path d="M4 6h12M8 6V4h4v2M7 6l.5 9.5a1 1 0 001 .95h3a1 1 0 001-.95L13 6"
              stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="session-card-stats">
      <span>${formatDuration(session.duration)}</span>
      <span>${formatBytes(session.size)}</span>
      <span class="accent">${(session.extension || 'webm').toUpperCase()}</span>
    </div>
    <div class="session-card-actions">
      <button class="btn-session-dl" data-action="video">
        <svg viewBox="0 0 20 20" fill="none">
          <rect x="2" y="4" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M13 8l4-2.5v6L13 9" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
        </svg>
        Video
      </button>
      <button class="btn-session-dl" data-action="zip" title="Download full QA package (recording, screenshots, session.json, AI-report instructions)">
        <svg viewBox="0 0 20 20" fill="none">
          <path d="M4 4h8l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4"/>
          <path d="M12 4v4h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M8 9v6M8 9l2 2-2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        ZIP
      </button>
      <button class="btn-session-dl" data-action="share">
        <svg viewBox="0 0 20 20" fill="none">
          <circle cx="15" cy="5" r="2.2" stroke="currentColor" stroke-width="1.4"/>
          <circle cx="15" cy="15" r="2.2" stroke="currentColor" stroke-width="1.4"/>
          <circle cx="5" cy="10" r="2.2" stroke="currentColor" stroke-width="1.4"/>
          <path d="M7 9l6-3.2M7 11l6 3.2" stroke="currentColor" stroke-width="1.4"/>
        </svg>
        Share
      </button>
    </div>`;

  const PRIORITY_COLORS: Record<string, string> = { critical: '#EF4444', high: '#F97316', medium: '#EAB308', low: '#22C55E' };
  const priority = session.priority || 'medium';

  (card.querySelector('.session-card-title') as HTMLElement).textContent = session.title || 'QA Session';
  (card.querySelector('.session-card-date') as HTMLElement).textContent  =
    `${session.tester || 'Tester'} · ${new Date(session.timestamp).toLocaleDateString()}`;

  const priorityEl = card.querySelector('.session-card-priority') as HTMLElement;
  const color = PRIORITY_COLORS[priority] || PRIORITY_COLORS['medium'];
  priorityEl.textContent = priority;
  priorityEl.style.color = color;
  priorityEl.style.background = `${color}1a`;

  card.querySelector('[data-action="video"]')?.addEventListener('click', () => downloadSessionVideo(session.id));
  card.querySelector('[data-action="zip"]')?.addEventListener('click', e => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    void downloadSessionZip(session.id).finally(() => { btn.disabled = false; });
  });
  card.querySelector('[data-action="share"]')?.addEventListener('click', () => void openShareModal(session.id));

  // Delete with inline confirmation (no native alert)
  card.querySelector('.btn-session-del')?.addEventListener('click', e => {
    e.stopPropagation();

    const existing = card.querySelector('.del-confirm-bar');
    if (existing) { existing.remove(); return; }

    const confirmBar = document.createElement('div');
    confirmBar.className = 'del-confirm-bar';
    confirmBar.innerHTML = `
      <span class="del-confirm-msg">Delete this session?</span>
      <button class="del-confirm-yes">Delete</button>
      <button class="del-confirm-no">Cancel</button>`;
    card.appendChild(confirmBar);

    confirmBar.querySelector('.del-confirm-no')?.addEventListener('click', ev => {
      ev.stopPropagation(); confirmBar.remove();
    });

    confirmBar.querySelector('.del-confirm-yes')?.addEventListener('click', async ev => {
      ev.stopPropagation();
      try {
        await deleteSession(session.id);
        card.remove();

        const list = el('results-list');
        if (list?.children.length === 0) {
          el('results-empty').style.display = '';
          el('results-data').style.display  = 'none';
        }
        showToast('Session deleted');
      } catch {
        showToast('Could not delete session');
      }
    });
  });

  return card;
}

const PRIORITY_ORDER: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };

async function loadResults(): Promise<void> {
  const emptyEl   = el('results-empty');
  const dataEl    = el('results-data');
  const listEl    = el('results-list');
  const statsEl   = el('results-stats');
  const searchEl  = el<HTMLInputElement>('results-search');
  const sortEl    = el<HTMLSelectElement>('results-sort');
  const bulkBar   = el('results-bulk-confirm');

  let sessions: QASession[] = [];
  try { sessions = await getAllSessions(); }
  catch (e) { console.warn('[QA] loadResults:', (e as Error).message); }

  if (!sessions.length) {
    emptyEl.style.display = ''; dataEl.style.display = 'none'; return;
  }

  emptyEl.style.display = 'none'; dataEl.style.display = '';

  // Stats bar
  if (statsEl) {
    const total    = sessions.length;
    const totalSec = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const avgSec   = Math.round(totalSec / total);
    statsEl.innerHTML = `
      <span>📁 <strong>${total}</strong> session${total !== 1 ? 's' : ''}</span>
      <span>⏱ <strong>${formatMinutes(totalSec)}</strong> total</span>
      <span>∅ <strong>${formatMinutes(avgSec)}</strong> avg</span>`;
  }

  buildDashboard(sessions);

  // Render filtered + sorted cards
  function renderFiltered(query: string): void {
    listEl.innerHTML = '';
    const q        = query.toLowerCase().trim();
    const filtered = q
      ? sessions.filter(s =>
          s.title?.toLowerCase().includes(q) ||
          s.tester?.toLowerCase().includes(q)
        )
      : sessions.slice();

    const dir = sortEl?.value === 'priority-asc' ? 1 : -1;
    filtered.sort((a, b) => dir * ((PRIORITY_ORDER[b.priority] ?? 0) - (PRIORITY_ORDER[a.priority] ?? 0)));

    if (!filtered.length) {
      listEl.innerHTML = `<p style="font-size:12px;color:var(--text-secondary);text-align:center;padding:16px 0;">
        No sessions match "${q}"
      </p>`;
      return;
    }

    filtered.forEach(session => listEl.appendChild(buildSessionCard(session)));
  }

  renderFiltered('');

  if (searchEl) {
    searchEl.value   = '';
    searchEl.oninput = () => renderFiltered(searchEl.value);
  }

  if (sortEl) sortEl.onchange = () => renderFiltered(searchEl?.value || '');

  const downloadAllBtn = el<HTMLButtonElement>('btn-download-all');
  if (downloadAllBtn) downloadAllBtn.onclick = () => void downloadAllSessionsZip(sessions);

  const deleteAllBtn = el<HTMLButtonElement>('btn-delete-all');
  if (deleteAllBtn) deleteAllBtn.onclick = () => { if (bulkBar) bulkBar.style.display = 'flex'; };

  const bulkNo = el<HTMLButtonElement>('results-bulk-no');
  if (bulkNo) bulkNo.onclick = () => { if (bulkBar) bulkBar.style.display = 'none'; };

  const bulkYes = el<HTMLButtonElement>('results-bulk-yes');
  if (bulkYes) {
    bulkYes.onclick = async () => {
      bulkYes.disabled = true;
      try {
        for (const session of sessions) await deleteSession(session.id);
        showToast('All sessions deleted');
        if (bulkBar) bulkBar.style.display = 'none';
        await loadResults();
      } catch (e) {
        console.warn('[QA] delete all sessions:', (e as Error).message);
        showToast('Could not delete all sessions');
        bulkYes.disabled = false;
      }
    };
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function setButtonLoading(id: string, loading: boolean, loadingText: string, normalText: string): void {
  const btn = el<HTMLButtonElement>(id);
  if (!btn) return;
  btn.disabled    = loading;
  btn.textContent = loading ? loadingText : normalText;
}

function setFieldError(id: string, message: string): void {
  const errEl = el(id);
  if (errEl) errEl.textContent = message;
}

function clearAuthErrors(): void {
  [
    'signin-email-error', 'signin-password-error', 'signup-name-error', 'signup-email-error',
    'signup-password-error', 'forgot-email-error', 'verify-email-error',
  ].forEach(id => setFieldError(id, ''));

  const forgotSuccess = el('forgot-success-msg');
  if (forgotSuccess) forgotSuccess.style.display = 'none';
  const verifySuccess = el('verify-success-msg');
  if (verifySuccess) verifySuccess.style.display = 'none';
}

function friendlyAuthError(e: unknown): string {
  const code = (e as { code?: string })?.code || '';
  switch (code) {
    case 'auth/invalid-email':      return 'Enter a valid email address';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential': return 'Incorrect email or password';
    case 'auth/email-already-in-use': return 'An account with this email already exists';
    case 'auth/weak-password':      return 'Password must be at least 6 characters';
    case 'auth/too-many-requests':  return 'Too many attempts. Please try again later';
    default: return (e as Error)?.message || 'Something went wrong. Please try again.';
  }
}

function prefillTesterName(user: { displayName: string | null; email: string | null } | null): void {
  const input = el<HTMLInputElement>('tester-name');
  if (!input || input.value.trim()) return;

  const fallback = user?.email ? user.email.split('@')[0] : '';
  input.value = user?.displayName || fallback;
}

function clearFieldsOnSignOut(): void {
  [
    'signin-email', 'signin-password', 'signup-name', 'signup-email', 'signup-password',
    'forgot-email', 'tester-name', 'session-title',
  ].forEach(id => {
      const input = el<HTMLInputElement>(id);
      if (input) input.value = '';
    });

  clearAuthErrors();

  document.querySelectorAll<HTMLInputElement>('.pw-wrap input').forEach(input => { input.type = 'password'; });
  document.querySelectorAll('.pw-toggle').forEach(btn => btn.classList.remove('showing'));
}

document.querySelectorAll<HTMLButtonElement>('.pw-toggle').forEach(toggle => {
  toggle.addEventListener('click', () => {
    const input = toggle.previousElementSibling as HTMLInputElement | null;
    if (!input) return;

    const showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    toggle.classList.toggle('showing', showing);
    toggle.title = showing ? 'Hide password' : 'Show password';
  });
});

document.querySelectorAll('.auth-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = (btn as HTMLElement).dataset['authTab'];
    document.querySelectorAll('.auth-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    el('auth-panel-' + tab)?.classList.add('active');
    clearAuthErrors();
  });
});

el('link-goto-signin')?.addEventListener('click', () => el('auth-tab-signin')?.click());

el('btn-google-signin')?.addEventListener('click', async () => {
  clearAuthErrors();
  setButtonLoading('btn-google-signin', true, 'Signing in…', 'Continue with Google');
  try {
    const user = await signInWithGoogle();
    prefillTesterName(user);
    showScreen('idle');
    showToast('Signed in');
  } catch (e) {
    showToast((e as Error).message || 'Google sign-in failed');
  } finally {
    setButtonLoading('btn-google-signin', false, 'Signing in…', 'Continue with Google');
  }
});

function showVerifyEmailScreen(user: QAUser): void {
  const addrEl = el('verify-email-address');
  if (addrEl) addrEl.textContent = user.email || '';
  clearAuthErrors();
  showScreen('verify-email');
}

el('btn-signin')?.addEventListener('click', async () => {
  clearAuthErrors();
  const email    = el<HTMLInputElement>('signin-email').value.trim();
  const password = el<HTMLInputElement>('signin-password').value;

  if (!email)    { setFieldError('signin-email-error', 'Email is required'); return; }
  if (!password) { setFieldError('signin-password-error', 'Password is required'); return; }

  setButtonLoading('btn-signin', true, 'Signing in...', 'Sign In');
  try {
    const user = await signInWithEmail(email, password);
    if (!isVerified(user)) {
      showVerifyEmailScreen(user);
    } else {
      prefillTesterName(user);
      showScreen('idle');
      showToast('Signed in');
    }
  } catch (e) {
    setFieldError('signin-password-error', friendlyAuthError(e));
  } finally {
    setButtonLoading('btn-signin', false, 'Signing in...', 'Sign In');
  }
});

el('btn-signup')?.addEventListener('click', async () => {
  clearAuthErrors();
  const name     = el<HTMLInputElement>('signup-name').value.trim();
  const email    = el<HTMLInputElement>('signup-email').value.trim();
  const password = el<HTMLInputElement>('signup-password').value;

  if (!name)             { setFieldError('signup-name-error', 'Name is required'); return; }
  if (!email)            { setFieldError('signup-email-error', 'Email is required'); return; }
  if (password.length < 6) { setFieldError('signup-password-error', 'Password must be at least 6 characters'); return; }

  setButtonLoading('btn-signup', true, 'Creating account...', 'Create Account');
  try {
    const { user, needsVerification } = await signUpWithEmail(email, password, name);
    prefillTesterName(user);
    if (needsVerification && !isGoogleUser(user)) {
      showVerifyEmailScreen(user);
    } else {
      showScreen('idle');
      showToast('Account created');
    }
  } catch (e) {
    setFieldError('signup-email-error', friendlyAuthError(e));
  } finally {
    setButtonLoading('btn-signup', false, 'Creating account...', 'Create Account');
  }
});

// ─── Forgot Password ──────────────────────────────────────────────────────────

el('btn-forgot-password')?.addEventListener('click', () => {
  clearAuthErrors();
  const signinEmail = el<HTMLInputElement>('signin-email').value.trim();
  const forgotInput = el<HTMLInputElement>('forgot-email');
  if (forgotInput) forgotInput.value = signinEmail;
  showScreen('forgot-password');
});

el('btn-back-forgot-password')?.addEventListener('click', () => {
  clearAuthErrors();
  showScreen('auth');
});

el('btn-send-reset')?.addEventListener('click', async () => {
  clearAuthErrors();
  const email = el<HTMLInputElement>('forgot-email').value.trim();
  if (!email) { setFieldError('forgot-email-error', 'Email is required'); return; }

  setButtonLoading('btn-send-reset', true, 'Sending...', 'Send Reset Link');
  try {
    await sendPasswordReset(email);
    const successEl = el('forgot-success-msg');
    if (successEl) {
      successEl.textContent = 'Reset link sent — check your inbox';
      successEl.style.display = '';
    }
    setTimeout(() => {
      clearAuthErrors();
      showScreen('auth');
    }, 3000);
  } catch (e) {
    setFieldError('forgot-email-error', (e as Error).message || 'Could not send reset email');
  } finally {
    setButtonLoading('btn-send-reset', false, 'Sending...', 'Send Reset Link');
  }
});

// ─── Verify Email ──────────────────────────────────────────────────────────────

el('btn-verify-continue')?.addEventListener('click', async () => {
  clearAuthErrors();
  setButtonLoading('btn-verify-continue', true, 'Checking...', "I've verified — continue");
  try {
    const user = await reloadCurrentUser();
    if (user && isVerified(user)) {
      prefillTesterName(user);
      showScreen('idle');
      showToast('Signed in');
    } else {
      setFieldError('verify-email-error', 'Email not verified yet. Check your inbox and click the link.');
    }
  } catch (e) {
    setFieldError('verify-email-error', (e as Error).message || 'Could not check verification status');
  } finally {
    setButtonLoading('btn-verify-continue', false, 'Checking...', "I've verified — continue");
  }
});

el('btn-verify-resend')?.addEventListener('click', async () => {
  clearAuthErrors();
  setButtonLoading('btn-verify-resend', true, 'Sending...', 'Resend verification email');
  try {
    await resendVerificationEmail();
    const successEl = el('verify-success-msg');
    if (successEl) {
      successEl.textContent = 'Verification email sent';
      successEl.style.display = '';
    }
  } catch (e) {
    setFieldError('verify-email-error', (e as Error).message || 'Could not resend verification email');
  } finally {
    setButtonLoading('btn-verify-resend', false, 'Sending...', 'Resend verification email');
  }
});

el('btn-verify-different-account')?.addEventListener('click', async () => {
  await signOut();
  clearFieldsOnSignOut();
  showScreen('auth');
});

async function handleSignOut(): Promise<void> {
  await signOut();
  clearFieldsOnSignOut();
  showScreen('auth');
  showToast('Signed out');
}

el('btn-sign-out')?.addEventListener('click', handleSignOut);
el('btn-sign-out-home')?.addEventListener('click', handleSignOut);

// ─── Keyboard Shortcuts Settings ──────────────────────────────────────────────

type ShortcutAction = 'pause' | 'stop' | 'screenshot' | 'draw' | 'bug' | 'mic' | 'camera';

const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  pause     : 'Alt+P',
  stop      : 'Alt+S',
  screenshot: 'Alt+C',
  draw      : 'Alt+D',
  bug       : 'Alt+B',
  mic       : 'Alt+M',
  camera    : 'Alt+K',
};

let shortcuts: Record<ShortcutAction, string> = { ...DEFAULT_SHORTCUTS };
let capturingAction: ShortcutAction | null = null;

function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.altKey)   parts.push('Alt');
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join('+');
}

function renderShortcutButtons(): void {
  (Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).forEach(action => {
    const btn = el(`shortcut-${action}-btn`);
    if (btn) btn.textContent = shortcuts[action].replace(/\+/g, ' + ');
  });
}

/** True if combo looks like a real shortcut (last part isn't itself a modifier). */
function isValidCombo(combo: string | undefined): combo is string {
  if (!combo) return false;
  const parts = combo.split('+');
  return !MODIFIER_KEYS.has(parts[parts.length - 1]);
}

function loadShortcutSettings(): void {
  chrome.storage.local.get(['qa_shortcuts'], result => {
    const saved = result['qa_shortcuts'] as Partial<Record<ShortcutAction, string>> | undefined;
    shortcuts = { ...DEFAULT_SHORTCUTS };

    // Self-heal shortcuts corrupted by a fixed bug where pressing Alt alone
    // (before the second key) got saved as the whole combo — fall back to
    // the default for any stored value that isn't a real key combo.
    (Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).forEach(action => {
      const value = saved?.[action];
      if (isValidCombo(value)) shortcuts[action] = value;
    });

    renderShortcutButtons();
  });
}

document.querySelectorAll<HTMLButtonElement>('.shortcut-key-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    capturingAction = btn.dataset['action'] as ShortcutAction;
    btn.textContent = 'Press a key...';
  });
});

const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Shift', 'Meta', 'AltGraph', 'OS']);

document.addEventListener('keydown', e => {
  if (!capturingAction) return;
  e.preventDefault();

  // Pressing Alt fires its own keydown (e.key === 'Alt') before the second
  // key is pressed — finalizing on that would capture "Alt" alone as the
  // whole shortcut. Wait for a real, non-modifier key.
  if (MODIFIER_KEYS.has(e.key)) return;

  const combo = comboFromEvent(e);
  shortcuts[capturingAction] = combo;

  const btn = el(`shortcut-${capturingAction}-btn`);
  if (btn) btn.textContent = combo.replace(/\+/g, ' + ');
  capturingAction = null;
});

document.querySelectorAll<HTMLButtonElement>('.shortcut-reset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset['action'] as ShortcutAction;
    shortcuts[action] = DEFAULT_SHORTCUTS[action];
    renderShortcutButtons();
  });
});

el('btn-save-shortcuts')?.addEventListener('click', () => {
  chrome.storage.local.set({ qa_shortcuts: shortcuts }, () => showToast('Shortcuts saved'));
});

loadShortcutSettings();

// ─── Session Timer Warning Settings ───────────────────────────────────────────

function loadTimerSettings(): void {
  chrome.storage.local.get(['qa_session_timer'], result => {
    const cfg   = result['qa_session_timer'] as { maxMinutes?: number } | undefined;
    const input = el<HTMLInputElement>('timer-max-minutes');
    if (input) input.value = String(cfg?.maxMinutes ?? 15);
  });
}

el('btn-save-timer')?.addEventListener('click', () => {
  const input = el<HTMLInputElement>('timer-max-minutes');
  let maxMinutes = parseInt(input?.value || '15', 10);
  if (isNaN(maxMinutes)) maxMinutes = 15;
  maxMinutes = Math.min(120, Math.max(1, maxMinutes));
  if (input) input.value = String(maxMinutes);

  chrome.storage.local.set({ qa_session_timer: { maxMinutes } }, () => showToast('Timer settings saved'));
});

loadTimerSettings();

// ─── Boot ────────────────────────────────────────────────────────────────────

(async function bootAuth(): Promise<void> {
  await initAuth();
  let user = await getCurrentUser();

  if (!user) { showScreen('auth'); return; }

  if (!isVerified(user)) {
    // Stored status may be stale (e.g. the user clicked the link since last
    // opening the popup) — refresh from Firebase before deciding.
    try { user = await reloadCurrentUser(); } catch { /* keep stale user, checked below */ }
  }

  if (user && isVerified(user)) {
    prefillTesterName(user);
    showScreen('idle');
  } else if (user) {
    showVerifyEmailScreen(user);
  } else {
    showScreen('auth');
  }
})();

refreshNotesCount();
