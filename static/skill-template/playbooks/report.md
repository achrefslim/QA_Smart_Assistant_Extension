# Report Playbook

Goal: produce ONE complete QA test session report from `session.json` (and
the recording/screenshots if present), following the exact structure below.
No clarifying questions, no skipped sections, no markdown syntax.

## 0. Read session.json first

It contains, in this shape:

```
{
  "id":           "unique session id",
  "title":        "session title the tester chose",
  "tester":       "tester name",
  "createdAt":    "human-readable date, e.g. June 30, 2026 at 2:26 PM",
  "createdAtIso": "ISO 8601 timestamp, for tooling only — do not print this",
  "durationSec":  number,
  "priority":     "critical" | "high" | "medium" | "low",
  "layer":        "Frontend" | "Backend" | "API" | "Mobile" | "Full Stack" | "",
  "environment":  "Development" | "Staging" | "Production" | "",
  "testType":     "Functional" | "Regression" | "Smoke" | "",
  "sprint":       "free text or empty",
  "tags":         ["array", "of", "strings"],
  "rules": [
    { "text": "rule description", "checked": true|false }
  ],
  "annotations": [
    { "timestamp": "0:14", "severity": "critical|high|medium|low", "text": "bug description" }
  ],
  "transcript": [
    { "timestamp": "0:00", "text": "what the tester said" }
  ],
  "screenshots": [
    { "file": "screenshots/screenshot-001.png", "timestamp": "0:08" }
  ],
  "hasRecording": true|false,
  "hasScreenshots": true|false,
  "hasTranscript": true|false
}
```

Use `hasRecording` / `hasScreenshots` / `hasTranscript` to know up front
which sections will have real content versus needing the "none recorded"
fallback line.

## 1. Classify session risk level (for your own use, not a section)

Quick read of `annotations` and `rules`:

- If any annotation has `severity: "critical"`, or more than half the rules
  failed → this session is high risk.
- If all rules passed and there are no annotations → low risk, a clean pass.
- Otherwise → medium risk.

This informs your tone and the Risk Assessment section — don't write it as
a separate section, just let it guide what you say.

## 2. Write the report — exact structure

Use this literal section header format: a line of 47 equals signs, the
header text in capitals, then another line of 47 equals signs, like this:

```
===============================================
EXECUTIVE SUMMARY
===============================================
```

Sections, in this exact order, every one of them present:

### EXECUTIVE SUMMARY
3-4 sentences. What was tested, what was the headline finding, what should
happen next. This is the only section a busy reader might read alone — make
it stand on its own. Be specific: reference the actual feature/page tested
and the actual number of issues found, not vague language.

### SESSION INFORMATION
A clean table-like list using this format, one fact per line:
```
Session Title : <value>
Tester        : <value>
Date & Time   : <value>
Duration      : <value>
Priority      : <value>
Layer         : <value>
Environment   : <value>
Test Type     : <value>
Sprint        : <value, or "Not specified">
Tags          : <comma-separated, or "None">
```

Use `createdAt` as-is for the Date & Time line — it is already formatted
for humans. Ignore `createdAtIso`; it exists only for tooling and must
never appear anywhere in the report.

### TEST COVERAGE ANALYSIS
Walk through the rules checklist. State how many passed out of the total.
For each failed rule, name it and say what its failure implies about
product quality — don't just restate the rule text. For each passed rule,
you can group them in one sentence ("Core login and validation flows
passed as expected") rather than listing every one individually if there
are many.

If `rules` is empty, write: "No formal test rules were defined for this
session; coverage is based on the tester's free-form exploration captured
below."

### BUG REPORT
For each item in `annotations`, write a numbered entry:
```
Bug #1
  Timestamp   : [m:ss]
  Severity    : <UPPERCASE>
  Description : <clear restatement of the issue, expanded with any relevant
                 transcript or screenshot context — not just the raw
                 annotation text copy-pasted>
  Suggested action : <one practical next step for the dev team>
```
If `annotations` is empty, write exactly: "No bugs were annotated during
this session." Do not invent bugs from the transcript here — unconfirmed
issues belong in Tester Observations, not Bug Report.

### TESTER OBSERVATIONS
Pull out concrete things the tester said or did that were not formally
annotated as bugs — hesitations, confusion, side comments, things that
seemed slow or off. Present as a short list, each with a timestamp where
useful. If screenshots are present, also note anything visibly wrong or
noteworthy in them here, described concretely (not "screenshot 2 shows an
issue" — describe what the issue actually is).

If there is no transcript and no screenshots, write: "No additional tester
observations were captured for this session beyond the formal annotations
above."

### RISK ASSESSMENT
Identify the highest-risk areas based on what failed and what wasn't
covered. State what could go wrong in production if these issues are not
addressed. End with one explicit line: "Overall session risk: LOW" or
"MEDIUM" or "HIGH" or "CRITICAL" — matching your classification from step 1.

### RECOMMENDATIONS
3-5 concrete, actionable items for the development and QA teams. Each one
should trace back to something specific found in this session — not
generic QA advice. Number them.

### CONCLUSION
One paragraph. Overall quality verdict on the area tested. State plainly
whether this is ready to ship, needs targeted fixes first, or needs a full
re-test, and why.

## 3. Formatting rules — strict

- Plain text only. No `**bold**`, no `# headers`, no `*` bullets — use
  plain numbered lists ("1.", "2.") or indented dashes ("  - ") only where
  the structure above shows them.
- Section header format is exactly as shown in step 2 — do not deviate.
- Do not add a title page, do not add a table of contents, do not add any
  section not listed above.
- End the report with exactly this line, nothing after it:
  ```
  Generated by QA Smart Assistant
  ```