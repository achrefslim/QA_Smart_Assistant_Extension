---
name: qa-report
description: Use this skill whenever you are given a QA Smart Assistant session package (a folder or ZIP containing session.json, a recording, screenshots/, and a transcript). Your job is to read the package and produce ONE professional QA test report from it. This file is the router — it tells you what's in the package and where to find the detailed writing rules.
---

# QA Report — Router

A QA Smart Assistant session package contains everything captured during one
manual test session: a screen recording, screenshots, a voice transcript, a
test rules checklist, bug annotations, and session metadata. It exists for
one purpose: to become a clear, professional QA report a project manager or
developer can read end-to-end without watching the video.

## What's in this package

```
session.json          structured data: metadata, rules, annotations, transcript
recording.mp4          screen + mic recording (may be absent if not exported)
screenshots/            PNG files captured during the session, numbered in order
skill/
  QA-REPORT-SKILL.md   this file
  playbooks/
    report.md          the writing rules — read this next
```

**Always read `session.json` first.** It is the single source of truth for
everything that happened in the session. The recording and screenshots are
supporting evidence; `session.json` tells you what they mean.

A package may be missing some parts — `session.json.transcript` may be empty
if the tester didn't use the microphone, `session.json.annotations` may be
empty if no bugs were marked, `screenshots/` may not exist if none were
captured. **Never treat an empty section as an error.** Use whatever is
present and say so plainly in the report; don't apologize for missing data
and don't invent data that isn't there.

## Step 1 — Read the playbook

Open `skill/playbooks/report.md` and follow it exactly. It defines the
report structure, the section order, the tone, the banned vocabulary, and
how to use screenshots and the transcript as evidence.

## Step 2 — Look at the screenshots if present

If `session.json.screenshots` is non-empty, you have been given the actual
image files (or they are attached alongside this prompt). Look at them.
Describe concrete, specific things you see — visible errors, broken layout,
misaligned elements, blank states — not generic statements like "the UI
looks fine". A screenshot is evidence; treat it as such.

## Hard rules (apply throughout)

1. **Never ask the user a clarifying question.** You have everything you
   need in `session.json`. If something is ambiguous, make the most
   reasonable interpretation and move on — note any real uncertainty as a
   single line in the report itself, not as a question back to the user.

2. **Plain text only.** No markdown bold (`**`), no markdown headers (`#`),
   no asterisks for emphasis. Section headers and dividers use the exact
   format defined in `playbooks/report.md`. This report may be read inside
   a plain-text panel, printed to PDF, or pasted into a ticket — markdown
   syntax left unrendered looks broken in all three.

3. **The transcript is a draft, not a quote source.** Browser speech
   recognition (or Whisper) makes mistakes, especially with technical
   terms, names, and accents. Use the transcript to understand what the
   tester was doing and observing — silently correct obvious
   mis-transcriptions using context. Never present a transcript line as a
   verbatim quote unless it is completely unambiguous.

4. **Reference timestamps when they add value**, written as `[m:ss]`, e.g.
   `[0:14]`. Use them in the Bug Report and Tester Observations sections so
   a reader can jump to that moment in the recording. Don't sprinkle them
   everywhere — only where they help someone navigate the evidence.

5. **Annotated bugs are ground truth for severity.** If the tester marked a
   bug as `critical`, treat it as critical in your risk assessment even if
   your own reading of the transcript suggests otherwise. You may add
   nuance ("this also affects X") but don't downgrade or upgrade a
   tester's explicit severity call without strong evidence in the data.

6. **Distinguish formally-annotated bugs from observations.** Annotated
   bugs (from `session.json.annotations`) go in the Bug Report section,
   structured and numbered. Things the tester said out loud but never
   formally marked go in Tester Observations — looser, but still useful
   signal for risk and recommendations.

7. **Write like a teammate, not like an AI summarizing a transcript.** The
   report describes what was tested and what was found. It never says
   "the user/tester said...", "according to the transcript...", "in the
   recording...", "as shown in screenshot 2...". State the finding
   directly: not "the tester mentioned the button doesn't respond" but
   "the submit button does not respond to clicks".

   Banned vocabulary — do not use these words/phrases anywhere in the
   report:
   - "the recording", "the video", "as shown in the recording"
   - "the transcript", "the tester said", "according to the transcript"
   - "session.json", "keyframe", file paths like "screenshots/screenshot-1.png"
   - "as an AI", "I observed", "I was given", "based on the data provided"

   The only acceptable reference to visual evidence is a direct, specific
   description of what is visibly wrong or notable — "the login button
   remains greyed out after a valid email is entered" — never a reference
   to the artifact itself.

## Step 2 — Follow `playbooks/report.md`

That file has the full report structure, section by section, with exact
formatting rules. Do not skip any section it defines, even if a section
ends up short (e.g. "No bugs were annotated during this session.").

Once the report is written, your job is done — there is no cleanup step
and nothing to delete. The session package is the user's permanent record;
the report is a derived artifact they can regenerate any time.
