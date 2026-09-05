// server.js — SmritiSaathi Care API + static frontend host.
//
// The backend also serves frontend/ so the whole app runs on ONE port.
// That is what removes the old
//   POST http://localhost:5000/api/translate-ui  net::ERR_CONNECTION_REFUSED
// class of error: the page and the API share an origin, the frontend calls
// /api/... relatively, and there is no second server to forget to start.
// Serving the frontend from a different port still works — CORS is enabled
// and the frontend falls back to http://localhost:5000/api.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

require('./database'); // opens the db, runs migrations, seeds demo data
const { router: authRouter } = require('./routes/auth');
const { router: schedulesRouter } = require('./routes/schedules');
const { router: patientsRouter } = require('./routes/patients');
const { router: translateRouter } = require('./routes/translate');
const { router: chatRouter } = require('./routes/chat');
const { router: reportsRouter } = require('./routes/reports');
const { router: analysisRouter } = require('./routes/analysis');
const realtime = require('./realtime');
const { requireAuth } = require('./middleware/auth');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Reject malformed JSON with a clean message instead of an HTML stack trace.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body was not valid JSON.' });
  }
  next(err);
});

app.get('/api/health', (req, res) => res.json({
  ok: true,
  app: 'SmritiSaathi Care',
  bhashiniConfigured: !!(process.env.BHASHINI_USER_ID && process.env.BHASHINI_API_KEY && process.env.BHASHINI_PIPELINE_ID),
  chatConfigured: !!process.env.ANTHROPIC_API_KEY,
  realtime: true,
  liveConnections: realtime.connectionCount(),
  time: Date.now(),
}));

// Live updates (Server-Sent Events). EventSource cannot set headers, so
// requireAuth also accepts ?token= for this one route.
app.get('/api/events', requireAuth, realtime.streamHandler);

app.use('/api', authRouter);
// schedules must be mounted before patients: both define /reminders/:id
// style paths and this is the Part 2 implementation.
app.use('/api', schedulesRouter);
app.use('/api', patientsRouter);
app.use('/api', reportsRouter);
app.use('/api', analysisRouter);
app.use('/api', translateRouter);
app.use('/api', chatRouter);

// Unknown API routes must never fall through to the HTML page — that is
// what produced confusing "404 <!DOCTYPE ..." parse errors in the console.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such API endpoint: ${req.method} ${req.originalUrl}` });
});

// ---------------------------------------------------------------- static
// Chart.js is served from node_modules rather than a CDN, so the dashboard
// charts still render on a slow or filtered connection. index.html falls
// back to the CDN if this path is unavailable (e.g. when frontend/ is
// served by a different static server).
const CHARTJS_DIR = path.join(__dirname, 'node_modules', 'chart.js', 'dist');
if (fs.existsSync(CHARTJS_DIR)) {
  app.use('/vendor/chartjs', express.static(CHARTJS_DIR, { maxAge: '7d' }));
} else {
  console.warn('[server] chart.js not found in node_modules — the frontend will fall back to the CDN.');
}

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));
  app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
} else {
  console.warn(`[server] frontend directory not found at ${FRONTEND_DIR} — serving API only.`);
}

// ---------------------------------------------------------- error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[server] unhandled route error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

const PORT = Number(process.env.PORT) || 5000;
const server = app.listen(PORT, () => {
  console.log('');
  console.log('  SmritiSaathi Care');
  console.log(`  App:    http://localhost:${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/api/health`);
  if (!process.env.BHASHINI_API_KEY) console.log('  Note:   Bhashini not configured — the UI stays in English.');
  if (!process.env.ANTHROPIC_API_KEY) console.log('  Note:   ANTHROPIC_API_KEY not set — chat is off, AI Analysis uses the built-in rule-based engine.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use. Stop the other process or set PORT in backend/.env.`);
    process.exit(1);
  }
  throw err;
});

// Never let a stray rejection kill the process silently.
process.on('unhandledRejection', (reason) => console.error('[server] unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err));

module.exports = app;
