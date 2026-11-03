// Part 4 checks: the report system (periods, PDF, CSV, content), the shared
// date filter, the caregiver overview, and the complete SIH demo flow run
// end to end against a running server with no manual setup.
const BASE = 'http://localhost:5000/api';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

let pass = 0, fail = 0;
const OUT = process.argv[2] || '.';

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

async function rawCall(path_, { method = 'GET', body, token }

 = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path_, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

/* Login is a two-step flow now: password, then a 6-digit code. This suite is
 * not about authentication, so `call` completes the second step itself and
 * returns the finished session — every existing assertion on .data.token
 * keeps working unchanged. The code comes from OTP_DEV_ECHO, which is
 * development-only and refused when NODE_ENV=production. */
/* Patient registration requires an emergency contact. These suites are about
 * other features, so `call` supplies a valid default rather than repeating
 * it at forty call sites. e2e-security.js deliberately does NOT do this —
 * it is the suite that proves the field is actually enforced. */
const TEST_EMERGENCY = '9800000000';

function withRequiredFields(path, opts) {
  const body = opts && opts.body;
  if (!body || typeof body !== 'object') return opts;
  const registersPatient = path.includes('/auth/register/patient')
    || (path.includes('/caregiver/patients') && body.mode === 'create');
  if (registersPatient && body.emergencyContact === undefined) {
    return { ...opts, body: { ...body, emergencyContact: TEST_EMERGENCY } };
  }
  return opts;
}

async function call(path, opts = {}) {
  const first = await rawCall(path, withRequiredFields(path, opts));
  if (!first.data || !first.data.mfaRequired) return first;
  if (!first.data.devCode) {
    throw new Error('Login needs a verification code, but OTP_DEV_ECHO is not enabled. '
      + 'Set OTP_DEV_ECHO=true in backend/.env to run these suites.');
  }
  const verified = await rawCall('/auth/verify-otp', {
    method: 'POST',
    body: { challengeId: first.data.challengeId, code: first.data.devCode },
  });
  // Keep the status of the operation the caller actually asked for: a
  // registration is a 201 even though the code that completes it answers 200.
  return { ...verified, status: first.status === 201 ? 201 : verified.status };
}


async function download(path_, token) {
  const res = await fetch(BASE + path_, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  const cd = res.headers.get('content-disposition') || '';
  return {
    status: res.status, buf,
    type: (res.headers.get('content-type') || '').split(';')[0],
    filename: (cd.match(/filename="([^"]+)"/) || [])[1],
  };
}

/**
 * Pulls readable text out of a pdfkit PDF.
 *
 * Streams are located by the /Length in their object dictionary and sliced
 * by exact byte count — matching forward to "endstream" with a regex is
 * unreliable, because deflate output can contain those bytes and silently
 * truncate the stream.
 */
function pdfText(buf) {
  const s = buf.toString('latin1');
  let streams = '';
  const re = /\/Length\s+(\d+)[\s\S]{0,200}?stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const length = Number(m[1]);
    const start = m.index + m[0].length;
    try {
      streams += zlib.inflateSync(buf.subarray(start, start + length)).toString('latin1');
    } catch (e) { /* not a deflate stream (fonts, images) */ }
  }
  const parts = [];
  const hex = /<([0-9A-Fa-f]+)>/g;
  while ((m = hex.exec(streams))) parts.push(Buffer.from(m[1], 'hex').toString('latin1'));
  return parts.join('');
}

const stamp = Date.now().toString().slice(-6);

(async () => {
  /* ============================================================
     THE COMPLETE SIH DEMO FLOW — no code edits, no db edits,
     no hard-coded users. Everything below is created by this run.
     ============================================================ */
  console.log('\n== SIH demo flow: caregiver registration -> login ==');
  const CG_USER = `demo_cg_${stamp}`;
  let r = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Demo Caregiver', username: CG_USER, password: 'demo@1234', confirmPassword: 'demo@1234',
    contact: `demo${stamp}@example.org`, relationship: 'ASHA Worker', role: 'asha',
  } });
  check('1. caregiver registration creates a usable account', r.status === 201 && !!r.data.token, r.data);
  check('   new caregiver starts with no patients', r.data.patients.length === 0, r.data.patients);

  r = await call('/auth/login', { method: 'POST', body: { username: CG_USER, password: 'demo@1234' } });
  check('2. caregiver logs in with those same credentials', r.status === 200 && r.data.role === 'caregiver', r.data);
  const CG = r.data.token;

  console.log('\n== add patient -> patient registration/linking ==');
  const PT_USER = `demo_pt_${stamp}`;
  r = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Demo Patient', username: PT_USER,
    password: 'pat@1234', confirmPassword: 'pat@1234', age: 73, gender: 'Female', lang: 'en-IN',
  } });
  check('3. Add Patient registers a real patient account', r.status === 201 && r.data.created, r.data);
  const PID = r.data.patient.id;

  r = await call('/caregiver/patients', { token: CG });
  check('   the patient is linked to this caregiver', r.data.patients.length === 1 && r.data.patients[0].id === PID, r.data.patients);
  check('   no invented statistics for a brand-new patient',
    r.data.patients[0].totalSessions === 0 && r.data.patients[0].overallAccuracy === null
    && r.data.patients[0].reminderCompletion === null, r.data.patients[0]);

  console.log('\n== add schedule ==');
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: {
    title: 'Morning Medicine', description: 'One tablet after breakfast', category: 'Medicine',
    time: '08:00', repeat: 'daily', reminderType: 'both', priority: 'high', notes: 'Blue box',
  } });
  check('4. caregiver schedule is saved', r.status === 201 && r.data.schedule.title === 'Morning Medicine', r.data);
  await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: {
    title: 'Memory Exercise', category: 'Activity', time: '18:00', repeat: 'daily',
  } });

  console.log('\n== patient login -> sees the schedule ==');
  r = await call('/auth/login', { method: 'POST', body: { username: PT_USER, password: 'pat@1234' } });
  check('5. patient logs in with the credentials the caregiver set', r.status === 200 && r.data.role === 'patient', r.data);
  const PT = r.data.token;

  r = await call(`/patients/${PID}/schedules`, { token: PT });
  check('6. patient sees the caregiver\'s schedule', r.data.schedules.length === 2, r.data.schedules.map((s) => s.title));
  r = await call(`/patients/${PID}/reminders`, { token: PT });
  check('   reminders were generated from it', r.data.reminders.some((x) => x.title === 'Morning Medicine'), r.data.reminders.map((x) => x.title));

  console.log('\n== patient completes cognitive activities -> performance saved ==');
  const played = [
    ['memory', 'Memory Match', 0.6, 5200], ['memory', 'Family Faces', 0.8, 4600],
    ['memory', 'Memory Match', 0.9, 4100], ['attention', 'Spot the Odd One', 0.7, 4800],
    ['attention', 'Spot the Odd One', 0.5, 6200], ['language', 'Word Recall', 1.0, 3400],
    ['orientation', 'Day and Date', 0.8, 4200], ['problem_solving', 'Sequence Recall', 0.6, 6100],
    ['pattern', 'Weaving Completion', 0.8, 4400],
  ];
  let allSaved = true;
  for (const [domain, gameType, accuracy, avgTimeMs] of played) {
    const res = await call('/game-results', { method: 'POST', token: PT, body: {
      patientId: PID, domain, gameType, level: 2, score: Math.round(accuracy * 5),
      totalRounds: 5, accuracy, avgTimeMs, answers: [{ q: 1, isCorrect: true, responseTimeMs: 3000 }],
    } });
    if (res.status !== 201) allSaved = false;
  }
  check('7. every completed activity was saved', allSaved);

  r = await call(`/patients/${PID}/sessions`, { token: CG });
  check('   score saved', r.data.length === played.length, r.data.length);
  check('   response time saved', r.data.every((s) => typeof s.avgTimeMs === 'number' && s.avgTimeMs > 0));
  check('   game type and timestamp saved', r.data.every((s) => !!s.gameType && !!s.ts));

  console.log('\n== caregiver dashboard updates ==');
  r = await call('/caregiver/patients', { token: CG });
  const summary = r.data.patients[0];
  check('8. caregiver summary reflects the activity', summary.totalSessions === played.length, summary);
  const expectedAvg = Math.round((played.reduce((a, p) => a + p[2], 0) / played.length) * 100);
  check('   overall accuracy is the real mean', summary.overallAccuracy === expectedAvg, { got: summary.overallAccuracy, expected: expectedAvg });

  r = await call('/caregiver/overview', { token: CG });
  check('9. overview counts this caregiver\'s patients', r.data.totalPatients === 1, r.data);
  check('   overview counts today\'s reminders', r.data.todaysReminders >= 2, r.data.todaysReminders);
  check('   overview average performance is real', r.data.averagePerformance === expectedAvg, { got: r.data.averagePerformance, expected: expectedAvg });
  check('   overview counts today\'s sessions', r.data.sessionsToday === played.length, r.data.sessionsToday);

  console.log('\n== graph data updates ==');
  r = await call(`/patients/${PID}`, { token: CG });
  check('10. the record the charts read carries every session', r.data.sessions.length === played.length, r.data.sessions.length);
  check('    per-area figures for the range are present', r.data.rangeMetrics.length === 6, r.data.rangeMetrics.length);
  const memMetric = r.data.rangeMetrics.find((m) => m.domain === 'memory');
  check('    memory average matches the three memory sessions',
    Math.round(memMetric.avg_accuracy * 100) === Math.round(((0.6 + 0.8 + 0.9) / 3) * 100), memMetric);

  console.log('\n== AI analysis updates from that data ==');
  r = await call(`/patients/${PID}/analysis`, { token: CG });
  check('11. analysis describes a trend now there is enough data', r.data.overallTrend !== 'insufficient_data', r.data.overallTrendLabel);
  check('    session count matches', r.data.figures.sessions === played.length, r.data.figures.sessions);
  check('    strengths / areas / actions all populated',
    r.data.strengths.length > 0 && r.data.areasToWatch.length > 0 && r.data.recommendedActions.length > 0,
    { s: r.data.strengths.length, a: r.data.areasToWatch.length, r: r.data.recommendedActions.length });

  /* ============================================================
     REPORT SYSTEM
     ============================================================ */
  console.log('\n== report periods ==');
  r = await call('/report/periods', { token: CG });
  check('12. daily / weekly / monthly / yearly all offered',
    ['daily', 'weekly', 'monthly', 'yearly'].every((k) => r.data.periods.some((p) => p.key === k)),
    r.data.periods.map((p) => p.key));
  check('    pdf and csv are offered', r.data.formats.includes('pdf') && r.data.formats.includes('csv'), r.data.formats);

  const periodResults = {};
  for (const period of ['daily', 'weekly', 'monthly', 'yearly']) {
    const res = await call(`/patients/${PID}/report?period=${period}`, { token: CG });
    periodResults[period] = res.data.report;
    check(`    ${period} report generated`, res.status === 200 && !!res.data.report, res.status);
  }

  console.log('\n== report content is the patient\'s real data ==');
  const rep = periodResults.weekly;
  check('13. carries the application name', rep.app === 'Smriti', rep.app);
  check('    patient name / ID / age present', rep.patient.name === 'Demo Patient' && rep.patient.patientId === PT_USER && rep.patient.age === 73, rep.patient);
  check('    report period named', rep.period.label === 'Weekly', rep.period);
  check('    overall score matches the sessions', rep.performance.overallScore === expectedAvg, { got: rep.performance.overallScore, expected: expectedAvg });
  check('    response time present', typeof rep.performance.averageResponseSeconds === 'number', rep.performance.averageResponseSeconds);
  const areas = rep.performance.byDomain.map((d) => d.domain);
  check('    all six activity areas covered',
    ['memory', 'attention', 'language', 'orientation', 'problem_solving', 'pattern'].every((d) => areas.includes(d)), areas);
  check('    reminder summary complete',
    ['total', 'completed', 'missed', 'snoozed'].every((k) => typeof rep.reminders[k] === 'number') && 'adherence' in rep.reminders,
    rep.reminders);
  check('    cognitive session block complete',
    rep.cognitiveSessions.count === played.length && rep.cognitiveSessions.averageScore === expectedAvg
    && rep.cognitiveSessions.recent.length > 0 && !!rep.cognitiveSessions.trend,
    { c: rep.cognitiveSessions.count, avg: rep.cognitiveSessions.averageScore });
  check('    analysis block complete',
    !!rep.analysis.overallTrendLabel && Array.isArray(rep.analysis.strengths)
    && Array.isArray(rep.analysis.areasToWatch) && Array.isArray(rep.analysis.recommendedActions),
    rep.analysis && Object.keys(rep.analysis));
  check('    carries a non-diagnostic note', /not a medical assessment or diagnosis/i.test(rep.disclaimer));

  console.log('\n== periods actually filter ==');
  // Backdating is not possible through the API, so compare a zero-width
  // custom window against the full one instead.
  const empty = (await call(`/patients/${PID}/report?from=${Date.now() - 2000}&to=${Date.now() - 1000}`, { token: CG })).data.report;
  check('14. an empty window reports zero sessions, not the full set', empty.cognitiveSessions.count === 0, empty.cognitiveSessions.count);
  check('    and says so rather than showing 0%', empty.performance.overallScore === null, empty.performance.overallScore);
  check('    a full window still has them', periodResults.yearly.cognitiveSessions.count === played.length);

  console.log('\n== PDF download ==');
  let d = await download(`/patients/${PID}/report/download?format=pdf&period=weekly`, CG);
  check('15. PDF downloads (200)', d.status === 200, d.status);
  check('    content-type is application/pdf', d.type === 'application/pdf', d.type);
  check('    it is a real PDF', d.buf.slice(0, 5).toString() === '%PDF-' && d.buf.toString('latin1').trimEnd().endsWith('%%EOF'));
  check('    filename names the app, period and patient',
    /Smriti_Weekly_Report_Demo_Patient_\d{4}-\d{2}-\d{2}\.pdf/.test(d.filename || ''), d.filename);
  fs.writeFileSync(path.join(OUT, d.filename), d.buf);

  const text = pdfText(d.buf);
  const required = [
    'Smriti', 'Weekly report', 'Patient information', 'Demo Patient', PT_USER, '73',
    'Performance summary', 'Overall score', 'Response time',
    'Memory', 'Attention', 'Language', 'Orientation', 'Problem solving', 'Pattern recognition',
    'Reminder summary', 'Total reminders', 'Completed', 'Missed', 'Snoozed', 'Adherence',
    'Cognitive sessions', 'Number of sessions', 'Average score', 'Best score', 'Trend', 'Recent performance',
    'Data analysis', 'Overall trend', 'Strengths', 'Areas to watch', 'Suggested caregiver actions',
    'not a medical assessment or diagnosis',
  ];
  const missing = required.filter((w) => !text.includes(w));
  check('16. the PDF contains every required section', missing.length === 0, missing);
  check('    the PDF shows this patient\'s real overall score', text.includes(`${expectedAvg}%`), expectedAvg);
  check('    the PDF has a chart (bar labels next to each area)',
    text.includes('Average score by activity area') && text.includes('Session scores over the period'));

  for (const period of ['daily', 'monthly', 'yearly']) {
    const dd = await download(`/patients/${PID}/report/download?format=pdf&period=${period}`, CG);
    check(`    ${period} PDF downloads`, dd.status === 200 && dd.buf.slice(0, 5).toString() === '%PDF-', dd.status);
  }

  console.log('\n== CSV download ==');
  d = await download(`/patients/${PID}/report/download?format=csv&period=weekly`, CG);
  check('17. CSV downloads (200)', d.status === 200, d.status);
  check('    content-type is text/csv', d.type === 'text/csv', d.type);
  check('    filename ends .csv', /\.csv$/.test(d.filename || ''), d.filename);
  fs.writeFileSync(path.join(OUT, d.filename), d.buf);
  const csv = d.buf.toString('utf8');
  const csvNeeds = ['PATIENT INFORMATION', 'Demo Patient', PT_USER, 'PERFORMANCE SUMMARY', 'Overall score %',
    'Activity area', 'REMINDER SUMMARY', 'Adherence %', 'COGNITIVE SESSIONS', 'Response time (s)', 'DATA ANALYSIS'];
  const csvMissing = csvNeeds.filter((w) => !csv.includes(w));
  check('18. the CSV contains every required block', csvMissing.length === 0, csvMissing);
  const dataRows = csv.split(/\r?\n/).filter((l) => /Memory Match|Word Recall|Day and Date/.test(l));
  check('    the CSV carries the raw session rows', dataRows.length >= 3, dataRows.length);

  console.log('\n== reports belong to the selected patient only ==');
  const other = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Other', username: `other_cg_${stamp}`, password: 'other123', confirmPassword: 'other123',
    contact: `other${stamp}@example.org`,
  } });
  d = await download(`/patients/${PID}/report/download?format=pdf&period=weekly`, other.data.token);
  check('19. an unlinked caregiver cannot download the report', d.status === 403, d.status);
  r = await call(`/patients/${PID}/report`, { token: null });
  check('    no token cannot generate one', r.status === 401, r.status);

  console.log('\n== shared date filter reaches every consumer ==');
  const from = Date.now() - 3 * 86400000;
  const to = Date.now();
  const scoped = (await call(`/patients/${PID}?from=${from}&to=${to}`, { token: CG })).data;
  const wide = (await call(`/patients/${PID}?from=0&to=${to}`, { token: CG })).data;
  check('20. the patient endpoint accepts a range', Array.isArray(scoped.sessions) && !!scoped.range, scoped.range);
  check('    the range is echoed back', scoped.range.from === from && scoped.range.to === to, scoped.range);
  const zero = (await call(`/patients/${PID}?from=${Date.now() - 2000}&to=${Date.now() - 1000}`, { token: CG })).data;
  check('    a zero-width window returns no sessions', zero.sessions.length === 0, zero.sessions.length);
  check('    a full window returns them all', wide.sessions.length === played.length, wide.sessions.length);
  check('    per-area figures follow the range', zero.rangeMetrics.every((m) => m.sessions_count === 0), zero.rangeMetrics);
  const analysisScoped = (await call(`/patients/${PID}/analysis?from=${Date.now() - 2000}&to=${Date.now() - 1000}`, { token: CG })).data;
  check('    the analysis follows the same range', analysisScoped.figures.sessions === 0, analysisScoped.figures.sessions);
  r = await call(`/patients/${PID}?from=notanumber`, { token: CG });
  check('    a bad range is rejected, not ignored', r.status === 400, r.status);

  console.log('\n== every visible number has a source ==');
  const finalOverview = (await call('/caregiver/overview', { token: CG })).data;
  const sessionsNow = (await call(`/patients/${PID}/sessions`, { token: CG })).data;
  const remindersNow = (await call(`/patients/${PID}/reminders`, { token: CG })).data;
  check('21. overview sessions today == stored sessions', finalOverview.sessionsToday === sessionsNow.length,
    { overview: finalOverview.sessionsToday, stored: sessionsNow.length });
  check('    overview reminders today == stored reminders due today',
    finalOverview.todaysReminders === remindersNow.reminders.length,
    { overview: finalOverview.todaysReminders, stored: remindersNow.reminders.length });
  check('    report session count == stored sessions',
    periodResults.yearly.cognitiveSessions.count === sessionsNow.length);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
