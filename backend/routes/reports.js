// routes/reports.js — patient reports: preview, PDF, CSV and HTML.
//
// The caregiver picks a patient and a period (daily / weekly / monthly /
// yearly, or a custom range), and every format is rendered from the same
// report object built in report_builder.js — so the preview on screen, the
// PDF and the CSV can never disagree.
//
// Access is the usual rule: only a caregiver linked to that patient (or the
// patient themselves) can generate or download anything.

const express = require('express');
const { db, uuid } = require('../database');
const { requireAuth, requirePatientAccess } = require('../middleware/auth');
const {
  buildReport, renderPdf, renderCsv, renderHtml, reportFilename, PERIODS,
} = require('../report_builder');

const router = express.Router();

const FORMATS = ['pdf', 'csv', 'html', 'json'];

/** Reads period / from / to off a query string or body, with validation. */
function readPeriod(src) {
  const period = PERIODS[src.period] ? src.period : (src.period ? null : 'weekly');
  if (period === null) return { error: `period must be one of: ${Object.keys(PERIODS).join(', ')}.` };

  const from = src.from ? Number(src.from) : undefined;
  const to = src.to ? Number(src.to) : undefined;
  if (src.from && !Number.isFinite(from)) return { error: 'from must be a timestamp in milliseconds.' };
  if (src.to && !Number.isFinite(to)) return { error: 'to must be a timestamp in milliseconds.' };
  if (from && to && from > to) return { error: 'The start of the range must be before the end.' };

  return { period, from, to };
}

// GET /api/report/periods — what the picker offers.
router.get('/report/periods', requireAuth, (req, res) => {
  res.json({
    periods: Object.values(PERIODS).map((p) => ({ key: p.key, label: p.label, title: p.title })),
    formats: FORMATS,
  });
});

// GET /api/patients/:patientId/report?period=weekly
// JSON preview, also stored so "what did we look at last week" is answerable.
router.get('/patients/:patientId/report', requireAuth, requirePatientAccess, (req, res) => {
  const opts = readPeriod(req.query);
  if (opts.error) return res.status(400).json({ error: opts.error, field: 'period' });

  const report = buildReport(req.patientId, opts);
  if (!report) return res.status(404).json({ error: 'Patient not found.' });

  const id = uuid();
  db.prepare(`INSERT INTO reports (id,patient_id,generated_by,title,period_start,period_end,payload,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    id, req.patientId, req.user.id, `${report.period.title} — ${report.patient.name}`,
    report.period.from, report.period.to, JSON.stringify(report), Date.now()
  );

  return res.json({ reportId: id, report });
});

// GET /api/patients/:patientId/report/download?format=pdf&period=weekly
router.get('/patients/:patientId/report/download', requireAuth, requirePatientAccess, async (req, res, next) => {
  try {
    const format = FORMATS.includes(req.query.format) ? req.query.format : 'pdf';
    const opts = readPeriod(req.query);
    if (opts.error) return res.status(400).json({ error: opts.error, field: 'period' });

    const report = buildReport(req.patientId, opts);
    if (!report) return res.status(404).json({ error: 'Patient not found.' });

    const filename = reportFilename(report, format);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    if (format === 'pdf') {
      const buffer = await renderPdf(report);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', buffer.length);
      return res.end(buffer);
    }
    if (format === 'csv') {
      // BOM so Excel opens the Indian-language names correctly.
      return res.type('text/csv; charset=utf-8').send('﻿' + renderCsv(report));
    }
    if (format === 'json') {
      return res.type('application/json').send(JSON.stringify(report, null, 2));
    }
    return res.type('text/html; charset=utf-8').send(renderHtml(report));
  } catch (err) {
    return next(err);
  }
});

// GET /api/patients/:patientId/reports — previously generated reports
router.get('/patients/:patientId/reports', requireAuth, requirePatientAccess, (req, res) => {
  const rows = db.prepare(`SELECT id,title,period_start,period_end,created_at FROM reports
    WHERE patient_id=? ORDER BY created_at DESC LIMIT 20`).all(req.patientId);
  res.json(rows.map((r) => ({
    id: r.id, title: r.title, periodStart: r.period_start, periodEnd: r.period_end, createdAt: r.created_at,
  })));
});

module.exports = { router, buildReport };
