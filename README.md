# SmritiSaathi Care

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

Four suites, run against a live server. They create their own accounts and
data, so they can be run repeatedly without resetting anything.

```bash
node e2e.js         # Part 1 — accounts, auth, linking, isolation
node e2e-part2.js   # Part 2 — schedules, reminders, adherence, live updates
node e2e-part3.js   # Part 3 — analysis engine, translation, chart data
node e2e-part4.js   # Part 4 — reports, PDF/CSV, date filter, full demo flow
```

### Status — 254 automated checks, 0 failing

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
