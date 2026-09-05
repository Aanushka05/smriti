// report_builder.js — assembles a patient report and renders it as PDF,
// CSV or HTML.
//
// One data function (buildReport) feeds all three renderers, so the PDF,
// the CSV and the on-screen preview can never disagree with each other.
//
// Every value comes out of the database for the SELECTED PATIENT over the
// SELECTED PERIOD. Where there is nothing recorded, the report prints an
// explicit "—" or "No sessions in this period" rather than a zero that
// looks like a measurement.

const PDFDocument = require('pdfkit');
const { db, DOMAINS, DOMAIN_LABELS, reminderStats, toDateKey } = require('./database');
const { analysePatient, TREND_LABELS } = require('./analysis_engine');

const APP_NAME = 'SmritiSaathi Care';

/* ------------------------------------------------------------- periods */

/**
 * The four report periods, resolved against "now" so a report generated
 * today covers today. `days: null` on 'yearly' means "since 1 January".
 */
const PERIODS = {
  daily: { key: 'daily', label: 'Daily', title: 'Daily report' },
  weekly: { key: 'weekly', label: 'Weekly', title: 'Weekly report' },
  monthly: { key: 'monthly', label: 'Monthly', title: 'Monthly report' },
  yearly: { key: 'yearly', label: 'Yearly', title: 'Yearly report' },
  all: { key: 'all', label: 'All time', title: 'Full history report' },
};

function resolvePeriod(periodKey, explicitFrom, explicitTo) {
  const to = Number(explicitTo) || Date.now();
  const now = new Date(to);

  if (explicitFrom) {
    return {
      key: 'custom', label: 'Custom range', title: 'Progress report',
      from: Number(explicitFrom), to,
    };
  }

  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const meta = PERIODS[periodKey] || PERIODS.weekly;

  let from;
  switch (meta.key) {
    case 'daily': from = startOfDay.getTime(); break;
    case 'weekly': from = to - 7 * 86400000; break;
    case 'monthly': from = to - 30 * 86400000; break;
    case 'yearly': from = new Date(now.getFullYear(), 0, 1).getTime(); break;
    case 'all': from = 0; break;
    default: from = to - 7 * 86400000;
  }
  return { ...meta, from, to };
}

/* ---------------------------------------------------------------- data */

const fmtPct = (v) => (v == null ? null : Math.round(v * 100));
const fmtSec = (ms) => (ms == null ? null : +(ms / 1000).toFixed(1));

/**
 * Everything the report shows, read from stored rows for one patient over
 * one period. The analysis section reuses analysis_engine, so the report
 * and the dashboard say exactly the same thing.
 */
function buildReport(patientId, { period = 'weekly', from, to } = {}) {
  const patient = db.prepare('SELECT * FROM patients WHERE id=?').get(patientId);
  if (!patient) return null;

  const range = resolvePeriod(period, from, to);

  const sessions = db.prepare(
    `SELECT * FROM sessions WHERE patient_id=? AND completed_at BETWEEN ? AND ?
     ORDER BY completed_at ASC`
  ).all(patientId, range.from, range.to);

  // Reminders are matched on their due DATE, which is what a caregiver
  // means by "this week's reminders".
  const fromDate = toDateKey(new Date(range.from || Date.now()));
  const toDate = toDateKey(new Date(range.to));
  const reminders = range.from === 0
    ? db.prepare('SELECT * FROM reminders WHERE patient_id=? ORDER BY due_date, time').all(patientId)
    : db.prepare(`SELECT * FROM reminders WHERE patient_id=? AND (due_date IS NULL OR due_date BETWEEN ? AND ?)
       ORDER BY due_date, time`).all(patientId, fromDate, toDate);

  const completed = reminders.filter((r) => r.status === 'done').length;
  const missed = reminders.filter((r) => r.status === 'missed').length;
  const snoozed = reminders.filter((r) => r.status === 'snoozed').length;
  const pending = reminders.filter((r) => r.status === 'pending').length;
  const settled = completed + missed;

  const accuracies = sessions.map((s) => s.accuracy);
  const overall = accuracies.length ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null;
  const responseMs = sessions.length
    ? sessions.reduce((a, s) => a + s.avg_time_ms, 0) / sessions.length : null;

  // Per-area figures for the period (not the all-time rollup, so the
  // report matches the period the caregiver picked).
  const byDomain = DOMAINS.map((domain) => {
    const rows = sessions.filter((s) => s.domain === domain);
    const accs = rows.map((s) => s.accuracy);
    let trend = 'none';
    if (rows.length >= 3) {
      const mid = Math.floor(accs.length / 2);
      const earlier = accs.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const later = accs.slice(accs.length - mid).reduce((a, b) => a + b, 0) / mid;
      trend = later - earlier >= 0.05 ? 'improving' : later - earlier <= -0.05 ? 'declining' : 'steady';
    } else if (rows.length === 2) {
      trend = accs[1] >= accs[0] ? 'improving' : 'declining';
    }
    return {
      domain,
      label: DOMAIN_LABELS[domain] || domain,
      sessions: rows.length,
      avgAccuracy: fmtPct(accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null),
      bestAccuracy: fmtPct(accs.length ? Math.max(...accs) : null),
      avgResponseSeconds: fmtSec(rows.length ? rows.reduce((a, s) => a + s.avg_time_ms, 0) / rows.length : null),
      trend,
    };
  });

  // Recent performance: the last five sessions, most recent first.
  const recent = sessions.slice(-5).reverse().map((s) => ({
    when: new Date(s.completed_at).toLocaleString(),
    game: s.game_type || DOMAIN_LABELS[s.domain] || s.domain,
    area: DOMAIN_LABELS[s.domain] || s.domain,
    accuracy: fmtPct(s.accuracy),
    responseSeconds: fmtSec(s.avg_time_ms),
    level: s.level,
    score: s.score == null ? null : `${s.score}/${s.total_rounds}`,
  }));

  const analysis = analysePatient(patientId, { from: range.from, to: range.to });

  return {
    app: APP_NAME,
    generatedAt: Date.now(),
    period: range,
    patient: {
      id: patient.id,
      patientId: patient.username || patient.id,
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      language: patient.lang,
      emergencyContact: patient.emergency_contact,
    },
    performance: {
      overallScore: fmtPct(overall),
      bestScore: fmtPct(accuracies.length ? Math.max(...accuracies) : null),
      averageResponseSeconds: fmtSec(responseMs),
      totalSessions: sessions.length,
      byDomain,
    },
    reminders: {
      total: reminders.length,
      completed,
      missed,
      snoozed,
      pending,
      adherence: settled ? Math.round((completed / settled) * 100) : null,
      list: reminders.map((r) => ({
        title: r.title, time: r.time, date: r.due_date,
        type: r.type, status: r.status || 'pending',
      })),
    },
    cognitiveSessions: {
      count: sessions.length,
      averageScore: fmtPct(overall),
      bestScore: fmtPct(accuracies.length ? Math.max(...accuracies) : null),
      recent,
      trend: analysis ? analysis.overallTrendLabel : 'Insufficient data',
      all: sessions.map((s) => ({
        when: new Date(s.completed_at).toLocaleString(),
        completedAt: s.completed_at,
        area: DOMAIN_LABELS[s.domain] || s.domain,
        game: s.game_type || '—',
        level: s.level,
        score: s.score,
        totalRounds: s.total_rounds,
        accuracy: fmtPct(s.accuracy),
        responseSeconds: fmtSec(s.avg_time_ms),
      })),
    },
    analysis: analysis ? {
      overallTrend: analysis.overallTrend,
      overallTrendLabel: analysis.overallTrendLabel,
      headline: analysis.headline,
      summary: analysis.summary,
      strengths: analysis.strengths,
      areasToWatch: analysis.areasToWatch,
      recommendedActions: analysis.recommendedActions,
    } : null,
    adherenceAllTime: reminderStats(patientId),
    disclaimer: 'This report summarises activity recorded inside the app. It is an observation of '
      + 'in-app performance, not a medical assessment or diagnosis. Please discuss any concerns with '
      + 'the patient\'s doctor or ASHA worker.',
  };
}

/* ----------------------------------------------------------------- PDF */

const INK = '#2B2420';
const SOFT = '#5A4F45';
const MAROON = '#6B2737';
const LINE = '#D9CFB8';
const AREA_COLORS = {
  memory: '#6B2737', attention: '#4A5C7A', language: '#3E5C3A',
  orientation: '#7A4A6B', problem_solving: '#8B5E34', pattern: '#C88B2E',
};

/**
 * Renders the report as a PDF and resolves to a Buffer.
 * Charts are drawn with pdfkit primitives (bars and a plotted line) rather
 * than by embedding an image, so the PDF needs no browser or headless
 * renderer and stays small.
 */
function renderPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 80;      // usable width
    const L = 40;                        // left margin
    const dash = (v, suffix) => (v == null ? '—' : `${v}${suffix || ''}`);

    /* -- helpers ------------------------------------------------------ */
    const sectionTitle = (text) => {
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.moveDown(0.8);
      doc.fillColor(MAROON).fontSize(13).font('Helvetica-Bold').text(text);
      doc.moveTo(L, doc.y + 2).lineTo(L + W, doc.y + 2).strokeColor(LINE).lineWidth(1).stroke();
      doc.moveDown(0.6);
      doc.fillColor(INK).font('Helvetica').fontSize(10);
    };

    const keyValueGrid = (pairs, columns) => {
      const cols = columns || 3;
      const colW = W / cols;
      let x = L;
      let y = doc.y;
      pairs.forEach((pair, i) => {
        if (i > 0 && i % cols === 0) { y += 34; x = L; }
        doc.fontSize(8).fillColor(SOFT).text(pair[0], x, y, { width: colW - 8 });
        doc.fontSize(13).fillColor(INK).font('Helvetica-Bold').text(pair[1], x, y + 11, { width: colW - 8 });
        doc.font('Helvetica');
        x += colW;
      });
      doc.y = y + 40;
      doc.x = L;
    };

    const table = (headers, rows, widths) => {
      const colW = widths.map((w) => (w / 100) * W);
      const drawRow = (cells, bold, fill) => {
        if (doc.y > doc.page.height - 70) {
          doc.addPage();
          drawRow(headers, true, '#EDE7D8');
        }
        const y = doc.y;
        const height = 16;
        if (fill) doc.rect(L, y - 2, W, height).fill(fill);
        let x = L;
        cells.forEach((cell, i) => {
          doc.fillColor(bold ? INK : SOFT).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
            .text(String(cell == null ? '—' : cell), x + 3, y + 2, { width: colW[i] - 6, ellipsis: true, lineBreak: false });
          x += colW[i];
        });
        doc.y = y + height;
        doc.x = L;
      };
      drawRow(headers, true, '#EDE7D8');
      rows.forEach((r) => drawRow(r, false, null));
      doc.moveDown(0.4);
      doc.fillColor(INK).font('Helvetica');
    };

    /** Horizontal bars, one per activity area — the "chart where practical". */
    const barChart = (rows) => {
      const withData = rows.filter((r) => r.avgAccuracy != null);
      if (!withData.length) {
        doc.fontSize(9).fillColor(SOFT).text('No performance data available for this period.');
        doc.moveDown(0.5);
        return;
      }
      const barH = 14;
      const gap = 8;
      const labelW = 110;
      const trackW = W - labelW - 44;
      let y = doc.y + 4;

      withData.forEach((r) => {
        if (y > doc.page.height - 80) { doc.addPage(); y = doc.y; }
        doc.fontSize(8.5).fillColor(SOFT).font('Helvetica')
          .text(r.label, L, y + 3, { width: labelW - 6, ellipsis: true, lineBreak: false });
        doc.rect(L + labelW, y, trackW, barH).fill('#EFE9DA');
        const filled = Math.max(2, (r.avgAccuracy / 100) * trackW);
        doc.rect(L + labelW, y, filled, barH).fill(AREA_COLORS[r.domain] || MAROON);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5)
          .text(`${r.avgAccuracy}%`, L + labelW + trackW + 6, y + 3, { width: 38, lineBreak: false });
        y += barH + gap;
      });
      doc.y = y + 2;
      doc.x = L;
      doc.font('Helvetica').fillColor(INK);
    };

    /** A small plotted line of session accuracy over the period. */
    const lineChart = (sessions) => {
      const points = sessions.map((s) => s.accuracy).filter((v) => v != null);
      if (points.length < 2) {
        doc.fontSize(9).fillColor(SOFT)
          .text(points.length === 1
            ? 'Only one session in this period — a line needs at least two.'
            : 'No sessions in this period.');
        doc.moveDown(0.5);
        return;
      }
      const h = 90;
      const top = doc.y + 6;
      const plotW = W - 30;
      const x0 = L + 26;

      // axis + gridlines at 0/50/100%
      [0, 50, 100].forEach((v) => {
        const y = top + h - (v / 100) * h;
        doc.moveTo(x0, y).lineTo(x0 + plotW, y).strokeColor('#EFE9DA').lineWidth(0.7).stroke();
        doc.fontSize(7).fillColor(SOFT).text(`${v}%`, L, y - 4, { width: 22, align: 'right', lineBreak: false });
      });

      const step = plotW / Math.max(1, points.length - 1);
      doc.strokeColor(MAROON).lineWidth(1.5);
      points.forEach((v, i) => {
        const x = x0 + i * step;
        const y = top + h - (v / 100) * h;
        if (i === 0) doc.moveTo(x, y); else doc.lineTo(x, y);
      });
      doc.stroke();
      points.forEach((v, i) => {
        doc.circle(x0 + i * step, top + h - (v / 100) * h, 2).fill(MAROON);
      });

      doc.y = top + h + 12;
      doc.x = L;
      doc.fillColor(INK).font('Helvetica');
    };

    /* -- header ------------------------------------------------------- */
    doc.rect(0, 0, doc.page.width, 74).fill(MAROON);
    doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold').text(report.app, L, 22);
    doc.fontSize(11).font('Helvetica').text(report.period.title, L, 48);
    doc.fontSize(8).text(`Generated ${new Date(report.generatedAt).toLocaleString()}`,
      L, 50, { width: W, align: 'right' });
    doc.fillColor(INK);
    doc.y = 92;

    /* -- patient information ------------------------------------------ */
    sectionTitle('Patient information');
    keyValueGrid([
      ['Patient name', report.patient.name],
      ['Patient ID', report.patient.patientId],
      ['Age', report.patient.age == null ? '—' : String(report.patient.age)],
      ['Gender', report.patient.gender || '—'],
      ['Report period', report.period.label],
      ['Covering', report.period.from === 0
        ? 'All recorded activity'
        : `${new Date(report.period.from).toLocaleDateString()} – ${new Date(report.period.to).toLocaleDateString()}`],
    ], 3);

    /* -- performance summary ------------------------------------------ */
    sectionTitle('Performance summary');
    keyValueGrid([
      ['Overall score', dash(report.performance.overallScore, '%')],
      ['Best score', dash(report.performance.bestScore, '%')],
      ['Response time', dash(report.performance.averageResponseSeconds, 's')],
      ...report.performance.byDomain.map((d) => [d.label, dash(d.avgAccuracy, '%')]),
    ], 3);

    doc.fontSize(9).fillColor(SOFT).text('Average score by activity area');
    barChart(report.performance.byDomain);

    table(
      ['Activity area', 'Sessions', 'Average', 'Best', 'Avg response', 'Trend'],
      report.performance.byDomain.map((d) => [
        d.label, d.sessions, dash(d.avgAccuracy, '%'), dash(d.bestAccuracy, '%'),
        dash(d.avgResponseSeconds, 's'), TREND_LABELS[d.trend] || (d.trend === 'none' ? 'No data' : d.trend),
      ]),
      [28, 12, 15, 13, 17, 15]
    );

    /* -- reminder summary --------------------------------------------- */
    sectionTitle('Reminder summary');
    keyValueGrid([
      ['Total reminders', String(report.reminders.total)],
      ['Completed', String(report.reminders.completed)],
      ['Missed', String(report.reminders.missed)],
      ['Snoozed', String(report.reminders.snoozed)],
      ['Still pending', String(report.reminders.pending)],
      ['Adherence', dash(report.reminders.adherence, '%')],
    ], 3);

    if (report.reminders.list.length) {
      table(
        ['Reminder', 'Date', 'Time', 'Type', 'Status'],
        report.reminders.list.slice(0, 25).map((r) => [r.title, r.date || '—', r.time, r.type, r.status]),
        [34, 18, 12, 18, 18]
      );
    } else {
      doc.fontSize(9).fillColor(SOFT).text('No reminders in this period.');
      doc.moveDown(0.5);
    }

    /* -- cognitive sessions -------------------------------------------- */
    sectionTitle('Cognitive sessions');
    keyValueGrid([
      ['Number of sessions', String(report.cognitiveSessions.count)],
      ['Average score', dash(report.cognitiveSessions.averageScore, '%')],
      ['Best score', dash(report.cognitiveSessions.bestScore, '%')],
      ['Trend', report.cognitiveSessions.trend],
    ], 4);

    doc.fontSize(9).fillColor(SOFT).text('Session scores over the period');
    lineChart(report.cognitiveSessions.all);

    doc.fontSize(9).fillColor(SOFT).text('Recent performance');
    doc.moveDown(0.3);
    if (report.cognitiveSessions.recent.length) {
      table(
        ['When', 'Activity', 'Area', 'Score', 'Accuracy', 'Response'],
        report.cognitiveSessions.recent.map((s) => [
          s.when, s.game, s.area, s.score || '—', dash(s.accuracy, '%'), dash(s.responseSeconds, 's'),
        ]),
        [24, 20, 18, 12, 13, 13]
      );
    } else {
      doc.fontSize(9).fillColor(SOFT).text('No sessions in this period.');
      doc.moveDown(0.5);
    }

    /* -- analysis ------------------------------------------------------ */
    if (report.analysis) {
      sectionTitle('Data analysis');
      doc.fontSize(9).fillColor(SOFT).text('Overall trend', { continued: true })
        .fillColor(INK).font('Helvetica-Bold').text(`   ${report.analysis.overallTrendLabel}`);
      doc.font('Helvetica').fillColor(INK).fontSize(10).moveDown(0.4);
      doc.text(report.analysis.headline, { width: W });
      if (report.analysis.summary) {
        doc.moveDown(0.2).fontSize(9).fillColor(SOFT).text(report.analysis.summary, { width: W });
      }

      const bullets = (title, items) => {
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor(MAROON).font('Helvetica-Bold').text(title);
        doc.font('Helvetica').fillColor(INK).fontSize(9);
        if (!items || !items.length) { doc.text('  —'); return; }
        items.forEach((it) => {
          const text = typeof it === 'string' ? it : `${it.title} — ${it.detail}`;
          if (doc.y > doc.page.height - 70) doc.addPage();
          doc.text(`•  ${text}`, { width: W - 10, indent: 4 });
        });
      };
      bullets('Strengths', report.analysis.strengths);
      bullets('Areas to watch', report.analysis.areasToWatch);
      bullets('Suggested caregiver actions', report.analysis.recommendedActions);
    }

    /* -- footer on every page ------------------------------------------ */
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      const y = doc.page.height - 46;
      doc.moveTo(L, y).lineTo(L + W, y).strokeColor(LINE).lineWidth(0.7).stroke();
      doc.fontSize(7).fillColor(SOFT).font('Helvetica')
        .text(report.disclaimer, L, y + 5, { width: W - 60 });
      doc.fontSize(7).fillColor(SOFT)
        .text(`${i + 1} / ${range.count}`, L + W - 50, y + 5, { width: 50, align: 'right' });
    }

    doc.end();
  });
}

/* ----------------------------------------------------------------- CSV */

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(',');

/** Raw data export: every section as its own labelled block. */
function renderCsv(report) {
  const L = [];
  const dash = (v, suffix) => (v == null ? '' : `${v}${suffix || ''}`);

  L.push(csvRow([report.app, report.period.title]));
  L.push(csvRow(['Generated', new Date(report.generatedAt).toLocaleString()]));
  L.push('');

  L.push(csvRow(['PATIENT INFORMATION']));
  L.push(csvRow(['Patient name', report.patient.name]));
  L.push(csvRow(['Patient ID', report.patient.patientId]));
  L.push(csvRow(['Age', report.patient.age]));
  L.push(csvRow(['Gender', report.patient.gender]));
  L.push(csvRow(['Report period', report.period.label]));
  L.push(csvRow(['Period start', report.period.from === 0 ? 'All time' : new Date(report.period.from).toLocaleString()]));
  L.push(csvRow(['Period end', new Date(report.period.to).toLocaleString()]));
  L.push('');

  L.push(csvRow(['PERFORMANCE SUMMARY']));
  L.push(csvRow(['Overall score %', dash(report.performance.overallScore)]));
  L.push(csvRow(['Best score %', dash(report.performance.bestScore)]));
  L.push(csvRow(['Average response time (s)', dash(report.performance.averageResponseSeconds)]));
  L.push(csvRow(['Total sessions', report.performance.totalSessions]));
  L.push('');
  L.push(csvRow(['Activity area', 'Sessions', 'Average %', 'Best %', 'Avg response (s)', 'Trend']));
  report.performance.byDomain.forEach((d) => L.push(csvRow([
    d.label, d.sessions, dash(d.avgAccuracy), dash(d.bestAccuracy), dash(d.avgResponseSeconds), d.trend,
  ])));
  L.push('');

  L.push(csvRow(['REMINDER SUMMARY']));
  L.push(csvRow(['Total reminders', report.reminders.total]));
  L.push(csvRow(['Completed', report.reminders.completed]));
  L.push(csvRow(['Missed', report.reminders.missed]));
  L.push(csvRow(['Snoozed', report.reminders.snoozed]));
  L.push(csvRow(['Pending', report.reminders.pending]));
  L.push(csvRow(['Adherence %', dash(report.reminders.adherence)]));
  L.push('');
  L.push(csvRow(['Reminder', 'Date', 'Time', 'Type', 'Status']));
  report.reminders.list.forEach((r) => L.push(csvRow([r.title, r.date, r.time, r.type, r.status])));
  L.push('');

  L.push(csvRow(['COGNITIVE SESSIONS']));
  L.push(csvRow(['Number of sessions', report.cognitiveSessions.count]));
  L.push(csvRow(['Average score %', dash(report.cognitiveSessions.averageScore)]));
  L.push(csvRow(['Best score %', dash(report.cognitiveSessions.bestScore)]));
  L.push(csvRow(['Trend', report.cognitiveSessions.trend]));
  L.push('');
  L.push(csvRow(['Date', 'Activity area', 'Game', 'Level', 'Score', 'Rounds', 'Accuracy %', 'Response time (s)']));
  report.cognitiveSessions.all.forEach((s) => L.push(csvRow([
    s.when, s.area, s.game, s.level, s.score, s.totalRounds, s.accuracy, s.responseSeconds,
  ])));
  L.push('');

  if (report.analysis) {
    L.push(csvRow(['DATA ANALYSIS']));
    L.push(csvRow(['Overall trend', report.analysis.overallTrendLabel]));
    L.push(csvRow(['Summary', report.analysis.headline]));
    L.push('');
    L.push(csvRow(['Type', 'Finding', 'Detail']));
    report.analysis.strengths.forEach((s) => L.push(csvRow(['Strength', s.title, s.detail])));
    report.analysis.areasToWatch.forEach((s) => L.push(csvRow(['Area to watch', s.title, s.detail])));
    report.analysis.recommendedActions.forEach((s) => L.push(csvRow(['Suggested action', s, ''])));
    L.push('');
  }

  L.push(csvRow(['Note', report.disclaimer]));
  return L.join('\r\n');
}

/* ---------------------------------------------------------------- HTML */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Printable HTML — the same content, for people who prefer a web page. */
function renderHtml(report) {
  const dash = (v, s) => (v == null ? '—' : `${v}${s || ''}`);
  const kpi = (label, value) => `<div class="kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  const row = (cells, tag) => `<tr>${cells.map((c) => `<${tag || 'td'}>${escapeHtml(c == null ? '—' : c)}</${tag || 'td'}>`).join('')}</tr>`;
  const bullets = (items) => (items && items.length
    ? `<ul>${items.map((i) => `<li>${escapeHtml(typeof i === 'string' ? i : `${i.title} — ${i.detail}`)}</li>`).join('')}</ul>`
    : '<p class="muted">—</p>');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(report.app)} — ${escapeHtml(report.period.title)} — ${escapeHtml(report.patient.name)}</title>
<style>
  body { font-family: Georgia,'Times New Roman',serif; color:#2B2420; background:#F3EEE2; margin:0; padding:28px; }
  .sheet { max-width:920px; margin:0 auto; background:#FFFDF8; border:1px solid #E4DCC9; padding:30px; }
  h1 { color:#6B2737; margin:0 0 4px; font-size:23px; }
  h2 { color:#4E1D29; font-size:15px; margin:26px 0 8px; border-bottom:1px solid #E4DCC9; padding-bottom:4px; }
  .meta { color:#5A4F45; font-size:12.5px; }
  .kpis { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0; }
  .kpi { border:1px solid #E4DCC9; border-radius:9px; padding:9px 13px; min-width:118px; }
  .kpi span { display:block; font-size:10.5px; color:#5A4F45; }
  .kpi strong { font-size:18px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; font-family:system-ui,sans-serif; }
  th { text-align:left; background:#EDE7D8; padding:6px 8px; }
  td { padding:6px 8px; border-bottom:1px solid #EFE9DA; }
  ul { font-family:system-ui,sans-serif; font-size:13px; padding-left:20px; }
  .bar { background:#EFE9DA; border-radius:4px; height:14px; position:relative; }
  .bar > i { display:block; height:100%; border-radius:4px; }
  .muted { color:#5A4F45; font-size:12.5px; font-style:italic; }
  .note { margin-top:22px; font-size:11.5px; color:#5A4F45; font-style:italic; }
  @media print { body { background:#fff; padding:0; } .sheet { border:0; } }
</style></head>
<body><div class="sheet">
  <h1>${escapeHtml(report.app)} — ${escapeHtml(report.period.title)}</h1>
  <div class="meta">
    <strong>${escapeHtml(report.patient.name)}</strong> · Patient ID: ${escapeHtml(report.patient.patientId)}
    · Age ${escapeHtml(report.patient.age == null ? '—' : report.patient.age)} · ${escapeHtml(report.patient.gender || '—')}<br />
    Period: ${escapeHtml(report.period.label)}
    ${report.period.from === 0 ? '(all recorded activity)'
    : `(${escapeHtml(new Date(report.period.from).toLocaleDateString())} – ${escapeHtml(new Date(report.period.to).toLocaleDateString())})`}
    · Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())}
  </div>

  <h2>Performance summary</h2>
  <div class="kpis">
    ${kpi('Overall score', dash(report.performance.overallScore, '%'))}
    ${kpi('Best score', dash(report.performance.bestScore, '%'))}
    ${kpi('Response time', dash(report.performance.averageResponseSeconds, 's'))}
    ${report.performance.byDomain.map((d) => kpi(d.label, dash(d.avgAccuracy, '%'))).join('')}
  </div>
  <table><thead>${row(['Activity area', 'Sessions', 'Average', 'Best', 'Avg response', 'Trend'], 'th')}</thead><tbody>
    ${report.performance.byDomain.map((d) => `<tr>
      <td>${escapeHtml(d.label)}</td><td>${d.sessions}</td>
      <td>${d.avgAccuracy == null ? '—' : `<div class="bar"><i style="width:${d.avgAccuracy}%;background:${AREA_COLORS[d.domain] || '#6B2737'}"></i></div> ${d.avgAccuracy}%`}</td>
      <td>${dash(d.bestAccuracy, '%')}</td><td>${dash(d.avgResponseSeconds, 's')}</td>
      <td>${escapeHtml(TREND_LABELS[d.trend] || (d.trend === 'none' ? 'No data' : d.trend))}</td>
    </tr>`).join('')}
  </tbody></table>

  <h2>Reminder summary</h2>
  <div class="kpis">
    ${kpi('Total reminders', String(report.reminders.total))}
    ${kpi('Completed', String(report.reminders.completed))}
    ${kpi('Missed', String(report.reminders.missed))}
    ${kpi('Snoozed', String(report.reminders.snoozed))}
    ${kpi('Adherence', dash(report.reminders.adherence, '%'))}
  </div>
  ${report.reminders.list.length ? `<table><thead>${row(['Reminder', 'Date', 'Time', 'Type', 'Status'], 'th')}</thead>
    <tbody>${report.reminders.list.map((r) => row([r.title, r.date, r.time, r.type, r.status])).join('')}</tbody></table>`
    : '<p class="muted">No reminders in this period.</p>'}

  <h2>Cognitive sessions</h2>
  <div class="kpis">
    ${kpi('Number of sessions', String(report.cognitiveSessions.count))}
    ${kpi('Average score', dash(report.cognitiveSessions.averageScore, '%'))}
    ${kpi('Best score', dash(report.cognitiveSessions.bestScore, '%'))}
    ${kpi('Trend', report.cognitiveSessions.trend)}
  </div>
  ${report.cognitiveSessions.all.length ? `<table><thead>${row(['Date', 'Area', 'Game', 'Level', 'Score', 'Accuracy', 'Response'], 'th')}</thead>
    <tbody>${report.cognitiveSessions.all.map((s) => row([
    s.when, s.area, s.game, s.level == null ? '—' : `L${s.level}`,
    s.score == null ? '—' : `${s.score}/${s.totalRounds}`, `${s.accuracy}%`, `${s.responseSeconds}s`,
  ])).join('')}</tbody></table>`
    : '<p class="muted">No sessions in this period.</p>'}

  ${report.analysis ? `
  <h2>Data analysis</h2>
  <p><strong>Overall trend:</strong> ${escapeHtml(report.analysis.overallTrendLabel)}</p>
  <p>${escapeHtml(report.analysis.headline)}</p>
  ${report.analysis.summary ? `<p class="muted">${escapeHtml(report.analysis.summary)}</p>` : ''}
  <h3>Strengths</h3>${bullets(report.analysis.strengths)}
  <h3>Areas to watch</h3>${bullets(report.analysis.areasToWatch)}
  <h3>Suggested caregiver actions</h3>${bullets(report.analysis.recommendedActions)}` : ''}

  <p class="note">${escapeHtml(report.disclaimer)}</p>
</div></body></html>`;
}

/** Consistent, descriptive download name. */
function reportFilename(report, extension) {
  const safeName = String(report.patient.name).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const stamp = new Date(report.generatedAt).toISOString().slice(0, 10);
  return `SmritiSaathi_Care_${report.period.label.replace(/\s+/g, '_')}_Report_${safeName}_${stamp}.${extension}`;
}

module.exports = { buildReport, renderPdf, renderCsv, renderHtml, reportFilename, resolvePeriod, PERIODS, APP_NAME };
