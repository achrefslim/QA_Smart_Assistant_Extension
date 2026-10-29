/**
 * src/shared/config/secrets.example.ts
 *
 * Copy this file to secrets.ts (same folder) and fill in your own values.
 * secrets.ts is ignored by git so your keys never leave your computer.
 */

export const Secrets = {
  // Groq Cloud key for Whisper transcription: https://console.groq.com/keys
  groqApiKey: '',

  // Google Gemini key for AI reports: https://aistudio.google.com
  geminiApiKey: '',

  // Firebase web app config: Firebase console > Project settings > Your apps
  firebase: {
    apiKey           : '',
    authDomain       : '',
    projectId        : '',
    storageBucket    : '',
    messagingSenderId: '',
    appId            : '',
    // OAuth 2.0 Web client ID used for Google sign in
    // (Google Cloud console > APIs and Services > Credentials)
    googleWebClientId: '',
  },
};
