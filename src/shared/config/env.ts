/**
 * src/shared/config/env.ts
 *
 * Central configuration file for QA Smart Assistant.
 * All URLs and constants live here. API keys are read from ./secrets.ts
 * (copy secrets.example.ts to secrets.ts and fill in your own keys).
 */

import { Secrets } from './secrets';

export const Config = {

  // Which AI engine to use for report generation: 'ollama' or 'gemini'
  //aiProvider: 'ollama' as 'ollama' | 'gemini',
  aiProvider: 'gemini' as 'ollama' | 'gemini',

  // Groq Cloud Whisper API — free transcription
  groq: {
    apiKey          : Secrets.groqApiKey,
    url             : 'https://api.groq.com/openai/v1/audio/transcriptions',
    model           : 'whisper-large-v3',
    maxFileSizeBytes: 24 * 1024 * 1024,
    timeoutMs       : 120_000,
  },

  // Ollama : local AI model for report generation

  ollama: {
    url      : 'http://localhost:11434/api/generate',
    healthUrl: 'http://localhost:11434/api/tags',
    model    : 'llama3.2:3b',
    timeoutMs: 180_000,
  },

  // Google Gemini : cloud AI model for report generation
  gemini: {
    apiKey   : Secrets.geminiApiKey,
    model  : 'gemini-3-flash-preview',
    url      : 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent',
    timeoutMs: 90_000,
  },

  // IndexedDB session storage
  db: {
    name       : 'qa_sessions_db',
    version    : 1,
    store      : 'sessions',
    maxSessions: 15,
  },

  // Firebase Authentication
  firebase: {
    ...Secrets.firebase,
  },

  // Supported transcript languages
  languages: [
    { code: 'en', label: 'English', flag: '🇬🇧' },
    { code: 'fr', label: 'French',  flag: '🇫🇷' },
    { code: 'ar', label: 'Arabic',  flag: '🇸🇦' },
  ] as const,

  name   : 'QA Smart Assistant',
  version: '8.0.0',

} as const;

export type LanguageCode = typeof Config.languages[number]['code'];