# Smriti

A dementia-support web app for **patients** and their **caregivers / ASHA workers**,
on one website with two roles, real accounts, a working caregiver dashboard,
downloadable progress reports, Bhashini-powered translation and a chat assistant.

```
smritisaathi/
├── frontend/                   # static SPA (served by the backend, or any static server)
│   ├── index.html
│   ├── config.js               # APP_NAME + API_BASE_URL — the ONLY place a backend URL is set
│   ├── styles.css              # theme + accessibility / responsive rules
│   ├── app.js                  # state, apiFetch (auth + errors), session, router, load states
│   ├── realtime.js             # live updates over SSE, with a polling fallback
│   ├── auth.js                 # role select, login, patient/caregiver registration
│   ├── patient.js              # the patient dashboard, reminders and voice control
│   ├── games.js                # game engine + Family Faces / Spot the Odd One / Weaving
│   ├── games-part2.js          # Memory Match / Sequence Recall / Word Recall / Day and Date
│   ├── vendor/chart.umd.min.js # Chart.js, shipped with the app (no CDN)
│   ├── charts.js               # the four charts + instance management
│   ├── daterange.js            # the ONE shared date filter
│   ├── dashboard.js            # caregiver dashboard shell + 7 sections
│   ├── dashboard-schedule.js   # caregiver Schedule (CRUD) + Reminders sections
│   ├── dashboard-reports.js    # report period picker, preview, PDF/CSV download
│   ├── dashboard-analysis.js   # AI Insights panel
│   ├── chat.js                 # chat widget (talks to /api/chat)
│   └── bhashini-client.js      # the ONLY i18n mechanism — no hand-written dictionary
├── backend/
│   ├── server.js               # API + serves frontend/ on the same port
│   ├── database.js             # SQLite schema, migrations, occurrence engine, dev seed
│   ├── analysis_engine.js      # the deterministic, data-driven analysis
│   ├── report_builder.js       # report data + PDF / CSV / HTML renderers
│   ├── realtime.js             # Server-Sent Events hub
│   ├── middleware/auth.js      # JWT issuing, route protection, patient-ownership checks
│   ├── bhashini_service.js     # real Bhashini pipeline config + compute calls
│   ├── chat_service.js         # Claude (Anthropic API) + Bhashini translation
│   └── routes/
│       ├── auth.js             # register / login / me / logout
│       ├── schedules.js        # schedule CRUD + reminder occurrences and actions
│       ├── patients.js         # patients, linking, game results, notifications
│       ├── reports.js          # progress reports (JSON / HTML / CSV download)
│       ├── analysis.js         # AI Analysis (rule-based always, AI write-up if a key is set)
│       ├── translate.js
│       └── chat.js
├── .env.example
└── README.md
```

## Quick start

You need **Node.js 18 or newer** (`node -v`). Download it from https://nodejs.org
if the command is not found.

```bash
cd backend
npm install
npm start
```

Then open **http://localhost:5000**.

That is the whole setup. The backend serves the frontend on the same port, so
there is no second server to start and no `ERR_CONNECTION_REFUSED` from a
port mismatch. The first run creates `backend/data/smritisaathi.db` (SQLite)
and seeds demo accounts.

### If `npm install` gives trouble

`better-sqlite3` is a native module. It normally installs a prebuilt binary,
but two things can get in the way:

- **npm 11+ blocks install scripts by default.** If npm prints
  `1 package has install scripts not yet covered by allowScripts`, the binary
  was never downloaded. Run `npm approve-scripts better-sqlite3` and then
  `npm rebuild better-sqlite3`.
- **No prebuilt binary for your Node version** (npm falls back to `node-gyp`
  and fails with `Could not find any Python installation`). Install a
  `better-sqlite3` release that supports your Node version — `npm install
  better-sqlite3@latest` — rather than installing Python and build tools.

### Optional: credentials for translation and chat

Copy `.env.example` to `backend/.env` and fill in what you have. Everything
except Bhashini translation and Claude chat works without any keys.

```bash
cp .env.example backend/.env
```

| Variable | What it enables | Without it |
|---|---|---|
| `JWT_SECRET` | Signs login tokens | A development secret is used and a warning is printed |
| `BHASHINI_USER_ID`, `BHASHINI_API_KEY`, `BHASHINI_PIPELINE_ID` | Translating the UI into 15 Indian languages | The UI stays in English and says why |
| `ANTHROPIC_API_KEY` | The chat assistant, and the AI write-up in AI Analysis | Chat is off; AI Analysis still runs on the built-in rule-based engine |

- Bhashini credentials: register at https://bhashini.gov.in/ulca/user/register,
  log in, open **My Profile** and create an API key. A public general-purpose
  pipeline ID is already filled in as the default.
- Anthropic API key: https://console.anthropic.com

### Serving the frontend separately (optional)

`frontend/` is plain static files, so you can also serve it yourself:

```bash
cd frontend
npx serve .
```

`config.js` probes the page's own origin first and falls back to
`http://localhost:5000/api`, so this works with the backend on port 5000 with
no file edits. (Set `window.SMRITISAATHI_API_BASE` before the scripts load to
point somewhere else, e.g. a LAN IP.)

## Demo accounts

Seeded on first run, only to have something on screen. Real registrations are
stored exactly the same way.

| Role | Username | Password |
|---|---|---|
| Patient | `manisha` | `1234` |
| Patient | `ramesh` | `1234` |
| Patient | `anima` | `1234` |
| Caregiver | `asha_demo` | `1234` |

## Accounts and roles

Both roles live on the **same website** and use the same login form: a
**username and password the user chooses** (e.g. `rahul123` / `rahul@123`).
Usernames are unique across patients and caregivers together, so `POST
/api/auth/login` can resolve the role by itself and send the user to the right
dashboard.

- **Patient registration:** full name, username, password + confirm, age,
  gender, preferred language, optional caregiver ID to link to, optional
  mobile number and emergency contact.
- **Caregiver registration:** full name, username, password + confirm,
  email or phone, relationship with the patient.

Passwords are hashed with bcrypt before they are stored and are never returned
by any endpoint or shown anywhere in the UI. Sessions are JWTs that expire
after 12 hours; an expired token sends the user back to the login screen with
a clear message.

## Caregiver dashboard

| Section | What it does |
|---|---|
| Overview | Total patients, today's reminders, completed and missed tasks and average performance across every linked patient, plus today's schedule and adherence |
| My Patients | Every linked patient with sessions, accuracy, reminder completion and decline flags |
| Add Patient | Connect an existing patient by Patient ID / username / mobile, **or** register a brand-new patient account that the patient can then log into themselves |
| Patient Profile | Edit name, age, gender, language, emergency contact; manage the family members used by the Family Faces game |
| Patient Performance | KPIs, per-domain rollups, decline/improvement flags, recent session table |
| Cognitive Trends | Four live charts drawn from the patient's stored sessions, scoped by the date filter |
| Schedule | Add, edit and delete schedules (activity, description, date, time, repeat, reminder type, priority, notes) and view the next 7 days |
| Reminders | Total / completed / missed / snoozed counts and adherence; mark done, missed or snoozed |
| Reports | Pick a patient and a period (Daily / Weekly / Monthly / Yearly), preview the report, and download it as **PDF**, **CSV** or HTML |
| AI Insights | Overall trend, strengths, areas to watch and suggested actions — each derived from the stored data and shown with the numbers behind it, optionally written up by Claude |

A caregiver can only ever see and change patients linked to their own account;
the backend enforces that on every route (403 otherwise), not just in the UI.

## Patient dashboard

Deliberately simpler than the caregiver view — big type, 56px buttons, one
column on a phone, one clear action per card, no tables and no charts to read.
In order: greeting · **Next reminder** · **Today's schedule** · **Today's
activities** · **Cognitive games** · **Performance** · **Progress** · **Voice** ·
**Help / emergency contact**.

Accessibility throughout: 44px minimum touch targets, thick high-contrast focus
rings, `aria-label`/`aria-live` on the parts that change, `prefers-reduced-motion`
and `prefers-contrast` honoured, and a confirmation before anything destructive.

**Voice** uses the browser's Web Speech API. The patient can say things like
*"show today's reminders"*, *"what's my next activity"*, *"start memory game"*
or *"how am I doing"*; replies are spoken and shown. Every voice action also has
a button, and where speech recognition is unavailable the app says so instead of
failing silently.

## Schedules and reminders

The distinction that makes the rest of it work:

- A **schedule** is the plan a caregiver sets — *"Medicine, 08:00, every day, high priority"*.
  It has a title, description, date, time, repeat rule (once / daily / weekly /
  monthly), category, reminder type and notes. It carries no completion status.
- A **reminder** is **one occurrence of that schedule on one date**. The backend
  materialises them from the active schedules whenever anything reads them
  (`ensureOccurrences`), so a daily schedule produces a fresh, separately tracked
  card every day instead of one row that never resets.

That is what makes adherence mean something:

```
caregiver adds a schedule
      ↓  ensureOccurrences()
one reminder row per due date
      ↓  patient marks it done / snoozes it, or its time passes
status: done | snoozed | missed
      ↓
adherence = completed ÷ (completed + missed)
```

Reminders that have not come due yet are excluded from adherence, so the figure
is not dragged down by items the patient still has time to do. When nothing has
come due, adherence is `null` and every screen shows **—**, never `0%`.

A reminder created *after* its own time (a caregiver adding an 08:00 item at
10pm) is never retroactively marked missed.

## Live updates

Changes reach open dashboards on their own — no refresh button, no page reload.

- **Server-Sent Events** on `GET /api/events`. The backend pushes a small hint
  (`{type, patientId}`) and the client re-fetches through the normal
  authenticated endpoints, so a live update can never expose more than an
  ordinary request would. Events go only to the patient and the caregivers
  linked to them.
- **Polling fallback**: if `EventSource` is missing or the stream keeps failing,
  the client switches to a 20-second refresh by itself. The header shows
  🟢 Live, 🟡 Auto-refresh or ⚪ Not updating so the state is never a mystery.

SSE rather than Socket.IO because every update here flows server → client, and
SSE is native to both Node and the browser — no extra dependency, no protocol
upgrade, and it reconnects on its own.

A game in progress is never re-rendered underneath the patient.

## Cognitive activities

| Activity | Area observed | What it asks |
|---|---|---|
| Family Faces | Memory | Who is in the photo |
| Memory Match | Memory | Find the matching pair after the cards turn over |
| Sequence Recall | Problem solving | Repeat a sequence of colours in order |
| Word Recall | Language | Which word does not belong to the group |
| Spot the Odd One | Attention | Tap the picture that differs |
| Weaving Completion | Pattern recognition | Complete the woven pattern |
| Day and Date | Orientation | Today's day, date, month, part of day, season |

Every completed activity writes one `sessions` row with the game type, domain,
level, score, accuracy, **measured** per-answer response times and a timestamp,
then the per-domain rollup is recomputed and both dashboards update live.
Difficulty adapts from the patient's own last result.

Randomness in these files generates *puzzle content* (which face to ask about,
which tile is odd). No score, time or statistic is ever generated.

## Data model

| Entity | Table |
|---|---|
| Users | `patients`, `caregivers` (both have a unique `username`) |
| Caregiver → Patients | `caregiver_patients` (many-to-many) |
| CognitiveSessions / GameResults | `sessions` (one row per completed activity) |
| PerformanceMetrics | `performance_metrics` (per-domain rollup, recomputed on every result) |
| Schedules | `schedules` (the plan: title, description, date, time, repeat, type, priority, notes) |
| Reminders | `reminders` (one dated occurrence of a schedule, with status and snooze) |
| Reports | `reports` (each generated report and AI analysis is stored) |
| Notifications | `notifications` (caregivers are notified of sessions and completed reminders) |
| Family / chat / translation cache | `family_members`, `chat_messages`, `translation_cache` |

Observed areas: **Memory · Attention · Language · Orientation · Problem solving ·
Pattern recognition**. A domain with no completed activity reports an empty
state — the app never fills a gap with a number.

## Where the numbers come from

There is no fabricated data in any live path:

- Dashboard figures are read from `sessions`, `reminders` and
  `performance_metrics` — nothing is computed for display only.
- "No data yet" is rendered as an explicit empty state ("No cognitive sessions
  recorded yet", "No reminders have come due yet") or a **—**, never as `0%`.
- The only invented values in the project are the **optional development seed**
  in `database.js`, clearly banded off under its own banner, fixed rather than
  randomised, and switched off completely with `SEED_DEMO_DATA=false` in
  `backend/.env` — which starts you with a genuinely empty database.

Every dynamic panel has four states — **loading**, **success**, **empty** and
**error with a Try again button** — so a slow or failed request is always
visible rather than showing as blankness.

Schema changes are applied as **idempotent migrations** at startup, so an
existing `smritisaathi.db` keeps its data — usernames are backfilled for rows
created before usernames existed, and performance metrics are computed for
patients whose sessions predate that table.

## API

All routes are under `/api`. Everything except `/api/health`,
`/api/auth/*` and `/api/translate-ui` requires `Authorization: Bearer <token>`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Server + configuration status |
| POST | `/auth/register/patient` · `/auth/register/caregiver` | Registration |
| POST | `/auth/login` · `/auth/logout` | Login / logout |
| GET | `/auth/me` | Restore a session, validate the token |
| GET | `/auth/username-available` | Live duplicate-username check |
| GET / POST / DELETE | `/caregiver/patients[/:id]` | List, add (link or create), unlink |
| GET / PUT | `/patients/:id` | Full record / profile update |
| POST | `/patients/:id/family` · `/patients/:id/password` | Family members, password reset |
| POST | `/game-results` | Save a completed activity (append-only) |
| GET | `/events` | Live update stream (SSE; takes `?token=`) |
| GET / POST | `/patients/:id/schedules` | List / add a schedule |
| PUT / DELETE | `/schedules/:id` | Edit / delete a schedule |
| GET | `/patients/:id/schedules/upcoming?days=7` | Upcoming occurrences, grouped by day |
| GET / POST | `/patients/:id/reminders` | Today's reminders (+ stats) / add a one-off |
| GET | `/patients/:id/reminders/next` | The reminder coming up next |
| POST | `/reminders/:id/complete` · `/miss` · `/snooze` | Reminder actions |
| PUT / DELETE | `/reminders/:id` | Set status / remove one occurrence |
| GET | `/patients/:id/adherence` | Total, completed, missed, snoozed, adherence |
| GET | `/caregiver/overview` | Across-all-patients figures for the Overview row |
| GET | `/patients/:id?from=&to=` | Patient record, sessions filtered by the shared date range |
| GET | `/report/periods` | The periods and formats the report picker offers |
| GET | `/patients/:id/report?period=weekly` | Report preview (JSON), also stored |
| GET | `/patients/:id/report/download?format=pdf\|csv\|html\|json&period=…` | Download the report |
| GET / POST | `/patients/:id/analysis` | Analysis snapshot (free) / with an AI write-up |
| GET | `/translate/languages` | Languages the backend will accept |
| GET | `/patients/:id/report`, `/patients/:id/report/download?format=html\|csv\|json` | Reports |
| POST | `/patients/:id/analysis` | AI Analysis |
| GET / PUT | `/notifications`, `/notifications/read-all` | Notifications |
| POST | `/translate-ui`, `/translate` | Bhashini translation |
| POST / GET / DELETE | `/chat`, `/chat/:id/history` | Chat assistant |

Every endpoint returns `{ error, field? }` with a real HTTP status on failure,
and an unknown `/api/...` path returns a JSON 404 rather than the HTML page.

## Translation architecture

`frontend/bhashini-client.js` defines only **English** source strings. When the
language changes, the frontend batches every string into one
`POST /api/translate-ui` call. The backend
(`routes/translate.js` → `bhashini_service.js`) is the only code that talks to
Bhashini, using the real two-step Pipeline Config + Pipeline Compute flow.
Results are cached server-side in SQLite and client-side in `localStorage`, but
every cached value came from an actual Bhashini response — none was typed by a
developer. If credentials are missing, the UI stays in English **and says so**
instead of failing silently.

## Security

- `BHASHINI_API_KEY`, `BHASHINI_USER_ID`, `ANTHROPIC_API_KEY` and `JWT_SECRET`
  live only in `backend/.env` (gitignored) and are read via `process.env` in
  backend code. They are never referenced in any file under `frontend/`.
- Passwords are bcrypt-hashed; no endpoint returns a password or hash.
- Every protected route verifies the JWT and, for anything patient-specific,
  that the caller is that patient or a caregiver linked to them.
- Request bodies are validated (username format, password length, age range,
  `HH:MM` times, accuracy in 0–1, allowed reminder statuses).
- User-supplied text is HTML-escaped before it is rendered.
## Reports

Reports → pick a **patient** → pick a **period** → **Preview**, **Download PDF**
or **Download CSV**.

| Period | Covers |
|---|---|
| Daily | Since midnight today |
| Weekly | The last 7 days |
| Monthly | The last 30 days |
| Yearly | Since 1 January |
| All time | Every recorded activity |

Every format is rendered from **one** report object (`backend/report_builder.js`),
so the preview on screen, the PDF and the CSV cannot disagree. The report
contains:

- **Application name** and the period it covers
- **Patient information** — name, Patient ID, age, gender, report period
- **Performance summary** — overall score, best score, response time, and each
  of Memory · Attention · Language · Orientation · Problem solving ·
  Pattern recognition, with a bar chart and a per-area table
- **Reminder summary** — total, completed, missed, snoozed, adherence
- **Cognitive sessions** — count, average, best, trend, a line chart of session
  scores, and the recent-performance table
- **Data analysis** — overall trend, strengths, areas to watch and suggested
  caregiver actions

The PDF is generated server-side with `pdfkit`; its charts are drawn with PDF
primitives, so no browser or headless renderer is involved. The CSV is the raw
data export — every session row, every reminder — with a UTF-8 BOM so Excel
opens Indian-language names correctly.

## The shared date filter

One picker (`frontend/daterange.js`), used by **charts, performance figures,
the session list, the AI analysis and reports together**. Options: Today,
Last 7 days, Last 30 days, This year, All time, and a custom range.

It works because there is only one copy of the selection (`state.dateRange`),
only one function that changes it (`setDateRange`), and every consumer passes
the same `from`/`to` to the backend. The chosen range is remembered between
visits.

## Testing

Eleven suites, run against a live server from the project root while the
backend is up. They create their own accounts and data, so they can be run
repeatedly without resetting anything.

```bash
node tests/e2e.js         # accounts, auth, linking, patient isolation
node tests/e2e-part2.js   # schedules, reminders, adherence, live updates
node tests/e2e-part3.js   # analysis engine, translation, chart data
node tests/e2e-part4.js   # reports, PDF/CSV, date filter, full demo flow
node tests/e2e-offline.js # local database, sync, idempotency, alerts, PWA
node tests/e2e-repeating.js # recurring reminders and waking hours
node tests/e2e-adaptive.js  # adaptive difficulty, grading, play limits
node tests/e2e-security.js  # MFA/OTP, caregiver verification, emergency contact
node tests/e2e-bhashini.js  # translation, speech, and honest degradation
node tests/e2e-owasp.js     # headers, CORS, JWT, IDOR, injection, throttling
node tests/e2e-theme.js     # cultural themes, measured contrast, chat provider
```

Each suite registers its **own** caregiver and its **own** patient, so a test
run never adds patients to the demo caregiver or schedules to a demo patient.
Test accounts do accumulate in the database over many runs. To clear them and
leave only the seeded demo (`asha_demo` with Manisha, Ramesh and Anima):

```bash
node tests/reset-demo-data.js --dry-run   # show what would be removed
node tests/reset-demo-data.js             # remove it (writes a .backup-*.db first)
```

### Status — 654 automated checks, 0 failing

| Feature | Status |
|---|---|
| Patient registration | PASS ✓ |
| Caregiver registration | PASS ✓ |
| Login (username + password chosen by the user) | PASS ✓ |
| Logout clears the session | PASS ✓ |
| Invalid login rejected | PASS ✓ |
| Duplicate username rejected | PASS ✓ |
| Add patient (create a new account) | PASS ✓ |
| Link patient (by Patient ID / username / mobile) | PASS ✓ |
| Add schedule | PASS ✓ |
| Edit schedule | PASS ✓ |
| Delete schedule | PASS ✓ |
| Complete reminder | PASS ✓ |
| Miss reminder | PASS ✓ |
| Snooze reminder | PASS ✓ |
| Patient sees the caregiver's schedule | PASS ✓ |
| Cognitive game starts and completes (7 activities) | PASS ✓ |
| Score saved | PASS ✓ |
| Response time saved | PASS ✓ |
| Patient dashboard updates | PASS ✓ |
| Caregiver dashboard updates | PASS ✓ |
| Graph rendering (4 charts, real data) | PASS ✓ |
| Live graph update (no reload) | PASS ✓ |
| Real-time / polling fallback | PASS ✓ |
| AI analysis from stored data | PASS ✓ |
| AI analysis updates after new data | PASS ✓ |
| Daily / Weekly / Monthly / Yearly reports | PASS ✓ |
| PDF download | PASS ✓ |
| CSV download | PASS ✓ |
| Date filter drives charts, performance, analysis and reports | PASS ✓ |
| Translation endpoint + graceful fallback | PASS ✓ |
| Voice interaction (+ fallback where unsupported) | PASS ✓ |
| Mobile responsiveness (375px, 10 sections) | PASS ✓ |
| Browser console clean (no errors) | PASS ✓ |
| No API keys or secrets in frontend files | PASS ✓ |
| No fabricated data in any live path | PASS ✓ |

### Manual checks worth doing before a demo

| # | Test | How |
|---|---|---|
| A | Full demo flow | Register a caregiver → Add Patient → Add Schedule → log in as that patient → play a game → back to the caregiver: overview, charts, analysis and report all move |
| B | Live updates | Two browser windows, caregiver in one and patient in the other. Add a schedule; it appears on the patient screen within a second, with no reload |
| C | Reports | Reports → choose Weekly → Preview → Download PDF and CSV; open both |
| D | Date filter | Cognitive Trends → switch Today / Last 30 days / All time; the charts and figures change together |
| E | Empty states | Add a brand-new patient: every panel says "No … yet" and shows — rather than 0% |
| F | Server down | Stop the backend and reload: the app says so and offers Try again instead of pretending you are signed in |
| G | No seed data | `SEED_DEMO_DATA=false`, delete `backend/data/*.db`, restart — the app comes up empty and still works |

## Reminders that repeat through the day

Some prompts are wrong as a once-a-day alarm. Drinking water is the obvious
one: a single 11:00 reminder does nothing for hydration.

Pick **Through the day** as the repeat rule and choose a gap — 30 minutes to
4 hours. What the patient then sees is **one card that keeps coming back**,
never a column of near-identical alarms:

```
07:00  Drink Water          ← the only water card on screen
  patient taps Done at 07:12
09:15  Drink Water          ← the next one, anchored to when they actually drank
  patient taps Done at 09:20
11:20  Drink Water
```

Only one occurrence of a recurring schedule is ever open at a time. The next
is created when the current one is acted on — or when it lapses — and is
anchored to that moment, so drinking at 10:37 with a two-hour gap prompts
again at 12:40 rather than at some fixed slot. Completed occurrences stay in
the database as history, which is what keeps adherence figures honest, but the
patient's screen collapses them to a single card marked *done twice today*.

### It stops at bedtime

Every patient has a waking window on their profile (**Wakes up at** / **Sleeps
at**, default 07:00–21:00). Repeats are only ever generated inside it. A start
time earlier than waking is pulled forward rather than dropped — dropping it
would silently lose the reminder. A reversed or malformed window is rejected
outright, since a bad value would either silence every repeat or ring all
night.

Only `interval` schedules consult the window. A daily medicine at 08:00 still
fires once, exactly as before.

---

## Adaptive difficulty

`frontend/adaptive.js` watches how a session is actually going and moves the
difficulty to match — **one step at a time**, on the existing 1–5 level scale:

```
Easy → Easy-Medium → Medium → Medium-Hard → Hard
```

| What happens | What the system does |
|---|---|
| 3 correct in a row, answered without effort | Step **up** one level |
| 2 wrong in a row | Step **down** one level |
| Correct but slow, or with a hint | **Hold** — the patient is coping, not mastering |
| Stuck for 12 seconds | Offer a **hint** |
| Stuck for 25 seconds | Offer to **move on**; the next question comes back easier |
| Question skipped or timed out | Step **down** one level |

A difficulty change takes effect on the very next question — the grid in *Spot
the Odd One* genuinely grows from 3×3 to 3×4, the sequence in *Sequence Recall*
gets longer. It is not a label on an unchanged game.

Hints are real clues about the question in front of the patient, never the
answer: the first letter of the word, which half of the grid holds the odd one,
how many shapes the pattern repeats in. Every hint, skip and timeout is
recorded, because "got it right after a hint" and "got it right" are different
facts about the same patient.

Nothing here is phrased as failure. The slow-response path says *"There is no
hurry"* and offers *"Try a different one"* — a patient must never feel punished
for being deliberate.

### Why the rules run on the device

A patient with no signal must still get questions pitched at the right level.
A difficulty engine behind a cloud API is one that fails exactly when the
patient is most isolated. So the rules are local and run in microseconds.

`adaptiveDecide()` is the **only** place a decision is made, and everything it
reads is already the feature vector a trained model would want. Swapping the
rules for a per-patient model later is a change to one function body — no
caller moves, and the recorded data is already the training set.

---

## Grading on more than right answers

Counting correct answers rewards a patient who never leaves the easiest level
and punishes one who is being stretched. The score is built from what actually
happened:

| Contributes | Weight |
|---|---|
| Accuracy | 55 |
| Difficulty actually faced (average level of answered questions) | 20 |
| Response speed, against a generous target | 10 |
| Consistency (how little the answers alternated) | 10 |
| Improvement within the session (second half vs first) | 5 |
| **Penalties** — hints (−2, max −10), skips (−3, max −12), timeouts (−2, max −8) | |

Result: 0–100, banded **Excellent / Good / Steady / Needs support**, with the
parts it was built from stored alongside it, so a caregiver can see *why* — a
bare number invites the wrong conclusion.

Each session also carries a plain-language status: **Improving, Stable, Needs
assistance, Difficulty reduced, Difficulty increased**. These describe an
activity, never a person's health.

---

## Play limits

Cognitive activities help; unlimited screen time does not.

- **30 minutes** per session, closed by a watchdog whether or not the patient
  is still tapping.
- **3 sessions a day** by default.
- When they run out, the patient sees *"That is all the games for today — you
  have completed today's game sessions. Well done, please rest now."* with no
  way to argue with it. A lock icon or an error would invite a confused patient
  to keep trying.

Only the **caregiver** can extend it, from the new 🎮 **Game activity** screen:
grant one more session for today, or change the standing daily limit (1–10). A
grant is spent on the day it was given — carrying it forward would quietly turn
"one extra today" into "four a day for ever". A patient's own device cannot
raise its allowance; both routes are caregiver-only and return 403 otherwise.

### How this holds with no network

The limit is enforced **on the device**, from IndexedDB. An "am I allowed?"
call to the server would fail open the moment the signal drops, which is the
one moment it matters.

The split is deliberate:

- The **server** owns the *allowance* — a caregiver decision. It rides along
  with the patient profile the device already caches, so the device can read
  its limit offline but never raise it.
- The **device** owns *usage* — it is the only thing that knows what happened
  while the network was down — and syncs it up as `game_session_start` /
  `game_session_end` events, keyed by the device's own session id so a replay
  can never double-count. A late-arriving start event cannot reopen a session
  the device already closed.

---

## What the caregiver sees

The 🎮 **Game activity** screen adds:

- **Sessions used / remaining / total play time / extra granted**, and the two
  controls above.
- **Difficulty progression** — where each session started, where it ended, and
  the highest point reached.
- **Question outcomes** — correct, incorrect, skipped, timed out and hints
  used, stacked per session. Counting only correct answers hides the two things
  that matter most: whether the patient is quietly struggling, and whether they
  are getting help.
- **Adaptive status** — the score, band, starting and highest difficulty, and
  the level recommended next.
- **Play sessions** — start time, duration and activity count for each.

Charts with no adaptive data behind them say *"Not enough activity recorded
yet"* rather than drawing an empty axis, and sessions recorded before this
feature existed are excluded rather than shown as a row of zeros.

---

# Signing in: two factors

A password now gets you a **challenge**, not a session. The token is minted
only after a 6-digit code is verified — anything else would make the second
factor decorative.

```
password  ->  POST /api/auth/login        ->  { mfaRequired, challengeId }
code      ->  POST /api/auth/verify-otp   ->  { token, role, … }
```

How the code is handled:

| | |
|---|---|
| Generated with | `crypto.randomInt` — never `Math.random`. A predictable code is not a second factor. |
| Stored as | a **bcrypt hash**. A stolen database hands out no live logins, and nothing in the codebase can read a code back. |
| Lifetime | 5 minutes, single use. Burned in the same statement that checks it is unburnt, so two racing requests cannot both succeed. |
| Wrong guesses | 5, then the challenge locks — and the *correct* code stops working on it too. |
| Resends | 3 per challenge, 30s apart. A resend **replaces** the code; the previous one dies immediately. |
| Requests | 6 per account per 15 minutes, so a stolen password cannot be used to spray codes at someone's phone. |
| Failure messages | deliberately identical for wrong / expired / already-used, so nothing can be learned by probing. |

Codes are delivered over SMS through the existing `SMS_PROVIDER`. With the
console provider they are printed to the server log and **delivered to
nobody** — fine for development, useless in production.

For automated tests there is `OTP_DEV_ECHO`, which returns the code in the
response. It is **ignored when `NODE_ENV=production`**, so it cannot weaken a
real deployment.

## Caregiver verification

**Removed.** Registration briefly required an uploaded identity document.
It was a bad trade and it is gone:

- it *blocked legitimate caregiver registration* — the API refused any
  sign-up without a file, which is the bug this replaced;
- an uploaded image proves very little, cannot be revoked, and needed a
  human reviewer that did not exist;
- it meant storing someone's identity papers, which is a real liability to
  carry for a check nobody was performing.

A caregiver now proves who they are the same way a patient does: with a
second factor at sign-in, which is checkable, revocable, and stores nothing
sensitive at rest.

The `verification_*` columns remain in the `caregivers` table so existing
rows keep their data, but nothing reads them.

## Emergency contact

Now **mandatory**, validated in `createPatient()` — the single door into the
patients table — so self-registration, a caregiver's "Add Patient", and
anything added later are all covered by construction rather than by
remembering. The browser checks it too, for a fast message, but turning that
off changes nothing.

It is required because it is the only route a missed-dose alert has to a human
being.

---

# Speech: what actually works

Bhashini handles translation, speech-to-text and text-to-speech, all through
**our own backend** — the API key never exists in a browser.

## Capability is asked, not assumed

Bhashini supports **different languages for each task**, and which ones depends
on the pipeline your account is issued. So the app asks:

```
GET /api/speech/capability?lang=as
  -> { offered, configured, translation, asr, tts, note }
```

With no credentials every online capability reports `false` with a reason, and
the UI hides the feature rather than offering a microphone button that cannot
work.

## The fallback order

```
1. Bhashini, via our backend      — when online AND the language is supported
2. The device's own voice          — for text-to-speech only
3. Say plainly that it cannot      — no invented text, no silent failure
```

## What is genuinely offline, and what is not

This distinction matters and is easy to get wrong:

| | Offline? | Reality |
|---|---|---|
| **Text to speech** | **Yes** | `speechSynthesis` uses voices installed on the device. Which voices exist is decided by the OS, not by us. |
| **Speech to text** | **No** | Chrome's `webkitSpeechRecognition` sends audio to Google's servers. It is **not** an offline capability despite the name. When the device is offline there is no browser fallback, and the app says so. |
| **Translation** | Partly | Previously fetched translations are cached in `translation_cache` and reused offline. Anything not already translated stays in English. |

## Languages, and their honest state

Priority order: **Assamese, Bodo, Manipuri/Meitei, Hindi, English.**

| Language | Translation | Speech → text | Text → speech |
|---|---|---|---|
| English | native | ✅ | ✅ |
| Hindi | ✅ | ✅ | ✅ |
| Assamese | ✅ | ❌ **none** | ✅ |
| Bodo | ✅ | ❌ **none** | ✅ |
| Manipuri | ✅ | ❌ **none** | ✅ |
| Bengali | ✅ | ✅ | ✅ |
| Marathi | ✅ | ✅ | ✅ |
| Nepali | ✅ | ❌ none | ❌ none |

These were **measured against the live Bhashini API**, not predicted. The
pipeline offers different languages for each task, which is exactly why the
app probes `GET /api/speech/capability?lang=…` instead of assuming.

**The consequence worth stating plainly:** a patient who speaks only
Assamese, Bodo or Manipuri can be *spoken to* by the app but cannot *speak
to it* — no speech recognition model exists for those languages on this
pipeline, and browser speech recognition is not offline for any language.
The microphone is hidden for them rather than offered and broken.
Everything with no credentials configured degrades the same way: the original
English is returned with `translated: false` and a machine-readable reason —
never a fabricated translation.

---

# Offline-first architecture

This app is built for areas where connectivity is weak, intermittent or
absent. The device is the primary place patient activity is written; the
server is a synchronisation destination, not a precondition for the app
working.

## Why these technology choices

| Layer | Choice | Why not the alternatives |
|---|---|---|
| Local database | **IndexedDB via Dexie** (`frontend/db.js`) | `localStorage` is synchronous, ~5MB and strings only - fine for a token, useless for a growing event log. SQLite-wasm needs OPFS plumbing and ~1MB of wasm for no gain here. PouchDB expects a CouchDB peer; this project already has REST + SQLite. Dexie ships a UMD build that drops in as one more `<script>`, matching a project with no build step. |
| Server database | **better-sqlite3, unchanged** | The existing schema was not touched. The offline layer adds two tables and one route. |
| Sync transport | **Batched REST + outbox** | The backend is REST; a replication protocol would have meant replacing it. |
| Live updates | **SSE, unchanged** | Already present from Part 2 and works fine alongside sync. |

## Data flow

```
              PATIENT DEVICE                                    SERVER
  +---------------------------------------+        +--------------------------+
  |  patient action (game / dose / miss)  |        |                          |
  |                 |                     |        |                          |
  |                 v                     |        |                          |
  |   +-----------------------------+     |        |                          |
  |   |   IndexedDB  (Dexie)        |     |        |                          |
  |   |   sessions - reminders -    |     |        |                          |
  |   |   schedules - alerts        |     |        |                          |
  |   +-------------+---------------+     |        |                          |
  |                 | same transaction    |        |                          |
  |                 v                     |        |                          |
  |   +-----------------------------+     |        |                          |
  |   |   OUTBOX (sync queue)       |     |        |                          |
  |   |   eventId - type - payload  |     |        |                          |
  |   |   retryCount - nextAttempt  |     |        |                          |
  |   +-------------+---------------+     |        |                          |
  |                 |                     |        |                          |
  |   +-------------v---------------+     |        |  POST /api/sync/batch    |
  |   |   SYNC ENGINE               |-----+------->|           |              |
  |   |   backoff - single-flight   |     |        |           v              |
  |   +-----------------------------+     |        |   sync_events (PK =      |
  |                 ^                     |        |   device UUID)           |
  |   +-------------+---------------+     |        |   accepted | duplicate   |
  |   |   CONNECTIVITY WATCH        |     |        |           |              |
  |   |   probes /api/health        |     |        |           v              |
  |   +-----------------------------+     |        |   sessions - reminders   |
  +---------------------------------------+        |   critical_alerts        |
                                                   |           |              |
                                                   |           v              |
                                                   |   CAREGIVER DASHBOARD    |
                                                   +--------------------------+
```

Nothing leaves the outbox because it was *sent*. A row is removed only
after the server confirms that event ID.

The cache is reconciled, not just appended to. On every successful refresh the
device drops local schedules and reminders the server no longer has, so a
schedule the caregiver deletes stops reappearing and stops generating
reminders. Two rules keep that safe: a row still marked `pending` is never
pruned, whatever the server says, and reminders are only judged on dates the
server actually reported on. Sessions are never pruned by absence at all — the
server sends only the selected date range, so a missing session means nothing.

## Critical alert path

```
        MEDICATION REMINDER DUE
                  |
                  v
    LOCAL MISSED-DOSE DETECTION          (reminder-engine.js - no network)
                  |
                  v
       alert written to IndexedDB
       + queued in the outbox
                  |
        +---------+----------+
        v                    v
  INTERNET AVAILABLE?   NO INTERNET
        |                    |
        v                    v
  POST /api/sync/batch   stays queued, retried with
        |                backoff, timestamp preserved
        v
  backend/sms_service.js
        |
   +----+-----+--------------+
   v          v              v
 gsm       http           console
 modem     gateway        logger
 (no       (needs         (dev only -
 internet  internet)      NOT delivered)
 needed)
        |
        v
  CAREGIVER RECEIVES SMS
```

## What a browser genuinely cannot do

These are platform limits, not gaps in the implementation. The app states
them to the user rather than implying capabilities it does not have.

| Capability | Reality | What this app does |
|---|---|---|
| Send an SMS from a web page | **Impossible.** No browser API exists. `sms:` links only open the messaging app and still need a human tap. | SMS leaves from the backend, via a gateway or a GSM modem. |
| Wake a closed device at an exact time | **Not dependable.** Notification Triggers is Chromium-only and mostly flagged off; Periodic Background Sync needs an installed PWA, is Chromium-only, and the browser picks the interval; push needs internet; iOS gives web apps effectively no background execution. | Reminders fire reliably while the app is open or backgrounded. Anything missed while it was closed is detected and alerted on the next launch, with the real due time preserved. For true alarms, wrap with Capacitor (below). |
| Guarantee IndexedDB is never evicted | Browsers may clear storage under pressure. | `navigator.storage.persist()` is requested at boot, and the caregiver dashboard shows how much is pending. |
| Work over plain HTTP | Service workers require HTTPS (or `localhost`). | Detected at boot; the app still runs, without offline start-up, and says so in the console. |

### For alarms that fire with the app closed

Wrap this exact frontend with **Capacitor** and schedule with Android's
`AlarmManager` (`setExactAndAllowWhileIdle`) plus a foreground service. No
rewrite is needed - the local database, outbox, sync engine and reminder
logic all run unchanged inside the WebView; only the *trigger* moves
native. The same wrapper can hold the `SEND_SMS` permission, which would
let the patient's own phone send the caregiver alert with no internet and
no separate modem.

## SMS configuration

Set these in `backend/.env`:

```bash
# Development (default): messages are printed, NOT delivered.
SMS_PROVIDER=console

# An internet SMS gateway (Twilio, MSG91, Gupshup, a state gateway).
SMS_PROVIDER=http
SMS_HTTP_URL=https://api.example.com/sms/send
SMS_HTTP_AUTH_HEADER=Bearer your-token
SMS_HTTP_BODY={"to":"{{to}}","from":"{{from}}","message":"{{text}}"}

# A GSM modem - the ONLY option that works with no internet at all.
SMS_PROVIDER=gsm
SMS_GSM_PORT=/dev/ttyUSB0     # or COM4 on Windows
SMS_GSM_BAUD=115200
```

For the GSM path also run `npm install serialport` in `backend/`. Expected
hardware: SIM800/SIM900 (2G) or SIM7600/SIM7670 (4G LTE) modules, and most
USB cellular dongles that expose an AT command port.

`GET /api/health` reports the truth about the current configuration:
`deliversRealSms` and `deliversWithoutInternet` are both `false` on the
default console provider, and the server prints a warning at startup.

### Deployment for "patient and caregiver both offline"

An SMS can only be sent by something with a radio. If this backend only
runs in a data centre, a patient with no internet cannot reach it. For
genuinely offline alerting, run a **local instance** near the patient - a
Raspberry-Pi-class box, a clinic machine, or the caregiver's laptop - with
a GSM modem attached and the patient's device on its Wi-Fi/hotspot:

```
patient device -> local Wi-Fi -> local backend -> GSM modem -> SMS -> caregiver
```

No internet anywhere in that chain. The local instance syncs upward to the
central server whenever a connection appears.

**If there is no cellular coverage either, no message can leave the area by
any means.** In that case the alert stays queued with its original
timestamp, is retried with exponential backoff when service returns, is
never sent twice (the alert ID is the idempotency key), and every attempt
is logged and visible on the caregiver dashboard.

## Security trade-offs, stated plainly

Offline operation means patient data rests on the device. The trade-offs
made here:

- **Stored locally:** the patient's own profile, their schedules, their
  reminders and their activity. Only for the signed-in patient.
- **Not stored locally:** password hashes, other patients' data, caregiver
  credentials. The JWT is kept in `localStorage` as before.
- **The device is trusted for reads while offline.** A stolen unlocked
  device exposes that patient's medication schedule and activity. This is
  the deliberate cost of the app working without a network - the same
  trade-off any offline health app makes.
- **Every write is still authorised server-side.** A queued event is
  accepted only if the token belongs to that patient or a linked
  caregiver; a device cannot sync data into someone else's record.
- **Local data is not encrypted at rest.** Browser IndexedDB has no
  practical key-storage story - a key kept beside the data protects
  nothing. Real at-rest encryption needs the OS keystore, which means the
  Capacitor wrapper.
- Use **HTTPS in production**; the service worker requires it anyway.

## Offline testing

```bash
node tests/e2e-offline.js
```

73 checks covering idempotency, no-data-loss, alert delivery status and PWA
assets. Also verified by hand in the browser: going offline mid-session,
playing a game and completing a dose with no network, reloading with the
network down, and reconnecting to drain the queue. The hardest case is
covered explicitly - **the server applies an event and the reply is lost**:
the device retries, the server answers `duplicate`, and no second record is
created.
