# QA Smart Assistant (Chrome extension)

QA Smart Assistant is a Chrome extension built for software testers. It records a manual test session (screen and microphone), lets the tester mark bugs with timestamps, take screenshots and draw on the page, transcribes the voice narration automatically, and then writes a complete professional QA report with AI. Bugs can be sent directly to **Jira** or **ClickUp**, and every session can be exported as a portable package that any AI agent can turn into the same report.

Written in **TypeScript**, bundled with **esbuild**, using **Manifest V3**.

## Table of contents

1. [Main features](#main-features)
2. [How it works](#how-it-works)
3. [The QA session package](#the-qa-session-package)
4. [Technologies](#technologies)
5. [Project structure](#project-structure)
6. [Quick start](#quick-start)
7. [Configuration](#configuration)
8. [Keyboard shortcuts](#keyboard-shortcuts)
9. [Privacy and security](#privacy-and-security)

For a full step by step guide, read [TUTORIAL.md](TUTORIAL.md).

## Main features

| Area | What you can do |
|---|---|
| Account | Sign up, sign in with email and password or with Google, email verification and password reset (Firebase Authentication) |
| Session setup | Choose a quick template, the layer (Frontend, Backend, Full Stack, Mobile), the environment (Development, Staging, Production), the test type (Functional, Regression, Exploratory and more), the sprint or build, tags and a checklist of test rules |
| Recording | Screen and microphone recording in 720p, 1080p or 4K, countdown before start, floating control bar on the page, pause and resume, mute and unmute |
| During the test | Mark bugs with a severity (Critical, High, Medium, Low) at the exact timestamp, take screenshots, draw on the page, add notes |
| Transcription | Automatic speech to text of the narration with Groq Whisper (English, French, Arabic) |
| AI report | One click report written by Google Gemini (cloud) or Ollama (fully local), following strict writing rules |
| Export | Download the video, the plain text report, a PDF report, the transcript, or the full ZIP session package |
| Integrations | Create a Jira issue or a ClickUp task from a session, with description, expected and actual outcome and attachments |
| Sharing | Share a session summary as a link and a QR code that opens in a small web viewer |
| Dashboard | Results page with bugs by severity, priority chart, severity trend and most used tags |
| Settings | Custom keyboard shortcuts and a duration warning timer |

## How it works

| Step | Where | What happens |
|:---:|---|---|
| 1 | Popup | The tester signs in and fills the session setup (context, tags, rules) |
| 2 | Recorder page | The screen and microphone are captured with the MediaRecorder API |
| 3 | Control bar (content script) | A floating toolbar is injected into the tested page to pause, mark bugs, take screenshots and draw |
| 4 | Background service worker | Coordinates the recorder, the control bar, the shortcuts and the timer |
| 5 | IndexedDB | The session (video, screenshots, annotations, metadata) is saved locally in the browser |
| 6 | Review page | The tester replays the video, edits bugs, runs the transcription and generates the AI report |
| 7 | Export | ZIP, PDF, Jira, ClickUp or share link |

## The QA session package

Every exported ZIP is a self contained package:

```
<title>_qa_package.zip
|__ <title>/
    |  README.md                what this package is
    |  session.json             metadata, rules, bug annotations and transcript
    |  recording.mp4            screen and microphone recording
    |__ screenshots/            screenshot 001.png, 002.png ...
    |__ skill/
    |   |  QA-REPORT-SKILL.md   main instructions for an AI agent
    |   |__ playbooks/
    |       |  report.md        exact report structure and writing rules
    |  <title>_report.txt       plain text report
    |  <title>_AI_Report.txt    AI report (if one was generated)
```

The same instruction files are used in two ways:

1. **Inside the extension:** when you click **Generate AI Report**, these rules are sent as the prompt to Gemini or Ollama together with `session.json` and the screenshots.
2. **Outside the extension:** you can give the ZIP to any AI assistant that reads files. It follows `skill/QA-REPORT-SKILL.md` and produces a report with exactly the same structure.

The instruction files are edited in `static/skill-template/` and compiled into `src/shared/skill/templates.ts` by `scripts/build-skill-templates.py`, so the prompt and the packaged files are always identical.

## Technologies

| Part | Tools |
|---|---|
| Language | TypeScript |
| Bundler | esbuild (`build.mjs`) |
| Extension platform | Chrome Manifest V3 (service worker, content scripts, chrome.identity) |
| Recording | MediaRecorder, getDisplayMedia, getUserMedia |
| Storage | IndexedDB |
| Authentication | Firebase Authentication (email and Google) |
| Transcription | Groq Cloud, Whisper large v3 |
| AI report | Google Gemini or Ollama (default model llama3.2 3b) |
| Export | JSZip, QRCode |
| Integrations | Jira REST API, ClickUp API |

## Project structure

```
qa-smart-assistant/
|  build.mjs                    Build script (esbuild, with watch mode)
|  package.json
|  tsconfig.json
|__ scripts/
|   |  build-skill-templates.py Compiles the skill markdown into TypeScript
|__ src/
|   |__ background/             Service worker
|   |__ content/                Script injected in the tested pages
|   |__ controlbar/             Floating recording toolbar
|   |__ screens/
|   |   |__ popup/              Main popup (auth, setup, dashboard, settings)
|   |   |__ recorder/           Screen and microphone recorder
|   |   |__ review/             Session review, transcription, AI report, export
|   |   |__ permissions/        Microphone permission page
|   |__ shared/
|       |__ config/             env.ts and secrets.example.ts
|       |__ db/                 IndexedDB layer
|       |__ skill/              Report rules as TypeScript constants
|       |__ types/              Shared types
|__ static/                     manifest.json, HTML, CSS, icons, skill templates
|__ viewer/                     Static web page that displays a shared session
```

## Quick start

```bash
git clone https://github.com/achrefslim/QA_Smart_Assistant_Extension.git
cd QA_Smart_Assistant_Extension
npm install
```

Copy `src/shared/config/secrets.example.ts` to `src/shared/config/secrets.ts` and fill in your keys, then:

```bash
node build.mjs
```

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `dist` folder.

## Configuration

| File | Setting |
|---|---|
| `src/shared/config/secrets.ts` | Groq key, Gemini key, Firebase config and Google OAuth client ID (never committed) |
| `src/shared/config/env.ts` | AI provider (`gemini` or `ollama`), model names, timeouts, number of stored sessions, languages |
| `static/skill-template/` | Rules used to write the AI report |
| Popup settings | Jira and ClickUp credentials, keyboard shortcuts, duration warning |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt + P | Pause or resume the recording |
| Alt + S | Stop the recording |
| Alt + C | Take a screenshot |
| Alt + D | Toggle draw mode |
| Alt + B | Mark a bug annotation |

All shortcuts can be changed in the popup settings.

## Privacy and security

1. No key is stored in the code. All keys live in `secrets.ts`, which is ignored by git.
2. Sessions (videos, screenshots, notes) are stored only in the browser IndexedDB.
3. Jira and ClickUp tokens are saved in the extension local storage of the tester.
4. With the Ollama provider, the report is generated entirely on your own computer.

## Author

[achrefslim](https://github.com/achrefslim)

## License

Shared for educational and portfolio purposes.
