/**
 * src/shared/types/index.ts
 *
 * All TypeScript interfaces and types shared across the extension.
 * If you add a new field to a session or message, add it here first.
 */

// ─── Session & Recording ──────────────────────────────────────────────────────

/** A single transcript segment returned by Whisper or Web Speech API */
export interface TranscriptEntry {
  ts  : number; // seconds from start of recording
  end?: number; // end time in seconds (from Whisper only)
  text: string;
}

/** A bug annotation the tester marks during video review */
export interface BugAnnotation {
  ts      : number; // video timestamp in seconds
  text    : string; // description of the bug
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/** A test rule item in the pre-recording checklist */
export interface TestRule {
  text   : string;
  checked: boolean;
}

/** A captured screenshot taken during recording */
export interface Screenshot {
  dataUrl  : string; // PNG as base64 data URL
  timestamp: number; // unix ms when the screenshot was taken
  index    : number; // sequential number (1, 2, 3...)
}

/** Priority levels for a QA session */
export type Priority = 'critical' | 'high' | 'medium' | 'low';

/** A complete QA session record saved in IndexedDB */
export interface QASession {
  id         : string;      // unique id: `${timestamp}-${random}`
  sessionId ?: string;      // alias kept for review page persistence
  title      : string;
  tester     : string;
  timestamp  : number;      // unix ms when recording stopped
  duration   : number;      // seconds
  size       : number;      // bytes
  extension  : string;      // 'mp4' or 'webm'
  videoBlob  : Blob;        // the actual recording (stored in IndexedDB)
  transcript : TranscriptEntry[];
  annotations: BugAnnotation[];
  rules      : TestRule[];
  screenshots: Screenshot[];
  priority   : Priority;
  layer      : string;      // e.g. 'Frontend', 'Backend', 'API'
  environment: string;      // e.g. 'Development', 'Staging', 'Production'
  testType   : string;      // e.g. 'Functional', 'Regression', 'Smoke'
  sprint     : string;      // e.g. 'Sprint 14', 'Week 3'
  tags       : string[];
}

// ─── Recorder Configuration ───────────────────────────────────────────────────

/** Config the popup saves before launching the recorder */
export interface RecorderConfig {
  mode        : 'desktop' | 'tab' | 'window';
  quality     : '720' | '1080' | '4k';
  micOn       : boolean;
  camOn       : boolean;
  ctrlBarOn   : boolean;
  countdownSec: number;
  title       : string;
  tester      : string;
  targetTabId : number | null;
  priority    : Priority;
  layer       : string;
  environment : string;
  testType    : string;
  sprint      : string;
  tags        : string[];
  rules       : string[];
}

// ─── Chrome Extension Messages ────────────────────────────────────────────────

/** All message types exchanged between extension components */
export type MessageType =
  | 'SAVE_RECORDER_CONFIG'
  | 'PERMISSIONS_DONE'
  | 'RECORDING_STARTED'
  | 'RECORDING_STOPPED'
  | 'RECORDING_PAUSED'
  | 'RECORDING_RESUMED'
  | 'RECORDING_DATA'
  | 'TIMER_TICK'
  | 'MIC_MUTE_TOGGLE'
  | 'MIC_MUTED_STATE'
  | 'CAM_INJECT'
  | 'CONTROLBAR_STOP'
  | 'CONTROLBAR_PAUSE'
  | 'CONTROLBAR_RESUME'
  | 'TAKE_SCREENSHOT'
  | 'SCREENSHOT_TAKEN'
  | 'SR_RESULT'
  | 'GET_PAGE_INFO'
  | 'TOGGLE_DRAW_MODE'
  | 'QUICK_BUG_OPEN'
  | 'QUICK_BUG_GET_TIME'
  | 'QUICK_BUG_SUBMIT'
  | 'QUICK_BUG_MARKED'
  | 'GET_CURRENT_TIME'
  | 'CONTROLBAR_TOGGLE_PAUSE'
  | 'PAUSE_STATE'
  | 'MIC_MUTE_SHORTCUT_TOGGLE'
  | 'CAM_TOGGLE'
  | 'CAM_STATE';

/** Generic message shape */
export interface ExtMessage {
  type: MessageType;
  [key: string]: unknown;
}

// ─── Connector Settings ───────────────────────────────────────────────────────

/** Jira connector credentials stored in chrome.storage.local */
export interface JiraConfig {
  url    : string; // e.g. https://yourteam.atlassian.net
  email  : string;
  token  : string; // API token from Jira account settings
  project: string; // project key e.g. 'QA', 'DEV'
}

/** ClickUp connector credentials stored in chrome.storage.local */
export interface ClickUpConfig {
  token : string; // API token from ClickUp settings
  listId: string; // the list ID where tasks will be created
}

// ─── Whisper API ──────────────────────────────────────────────────────────────

/** Shape of a segment returned by Groq verbose_json */
export interface GroqSegment {
  start: number;
  end  : number;
  text : string;
}

/** Full response from Groq transcription API */
export interface GroqTranscriptionResponse {
  text    : string;
  language: string;
  segments: GroqSegment[];
}

// ─── QA Session Package (session.json inside the exported ZIP) ───────────────

/**
 * The structured manifest written as session.json at the root of every
 * exported QA session ZIP. This is the single source of truth an AI agent
 * (or a human) reads to understand the session — modeled after the
 * "brief.json" pattern: one clean JSON file plus supporting media files.
 */
export interface QaSessionManifest {
  id            : string;
  schemaVersion : number;
  title         : string;
  tester        : string;
  createdAt     : string;   // human-readable, e.g. "June 30, 2026 at 2:26 PM"
  createdAtIso  : string;   // machine-readable ISO 8601 timestamp, for tooling
  durationSec   : number;
  priority      : Priority | string;
  layer         : string;
  environment   : string;
  testType      : string;
  sprint        : string;
  tags          : string[];
  rules         : Array<{ text: string; checked: boolean }>;
  annotations   : Array<{ timestamp: string; severity: string; text: string }>;
  transcript    : Array<{ timestamp: string; text: string }>;
  screenshots   : Array<{ file: string; timestamp: string }>;
  hasRecording  : boolean;
  hasScreenshots: boolean;
  hasTranscript : boolean;
  recordingFile?: string;
}