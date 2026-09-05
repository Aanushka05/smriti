// routes/analysis.js — the caregiver dashboard's "AI Insights" panel.
//
// Two layers, and the order matters:
//
//   1. analysis_engine.js reads the patient's stored sessions, per-domain
//      metrics, measured response times, activity frequency and reminder
//      outcomes, and derives the trend, strengths, areas to watch and
//      suggested actions. This ALWAYS runs and never needs a network.
//   2. If ANTHROPIC_API_KEY is set, those same real numbers are handed to
//      Claude to be written up as a short note for the caregiver. The model
//      only rephrases findings that are already grounded in the data — it
//      is never the source of them.
//
// So the panel is honest in every configuration: with a key it says
// "AI write-up", without one it says "Built-in analysis", and if the API
// call fails it says so and still shows the real findings.

const express = require('express');
const fetch = require('node-fetch');
const { db, uuid } = require('../database');
const { requireAuth, requirePatientAccess } = require('../middleware/auth');
const { analysePatient, DISCLAIMER } = require('../analysis_engine');

const router = express.Router();

const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 25000;

const SYSTEM_PROMPT = `You are writing a short observation note inside SmritiSaathi Care, a dementia-support
app used by family caregivers and ASHA workers in India.

You will be given a FINISHED analysis of one patient's in-app activity: an overall trend, strengths,
areas to watch, and suggested actions, each with the real numbers behind it.

Your job is ONLY to rewrite that analysis as 3-5 short, warm, plain-English sentences a caregiver can
read quickly. Rules you must follow exactly:
- Use only the findings and numbers you are given. Never add, estimate or infer any other figure.
- Never state or imply a diagnosis. Never say the patient has, or does not have, dementia, and never
  say a condition is improving or worsening. You are describing app activity, not health.
- Never give medical advice. If something looks concerning, suggest speaking to their doctor or ASHA worker.
- No headings, no bullet points, no markdown. Just the sentences.`;

/** Sends the engine's own findings to Claude for a plain-English write-up. */
async function narrateWithClaude(analysis) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const facts = {
    overallTrend: analysis.overallTrendLabel,
    summary: analysis.summary,
    sessions: analysis.evidence.totals.sessions,
    averageAccuracyPct: Math.round((analysis.evidence.totals.avgAccuracy || 0) * 100),
    averageResponseSeconds: +((analysis.evidence.totals.avgResponseMs || 0) / 1000).toFixed(1),
    reminderAdherencePct: analysis.evidence.reminders.adherence,
    byArea: Object.values(analysis.evidence.byDomain)
      .filter((d) => d.sessions > 0)
      .map((d) => ({
        area: d.label, sessions: d.sessions,
        averagePct: Math.round(d.avgAccuracy * 100), trend: d.trend,
      })),
    strengths: analysis.strengths.map((s) => `${s.title} — ${s.detail}`),
    areasToWatch: analysis.areasToWatch.map((a) => `${a.title} — ${a.detail}`),
    suggestedActions: analysis.recommendedActions,
  };

  // node-fetch has no native timeout; without one a hung API call would
  // leave the caregiver watching a spinner forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Analysis to rewrite (JSON):\n${JSON.stringify(facts, null, 2)}` }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API call failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === 'text');
    return block ? block.text.trim() : null;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`the AI service did not respond within ${AI_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Trimmed for the client: the full evidence blob stays on the server. */
function analysisResponse(analysis, extra) {
  return {
    generatedAt: analysis.generatedAt,
    source: extra.source,
    note: extra.note || null,
    narrative: extra.narrative || null,
    patient: analysis.patient,
    period: analysis.period,
    overallTrend: analysis.overallTrend,
    overallTrendLabel: analysis.overallTrendLabel,
    headline: analysis.headline,
    summary: analysis.summary,
    strengths: analysis.strengths,
    areasToWatch: analysis.areasToWatch,
    recommendedActions: analysis.recommendedActions,
    figures: {
      sessions: analysis.evidence.totals.sessions,
      averageAccuracyPct: analysis.evidence.totals.avgAccuracy == null
        ? null : Math.round(analysis.evidence.totals.avgAccuracy * 100),
      bestAccuracyPct: analysis.evidence.totals.bestAccuracy == null
        ? null : Math.round(analysis.evidence.totals.bestAccuracy * 100),
      averageResponseSeconds: analysis.evidence.totals.avgResponseMs == null
        ? null : +(analysis.evidence.totals.avgResponseMs / 1000).toFixed(1),
      activeDays: analysis.evidence.activity.activeDays,
      recentSessions: analysis.evidence.activity.recentSessions,
      reminders: analysis.evidence.reminders,
      byArea: Object.values(analysis.evidence.byDomain).map((d) => ({
        domain: d.domain, label: d.label, sessions: d.sessions,
        averagePct: d.avgAccuracy == null ? null : Math.round(d.avgAccuracy * 100),
        bestPct: d.bestAccuracy == null ? null : Math.round(d.bestAccuracy * 100),
        averageResponseSeconds: d.avgResponseMs == null ? null : +(d.avgResponseMs / 1000).toFixed(1),
        trend: d.trend,
      })),
    },
    disclaimer: analysis.disclaimer || DISCLAIMER,
  };
}

// POST /api/patients/:patientId/analysis   { days?, from?, to? }
router.post('/patients/:patientId/analysis', requireAuth, requirePatientAccess, async (req, res, next) => {
  try {
    const b = req.body || {};
    const to = Number(b.to) || Date.now();
    const from = Number(b.from) || (Number(b.days) > 0 ? to - Number(b.days) * 86400000 : 0);

    const analysis = analysePatient(req.patientId, { from, to });
    if (!analysis) return res.status(404).json({ error: 'Patient not found.' });

    let source = 'engine';
    let narrative = null;
    let note = null;

    try {
      narrative = await narrateWithClaude(analysis);
      if (narrative) source = 'ai';
      else note = 'ANTHROPIC_API_KEY is not configured, so this analysis was produced by the app\'s own '
        + 'data-driven engine from the patient\'s stored activity.';
    } catch (err) {
      console.error('[analysis] AI write-up failed:', err.message);
      note = `The AI write-up could not be generated (${err.message}). The findings below still come `
        + 'from the patient\'s real recorded activity.';
    }

    const payload = analysisResponse(analysis, { source, narrative, note });

    db.prepare(`INSERT INTO reports (id,patient_id,generated_by,title,period_start,period_end,payload,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      uuid(), req.patientId, req.user.id, `Analysis — ${analysis.patient.name}`,
      from, to, JSON.stringify(payload), Date.now()
    );

    res.json(payload);
  } catch (err) { next(err); }
});

// GET — the same analysis without the AI layer. Used by reports and by the
// dashboard's automatic refresh, so a live update never costs an API call.
router.get('/patients/:patientId/analysis', requireAuth, requirePatientAccess, (req, res) => {
  const to = Number(req.query.to) || Date.now();
  const from = Number(req.query.from) || (Number(req.query.days) > 0 ? to - Number(req.query.days) * 86400000 : 0);
  const analysis = analysePatient(req.patientId, { from, to });
  if (!analysis) return res.status(404).json({ error: 'Patient not found.' });
  res.json(analysisResponse(analysis, { source: 'engine' }));
});

module.exports = { router, analysePatient };
