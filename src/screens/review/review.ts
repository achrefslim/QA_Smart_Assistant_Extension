/**
 * src/screens/review/review.ts
 *
 * Review page — shown after a recording stops.
 * Responsibilities:
 *  - Receive recording data from the recorder tab via chrome.runtime.onMessage
 *  - Display the video player with custom controls
 *  - Show session metadata, priority, rules checklist
 *  - Show bug annotations with timestamp-linked video seeking
 *  - Show recording quality indicator
 *  - Show screenshots taken during recording
 *  - Groq AI transcription via direct API call (no local server needed)
 *  - Export: download recording, download report .txt, download ZIP bundle, export PDF
 *  - Connectors: create Jira ticket or ClickUp task from the session
 *  - Persist rules, annotations, transcript back to IndexedDB for the Results page
 */

import { updateSessionFields } from '../../shared/db/database';
import { Config } from '../../shared/config/env';
import { SKILL_MD, REPORT_PLAYBOOK_MD, README_MD } from '../../shared/skill/templates';
import type { TranscriptEntry, BugAnnotation, Screenshot, TestRule, JiraConfig, ClickUpConfig, QaSessionManifest } from '../../shared/types';

// ─── State ───────────────────────────────────────────────────────────────────

interface RecordingData {
  blobURL    : string;
  extension  : string;
  sessionId ?: string;
  duration   : number;
  title      : string;
  tester     : string;
  size       : number;
  timestamp  : number;
  transcript : TranscriptEntry[];
  screenshots: Screenshot[];
  rules      : TestRule[];
  priority  ?: string;
  layer     ?: string;
  environment?: string;
  testType  ?: string;
  sprint    ?: string;
  tags      ?: string[];
  annotations?: BugAnnotation[]; // bugs marked with Quick Bug (Alt+B) during recording
}

let recordingData: RecordingData | null = null;
let blobURL      : string | null        = null;
let whisperDone   = false;
let selectedLang  = 'en';

// Bug annotations live in this page's memory
// (also persisted to IndexedDB via persistSession)
const annotations: BugAnnotation[] = [];

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  // Use Math.floor (not Math.round) so 3.9s displays as 0:03 not 0:04.
  // This matches what you see on the video player seek bar.
  const sec = Math.floor(s || 0);
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  const b = bytes || 0;
  return b < 1_048_576
    ? (b / 1024).toFixed(0) + ' KB'
    : (b / 1_048_576).toFixed(1) + ' MB';
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ─── Persist to IndexedDB ────────────────────────────────────────────────────

/**
 * Save the current state of rules, annotations, and transcript back to IndexedDB.
 * Called every time the user checks a rule, adds/removes an annotation, or
 * finishes Groq transcription — so the Results page always has the latest data.
 */
async function persistSession(): Promise<void> {
  if (!recordingData?.sessionId) return;
  try {
    await updateSessionFields(recordingData.sessionId, {
      rules      : recordingData.rules || [],
      annotations: [...annotations],
      transcript : recordingData.transcript || [],
    });
  } catch (e: any) {
    console.warn('[QA] persistSession failed:', e.message);
  }
}

// ─── Error Display ────────────────────────────────────────────────────────────

function showError(message: string): void {
  el('overlay-loading')?.style.setProperty('display', 'none');
  const errorOverlay = el('overlay-error');
  const errorMsg     = el('error-msg');
  if (errorOverlay) errorOverlay.style.display = 'flex';
  if (errorMsg && message) errorMsg.textContent = message;
}

// ─── Metadata Panel ───────────────────────────────────────────────────────────

function fillMeta(data: RecordingData): void {
  const setText = (id: string, value: string) => {
    const elem = el(id);
    if (elem) elem.textContent = value;
  };

  setText('video-title', `${data.title || 'QA_Session'}.${data.extension || 'webm'}`);
  setText('video-meta',  `Tester: ${data.tester || 'Unknown'} · ${formatTime(data.duration)} · ${formatSize(data.size)}`);
  setText('panel-title', data.title || 'Recording Complete');
  setText('panel-sub',   `By ${data.tester || 'Tester'} · ${formatTime(data.duration)}`);
  setText('stat-dur',    formatTime(data.duration));
  setText('stat-size',   formatSize(data.size));
  setText('stat-fmt',    (data.extension || 'webm').toUpperCase());
  document.title = `Review: ${data.title || 'QA Session'}`;

  // Priority badge
  const priorityPanel = el('meta-panel');
  if (priorityPanel) {
    priorityPanel.style.display = 'flex';
    const badge = el('meta-priority');
    if (badge) {
      const priority = data.priority || 'medium';
      const labels: Record<string, string> = {
        critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low',
      };
      badge.textContent = labels[priority] || priority;
      badge.className   = `meta-priority-badge ${priority}`;
    }

    // Context fields — only show rows that have data
    const showMetaRow = (rowId: string, valId: string, value: string | undefined) => {
      const row  = el(rowId);
      const cell = el(valId);
      if (value && row && cell) {
        cell.textContent    = value;
        row.style.display  = 'flex';
      }
    };
    showMetaRow('meta-row-layer',  'meta-layer',  data.layer);
    showMetaRow('meta-row-env',    'meta-env',    data.environment);
    showMetaRow('meta-row-type',   'meta-type',   data.testType);
    showMetaRow('meta-row-sprint', 'meta-sprint', data.sprint);

    // Tags
    if (data.tags?.length) {
      const tagsRow  = el('meta-row-tags');
      const tagsEl   = el('meta-tags');
      if (tagsRow && tagsEl) {
        tagsRow.style.display = 'flex';
        tagsEl.innerHTML = data.tags.map(t => `<span class="meta-tag">${t}</span>`).join('');
      }
    }
  }

  // Rules checklist
  buildRulesChecklist(data.rules || []);

  // Voice notes section is always visible
  el('transcript-box')?.style.setProperty('display', 'flex');

  if (data.transcript?.length > 0) {
    renderTranscriptList(data.transcript, whisperDone ? 'whisper' : 'sr');
  } else {
    const list = el('t-list');
    if (list) {
      list.innerHTML = '<p class="t-empty">No voice notes recorded.<br>Enable microphone and speak during recording.</p>';
    }
  }
}

function buildRulesChecklist(rules: TestRule[]): void {
  if (!rules.length) return;

  const panel     = el('rules-panel');
  const checklist = el('rules-checklist');
  if (!panel || !checklist) return;

  panel.style.display = 'flex';
  checklist.innerHTML = '';

  rules.forEach(rule => {
    const item = document.createElement('div');
    item.className = `rule-check-item${rule.checked ? ' checked' : ''}`;
    item.innerHTML = `
      <div class="rule-check-box">
        ${rule.checked ? checkmark() : ''}
      </div>
      <span class="rule-check-text"></span>`;
    (item.querySelector('.rule-check-text') as HTMLElement).textContent = rule.text;

    item.addEventListener('click', () => {
      rule.checked = !rule.checked;
      item.classList.toggle('checked', rule.checked);
      const box = item.querySelector('.rule-check-box') as HTMLElement;
      box.innerHTML = rule.checked ? checkmark() : '';
      (item.querySelector('.rule-check-text') as HTMLElement).style.textDecoration =
        rule.checked ? 'line-through' : '';
      persistSession();
    });

    checklist.appendChild(item);
  });
}

function checkmark(): string {
  return `<svg viewBox="0 0 12 12" fill="none">
    <path d="M2 6l3 3 5-5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ─── Quality Indicator ────────────────────────────────────────────────────────

function showQualityIndicator(data: RecordingData): void {
  el('quality-indicator')?.remove();

  const div = document.createElement('div');
  div.id        = 'quality-indicator';
  div.className = 'quality-indicator';

  const hasMic = data.transcript?.length > 0;
  const micBadge = hasMic
    ? '<span class="quality-item quality-ok">🎤 Mic: ✓ Audio captured</span>'
    : '<span class="quality-item quality-warn">🎤 Mic: No audio detected</span>';

  div.innerHTML = `
    <span class="quality-item">⏱ ${formatTime(data.duration)}</span>
    <span class="quality-item">&nbsp;·&nbsp;</span>
    <span class="quality-item">${formatSize(data.size)}</span>
    <span class="quality-item">&nbsp;·&nbsp;</span>
    <span class="quality-item">${(data.extension || 'MP4').toUpperCase()}</span>
    <span class="quality-item">&nbsp;·&nbsp;</span>
    ${micBadge}`;

  const statsRow = document.querySelector('.stats-row');
  statsRow?.parentNode?.insertBefore(div, statsRow.nextSibling);
}

// ─── Severity Counter ─────────────────────────────────────────────────────────

function updateSeverityCounter(): void {
  const counter = el('severity-counter');
  if (!counter) return;

  if (!annotations.length) { counter.style.display = 'none'; return; }

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  annotations.forEach(a => { counts[a.severity]++; });

  counter.style.display = 'flex';
  (['critical', 'high', 'medium', 'low'] as const).forEach(sev => {
    const sevEl = el('sev-' + sev);
    if (sevEl) {
      (sevEl.querySelector('.sev-num') as HTMLElement).textContent = String(counts[sev]);
      sevEl.style.opacity = counts[sev] > 0 ? '1' : '0.35';
    }
  });
}

// ─── Video Player ─────────────────────────────────────────────────────────────

function getVideoDuration(video: HTMLVideoElement, fallback: number): number {
  if (video.seekable?.length > 0) {
    const d = video.seekable.end(video.seekable.length - 1);
    if (isFinite(d) && d > 0) return d;
  }
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  return fallback || 0;
}

function initVideo(url: string, data: RecordingData): void {
  const video = el<HTMLVideoElement>('rv');
  if (!video) return;

  video.src = url;

  video.addEventListener('loadedmetadata', () => {
    el('overlay-loading')?.style.setProperty('display', 'none');
    el('video-wrap')?.style.setProperty('display', 'block');
    el('video-info')?.style.setProperty('display', 'flex');
    setupVideoControls(video, data);
  }, { once: true });

  video.addEventListener('error', () => {
    showError('Video could not be played in the browser. Click "Download Recording" and open the file in VLC.');
  }, { once: true });
}

function setupVideoControls(video: HTMLVideoElement, data: RecordingData): void {
  const playBtn  = el('vc-play');
  const playIcon = el('play-icon');
  const timeEl   = el('vc-time');
  const fillEl   = el('vc-fill');
  const barEl    = el('vc-bar');
  const muteBtn  = el('vc-mute');
  const fsBtn    = el('vc-fs');

  if (!playBtn) return;

  function updateTime(): void {
    const current  = isNaN(video.currentTime) ? 0 : video.currentTime;
    const duration = getVideoDuration(video, data.duration);
    if (timeEl) timeEl.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    if (fillEl && duration > 0) fillEl.style.width = ((current / duration) * 100) + '%';
  }

  playBtn.addEventListener('click', () => {
    if (video.paused) {
      video.play().catch(e => console.warn('[QA] play:', e));
      if (playIcon) playIcon.innerHTML = `
        <rect x="5" y="4" width="3" height="12" rx="1.5" fill="currentColor"/>
        <rect x="12" y="4" width="3" height="12" rx="1.5" fill="currentColor"/>`;
    } else {
      video.pause();
      if (playIcon) playIcon.innerHTML = `<path d="M7 5l9 5-9 5V5z" fill="currentColor"/>`;
    }
  });

  video.addEventListener('ended', () => {
    if (playIcon) playIcon.innerHTML = `<path d="M7 5l9 5-9 5V5z" fill="currentColor"/>`;
  });

  ['timeupdate', 'loadedmetadata', 'durationchange', 'progress'].forEach(event => {
    video.addEventListener(event, updateTime);
  });

  barEl?.addEventListener('click', (e: MouseEvent) => {
    const duration = getVideoDuration(video, data.duration);
    if (!duration) return;
    const rect = barEl.getBoundingClientRect();
    const time = ((e.clientX - rect.left) / rect.width) * duration;
    if (isFinite(time)) { try { video.currentTime = time; } catch { /* ignore */ } }
  });

  let muted = false;
  muteBtn?.addEventListener('click', () => {
    muted       = !muted;
    video.muted = muted;
    const volIcon = el('vol-icon');
    if (volIcon) {
      volIcon.innerHTML = muted
        ? `<path d="M5 7H2v6h3l5 4V3L5 7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" opacity=".3"/>
           <line x1="13" y1="8" x2="18" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
           <line x1="18" y1="8" x2="13" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`
        : `<path d="M5 7H2v6h3l5 4V3L5 7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
           <path d="M14.5 6.5a5 5 0 010 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`;
    }
  });

  fsBtn?.addEventListener('click', () => {
    const wrap = el('video-wrap');
    if (!document.fullscreenElement) wrap?.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });
}

// ─── Receive Recording Data ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RECORDING_DATA' && msg.data) {
    recordingData = msg.data as RecordingData;
    blobURL       = recordingData.blobURL;

    if (!blobURL) {
      showError('No blob URL received.');
      sendResponse({ ok: false });
      return true;
    }

    // Seed with any bugs marked via Quick Bug (Alt+B) during recording
    if (recordingData.annotations?.length) {
      annotations.push(...recordingData.annotations);
      renderAnnotations();
      updateSeverityCounter();
    }

    fillMeta(recordingData);
    initVideo(blobURL, recordingData);
    showQualityIndicator(recordingData);

    // Load screenshots from data, falling back to session storage
    const initialShots = recordingData.screenshots || [];
    if (initialShots.length > 0) {
      renderScreenshots(initialShots);
    } else {
      chrome.storage.session.get(['qa_screenshots'], result => {
        const shots = result['qa_screenshots'] as Screenshot[] || [];
        if (shots.length > 0) {
          const indexed = shots.map((s, i) => ({ ...s, index: i + 1 }));
          if (recordingData) recordingData.screenshots = indexed;
          renderScreenshots(indexed);
        }
      });
    }

    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Show error if recorder tab never sends data within 20 seconds
setTimeout(() => {
  const video = el<HTMLVideoElement>('rv');
  if (!video?.src) {
    showError('No recording received. The recorder tab may have been closed. Please try again and keep the recorder tab open until you download.');
  }
}, 20_000);

// ─── Groq Transcription ───────────────────────────────────────────────────────

function setTranscriptStatus(message: string, state: 'loading' | 'ok' | 'warn' | ''): void {
  const bar      = el('whisper-status');
  const text     = el('whisper-status-text');
  const spinner  = el('whisper-spinner');
  const iconOk   = el('whisper-icon-ok');
  const iconWarn = el('whisper-icon-warn');

  if (bar)      { bar.style.display = 'flex'; bar.className = `whisper-status${state ? ' ' + state : ''}`; }
  if (text)     text.textContent    = message;
  if (spinner)  spinner.style.display  = state === 'loading' ? 'block' : 'none';
  if (iconOk)   iconOk.style.display   = state === 'ok'      ? 'block' : 'none';
  if (iconWarn) iconWarn.style.display = state === 'warn'    ? 'block' : 'none';
}

function hideTranscriptStatus(): void {
  el('whisper-status')?.style.setProperty('display', 'none');
}

function renderTranscriptList(
  segments   : TranscriptEntry[],
  source     : 'whisper' | 'sr',
  sourceLabel?: string
): void {
  const list = el('t-list');
  if (!list) return;

  // Update source badge
  const badge = el('transcript-source-badge');
  if (badge) {
    if (source === 'whisper') {
      badge.className = 'source-badge sb-whisper';
      badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none">
        <path d="M5 10l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>${sourceLabel || 'Whisper AI'}`;
    } else {
      badge.className = 'source-badge sb-sr';
      badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none">
        <path d="M10 2l1.5 5.5L17 9l-5.5 1.5L10 16l-1.5-5.5L3 9l5.5-1.5L10 2z" fill="currentColor"/>
      </svg>Live (Web Speech)`;
    }
    badge.style.display = 'block';
  }

  list.innerHTML = '';

  segments.forEach(entry => {
    const row = document.createElement('div');
    row.className = 't-row';
    row.innerHTML = `
      <span class="t-ts t-ts-link" title="Click to seek to ${formatTime(entry.ts)}">
        ${formatTime(entry.ts)}
      </span>
      <span class="t-text"></span>`;

    const text = entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
    (row.querySelector('.t-text') as HTMLElement).textContent = text;

    // Click timestamp → seek video to that second
    row.querySelector('.t-ts')?.addEventListener('click', () => {
      const video = el<HTMLVideoElement>('rv');
      if (video && isFinite(entry.ts)) {
        video.currentTime = entry.ts;
        video.play().catch(() => {});
      }
    });

    list.appendChild(row);
  });
}


async function transcribeWithGroq(): Promise<void> {
  if (!blobURL) { alert('Recording not ready yet. Please wait for the video to load.'); return; }

  const btn     = el<HTMLButtonElement>('btn-whisper');
  const btnText = el('whisper-btn-text');
  if (btn)     btn.disabled       = true;
  if (btnText) btnText.textContent = 'Transcribing…';

  const langNames: Record<string, string> = { en: 'English', fr: 'French', ar: 'Arabic' };

  // Fetch audio blob
  setTranscriptStatus('Preparing audio…', 'loading');
  let audioBlob: Blob;
  try {
    audioBlob = await fetch(blobURL).then(r => r.blob());
  } catch {
    setTranscriptStatus('Could not read recording. Try downloading the file first.', 'warn');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Groq';
    return;
  }

  if (audioBlob.size > Config.groq.maxFileSizeBytes) {
    setTranscriptStatus('Recording is too large for Groq (max 25 MB). Try a shorter session.', 'warn');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Groq';
    return;
  }

  // Send the raw recording directly to Groq.
  // We tried extracting audio via Web Audio API first but that resamples
  // the audio and compresses/stretches it, making Groq timestamps wrong.
  // Groq handles MP4/WebM natively and returns timestamps relative to the
  // start of the file — which matches the video timeline exactly.
  const ext      = recordingData?.extension || 'webm';
  const mimeType = ext === 'mp4' ? 'video/mp4' : 'video/webm';

  const form = new FormData();
  form.append('file', new File([audioBlob], `recording.${ext}`, { type: mimeType }));
  form.append('model', Config.groq.model);
  form.append('language', selectedLang);
  form.append('response_format', 'verbose_json');
  // Request word-level timestamps — Groq aligns them to the actual audio
  // waveform, which gives us much more precise seek positions than segments
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');

  setTranscriptStatus(
    `Sending to Groq AI (${langNames[selectedLang] || selectedLang}, ${formatSize(audioBlob.size)})…`,
    'loading'
  );

  try {
    const response = await fetch(Config.groq.url, {
      method : 'POST',
      headers: { 'Authorization': 'Bearer ' + Config.groq.apiKey },
      body   : form,
      signal : AbortSignal.timeout(Config.groq.timeoutMs),
    });

    if (!response.ok) {
      const err    = await response.json().catch(() => ({})) as any;
      const errMsg = err?.error?.message || `Groq error ${response.status}`;
      throw new Error(errMsg);
    }

    const result = await response.json() as any;

    // Groq returns both segment-level and word-level timestamps.
    // Word timestamps are aligned to the actual audio waveform so they are
    // more precise. For each segment we use the start time of its first word
    // as the seek position — this is what the user actually hears first.
    const wordTimings: Record<number, number> = {};
    (result.words || []).forEach((w: any, i: number) => {
      // Map each word to its segment by approximate position
      wordTimings[i] = parseFloat(w.start) || 0;
    });

    // Build a flat list of words so we can find the first word of each segment
    const allWords: any[] = result.words || [];
    let wordCursor = 0;

    const segments: TranscriptEntry[] = (result.segments || [])
      .filter((s: any) => s.text?.trim().length > 2)
      .map((s: any) => {
        const segmentStart = parseFloat(s.start) || 0;
        const segmentEnd   = parseFloat(s.end)   || 0;
        const segmentText  = s.text.trim();

        // Find the first word in this segment's time range
        // Word timestamps are more accurate than segment timestamps
        let preciseStart = segmentStart;
        for (let i = wordCursor; i < allWords.length; i++) {
          const wordStart = parseFloat(allWords[i].start) || 0;
          const wordEnd   = parseFloat(allWords[i].end)   || 0;
          if (wordStart >= segmentStart - 0.5 && wordEnd <= segmentEnd + 0.5) {
            preciseStart = wordStart; // use first word's timestamp
            wordCursor   = i;
            break;
          }
        }

        return {
          ts  : preciseStart,
          end : segmentEnd,
          text: segmentText,
        };
      });

    if (!segments.length) {
      setTranscriptStatus('Groq found no speech. Check that microphone was enabled.', 'warn');
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = 'Try Again';
      return;
    }

    // Update transcript and persist
    whisperDone = true;
    if (recordingData) recordingData.transcript = segments;
    await persistSession();

    const sourceLabel = `✓ Groq Cloud (${Config.groq.model})`;
    renderTranscriptList(segments, 'whisper', sourceLabel);
    hideTranscriptStatus();
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '✓ Transcribed';

    setTranscriptStatus(`${sourceLabel} — ${segments.length} segment${segments.length !== 1 ? 's' : ''}`, 'ok');
    setTimeout(hideTranscriptStatus, 3000);

  } catch (e: any) {
    console.error('[QA Groq]', e);
    const msg = e.name === 'TimeoutError'
      ? 'Groq timed out. Recording may be too long. Try a shorter session.'
      : 'Groq error: ' + e.message;
    setTranscriptStatus(msg, 'warn');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Groq';
  }
}

// ─── Report Text Builder ──────────────────────────────────────────────────────

async function buildReportText(): Promise<string> {
  const d    = recordingData;
  const tr   = d?.transcript;
  const priorityLabels: Record<string, string> = {
    critical: 'P1 Critical', high: 'P2 High', medium: 'P3 Medium', low: 'P4 Low',
  };

  // Fetch page notes from storage
  interface Note { text: string; ts: number; }
  let pageNotes: Note[] = [];
  try {
    const stored = await new Promise<Record<string, Note[]>>(resolve => {
      chrome.storage.local.get(['qa_notes'], r => resolve(r['qa_notes'] as Record<string, Note[]> || {}));
    });
    pageNotes = Object.values(stored).flat().sort((a, b) => a.ts - b.ts);
  } catch { /* storage may not be available */ }

  const lines: string[] = [];
  lines.push('===========================================');
  lines.push('   QA Smart Assistant - Session Report');
  lines.push('===========================================');
  lines.push('');
  lines.push(`Session     : ${d?.title     || 'QA Session'}`);
  lines.push(`Tester      : ${d?.tester    || 'Tester'}`);
  lines.push(`Date        : ${new Date(d?.timestamp || Date.now()).toLocaleString()}`);
  lines.push(`Duration    : ${formatTime(d?.duration || 0)}`);
  if (d?.priority)    lines.push(`Priority    : ${priorityLabels[d.priority] || d.priority}`);
  if (d?.layer)       lines.push(`Layer       : ${d.layer}`);
  if (d?.environment) lines.push(`Environment : ${d.environment}`);
  if (d?.testType)    lines.push(`Test Type   : ${d.testType}`);
  if (d?.sprint)      lines.push(`Sprint      : ${d.sprint}`);
  if (d?.tags?.length) lines.push(`Tags        : ${d.tags.join(', ')}`);
  lines.push('');

  if (pageNotes.length) {
    lines.push('-------------------------------------------');
    lines.push('  PAGE NOTES');
    lines.push('-------------------------------------------');
    pageNotes.forEach(n => lines.push(`  ${n.text}`));
    lines.push('');
  }

  if (d?.rules?.length) {
    lines.push('-------------------------------------------');
    lines.push('  TEST RULES');
    lines.push('-------------------------------------------');
    d.rules.forEach(r => lines.push(`  ${r.checked ? '[x]' : '[ ]'} ${r.text}`));
    const completed = d.rules.filter(r => r.checked).length;
    lines.push(`  Completed: ${completed}/${d.rules.length}`);
    lines.push('');
  }

  if (annotations.length) {
    lines.push('-------------------------------------------');
    lines.push('  BUG ANNOTATIONS');
    lines.push('-------------------------------------------');
    annotations.forEach(a => {
      lines.push(`  [${formatTime(a.ts)}] [${a.severity.toUpperCase()}] ${a.text}`);
    });
    lines.push('');
  }

  const shots = d?.screenshots || [];
  if (shots.length) {
    lines.push('-------------------------------------------');
    lines.push(`  SCREENSHOTS (${shots.length} captured)`);
    lines.push('-------------------------------------------');
    lines.push('  See screenshots/ folder in the ZIP bundle.');
    lines.push('');
  }

  lines.push('-------------------------------------------');
  lines.push('  VOICE TRANSCRIPT');
  lines.push('-------------------------------------------');
  lines.push('');
  if (tr?.length) {
    tr.forEach((entry, i) => {
      const text = entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
      lines.push(`[${formatTime(entry.ts)}]  ${text}`);
      if (i < tr.length - 1) lines.push('');
    });
    lines.push('');
    lines.push(`Total entries: ${tr.length}`);
  } else {
    lines.push('(No voice notes were recorded for this session)');
  }

  lines.push('');
  lines.push('Generated by QA Smart Assistant');
  lines.push('===========================================');

  return lines.join('\n');
}

// ─── Session Manifest Builder (session.json for the skill package) ───────────

/**
 * Build the structured session.json that ships inside the ZIP package.
 * This is the single source of truth an AI agent reads first — see
 * static/skill-template/QA-REPORT-SKILL.md for how it's consumed.
 */
function buildSessionManifest(): QaSessionManifest {
  const d = recordingData;

  // Screenshots store an absolute capture time (ms epoch), not a video-relative
  // timestamp, so we label them by capture order rather than guessing a time.
  const screenshotEntries = (d?.screenshots || []).map((s, i) => ({
    file     : `screenshots/screenshot-${String(s.index || i + 1).padStart(3, '0')}.png`,
    timestamp: '',
  }));

  return {
    id            : d?.sessionId || (Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
    schemaVersion : 1,
    title         : d?.title  || 'QA Session',
    tester        : d?.tester || 'Tester',
    createdAt     : new Date(d?.timestamp || Date.now()).toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }),
    createdAtIso  : new Date(d?.timestamp || Date.now()).toISOString(),
    durationSec   : Math.round(d?.duration || 0),
    priority      : d?.priority    || 'medium',
    layer         : d?.layer       || '',
    environment   : d?.environment || '',
    testType      : d?.testType    || '',
    sprint        : d?.sprint      || '',
    tags          : d?.tags || [],
    rules         : (d?.rules || []).map(r => ({ text: r.text, checked: r.checked })),
    annotations   : annotations.map(a => ({
      timestamp: formatTime(a.ts),
      severity : a.severity,
      text     : a.text,
    })),
    transcript    : (d?.transcript || []).map(t => ({
      timestamp: formatTime(t.ts),
      text     : t.text,
    })),
    screenshots   : screenshotEntries,
    hasRecording  : !!blobURL,
    hasScreenshots: (d?.screenshots || []).length > 0,
    hasTranscript : (d?.transcript  || []).length > 0,
    recordingFile : blobURL ? `recording.${d?.extension || 'webm'}` : undefined,
  };
}

// ─── Downloads ────────────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadReport(): Promise<void> {
  const text = await buildReportText();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, (recordingData?.title || 'QA_Session') + '_report.txt');
}

/**
 * Download the full QA session as a structured ZIP package — modeled after
 * the "brief" pattern: one clean session.json, the recording, screenshots,
 * and a skill/ folder containing the exact instructions an AI agent (or a
 * human) should follow to turn this package into a professional report.
 *
 * Layout:
 *   <title>/
 *     README.md
 *     session.json
 *     recording.<ext>           (if a recording exists)
 *     screenshots/
 *       screenshot-001.png ...
 *     skill/
 *       QA-REPORT-SKILL.md
 *       playbooks/report.md
 *     <title>_report.txt        (human-readable plain text, kept for convenience)
 *     <title>_AI_Report.txt     (if an AI report was already generated)
 */
async function downloadZipBundle(): Promise<void> {
  const btn     = el<HTMLButtonElement>('btn-zip');
  const btnText = el('zip-btn-text');

  if (!recordingData) { alert('Recording not ready yet.'); return; }
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Building package…';

  try {
    const JSZip = (window as any).JSZip;
    if (!JSZip) { alert('JSZip library not loaded.'); return; }

    const zip       = new JSZip();
    const titleSlug = (recordingData.title || 'QA_Session').replace(/[^a-zA-Z0-9_-]/g, '_');
    const root      = zip.folder(titleSlug)!;
    const ext       = recordingData.extension || 'webm';

    // 1. session.json — the single source of truth for any AI agent reading this package
    if (btnText) btnText.textContent = 'Writing session.json…';
    const manifest = buildSessionManifest();
    root.file('session.json', JSON.stringify(manifest, null, 2));

    // 2. README — same idea as Brief's root README, explains the package to a human or AI
    root.file('README.md', README_MD);

    // 3. Recording
    if (blobURL) {
      if (btnText) btnText.textContent = 'Adding recording…';
      const videoBlob = await fetch(blobURL).then(r => r.blob());
      root.file(`recording.${ext}`, videoBlob);
    }

    // 4. Screenshots — numbered to match session.json's screenshots[].file entries
    const shots = recordingData.screenshots || [];
    if (shots.length) {
      if (btnText) btnText.textContent = `Adding ${shots.length} screenshots…`;
      const shotsFolder = root.folder('screenshots')!;
      for (let i = 0; i < shots.length; i++) {
        const shot     = shots[i];
        const shotBlob = await fetch(shot.dataUrl).then(r => r.blob());
        const numbered = String(shot.index || i + 1).padStart(3, '0');
        shotsFolder.file(`screenshot-${numbered}.png`, shotBlob);
      }
    }

    // 5. Skill folder — the instructions that make any AI agent generate a
    //    strong, consistently-structured report from this package
    if (btnText) btnText.textContent = 'Writing skill instructions…';
    const skillFolder = root.folder('skill')!;
    skillFolder.file('QA-REPORT-SKILL.md', SKILL_MD);
    skillFolder.folder('playbooks')!.file('report.md', REPORT_PLAYBOOK_MD);

    // 6. Human-readable plain text report (kept for convenience / quick reading)
    if (btnText) btnText.textContent = 'Adding text report…';
    root.file(`${titleSlug}_report.txt`, await buildReportText());

    // 7. AI report, if one was already generated in this session
    const aiReport = (window as any).__qa_ai_report__ as string | undefined;
    if (aiReport) root.file(`${titleSlug}_AI_Report.txt`, aiReport);

    // 8. Generate and download
    if (btnText) btnText.textContent = 'Compressing…';
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(zipBlob, `${titleSlug}_qa_package.zip`);

    if (btnText) btnText.textContent = '✓ Downloaded!';
    setTimeout(() => { if (btnText) btnText.textContent = 'Download ZIP Bundle'; }, 3000);

  } catch (e: any) {
    console.error('[QA ZIP]', e);
    alert('ZIP creation failed: ' + e.message);
    if (btnText) btnText.textContent = 'Download ZIP Bundle';
  }

  if (btn) btn.disabled = false;
}

/* ══════════════════════════════════════════════════════════
   AI REPORT GENERATION — Ollama (local LLM)

   Flow:
   1. Check Ollama is running at localhost:11434
   2. Build a rich structured prompt from all session data
   3. Stream the response token by token into the panel
   4. User can copy or download the finished report
══════════════════════════════════════════════════════════ */

/** Build the full QA report prompt from all session data */
/* ══════════════════════════════════════════════════════════
   AI REPORT GENERATION — shared skill-based prompt
   for both Ollama (local) and Gemini (cloud)

   The same instructions an AI agent would read from the exported
   ZIP's skill/ folder are sent directly as the prompt here — see
   static/skill-template/ for the source of truth on these rules.
══════════════════════════════════════════════════════════ */

/**
 * Build the full prompt: the skill instructions + the report playbook +
 * the session.json content, formatted as plain text. This is what both
 * Ollama and Gemini receive — identical rules either engine reads.
 */
function buildSkillPrompt(): string {
  const manifest = buildSessionManifest();
  const sessionJson = JSON.stringify(manifest, null, 2);

  const sections: string[] = [
    SKILL_MD,
    '',
    '================================================',
    'PLAYBOOK: skill/playbooks/report.md',
    '================================================',
    REPORT_PLAYBOOK_MD,
    '',
    '================================================',
    'SESSION DATA: session.json',
    '================================================',
    sessionJson,
    '',
    '================================================',
    'Now write the complete report. Follow the playbook structure exactly.',
    'Do not include this instruction block in your output.',
    'Start directly with the EXECUTIVE SUMMARY section header.',
    '================================================',
  ];

  return sections.join('\n');
}

/** Style the report text — detect section headers and add CSS classes */
function renderAiReport(text: string): void {
  const container = document.getElementById('ai-report-content');
  if (!container) return;

  const SECTION_HEADERS = [
    'EXECUTIVE SUMMARY', 'SESSION INFORMATION', 'TEST COVERAGE ANALYSIS',
    'BUG REPORT', 'TESTER OBSERVATIONS', 'RISK ASSESSMENT',
    'RECOMMENDATIONS', 'CONCLUSION',
  ];

  const out: string[] = [];
  text.split('\n').forEach(line => {
    const t         = line.trim();
    const isDivider = /^[=\-]{10,}$/.test(t);
    const isHeader  = SECTION_HEADERS.includes(t);

    if (isDivider) {
      out.push('<hr class="ai-divider"/>');
    } else if (isHeader) {
      out.push('<span class="ai-heading">' + t + '</span>');
    } else {
      const safe = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      out.push(safe);
    }
  });

  container.innerHTML = out.join('\n');
}

/** Show a status message inside the AI panel */
function setAiStatus(msg: string, loading = false): void {
  const statusEl = document.getElementById('ai-report-status');
  if (!statusEl) return;
  statusEl.style.display = msg ? 'flex' : 'none';
  statusEl.innerHTML = loading
    ? '<div class="ai-spinner"></div>' + msg
    : msg;
}

/** Check Ollama is reachable before trying to generate */
async function checkOllamaHealth(): Promise<{ok: boolean; models: string[]}> {
  try {
    const res = await fetch(Config.ollama.healthUrl, {signal: AbortSignal.timeout(3000)});
    if (!res.ok) return {ok: false, models: []};
    const json = await res.json() as any;
    const models = ((json.models || []) as any[]).map((m: any) => m.name as string);
    return {ok: true, models};
  } catch {
    return {ok: false, models: []};
  }
}

/** Generate AI report using Ollama — streams response token by token */
async function generateAiReportOllama(): Promise<void> {
  const btn     = document.getElementById('btn-ai') as HTMLButtonElement | null;
  const btnText = document.getElementById('ai-btn-text');
  const panel   = document.getElementById('ai-report-panel');
  const content = document.getElementById('ai-report-content');
  const badge   = document.getElementById('ai-model-badge');

  if (!recordingData) {
    alert('Recording not ready. Please wait for the video to load.');
    return;
  }

  if (btn)     btn.disabled        = true;
  if (btnText) btnText.textContent = 'Checking Ollama...';
  if (panel)   panel.style.display = 'flex';
  if (content) content.innerHTML   = '';
  panel?.scrollIntoView({behavior: 'smooth', block: 'start'});

  setAiStatus('Connecting to Ollama at localhost:11434...', true);
  const health = await checkOllamaHealth();

  if (!health.ok) {
    setAiStatus('');
    if (content) content.innerHTML =
      '<div style="color:#EF4444;font-size:12.5px;line-height:1.7;">' +
      '<strong>Ollama is not running.</strong><br>' +
      'Please start it by opening a terminal and running:<br>' +
      '<code style="background:rgba(0,0,0,.1);padding:2px 6px;border-radius:4px;">ollama serve</code><br><br>' +
      'Then try again.' +
      '</div>';
    if (btnText) btnText.textContent = 'Try Again';
    if (btn)     btn.disabled        = false;
    return;
  }

  const modelName  = Config.ollama.model;
  const modelReady = health.models.some(m => m.startsWith(modelName.split(':')[0]));

  if (!modelReady) {
    setAiStatus('');
    if (content) content.innerHTML =
      '<div style="color:#F59E0B;font-size:12.5px;line-height:1.7;">' +
      '<strong>Model not found: ' + modelName + '</strong><br>' +
      'Please run this in your terminal:<br>' +
      '<code style="background:rgba(0,0,0,.1);padding:2px 6px;border-radius:4px;">ollama pull ' + modelName + '</code><br><br>' +
      'Available models: ' + (health.models.join(', ') || 'none') +
      '</div>';
    if (btnText) btnText.textContent = 'Try Again';
    if (btn)     btn.disabled        = false;
    return;
  }

  if (badge) badge.textContent = modelName;
  setAiStatus('Generating report with ' + modelName + ' using the QA report skill — this takes 30-90 seconds...', true);
  if (btnText) btnText.textContent = 'Generating...';

  const prompt = buildSkillPrompt();

  try {
    const response = await fetch(Config.ollama.url, {
      method : 'POST',
      headers: {'Content-Type': 'application/json'},
      body   : JSON.stringify({
        model : modelName,
        prompt,
        stream: true,
        options: {
          temperature   : 0.3,
          num_predict   : 2048,
          top_p         : 0.85,
          repeat_penalty: 1.1,
        },
      }),
      signal: AbortSignal.timeout(Config.ollama.timeoutMs),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error('Ollama error ' + response.status + ': ' + err);
    }

    if (!response.body) throw new Error('No response stream from Ollama');

    setAiStatus('Streaming response...', true);
    let fullText  = '';
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as any;
          if (chunk.response) {
            fullText += chunk.response;
            if (content) content.textContent = fullText;
          }
          if (chunk.done) break;
        } catch { /* skip malformed chunks */ }
      }
    }

    if (!fullText.trim()) throw new Error('Ollama returned an empty response. Try again.');

    (window as any).__qa_ai_report__ = fullText;
    renderAiReport(fullText);
    setAiStatus('');

    if (btnText) btnText.textContent = 'Report Ready';
    setTimeout(() => {
      if (btnText) btnText.textContent = 'Regenerate Report';
      if (btn)     btn.disabled        = false;
    }, 3000);

  } catch (e: any) {
    console.error('[QA Ollama]', e);
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    const msg = isTimeout
      ? 'Timed out. The model may be too slow. Try restarting Ollama or use a smaller model.'
      : 'Error: ' + (e.message || 'Unknown error');

    setAiStatus('');
    if (content) content.innerHTML =
      '<div style="color:#EF4444;font-size:12.5px;">' + msg + '</div>';
    if (btnText) btnText.textContent = 'Try Again';
    if (btn)     btn.disabled        = false;
  }
}

/** Convert a screenshot data URL to the Gemini API image part format */
function dataUrlToGeminiPart(dataUrl: string): {inlineData: {mimeType: string; data: string}} {
  const [header, data] = dataUrl.split(',');
  const mimeType = header.replace('data:', '').replace(';base64', '');
  return {inlineData: {mimeType, data}};
}

/** Generate AI report using Google Gemini — sends the skill prompt + screenshots, returns full report at once */
async function generateAiReportGemini(): Promise<void> {
  const btn     = document.getElementById('btn-ai') as HTMLButtonElement | null;
  const btnText = document.getElementById('ai-btn-text');
  const panel   = document.getElementById('ai-report-panel');
  const content = document.getElementById('ai-report-content');
  const badge   = document.getElementById('ai-model-badge');

  if (!recordingData) {
    alert('Recording not ready. Please wait for the video to load.');
    return;
  }

  if (btn)     btn.disabled        = true;
  if (btnText) btnText.textContent = 'Generating...';
  if (panel)   panel.style.display = 'flex';
  if (content) content.innerHTML   = '';
  if (badge)   badge.textContent   = Config.gemini.model;
  panel?.scrollIntoView({behavior: 'smooth', block: 'start'});

  setAiStatus('Sending the QA report skill and session package to Gemini...', true);

  try {
    const prompt = buildSkillPrompt();
    const parts: any[] = [{text: prompt}];

    const shots = (recordingData.screenshots || []) as Array<{dataUrl: string; timestamp: number; index?: number}>;
    if (shots.length > 0) {
      parts.push({text: 'Attached below are the ' + shots.length + ' screenshot(s) referenced in session.json, in order:'});
      shots.forEach((shot, i) => {
        parts.push({text: 'screenshots/screenshot-' + String(shot.index || i + 1).padStart(3, '0') + '.png:'});
        parts.push(dataUrlToGeminiPart(shot.dataUrl));
      });
    }

    const body = {
      contents: [{parts}],
      generationConfig: {temperature: 0.3, topP: 0.85, maxOutputTokens: 4096},
      safetySettings: [
        {category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE'},
        {category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE'},
        {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE'},
        {category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE'},
      ],
    };

    const url      = Config.gemini.url + '?key=' + Config.gemini.apiKey;
    const response = await fetch(url, {
      method : 'POST',
      headers: {'Content-Type': 'application/json'},
      body   : JSON.stringify(body),
      signal : AbortSignal.timeout(Config.gemini.timeoutMs),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as any;
      throw new Error(err?.error?.message || ('Gemini error ' + response.status));
    }

    const result    = await response.json() as any;
    const candidate = result?.candidates?.[0];
    if (!candidate) throw new Error('Gemini returned no response. Please try again.');

    const reportText = (candidate.content?.parts || [])
      .filter((p: any) => typeof p.text === 'string')
      .map((p: any) => p.text as string)
      .join('');

    if (!reportText.trim()) throw new Error('Gemini returned an empty report.');

    (window as any).__qa_ai_report__ = reportText;
    renderAiReport(reportText);
    setAiStatus('');

    if (btnText) btnText.textContent = 'Report Ready';
    setTimeout(() => {
      if (btnText) btnText.textContent = 'Regenerate Report';
      if (btn)     btn.disabled        = false;
    }, 3000);

  } catch (e: any) {
    console.error('[QA Gemini]', e);
    const msg = e.name === 'TimeoutError'
      ? 'Request timed out. Gemini may be busy — please try again.'
      : 'Error: ' + (e.message || 'Unknown error');

    setAiStatus('');
    if (content) content.innerHTML = '<div style="color:#EF4444;font-size:12.5px;">' + msg + '</div>';
    if (btnText) btnText.textContent = 'Try Again';
    if (btn)     btn.disabled        = false;
  }
}

/** Entry point — dispatches to Ollama or Gemini based on Config.aiProvider */
async function generateAiReport(): Promise<void> {
  if (Config.aiProvider === 'gemini') {
    await generateAiReportGemini();
  } else {
    await generateAiReportOllama();
  }
}


function exportPDF(): void {
  const tList = document.querySelector<HTMLElement>('.t-list');
  const savedMaxHeight = tList?.style.maxHeight || '';
  if (tList) tList.style.maxHeight = 'none';

  window.print();

  if (tList) tList.style.maxHeight = savedMaxHeight;
}

// ─── Connectors ───────────────────────────────────────────────────────────────

// ─── Connectors ───────────────────────────────────────────────────────────────

/**
 * Build the three structured fields for the ClickUp task description.
 *
 * Strategy:
 * - If an AI report was already generated in this session, parse the three
 *   fields from its section text — richer, more readable.
 * - Otherwise fall back to a deterministic build from raw session data —
 *   always available, consistent, slightly more mechanical.
 */
function buildClickUpFields(): { description: string; expected: string; actual: string } {
  const d  = recordingData;
  const ai = (window as any).__qa_ai_report__ as string | undefined;

  if (ai) {
    const extract = (from: string, to: string): string => {
      const lines  = ai.split('\n');
      let   inside = false;
      const out: string[] = [];
      for (const line of lines) {
        const t = line.trim();
        if (t === from) { inside = true; continue; }
        if (inside && (t === to || /^[=\-]{10,}$/.test(t))) break;
        if (inside && t) out.push(line);
      }
      return out.join('\n').trim();
    };

    const description = extract('EXECUTIVE SUMMARY',     'SESSION INFORMATION');
    const expected    = extract('TEST COVERAGE ANALYSIS', 'BUG REPORT');
    const actual      = [
      extract('BUG REPORT',          'TESTER OBSERVATIONS'),
      extract('TESTER OBSERVATIONS',  'RISK ASSESSMENT'),
    ].filter(Boolean).join('\n\n').trim();

    if (description && expected && actual) {
      return { description, expected, actual };
    }
  }

  // ── Deterministic build ────────────────────────────────────────────────────
  const priorityLabels: Record<string, string> = {
    critical: 'P1 - Critical (Urgent)',
    high    : 'P2 - High',
    medium  : 'P3 - Medium (Normal)',
    low     : 'P4 - Low',
  };

  const rules       = d?.rules || [];
  const passedRules = rules.filter(r =>  r.checked);
  const failedRules = rules.filter(r => !r.checked);
  const bugCount    = annotations.length;

  // ── DESCRIPTION ───────────────────────────────────────────────────────────
  const descLines: string[] = [
    '--- Session Info ---',
    'Session    : ' + (d?.title  || 'QA Session'),
    'Tester     : ' + (d?.tester || 'Unknown'),
    'Date       : ' + new Date(d?.timestamp || Date.now()).toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }),
    'Duration   : ' + formatTime(d?.duration || 0),
    'Priority   : ' + (priorityLabels[d?.priority || ''] || 'P3 - Medium (Normal)'),
    d?.layer       ? ('Layer      : ' + d.layer)       : '',
    d?.environment ? ('Environment: ' + d.environment) : '',
    d?.testType    ? ('Test Type  : ' + d.testType)    : '',
    d?.sprint      ? ('Sprint     : ' + d.sprint)      : '',
    d?.tags?.length ? ('Tags       : ' + d.tags.join(', ')) : '',
  ].filter(Boolean);

  if (passedRules.length > 0) {
    descLines.push('', '--- Verified and Passing ---');
    passedRules.forEach(r => descLines.push('  ' + String.fromCharCode(10003) + ' ' + r.text));
  }

  if (d?.transcript?.length) {
    descLines.push('', '--- Tester Voice Notes ---');
    d.transcript.forEach(t => descLines.push('  [' + formatTime(t.ts) + '] ' + t.text));
  }

  // ── EXPECTED OUTCOME ──────────────────────────────────────────────────────
  const expectedLines: string[] = [];
  if (rules.length > 0) {
    expectedLines.push('All ' + rules.length + ' test scenario' + (rules.length !== 1 ? 's' : '') + ' should pass without errors or UI issues:');
    expectedLines.push('');
    rules.forEach(r => expectedLines.push('  - ' + r.text));
  } else {
    expectedLines.push('All tested features should function correctly with no errors or UI issues.');
  }
  if (bugCount === 0 && failedRules.length === 0) {
    expectedLines.push('', 'No regressions or new issues should be introduced.');
  }

  // ── ACTUAL OUTCOME ────────────────────────────────────────────────────────
  const actualLines: string[] = [];

  if (bugCount > 0) {
    actualLines.push(bugCount + ' bug' + (bugCount !== 1 ? 's' : '') + ' annotated during the session:');
    actualLines.push('');
    annotations.forEach((a, i) => {
      actualLines.push('  Bug #' + (i + 1));
      actualLines.push('    Severity  : ' + a.severity.toUpperCase());
      actualLines.push('    Timestamp : [' + formatTime(a.ts) + ']');
      actualLines.push('    Issue     : ' + a.text);
      actualLines.push('');
    });
  }

  if (failedRules.length > 0) {
    if (actualLines.length) actualLines.push('');
    actualLines.push(failedRules.length + ' scenario' + (failedRules.length !== 1 ? 's' : '') + ' not tested in this session:');
    actualLines.push('');
    failedRules.forEach(r => actualLines.push('  - ' + r.text + '  [NOT TESTED]'));
    actualLines.push('');
    actualLines.push('These require a dedicated follow-up test session.');
  }

  if (bugCount === 0 && failedRules.length === 0) {
    actualLines.push('All test scenarios passed. No bugs were annotated.');
    actualLines.push('The feature appears stable and ready for the next testing phase.');
  }

  return {
    description: descLines.join('\n'),
    expected   : expectedLines.join('\n'),
    actual     : actualLines.join('\n'),
  };
}

function showConnectorStatus(message: string, type: 'ok' | 'err' | ''): void {
  const statusEl = el('connector-status');
  if (!statusEl) return;
  statusEl.style.display = 'block';
  statusEl.textContent   = message;
  statusEl.className     = `connector-status${type ? ' ' + type : ''}`;
  if (type === 'ok') setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
}

function buildTicketDescription(): string {
  // kept for Jira — combines all three fields into one flat description
  const { description, expected, actual } = buildClickUpFields();
  return [
    '--- DESCRIPTION ---',
    description,
    '',
    '--- EXPECTED OUTCOME ---',
    expected,
    '',
    '--- ACTUAL OUTCOME ---',
    actual,
  ].join('\n');
}

// ─── Jira connector ───────────────────────────────────────────────────────────

el('btn-jira')?.addEventListener('click', () => {
  chrome.storage.local.get(['qa_jira'], result => {
    const jira = result['qa_jira'] as Partial<JiraConfig> || {};
    if (!jira.url || !jira.token) {
      showConnectorStatus('Jira not configured. Go to the extension popup → Settings tab.', 'err');
      return;
    }
    el<HTMLInputElement>('jira-summary').value     = `[QA] ${recordingData?.title || 'QA Session'} - Bug Report`;
    el<HTMLTextAreaElement>('jira-desc').value     = buildTicketDescription();
    el('jira-modal').style.display = 'block';
  });
});

el('jira-modal-close')?.addEventListener('click', () => {
  el('jira-modal').style.display = 'none';
});

el('btn-jira-submit')?.addEventListener('click', async () => {
  const btn = el<HTMLButtonElement>('btn-jira-submit');
  btn.disabled     = true;
  btn.textContent  = 'Creating…';
  showConnectorStatus('Creating Jira ticket…', '');

  chrome.storage.local.get(['qa_jira'], async result => {
    const jira      = result['qa_jira'] as JiraConfig;
    const summary   = el<HTMLInputElement>('jira-summary').value.trim();
    const desc      = el<HTMLTextAreaElement>('jira-desc').value.trim();
    const issueType = el<HTMLSelectElement>('jira-issue-type').value;
    const priorityMap: Record<string, string> = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };
    const priority  = priorityMap[recordingData?.priority || ''] || 'Medium';

    try {
      const res = await fetch(`${jira.url}/rest/api/3/issue`, {
        method : 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${jira.email}:${jira.token}`),
          'Content-Type' : 'application/json',
          'Accept'       : 'application/json',
        },
        body: JSON.stringify({
          fields: {
            project    : { key: jira.project || 'QA' },
            summary,
            description: {
              type: 'doc', version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: desc }] }],
            },
            issuetype: { name: issueType },
            priority : { name: priority },
          },
        }),
      });

      const json = await res.json() as any;
      if (res.ok && json.key) {
        showConnectorStatus(`✓ Jira ticket created: ${json.key}`, 'ok');
        el('jira-modal').style.display = 'none';
      } else {
        const errMsg = json.errors ? Object.values(json.errors).join(', ') : (json.message || 'Unknown error');
        showConnectorStatus(`Jira error: ${errMsg}`, 'err');
      }
    } catch (e: any) {
      showConnectorStatus(`Network error: ${e.message}`, 'err');
    }

    btn.disabled    = false;
    btn.textContent = 'Create Ticket';
  });
});

// ─── ClickUp connector ────────────────────────────────────────────────────────

el('btn-clickup')?.addEventListener('click', () => {
  chrome.storage.local.get(['qa_clickup'], result => {
    const cu = result['qa_clickup'] as Partial<ClickUpConfig> || {};
    if (!cu.token) {
      showConnectorStatus('ClickUp not configured. Go to the extension popup → Settings tab.', 'err');
      return;
    }

    // Fill the 3 structured fields
    const fields = buildClickUpFields();
    const hasAi  = !!(window as any).__qa_ai_report__;
    el<HTMLInputElement>('clickup-name').value            = `[QA] ${recordingData?.title || 'QA Session'} — Bug Report`;
    el<HTMLTextAreaElement>('clickup-field-description').value = fields.description;
    el<HTMLTextAreaElement>('clickup-field-expected').value    = fields.expected;
    el<HTMLTextAreaElement>('clickup-field-actual').value      = fields.actual;

    // Show/hide optional attachment options based on what exists
    const shots = recordingData?.screenshots || [];
    const aiNotice          = el('clickup-ai-notice');
    const aiOption          = el('attach-ai-option');
    const screenshotsOption = el('attach-screenshots-option');
    const screenshotsLabel  = el('attach-screenshots-label');

    if (aiNotice)          aiNotice.style.display          = hasAi ? 'block' : 'none';
    if (aiOption)          aiOption.style.display          = hasAi ? 'flex'  : 'none';
    if (screenshotsOption) screenshotsOption.style.display = shots.length ? 'flex' : 'none';
    if (screenshotsLabel)  screenshotsLabel.textContent    = `Screenshots (${shots.length})`;

    el('clickup-modal').style.display = 'block';
  });
});

el('clickup-modal-close')?.addEventListener('click', () => {
  el('clickup-modal').style.display = 'none';
});

el('btn-clickup-submit')?.addEventListener('click', async () => {
  const btn         = el<HTMLButtonElement>('btn-clickup-submit');
  const submitLabel = el('clickup-submit-label');
  const statusEl    = el('clickup-submit-status');

  btn.disabled = true;

  const setStatus = (msg: string) => {
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = msg; }
  };

  chrome.storage.local.get(['qa_clickup'], async result => {
    const cu     = result['qa_clickup'] as ClickUpConfig;
    const name   = el<HTMLInputElement>('clickup-name').value.trim();
    const descF  = el<HTMLTextAreaElement>('clickup-field-description').value.trim();
    const expF   = el<HTMLTextAreaElement>('clickup-field-expected').value.trim();
    const actF   = el<HTMLTextAreaElement>('clickup-field-actual').value.trim();

    // Build the final markdown-like description ClickUp renders
    const fullDesc = [
      '--- DESCRIPTION ---',
      descF,
      '',
      '--- EXPECTED OUTCOME ---',
      expF,
      '',
      '--- ACTUAL OUTCOME ---',
      actF,
    ].join('\n');

    // Map our priority to ClickUp's integer scale (1=Urgent, 2=High, 3=Normal, 4=Low)
    // ClickUp priority integers: 1=Urgent, 2=High, 3=Normal, 4=Low
    const priorityMap: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4 };
    const priority = priorityMap[recordingData?.priority || ''] || 3;

    // Tags — ClickUp API accepts tag names directly; they'll be created if they don't exist
    const tags = (recordingData?.tags || []).map((t: string) => ({ name: t }));

    if (submitLabel) submitLabel.textContent = 'Creating task…';
    setStatus('Creating ClickUp task…');

    try {
      // Step 1: Create the task with native fields
      const res = await fetch(`https://api.clickup.com/api/v2/list/${cu.listId}/task`, {
        method : 'POST',
        headers: { 'Authorization': cu.token, 'Content-Type': 'application/json' },
        body   : JSON.stringify({
          name,
          description: fullDesc,
          priority,
          tags,
          // status: 'to do',  // ClickUp default, set explicitly if needed
        }),
      });

      const json = await res.json() as any;
      if (!res.ok || !json.id) {
        showConnectorStatus(`ClickUp error: ${json.err || json.message || 'Unknown error'}`, 'err');
        if (submitLabel) submitLabel.textContent = 'Create Task';
        btn.disabled = false;
        return;
      }

      const taskId = json.id as string;

      // Step 2: Upload attachments the tester selected
      const attachErrors: string[] = [];

      /** Upload a single file blob to the task as an attachment */
      const uploadAttachment = async (fileBlob: Blob, filename: string): Promise<void> => {
        const form = new FormData();
        form.append('attachment', fileBlob, filename);
        try {
          const uploadRes = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
            method : 'POST',
            headers: { 'Authorization': cu.token },
            body   : form,
          });
          if (!uploadRes.ok) {
            const errJson = await uploadRes.json().catch(() => ({})) as any;
            attachErrors.push(`${filename}: ${errJson.err || uploadRes.status}`);
          }
        } catch (e: any) {
          attachErrors.push(`${filename}: ${e.message}`);
        }
      };

      const titleSlug = (recordingData?.title || 'QA_Session').replace(/[^a-zA-Z0-9_-]/g, '_');

      // Attach full report text
      if ((el<HTMLInputElement>('attach-report'))?.checked) {
        setStatus('Uploading report…');
        const reportText = await buildReportText();
        await uploadAttachment(
          new Blob([reportText], { type: 'text/plain' }),
          `${titleSlug}_report.txt`
        );
      }

      // Attach AI report if it was generated and selected
      const aiReport = (window as any).__qa_ai_report__ as string | undefined;
      if (aiReport && (el<HTMLInputElement>('attach-ai-report'))?.checked) {
        setStatus('Uploading AI report…');
        await uploadAttachment(
          new Blob([aiReport], { type: 'text/plain' }),
          `${titleSlug}_AI_Report.txt`
        );
      }

      // Attach screenshots
      const shots = recordingData?.screenshots || [];
      if (shots.length && (el<HTMLInputElement>('attach-screenshots'))?.checked) {
        for (let i = 0; i < shots.length; i++) {
          setStatus(`Uploading screenshot ${i + 1} of ${shots.length}…`);
          const shotBlob = await fetch(shots[i].dataUrl).then(r => r.blob());
          const num      = String(shots[i].index || i + 1).padStart(3, '0');
          await uploadAttachment(shotBlob, `screenshot-${num}.png`);
        }
      }

      // Attach recording video (optional — can be large)
      if (blobURL && (el<HTMLInputElement>('attach-video'))?.checked) {
        setStatus('Uploading recording (this may take a while)…');
        const ext       = recordingData?.extension || 'webm';
        const videoBlob = await fetch(blobURL).then(r => r.blob());
        await uploadAttachment(videoBlob, `${titleSlug}_recording.${ext}`);
      }

      // Done
      if (statusEl) statusEl.style.display = 'none';
      el('clickup-modal').style.display = 'none';

      const attachMsg = attachErrors.length
        ? ` (${attachErrors.length} attachment${attachErrors.length > 1 ? 's' : ''} failed: ${attachErrors.join('; ')})`
        : '';
      showConnectorStatus(`✓ ClickUp task created: ${json.name}${attachMsg}`, 'ok');

    } catch (e: any) {
      showConnectorStatus(`Network error: ${e.message}`, 'err');
      if (statusEl) statusEl.style.display = 'none';
    }

    if (submitLabel) submitLabel.textContent = 'Create Task';
    btn.disabled = false;
  });
});



// ─── Screenshots ──────────────────────────────────────────────────────────────

function renderScreenshots(shots: Screenshot[]): void {
  const panel = el('screenshots-panel');
  const grid  = el('screenshots-grid');
  const count = el('screenshots-count');

  if (!panel || !grid) return;
  if (!shots.length) { panel.style.display = 'none'; return; }

  panel.style.display = 'flex';
  if (count) count.textContent = `${shots.length} screenshot${shots.length !== 1 ? 's' : ''}`;
  grid.innerHTML = '';

  shots.forEach((shot, i) => {
    const item = document.createElement('div');
    item.className = 'screenshot-item';
    item.innerHTML = `
      <img src="${shot.dataUrl}" alt="Screenshot ${shot.index || i + 1}" loading="lazy"/>
      <div class="screenshot-item-label">Screenshot ${shot.index || i + 1}</div>
      <button class="screenshot-item-dl" title="Download screenshot">
        <svg viewBox="0 0 20 20" fill="none">
          <path d="M10 4v8M7 9l3 3 3-3" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 15v1a1 1 0 001 1h10a1 1 0 001-1v-1" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>`;

    // Click image → open fullscreen
    item.querySelector('img')?.addEventListener('click', () => {
      const w = window.open('', '_blank')!;
      w.document.write(`<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <img src="${shot.dataUrl}" style="max-width:100%;max-height:100vh;"/>
      </body></html>`);
    });

    // Download individual screenshot
    item.querySelector('.screenshot-item-dl')?.addEventListener('click', e => {
      e.stopPropagation();
      const a   = document.createElement('a');
      a.href     = shot.dataUrl;
      a.download = `${recordingData?.title || 'QA'}_screenshot_${shot.index || i + 1}.png`;
      a.click();
    });

    grid.appendChild(item);
  });
}

// ─── Annotations ──────────────────────────────────────────────────────────────

function renderAnnotations(): void {
  const list  = el('annotations-list');
  const count = el('annotations-count');
  if (!list) return;

  if (count) {
    count.textContent = annotations.length > 0
      ? `${annotations.length} annotation${annotations.length !== 1 ? 's' : ''}`
      : '';
  }

  if (!annotations.length) {
    list.innerHTML = '<p style="font-size:12px;color:var(--text-lo);font-style:italic;padding:4px 0;">No bug annotations yet. Play the video and click Mark to annotate a timestamp.</p>';
    return;
  }

  const severityLabels: Record<string, string> = {
    critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
  };

  list.innerHTML = '';

  annotations.forEach((ann, i) => {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    item.innerHTML = `
      <span class="annotation-ts" title="Click to seek to this moment">[${formatTime(ann.ts)}]</span>
      <span class="annotation-text"></span>
      <span class="annotation-sev ${ann.severity}">${severityLabels[ann.severity] || ann.severity}</span>
      <button class="annotation-del" title="Delete">
        <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
          <path d="M3 4h10M6 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4m-6 0l.4 8.5a1 1 0 001 .95h3.2a1 1 0 001-.95L11 4"
            stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>`;

    (item.querySelector('.annotation-text') as HTMLElement).textContent = ann.text;

    // Click timestamp → seek video
    item.querySelector('.annotation-ts')?.addEventListener('click', () => {
      const video = el<HTMLVideoElement>('rv');
      if (video && isFinite(ann.ts)) {
        video.currentTime = ann.ts;
        video.play().catch(() => {});
      }
    });

    // Delete annotation
    item.querySelector('.annotation-del')?.addEventListener('click', () => {
      annotations.splice(i, 1);
      renderAnnotations();
      updateSeverityCounter();
      persistSession();
    });

    list.appendChild(item);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  let downloaded = false;

  // Download Recording
  el('btn-dl')?.addEventListener('click', () => {
    if (!blobURL) { alert('Recording not ready yet.'); return; }
    downloaded = true;
    const a   = document.createElement('a');
    a.href     = blobURL;
    a.download = `${recordingData?.title || 'QA_Session'}.${recordingData?.extension || 'webm'}`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });

  el('btn-dl-transcript')?.addEventListener('click', downloadReport);
  el('btn-new')?.addEventListener('click', () => window.close());
  el('btn-whisper')?.addEventListener('click', transcribeWithGroq);
  el('btn-zip')?.addEventListener('click', downloadZipBundle);
  el('btn-pdf')?.addEventListener('click', exportPDF);
  el('btn-ai')?.addEventListener('click', generateAiReport);

  // Copy AI report to clipboard
  el('btn-ai-copy')?.addEventListener('click', async () => {
    const text = (window as any).__qa_ai_report__ as string | undefined;
    if (!text) { alert('No report yet. Click Generate AI Report first.'); return; }
    try {
      await navigator.clipboard.writeText(text);
      const btn = el('btn-ai-copy');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="M5 10l4 4 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 2000);
      }
    } catch { alert('Copy failed. Please select and copy the text manually.'); }
  });

  // Download AI report as PDF
  el('btn-ai-download')?.addEventListener('click', () => {
    const text = (window as any).__qa_ai_report__ as string | undefined;
    if (!text) { alert('No report yet. Click Generate AI Report first.'); return; }

    const title = (recordingData?.title || 'QA_Session').replace(/[^a-zA-Z0-9_\-]/g, '_');

    // Build styled HTML, convert to blob, open in same tab print dialog
    const HEADERS = ['EXECUTIVE SUMMARY','SESSION INFORMATION','TEST COVERAGE ANALYSIS',
      'BUG REPORT','TESTER OBSERVATIONS','RISK ASSESSMENT','RECOMMENDATIONS','CONCLUSION'];

    // Render report lines as HTML
    let bodyHtml = '';
    text.split('\n').forEach(line => {
      const t = line.trim();
      const safe = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      if (/^[=\-]{10,}$/.test(t)) {
        bodyHtml += '<hr/>';
      } else if (HEADERS.includes(t)) {
        bodyHtml += '<div class="heading">' + t + '</div>';
      } else if (t === '') {
        bodyHtml += '<div class="empty"></div>';
      } else {
        bodyHtml += '<div class="line">' + safe + '</div>';
      }
    });

    const html = [
      '<!DOCTYPE html><html><head><meta charset="utf-8"/>',
      '<title>' + title + ' - AI Report</title>',
      '<style>',
      'body{font-family:Arial,sans-serif;font-size:13px;line-height:1.75;color:#0F172A;padding:40px;max-width:800px;margin:0 auto;}',
      'h1{font-size:19px;color:#1E1B4B;border-bottom:3px solid #7C3AED;padding-bottom:10px;margin-bottom:24px;}',
      '.heading{font-size:10.5px;font-weight:800;color:#7C3AED;letter-spacing:.06em;text-transform:uppercase;margin-top:18px;margin-bottom:3px;}',
      'hr{border:none;border-top:1px solid #E2E8F0;margin:6px 0;}',
      '.line{min-height:1.2em;}',
      '.empty{height:.6em;}',
      '.footer{margin-top:36px;font-size:11px;color:#94A3B8;border-top:1px solid #E2E8F0;padding-top:10px;}',
      '@page{margin:20mm;}',
      '</style></head><body>',
      '<h1>AI Generated QA Report &mdash; ' + (recordingData?.title || 'QA Session') + '</h1>',
      bodyHtml,
      '<div class="footer">Generated by QA Smart Assistant &mdash; Powered by ' + (Config.aiProvider === 'gemini' ? ('Google Gemini (' + Config.gemini.model + ')') : ('Ollama (' + Config.ollama.model + ')')) + '</div>',
      '</body></html>',
    ].join('');

    // Create a blob URL and trigger print via iframe — no new tab opened
    const blob = new Blob([html], {type: 'text/html;charset=utf-8'});
    const url  = URL.createObjectURL(blob);

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:none;opacity:0;';
    iframe.src = url;
    document.body.appendChild(iframe);

    iframe.onload = () => {
      iframe.contentWindow?.print();
      // Clean up after print dialog closes
      setTimeout(() => {
        document.body.removeChild(iframe);
        URL.revokeObjectURL(url);
      }, 60_000);
    };
  });

  // Auto-save warning — fires when user tries to close tab before downloading
  window.addEventListener('beforeunload', e => {
    if (blobURL && !downloaded) {
      e.preventDefault();
      e.returnValue = 'You have an unsaved recording. Download it before closing to prevent data loss.';
    }
  });

  // Language selector for Groq transcription
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLang = (btn as HTMLElement).dataset['lang'] || 'en';
    });
  });

  // Bug annotation: add on button click or Enter key
  const addBtn = el('btn-add-annotation');
  const input  = el<HTMLInputElement>('annotation-input');
  const sevSel = el<HTMLSelectElement>('annotation-sev');

  function addAnnotation(): void {
    const text = input?.value.trim() || '';
    if (!text) { input?.focus(); return; }

    const video = el<HTMLVideoElement>('rv');
    const ts    = (video && !isNaN(video.currentTime)) ? Math.round(video.currentTime) : 0;

    annotations.push({ ts, text, severity: (sevSel?.value || 'medium') as BugAnnotation['severity'] });
    annotations.sort((a, b) => a.ts - b.ts);
    if (input) input.value = '';
    renderAnnotations();
    updateSeverityCounter();
    persistSession();
  }

  addBtn?.addEventListener('click', addAnnotation);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addAnnotation(); } });
});