# Tutorial: installing and using QA Smart Assistant

This guide takes you from the source code to a finished QA report, step by step.

## Part 1: Requirements

| Tool | Why |
|---|---|
| Google Chrome (or another Chromium browser) | Runs the extension |
| Node.js 18 or newer and npm | Builds the TypeScript code |
| Python 3 | Only needed if you edit the report rules |
| Groq account (free) | Voice transcription |
| Gemini API key (free) or Ollama | AI report generation |
| Firebase project (free) | User accounts |

## Part 2: Get the keys

### 2.1 Groq (transcription)

1. Go to [console.groq.com/keys](https://console.groq.com/keys) and sign in.
2. Click **Create API Key** and copy it.

### 2.2 Gemini (AI report in the cloud)

1. Go to [Google AI Studio](https://aistudio.google.com).
2. Click **Get API key** then **Create API key** and copy it.

You can skip Gemini and use Ollama instead (Part 7).

### 2.3 Firebase (accounts)

1. Open the [Firebase console](https://console.firebase.google.com) and create a project.
2. Go to **Build** then **Authentication**, click **Get started** and enable **Email/Password** and **Google**.
3. Go to **Project settings**, then **Your apps**, click the web icon and register an app. Keep the `firebaseConfig` values.
4. For Google sign in, open the [Google Cloud console](https://console.cloud.google.com) for the same project, go to **APIs and Services** then **Credentials** and copy the **Web client** OAuth client ID.
5. In that OAuth client, add the redirect URL of your extension: `https://<your extension id>.chromiumapp.org/`. You will find the extension id in Part 4.

## Part 3: Build the extension

**Step 1.** Download the code and install the dependencies.

```bash
git clone https://github.com/achrefslim/QA_Smart_Assistant_Extension.git
cd QA_Smart_Assistant_Extension
npm install
```

**Step 2.** Create your secrets file. Copy

`src/shared/config/secrets.example.ts`

to

`src/shared/config/secrets.ts`

and fill it with the values from Part 2:

```ts
export const Secrets = {
  groqApiKey: 'your groq key',
  geminiApiKey: 'your gemini key',
  firebase: {
    apiKey           : '...',
    authDomain       : '...',
    projectId        : '...',
    storageBucket    : '...',
    messagingSenderId: '...',
    appId            : '...',
    googleWebClientId: '...',
  },
};
```

This file is listed in `.gitignore`, so it is never uploaded.

**Step 3.** Build.

```bash
node build.mjs
```

The ready to use extension is created in the `dist` folder.

While you develop, you can use watch mode so every save rebuilds automatically:

```bash
node build.mjs --watch
```

## Part 4: Install it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist` folder.
4. Pin the extension with the puzzle icon so it stays visible in the toolbar.
5. Note the **ID** shown under the extension name, you need it for the Google redirect URL (Part 2.3 step 5).

After every rebuild, click the reload icon on the extension card.

## Part 5: Record your first test session

**Step 1. Sign in.** Click the extension icon. Create an account with your email (then confirm the verification email) or click **Sign in with Google**.

**Step 2. Set up the session.** On the home screen click **START SESSION**, then fill the setup:

| Field | Example |
|---|---|
| Quick Template | Choose a ready made template or **No template** |
| Layer | Frontend, Backend, Full Stack or Mobile |
| Environment | Development, Staging or Production |
| Test Type | Functional, Regression, Exploratory ... |
| Sprint / Build | Sprint 14 |
| Tags | login, checkout |
| Test rules | A checklist of what must be verified, for example "Login with wrong password shows an error" |

Choose the video quality (720p, 1080p or 4K), and enable the microphone if you want to narrate.

**Step 3. Start.** Click **Continue to Recording**, then choose the tab, window or screen to share. A short countdown starts.

**Step 4. Test.** A floating control bar appears on the page. While you test you can:

1. Talk out loud to explain what you are doing (it will be transcribed)
2. Press **Alt + B** to mark a bug at the current time, then choose its severity
3. Press **Alt + C** to take a screenshot
4. Press **Alt + D** to draw on the page and highlight a problem
5. Press **Alt + P** to pause and resume
6. Add free notes from the popup

**Step 5. Stop.** Press **Alt + S** or click stop on the control bar or in the popup. The review page opens automatically.

## Part 6: Review and generate the report

On the review page:

1. **Replay** the video. Click a bug in the list to jump to its timestamp.
2. **Edit bugs** or add new ones with the add annotation button.
3. **Transcribe** the narration with the Whisper button. Download the transcript if you need it.
4. Click **Generate AI Report**. The report appears in the AI Generated Report section, written live. Copy it or download it as PDF.
5. **Export** what you need:

| Button | Result |
|---|---|
| Download video | The recording file |
| Download report | Plain text report |
| PDF | Printable report |
| ZIP package | The full portable session package |

## Part 7: Use Ollama instead of Gemini (fully local)

1. Install Ollama from [ollama.com](https://ollama.com).
2. Download the model:

```bash
ollama pull llama3.2:3b
```

3. Start the server:

```bash
ollama serve
```

4. In `src/shared/config/env.ts` change the provider:

```ts
aiProvider: 'ollama' as 'ollama' | 'gemini',
```

5. Rebuild with `node build.mjs` and reload the extension.

Now the report is written on your own computer and no data leaves it.

## Part 8: Send bugs to Jira or ClickUp

### Jira

1. In the popup open the settings and find **Jira Connector**.
2. Enter your Jira URL (for example `https://yourteam.atlassian.net`), your email, an API token from your Atlassian account and the project key.
3. Click **Save Jira Settings**.
4. On the review page click the Jira button, check the summary, description and issue type, then submit.

### ClickUp

1. In **ClickUp Connector**, paste your ClickUp API token and the List ID where tasks should be created.
2. Click **Save ClickUp Settings**.
3. On the review page click the ClickUp button, fill the task name, description, expected and actual outcome, choose attachments and submit.

## Part 9: Share a session

From the session list, click share. The extension creates a link and a QR code that open `viewer/index.html`, a small static page showing the session summary (context, rules, bugs, start of the transcript).

To host your own viewer, deploy the `viewer` folder on any static host (Netlify, GitHub Pages ...) and replace the viewer address in the `openShareModal` function of `src/screens/popup/popup.ts`.

## Part 10: Customise the AI report rules

1. Edit `static/skill-template/QA-REPORT-SKILL.md` or `static/skill-template/playbooks/report.md`.
2. Regenerate the TypeScript constants:

```bash
python scripts/build-skill-templates.py
```

3. Rebuild:

```bash
node build.mjs
```

The new rules are used both for the in extension AI report and inside every exported ZIP.

## Part 11: Settings

| Setting | Where |
|---|---|
| Keyboard shortcuts | Popup settings, **Keyboard Shortcuts**. Click a shortcut and press the new keys, or reset it |
| Duration warning | Popup settings, **Warn me after**, to be reminded when a session gets long |
| Stored sessions | `db.maxSessions` in `env.ts` (default 15) |
| Transcript languages | `languages` in `env.ts` (English, French, Arabic) |

## Part 12: Troubleshooting

| Problem | Solution |
|---|---|
| Build error `Cannot find module './secrets'` | Create `src/shared/config/secrets.ts` from the example file (Part 3 step 2) |
| Microphone not recorded | Accept the microphone permission page that the extension opens |
| Transcription fails | Check the Groq key. Recordings over 24 MB of audio are too large for the API |
| AI report fails with Gemini | Check the Gemini key and your daily quota |
| AI report fails with Ollama | Make sure `ollama serve` is running and the model is pulled |
| Google sign in fails | Check the OAuth client ID and the redirect URL with your extension id |
| Changes do not appear | Run `node build.mjs` again and click reload on the extension card |
