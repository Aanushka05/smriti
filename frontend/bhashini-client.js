/* bhashini-client.js — SmritiSaathi Care
 * ---------------------------------------------------------------------
 * The ONLY translation mechanism in the whole app. There is no
 * `TRANSLATIONS = { en: {...}, hi: {...} }` object anywhere in this
 * project. Every non-English string shown on screen was produced by a
 * live call to POST /api/translate-ui, which the backend fulfils by
 * calling the real Bhashini pipeline (see backend/bhashini_service.js).
 *
 * SOURCE_STRINGS below holds ENGLISH TEXT ONLY, keyed for convenience.
 * Bhashini supplies every translated value at runtime, and results are
 * cached locally so we don't re-hit the API for text already translated.
 *
 * The product name "SmritiSaathi Care" is deliberately NOT translated —
 * it is a proper noun and is rendered from APP_NAME in config.js.
 * ---------------------------------------------------------------------
 */

const SOURCE_STRINGS = {
  tagline: 'A gentle companion for memory care',
  patient: 'Patient',
  caregiver: 'Caregiver / ASHA Worker',
  login: 'Login',
  register: 'Register',
  logout: 'Logout',
  back: 'Back',
  pleaseWait: 'Please wait…',
  startingUp: 'Starting up…',

  // ---- accounts ----
  username: 'Username',
  password: 'Password',
  confirmPassword: 'Confirm Password',
  usernameHint: 'Letters, numbers, dots and underscores. Example: rahul123',
  loginBtn: 'Login',
  registerBtn: 'Create account',
  fullName: 'Full Name',
  age: 'Age',
  gender: 'Gender',
  male: 'Male', female: 'Female', other: 'Other',
  mobileNumber: 'Mobile Number',
  emailOrPhone: 'Email or Phone Number',
  relationshipWithPatient: 'Relationship with patient',
  preferredLanguage: 'Preferred Language',
  emergencyContact: 'Emergency Contact',
  caregiverId: 'Caregiver ID (optional)',
  caregiverIdHint: 'If your caregiver already has an account, enter their username to connect.',
  optional: 'Optional',
  alreadyRegistered: 'Already registered? Login',
  newHereRegister: 'New here? Create an account',
  forgotPassword: 'Forgot password?',
  forgotPasswordHelp: 'Ask your caregiver or ASHA worker to reset your password from their dashboard.',
  roleFamily: 'Family Caregiver',
  roleAsha: 'ASHA Worker',
  roleChw: 'Community Health Worker',
  relSonDaughter: 'Son / Daughter',
  relSpouse: 'Spouse',
  relNurse: 'Nurse',
  demoAccounts: 'Demo accounts — patient: manisha / 1234 · caregiver: asha_demo / 1234',
  loggedInAs: 'Signed in as',
  loggedOut: 'You have been signed out.',
  passwordNeverShown: 'Passwords are hashed on the server and are never displayed anywhere in this app.',

  // ---- validation / status ----
  fillAllFields: 'Please fill in all required fields.',
  passwordsDontMatch: 'Password and Confirm Password do not match.',
  registrationSuccess: 'Registration successful. You are now signed in.',
  loginSuccess: 'Welcome back!',
  sessionExpired: 'Your session has expired. Please log in again.',
  pleaseLoginFirst: 'Please log in to open that page.',
  wrongRoleForPage: 'That page belongs to the other kind of account.',
  requestFailed: 'The request could not be completed',
  backendUnreachable: 'Cannot reach the SmritiSaathi Care server. Start the backend and try again.',
  backendUnreachableShort: 'Server not reachable',
  backendStartHint: 'Open a terminal in the backend folder and run: npm install, then npm start.',
  retryConnection: 'Try again',
  checkingServer: 'Checking the server…',
  connectedToServer: 'Connected to the server',
  liveData: 'Live data',
  switchingLanguage: 'Switching language…',

  // ---- patient app ----
  patientDashboard: 'Patient Dashboard',
  goodMorning: 'Welcome',
  chooseGame: 'Choose a game, or check today’s reminders below.',
  cognitiveGames: 'Cognitive Games',
  todaysReminders: "Today's reminders",
  mySchedule: 'My schedule',
  done: 'Done', later: 'Later', missed: 'Missed', pending: 'Pending',
  playGame: 'PLAY GAME', backHome: '← Back home', playAgain: 'Play Again',
  score: 'Score', accuracy: 'Accuracy', avgResponseTime: 'Average response time',
  activityComplete: 'Activity Complete',
  hearReminder: 'Hear', online: 'Online', offline: 'Offline',
  level: 'Level', round: 'Round', tapToSpeak: 'Tap to Speak', listening: 'Listening…',
  voiceNotSupported: "Voice input isn't available on this browser. You can still use the buttons.",
  correct: '✓ Correct! Good job!', tryNext: "That's okay. Let's try the next one.",
  sessionSaved: 'Session saved. Your caregiver can see it on their dashboard.',
  sessionNotSaved: 'The session could not be saved. Please check your connection.',
  reminderMarkedDone: 'Marked as done.',
  reminderUpdated: 'Reminder updated.',
  noRemindersYet: 'No reminders yet.',

  // ---- caregiver dashboard ----
  caregiverDashboard: 'Caregiver Dashboard',
  myPatients: 'My Patients',
  addPatient: 'Add Patient',
  patientProfile: 'Patient Profile',
  patientPerformance: 'Patient Performance',
  cognitivePerformance: 'Cognitive Performance',
  schedule: 'Schedule',
  reminders: 'Reminders',
  reports: 'Reports',
  aiAnalysis: 'AI Analysis',
  notifications: 'Notifications',
  noNotifications: 'No notifications yet.',
  markAllRead: 'Mark all as read',
  selectPatient: 'Select patient',
  selectPatientFirst: 'Add or select a patient first.',
  patientsConnected: 'patients connected',
  noPatientsYet: 'You have not added any patients yet.',
  emptyDashboardTitle: 'Your dashboard is ready',
  emptyDashboardBody: 'Add your first patient to start tracking reminders, schedules and cognitive activity.',
  patientId: 'Patient ID',
  openPatient: 'Open',
  removePatient: 'Remove from my list',
  confirmRemovePatient: 'Remove this patient from your list?',
  patientRemoved: 'Patient removed from your list.',
  decliningIn: 'Declining in',
  lastSession: 'Last session',
  never: 'Never',
  addPatientSubtitle: 'Connect a patient who already has an account, or register a new one.',
  linkExistingPatient: 'Connect existing patient',
  createNewPatient: 'Register new patient',
  linkPatientHelp: 'Enter the Patient ID (username) or mobile number of a patient who already has an account.',
  patientIdOrUsername: 'Patient ID / Username',
  connectPatient: 'Connect patient',
  createPatientHelp: 'Create a login for a patient who does not have one yet. They can sign in with these credentials on their own device.',
  registerAndConnect: 'Register and connect',
  basicDetails: 'Basic details',
  accountAndLinks: 'Account',
  registeredOn: 'Registered on',
  connectedCaregivers: 'Connected caregivers',
  familyMembers: 'Family members',
  familyMembersHelp: 'Family members are used by the Family Faces memory game.',
  noFamilyMembers: 'No family members added yet.',
  familyMemberAdded: 'Family member added.',
  name: 'Name', relation: 'Relation', add: 'Add', remove: 'Remove',
  saveChanges: 'Save changes',
  profileUpdated: 'Profile updated.',

  totalSessions: 'Total sessions',
  overallAccuracy: 'Overall accuracy',
  reminderCompletion: 'Reminder completion',
  acrossThreeDomains: 'across all activity areas',
  weightedAverage: 'average of all sessions',
  perQuestion: 'per question',
  today: 'today',
  adherenceSub: 'of reminders that came due',
  average: 'Average', best: 'Best', trend: 'Trend', game: 'Game',
  trend_improving: 'Improving', trend_declining: 'Declining',
  trend_steady: 'Steady', trend_none: 'No data',
  performanceObservation: 'Areas requiring attention',
  observedActivity: 'Observed activity',
  performanceTrend: 'Performance trend',
  declineMessage: 'accuracy has decreased over the last 3 sessions. This is a prompt to check in — not a diagnosis.',
  improvingMessage: 'performance is improving compared to the first recorded session.',
  recentSessions: 'Recent sessions',
  noSessionsYet: 'No sessions yet.',
  noCognitiveSessions: 'No cognitive sessions recorded yet.',
  time: 'Time', domain: 'Domain', avgTime: 'Avg time', sessions: 'Sessions',
  completed: 'Completed', postponed: 'Postponed',
  statusesUpdateLive: "Statuses update live from the patient's device.",
  adherence: 'Adherence',
  cognitivePerformanceOverTime: 'Cognitive performance over time',
  averageByDomain: 'Average by domain',
  averageResponseTimeOverSessions: 'Average response time over sessions',
  reminderAdherence: 'Reminder adherence',

  plannedActivities: 'Planned activities',
  noSchedulesYet: 'No schedule entries yet.',
  addSchedule: 'Add to schedule',
  scheduleAdded: 'Schedule added and shown on the patient’s home screen.',
  scheduleRemoved: 'Schedule removed.',
  scheduleCreatesReminder: 'Adding a schedule also creates a reminder card on the patient’s home screen.',
  scheduleTitlePlaceholder: 'Morning medicine',
  title: 'Title', category: 'Category', repeats: 'Repeats', notes: 'Notes',
  repeat_daily: 'Every day', repeat_weekly: 'Every week', repeat_once: 'Once',
  catMedicine: 'Medicine', catHydration: 'Hydration', catAppointment: 'Appointment',
  catExercise: 'Exercise', catActivity: 'Activity', catGeneral: 'General',

  generateReport: 'Generate a progress report',
  generate: 'Generate',
  period: 'Period',
  last7Days: 'Last 7 days', last30Days: 'Last 30 days', last90Days: 'Last 90 days', allTime: 'All time',
  downloadHtml: 'Download report',
  downloadCsv: 'Download CSV',
  reportHelp: 'The report is built from this patient’s stored sessions and reminders. The download opens in any browser and can be printed or shared.',
  noReportYet: 'Generate a report to see it here.',
  progressReport: 'Progress report',
  generated: 'Generated',
  reportReady: 'Report ready.',
  reportDownloaded: 'Report downloaded.',
  reportFailed: 'The report could not be downloaded.',

  analysisHelp: 'The analysis reads this patient’s recorded sessions, trends and reminder adherence. If an AI key is configured on the server it is also written up as a short note for you.',
  runAnalysis: 'Run analysis',
  analysing: 'Analysing…',
  noAnalysisYet: 'Run the analysis to see what the recorded activity shows.',
  whatTheDataShows: 'What the data shows',
  suggestedNextSteps: 'Suggested next steps',
  sourceAi: 'AI write-up',
  sourceRules: 'Built-in analysis',

  // ---- games ----
  familyFaces: 'Family Faces', spotOddOne: 'Spot the Odd One', weavingCompletion: 'Weaving Completion',
  memory: 'Memory', attention: 'Attention', patternRecognition: 'Pattern Recognition',
  familyFacesInstructions: 'Look carefully, then say who is in the photo.',
  needFamilyMembers: 'Add at least two family members first — ask your caregiver to add them from the Patient Profile page.',
  spotOddOneInstructions: 'Tap the picture that is different from the others.',
  weavingInstructions: 'Complete the missing part of the weaving pattern.',
  notDiagnosis: 'This is an activity-based observation and not a medical diagnosis.',

  // ---- Part 2: loading / empty / error states ----
  loading: 'Loading…',
  couldNotLoad: 'Could not load this',
  genericLoadError: 'Something went wrong. Please try again.',
  tryAgain: 'Try again',
  cancel: 'Cancel',
  close: 'Close',
  edit: 'Edit',
  delete: 'Delete',
  actions: 'Actions',
  liveUpdates: 'Live',
  autoRefresh: 'Auto-refresh',
  offlineUpdates: 'Not updating',
  liveUpdatesHelp: 'This screen updates by itself when anything changes.',
  autoRefreshHelp: 'Live updates are unavailable, so this screen refreshes on a timer.',

  // ---- Part 2: patient dashboard ----
  goodMorningGreeting: 'Good morning',
  goodAfternoonGreeting: 'Good afternoon',
  goodEveningGreeting: 'Good evening',
  todaysSchedule: "Today's schedule",
  todaysActivities: "Today's activities",
  nextReminder: 'Next reminder',
  nothingComingUp: 'Nothing coming up right now.',
  noScheduleYet: 'Your caregiver has not added a schedule yet.',
  noRemindersToday: 'No reminders for today.',
  markDone: 'Done',
  snooze: 'Snooze',
  snooze15: 'Remind me later',
  snoozed: 'Snoozed',
  doneLower: 'done',
  today: 'Today',
  tomorrow: 'Tomorrow',
  until: 'until',
  important: 'Important',
  todaysAdherence: "Today's completion",
  myPerformance: 'My performance',
  myProgress: 'My progress',
  activitiesDone: 'Activities done',
  overallScore: 'Overall score',
  averageAnswerTime: 'Average answer time',
  byActivityArea: 'By activity area',
  noSessionsYetPatient: 'No activities completed yet. Try a game below to get started.',
  progressUp: 'Your recent scores are going up. Keep going!',
  progressDown: 'Your recent scores are a little lower. That is normal — try again when you are rested.',
  progressSteady: 'Your recent scores are steady.',
  lastActivitiesChart: 'Scores from your recent activities',
  lastNActivities: 'Your last {n} activities',
  voiceHelp: 'Voice',
  youSaid: 'You said',
  voiceExamples: 'You can say things like:',
  voiceCmdReminders: "Show today's reminders",
  voiceCmdNext: "What's my next activity?",
  voiceCmdGame: 'Start memory game',
  voiceCmdRead: 'How am I doing?',
  voiceNoSpeech: "I didn't hear anything. Please try again.",
  voiceFailed: 'Voice input did not work. You can use the buttons instead.',
  voiceNotUnderstood: "I didn't understand that. Try saying: show today's reminders.",
  allRemindersDone: 'All of today’s reminders are done. Well done!',
  helpAndContacts: 'Help',
  callEmergencyContact: 'Call for help',
  noEmergencyContact: 'No emergency contact has been added yet. Ask your caregiver to add one.',
  myCaregivers: 'My caregivers',
  reminderSnoozed: 'Reminder snoozed.',
  reminderMarkedMissed: 'Marked as missed.',

  // ---- Part 2: games ----
  memoryMatch: 'Memory Match',
  memoryMatchInstructions: 'Find the two cards that show the same picture.',
  memorise: 'Look carefully and remember where the pictures are.',
  hiddenCard: 'Hidden card',
  pairsFound: 'Pairs found',
  sequenceRecall: 'Sequence Recall',
  sequenceRecallInstructions: 'Tap the colours in the same order you saw them.',
  watchTheOrder: 'Watch the order carefully.',
  undo: 'Undo',
  wordRecall: 'Word Recall',
  wordRecallInstructions: 'Tap the word that does NOT belong with the others.',
  readAloud: 'Read aloud',
  dayAndDate: 'Day and Date',
  dayAndDateInstructions: 'Simple questions about today.',
  whichDayToday: 'Which day is it today?',
  whichPartOfDay: 'Is it morning, afternoon, evening or night?',
  whichMonth: 'Which month is it?',
  whichDateToday: 'What is the date today?',
  whichSeason: 'Which season is it?',
  language: 'Language',
  orientation: 'Orientation',
  problemSolving: 'Problem solving',

  // ---- Part 2: caregiver schedule ----
  activity: 'Activity',
  activityName: 'Activity / task name',
  activityNameRequired: 'Please enter the activity or task name.',
  description: 'Description',
  descriptionPlaceholder: 'One line the patient will see',
  date: 'Date',
  dateHint: 'Start date for a repeating activity, or the day for a one-time one.',
  dateRequiredForOnce: 'A one-time activity needs a date.',
  timeRequired: 'Please choose a time.',
  priority: 'Priority',
  priority_low: 'Low', priority_normal: 'Normal', priority_high: 'High',
  reminderType: 'Reminder type',
  remType_app: 'On screen', remType_voice: 'Spoken', remType_both: 'Screen and spoken', remType_none: 'No reminder',
  repeat_monthly: 'Every month',
  catMeal: 'Meal', catTherapy: 'Therapy',
  editSchedule: 'Edit schedule',
  scheduleSaved: 'Schedule saved.',
  confirmDeleteSchedule: 'Delete this schedule? Reminders already completed or missed are kept in the history.',
  viewUpcoming: 'Upcoming',
  upcomingSchedules: 'Upcoming schedules',
  nothingScheduledAhead: 'Nothing scheduled in the next few days.',

  // ---- Part 2: caregiver reminders ----
  totalReminders: 'Total reminders',
  markMissed: 'Missed',
  snoozeForMinutes: 'Snooze for how many minutes?',
  snoozeRange: 'Please choose between 5 and 180 minutes.',
  noAdherenceData: 'No reminders have come due yet.',

  // ---- Part 4: overview, date range, reports ----
  overview: 'Overview',
  acrossAllPatients: 'Across all your patients',
  totalPatients: 'Total patients',
  completedTasks: 'Completed tasks',
  missedTasks: 'Missed tasks',
  averagePerformance: 'Average performance',
  patientsWithActivity: 'patients with activity',
  noActivityYet: 'No activity recorded yet',
  stillPending: 'still to do',
  addYourFirstPatient: 'Add your first patient',
  upcomingSchedule: 'Upcoming schedule',
  nothingLeftToday: 'Nothing left for today.',
  manageSchedule: 'Manage schedule',
  viewAll: 'View all',
  activityToday: 'Activity today',
  sessionCompletedToday: 'activity completed today',
  sessionsCompletedToday: 'activities completed today',
  cognitiveTrends: 'Cognitive Trends',
  profile: 'Profile',

  dateRange: 'Date range',
  rangeToday: 'Today',
  rangeLast7: 'Last 7 days',
  rangeLast30: 'Last 30 days',
  rangeThisYear: 'This year',
  rangeAll: 'All time',
  rangeCustom: 'Custom range',
  rangeInvalid: 'The start date must be before the end date.',
  rangePickBothDates: 'Please choose both a start and an end date.',
  from: 'From', to: 'to', apply: 'Apply',
  showing: 'Showing',
  showingAllActivity: 'Showing all recorded activity',

  downloadReport: 'Download report',
  reportPeriod: 'Report period',
  periodDaily: 'Daily', periodWeekly: 'Weekly',
  periodMonthly: 'Monthly', periodYearly: 'Yearly', periodAll: 'All time',
  preview: 'Preview',
  downloadPdf: 'Download PDF',
  reportContentNote: 'The report contains the patient details, performance by activity area, reminder adherence, cognitive sessions and the data analysis — all from this patient’s stored records.',
  patientInformation: 'Patient information',
  performanceSummary: 'Performance summary',
  reminderSummary: 'Reminder summary',
  cognitiveSessionsHeading: 'Cognitive sessions',
  numberOfSessions: 'Number of sessions',
  averageScore: 'Average score',
  overallScore: 'Overall score',
  dataAnalysis: 'Data analysis',
  suggestedCaregiverActions: 'Suggested caregiver actions',
  noSessionsInPeriod: 'No sessions in this period.',

  // ---- Part 3: AI insights ----
  aiInsights: 'AI Insights',
  overallTrend: 'Overall trend',
  strengths: 'Strengths',
  areasToWatch: 'Areas to watch',
  recommendedActions: 'Recommended actions',
  recalculate: 'Recalculate',
  writeUp: 'AI write-up',
  sourceEngine: 'Built-in analysis',
  figuresBehindThis: 'The figures behind this',
  figuresBehindThisHelp: 'Every statement above is derived from these stored values.',
  activityArea: 'Activity area',
  bestScore: 'Best score',
  activeDays: 'Active days',
  trend_insufficient_data: 'Insufficient data',

  // ---- Part 3: charts ----
  chartsUnavailable: 'The chart library could not be loaded. The figures above are still live.',
  noPerformanceData: 'No performance data available yet.',
  noResponseTimeData: 'No response times recorded yet.',
  loadingPerformance: 'Loading performance…',
  couldNotLoadPerformance: 'Unable to load performance data. Try again.',
  sessionSingular: 'session',
  noneDueYet: 'Nothing has come due yet.',
  overallAdherence: 'Overall adherence',

  // ---- chat ----
  chatTitle: 'Chat with SmritiSaathi Care',
  chatPlaceholder: 'Type your message…',
  chatSend: 'Send',
  chatClear: 'Clear conversation',
  chatThinking: 'Thinking…',
  chatError: "I couldn't reach the assistant just now. Please try again.",
};

const I18N_CACHE_KEY = 'smritisaathi_i18n_cache_v2';

function loadCache() {
  try { return JSON.parse(localStorage.getItem(I18N_CACHE_KEY)) || {}; } catch (e) { return {}; }
}
function saveCache(cache) {
  try { localStorage.setItem(I18N_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
}

const i18n = {
  currentLang: 'en-IN',
  cache: loadCache(),
  onChange: null,
  lastFailureReason: null,
  lastFailureCode: null,
  busy: false,               // a language switch is in flight

  base(code) { return (code || 'en-IN').split('-')[0].toLowerCase(); },

  /** Plain-English explanation of the last failure, for the user. */
  failureMessage() {
    if (!this.lastFailureCode) return null;
    const byCode = {
      not_configured: 'Translation is not configured on the server, so the app is showing English.',
      unsupported_language: 'That language is not available for translation yet, so the app is showing English.',
      timeout: 'The translation service did not respond in time, so the app is showing English.',
      unreachable: 'The translation service could not be reached, so the app is showing English.',
      service_error: 'The translation service returned an error, so the app is showing English.',
    };
    return byCode[this.lastFailureCode] || 'Translation is unavailable, so the app is showing English.';
  },

  /** Synchronous lookup used everywhere in render code: t(key) or t(freeText) */
  tr(keyOrText) {
    const english = SOURCE_STRINGS[keyOrText] || keyOrText;
    const b = this.base(this.currentLang);
    if (b === 'en') return english;
    const bucket = this.cache[b];
    return (bucket && bucket[english]) || english;
  },

  /** Translate arbitrary strings through the backend, and cache them. */
  async translateDynamic(texts, targetLangCode) {
    const b = this.base(targetLangCode || this.currentLang);
    if (b === 'en' || !texts.length) return texts.slice();
    this.cache[b] = this.cache[b] || {};
    const missing = texts.filter((text) => !(text in this.cache[b]));
    if (missing.length) {
      const res = await apiFetch('/translate-ui', {
        method: 'POST',
        auth: false,
        body: { texts: missing, sourceLanguage: 'en', targetLanguage: b },
      });
      if (res.ok && res.data && Array.isArray(res.data.translations)) {
        if (res.data.translated === false) {
          // The backend answered, but Bhashini could not: keep the English
          // and remember exactly why so the UI can explain it.
          this.lastFailureReason = res.data.reason || null;
          this.lastFailureCode = res.data.reasonCode || 'service_error';
        } else {
          this.lastFailureReason = null;
          this.lastFailureCode = null;
          missing.forEach((orig, i) => { this.cache[b][orig] = res.data.translations[i] || orig; });
          saveCache(this.cache);
        }
      } else {
        // Could not reach our own backend at all.
        this.lastFailureReason = res.error || null;
        this.lastFailureCode = res.offline ? 'unreachable' : 'service_error';
      }
    }
    return texts.map((text) => this.cache[b][text] || text);
  },

  /** Changing the language = one batch call to Bhashini for the whole
   * vocabulary, not a lookup into a hand-written table.
   *
   * English needs no round trip at all, so switching back is instant and
   * always works — that is the fallback language when anything goes wrong. */
  async setLanguage(langCode) {
    const b = this.base(langCode);
    this.busy = b !== 'en';
    if (this.busy && typeof render === 'function') render();  // show the busy state

    try {
      this.currentLang = langCode;
      if (b !== 'en') await this.translateDynamic(Object.values(SOURCE_STRINGS), langCode);
    } finally {
      this.busy = false;
    }

    if (typeof this.onChange === 'function') this.onChange(langCode);

    if (b !== 'en' && this.lastFailureCode && typeof showToast === 'function') {
      showToast(this.failureMessage());
    }
  },
};

// Backwards-compatible helper name used throughout the rest of the app.
function t(key) { return i18n.tr(key); }
