# Smriti — Technical Approach

**An offline-first dementia care companion for Northeast India.**
Patients and their caregivers, on one system, on a phone that may have no signal.

> Every figure and behaviour in this document is taken from the working code and
> is covered by **648 automated checks, currently all passing**. Nothing here is
> planned or aspirational; where something is *not* built, it says so.

---

## 1. The problem we actually solve

Dementia care in Assam, Manipur and the wider Northeast fails on three
practical realities, not on a lack of algorithms:

| Reality | What it breaks | What we do |
|---|---|---|
| Connectivity is intermittent or absent | Any cloud-dependent app | The device is the primary store; the server is a sync destination |
| Patients speak Assamese, Bodo, Manipuri | English-only interfaces | Live translation + speech, with honest per-language capability |
| Caregivers are ASHA workers with a shared phone | Per-device assumptions | Two roles, real authorization, SMS alerts that reach a human |

The engineering follows from those constraints. That is the pitch.

---

## 2. Architecture at a glance

```
        PATIENT DEVICE (works with no network)          SERVER
  ┌───────────────────────────────────────┐    ┌──────────────────────────┐
  │  Activity: games · doses · sessions   │    │                          │
  │                 │                     │    │                          │
  │                 ▼                     │    │                          │
  │   IndexedDB (Dexie) ── local truth    │    │                          │
  │                 │  same transaction   │    │  Express REST API        │
  │                 ▼                     │    │           │              │
  │   OUTBOX — every unsent write         │────┼──────────▶│              │
  │                 │  UUID per event     │    │           ▼              │
  │                 ▼                     │    │  SQLite (better-sqlite3) │
  │   SYNC ENGINE  backoff · single-flight│    │  idempotent on event id  │
  │                 ▲                     │    │           │              │
  │   CONNECTIVITY WATCH (probes /health) │    │           ▼              │
  │                                       │    │  SSE ──▶ CAREGIVER       │
  │   Adaptive engine · Reminder engine   │    │  GSM/SMS ──▶ CAREGIVER   │
  └───────────────────────────────────────┘    └──────────────────────────┘
```

**The rule that makes it safe:** a row leaves the outbox only when the server
confirms *that event ID* — never merely because it was sent.

---

## 3. Data we actually collect

There are no wearables, no Fitbit, no Apple Health and no EHR integration.
Every figure in the system comes from one of four places:

| Source | Stored as | Who enters it |
|---|---|---|
| **Cognitive activity** — 7 games across 5 domains | `sessions` (24 columns) | Patient, by playing |
| **Medication & routine adherence** | `reminders`, `schedules` | Caregiver plans, patient acts |
| **Play sessions** — duration, count, limits | `game_sessions` | Device, automatically |
| **Profile & context** — age, language, waking hours, emergency contact | `patients`, `family_members` | Caregiver at registration |

Derived, never entered: `performance_metrics` (per-domain rollups),
`critical_alerts` (missed doses), `sync_events` (the idempotency ledger).

**16 tables. SQLite. No document store.**

---

## 4. How the intelligence actually works

This is the part most decks overstate, so we are precise about it.

### 4.1 Adaptive difficulty — a rules engine on the device

`frontend/adaptive.js`. Runs in microseconds, needs no network.

```
Easy → Easy-Medium → Medium → Medium-Hard → Hard      (one step at a time)
```

| Signal | Response |
|---|---|
| 3 correct in a row, unlaboured | step **up** one |
| 2 wrong in a row | step **down** one |
| Correct but slow, or after a hint | **hold** — coping is not mastery |
| Stuck 12s | offer a **hint** (a real clue, never the answer) |
| Stuck 25s | offer to **move on**; next question is easier |

A difficulty change takes effect on the very next question — the *Spot the Odd
One* grid genuinely grows 3×3 → 3×4, the recall sequence gets longer. It is not
a label on an unchanged game.

**Why rules and not a trained model.** A patient with no signal must still get
questions at the right level; a model behind a cloud API fails exactly when the
patient is most isolated. `adaptiveDecide()` is the single decision point, and
everything it reads is already the feature vector a trained model would want —
so swapping rules for a per-patient model later is one function body, and the
data being recorded now is already the training set.

### 4.2 Composite grading — not a right-answer count

Counting correct answers rewards a patient who never leaves the easiest level
and punishes one being stretched. The score is built from what happened:

| Component | Weight |
|---|---|
| Accuracy | 55 |
| Difficulty actually faced (mean level of answered questions) | 20 |
| Response speed, against a generous target | 10 |
| Consistency (how little answers alternated) | 10 |
| Improvement within the session | 5 |
| **Penalties** — hints (−2, cap −10), skips (−3, cap −12), timeouts (−2, cap −8) | |

Result: 0–100, banded Excellent / Good / Steady / Needs support, with its
components stored so a caregiver can see *why*.

### 4.3 Trend analysis — deterministic, and it refuses to guess

`backend/analysis_engine.js`. Splits a patient's sessions in half and compares
the means. **Below 3 sessions it returns `insufficient_data` and says so** —
it does not draw a trend line through two points.

Output: Overall Trend (Improving / Stable / Declining / Insufficient Data),
Strengths, Areas to Watch, Recommended Actions.

**It never diagnoses.** The wording is enforced by tests that fail on
"has dementia", "diagnosis", "prescribe" and similar.

> An optional LLM can *narrate* these findings in friendlier prose. The findings
> themselves always come from the engine, so the analysis works with no API key
> and cannot be hallucinated.

---

## 5. Offline-first, in detail

The strongest engineering claim we have, and it is demonstrable.

| Capability | Offline? |
|---|---|
| Play games, adaptive difficulty adapts | ✅ |
| Medication reminders fire | ✅ while the app is open or backgrounded |
| Missed-dose detection | ✅ on-device |
| Session limits enforced | ✅ from IndexedDB — a server check would fail *open* |
| Cold start with no network | ✅ restores from IndexedDB |
| Translation of already-seen text | ✅ from cache |
| Speech-to-text | ❌ — see §7 |

**Idempotency.** Every critical event carries a device-generated UUID; the
server's `sync_events` table uses it as the primary key. Proven under the
hardest case: server applies the event, the reply is destroyed, the device
retries → server answers `duplicate`, no second record. No loss, no duplicates.

**Conflict handling.** Events are append-only facts stamped with when they
*happened*, not when they synced. The two places that could still collide are
handled explicitly: a reminder never downgrades `done` → `missed`, and a game
result is timestamped at play time.

---

## 6. Alerting: what can and cannot be done

A missed medication dose raises an alert on the device, queued with its real
timestamp. Delivery is honest about its limits:

| Scenario | What actually happens |
|---|---|
| Patient online | Alert syncs → backend sends SMS via gateway or GSM modem |
| Patient offline, **GSM hardware present** | Requires the backend to run *locally* (Raspberry Pi / clinic PC) on the same Wi-Fi with a SIM800/SIM7600 modem: `device → local Wi-Fi → local backend → GSM → SMS`. No internet anywhere in that chain. |
| No cellular coverage either | **No message can leave the area by any means.** The alert stays queued with its original timestamp, retries with backoff, is never sent twice, and is visible on the caregiver dashboard. |

**A web page cannot send an SMS.** No browser API exists. Every alert leaves
from the backend. The default `console` provider delivers to *nobody* and the
server says so at startup.

---

## 7. Language: verified, not assumed

Bhashini (MeitY) handles translation, ASR and TTS — **reached only through our
backend**, so the API key never exists in a browser.

Measured against the live API:

| Language | Translation | Speech → text | Text → speech |
|---|---|---|---|
| English | native | ✅ | ✅ |
| Hindi | ✅ | ✅ | ✅ |
| **Assamese** | ✅ | ❌ **none** | ✅ |
| **Bodo** | ✅ | ❌ **none** | ✅ |
| **Manipuri** | ✅ | ❌ **none** | ✅ |
| Bengali / Marathi | ✅ | ✅ | ✅ |

Real output: *"Time to take your morning medicine."* →
**আপোনাৰ ৰাতিপুৱাৰ ঔষধ লোৱাৰ সময় হৈছে।** · Assamese TTS returns real WAV audio ·
a Hindi round trip (text → speech → text) returns the phrase exactly.

**The honest consequence:** a patient who speaks only Assamese, Bodo or
Manipuri can be *spoken to* but **cannot speak to the app**. No ASR model exists
for those languages on this pipeline, and browser speech recognition is not
offline for any language. We hide the microphone for them rather than offering
a control that will not respond. Capability is *probed at runtime*, never
assumed, because Bhashini supports different languages for each task.

---

## 8. Security

| Area | Implementation |
|---|---|
| Authentication | Password **+ 6-digit OTP** for both roles. Codes are `crypto.randomInt`, stored **bcrypt-hashed**, single-use, 5-minute expiry |
| Limits | 5 wrong attempts locks the challenge; 3 resends; two-tier throttle — tight per account, loose per connection so a shared clinic line is not locked out |
| Authorization | Every patient route passes `requirePatientAccess`. **14 IDOR/BOLA vectors probed, all blocked** |
| Transport | CSP, HSTS, `nosniff`, `X-Frame-Options: DENY`, same-origin CORS by default |
| Tokens | HS256 pinned on sign *and* verify; server refuses to start in production on the dev secret |
| Secrets | Environment only. No key appears in any frontend file — asserted by tests |

Data minimisation: only the signed-in patient's own records are cached locally;
password hashes and other patients' data never are.

---

## 9. Technology stack — as built

| Layer | What we actually use | Why |
|---|---|---|
| **Server DB** | **SQLite** (`better-sqlite3`) | Single file, zero admin, runs on a Raspberry Pi in a clinic. Real transactions — which is what makes idempotent sync possible |
| **Device DB** | **IndexedDB via Dexie** | `localStorage` is 5MB and synchronous; this is the local source of truth |
| **Backend** | **Node.js + Express** | One language across the stack; no build step |
| **Frontend** | **Vanilla JS + Tailwind (CDN)** | No bundler, no toolchain — the whole app is static files any server can host |
| **Charts** | **Chart.js**, vendored locally | No CDN dependency; works offline |
| **Language** | **Bhashini / ULCA** | Government pipeline, Indian-language coverage |
| **Realtime** | **Server-Sent Events** | Simpler than WebSockets for one-way updates; reconnects natively |
| **Offline shell** | **Service Worker + Web App Manifest** | Installable PWA, cache-first shell |
| **Auth** | **JWT + bcryptjs** | Stateless sessions, hashed secrets |
| **Reports** | **PDFKit** | Server-rendered PDF/CSV |
| **Alerts** | **serialport** → GSM modem (optional) | The only path that works with no internet |

**Not used, deliberately:** MongoDB, Python, scikit-learn, TensorFlow.
See §11 for why.

---

## 10. What the caregiver sees

- **Overview** — patients, adherence, activity, alerts
- **Per-patient** — cognitive trend, domain comparison, response time, adherence
- **Game activity** — difficulty progression, question outcomes (correct /
  wrong / skipped / timed out / hints), session history, play limits
- **Analysis** — trend, strengths, areas to watch, recommended actions
- **Reports** — Daily / Weekly / Monthly / Yearly as PDF or CSV
- **Offline status** — pending events, last sync, alert delivery state

Every figure is read from stored rows. A patient with no activity shows a
proper empty state, never a fabricated zero.

---

## 11. Honest gaps

Say these before someone asks. They make the rest more credible.

1. **No trained ML model yet.** The adaptive and analysis engines are
   deterministic. The architecture is built so a model can replace
   `adaptiveDecide()` without touching a caller, and the data is already being
   collected in the right shape.
2. **No wearable or EHR integration.** No sensor data, no Fitbit, no ABDM.
3. **Speech-to-text is unavailable in our three priority NE languages** (§7).
4. **Browser reminders cannot guarantee an alarm when the app is fully closed** —
   Notification Triggers is flagged off, iOS gives web apps no background
   execution. Reminders fire while open or backgrounded; anything missed is
   detected on next launch with the real due time preserved. A Capacitor wrapper
   with Android `AlarmManager` fixes this without a rewrite.
5. **Offline SMS needs hardware** — a local backend plus a GSM modem (§6).
6. **Local data is not encrypted at rest.** Browser IndexedDB has no practical
   key-storage story; real at-rest encryption needs the OS keystore.

---

## 12. Evidence

**648 automated checks, 0 failing**, across 11 suites:

| Suite | Covers |
|---|---|
| `e2e` | accounts, auth, linking, patient isolation |
| `e2e-part2` | schedules, reminders, adherence, live updates |
| `e2e-part3` | analysis engine, translation, chart data |
| `e2e-part4` | reports, PDF/CSV, date filtering, full demo flow |
| `e2e-offline` | local DB, sync, idempotency, alerts, PWA |
| `e2e-repeating` | recurring reminders, waking hours |
| `e2e-adaptive` | adaptive difficulty, grading, play limits |
| `e2e-security` | MFA/OTP, emergency contact |
| `e2e-bhashini` | live translation, ASR/TTS, honest degradation |
| `e2e-owasp` | headers, CORS, JWT, IDOR, injection, throttling |
| `e2e-theme` | cultural themes, measured contrast, chat provider |

Plus browser verification of the complete journey: registration → OTP →
dashboard → game → database → metrics → live graph → caregiver view.

---

## 13. Accessibility

Contrast is **measured**, not claimed: body text **13.2–15.1:1**, primary
buttons **7.9–10.7:1** across all six cultural themes — every one clears
WCAG **AAA** (7:1). 44px touch targets, visible focus rings that survive
Windows high-contrast mode, `prefers-reduced-motion` honoured, live regions
on anything that updates.

Themes tint only. No moving backgrounds — actively disorienting for someone
with dementia.
