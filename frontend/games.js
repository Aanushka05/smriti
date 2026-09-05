/* games.js — the cognitive activities and the engine behind them.
 *
 * Every game follows the same contract:
 *   startGame(key) -> rounds -> result card -> finishGame()
 *     -> POST /api/game-results (score, accuracy, per-answer response
 *        times, level, game type, patient)
 *     -> backend recomputes performance_metrics
 *     -> both dashboards update (live, via realtime.js)
 *
 * Randomness here generates PUZZLE CONTENT (which face to ask about, which
 * tile is the odd one). No score, time or statistic is ever invented — all
 * of those are measured from what the patient actually did.
 */

const DOMAIN_META = {
  memory: { label: () => t('memory'), color: '#6B2737' },
  attention: { label: () => t('attention'), color: '#4A5C7A' },
  language: { label: () => t('language'), color: '#3E5C3A' },
  orientation: { label: () => t('orientation'), color: '#7A4A6B' },
  problem_solving: { label: () => t('problemSolving'), color: '#8B5E34' },
  pattern: { label: () => t('patternRecognition'), color: '#C88B2E' },
};
const DOMAIN_KEYS = Object.keys(DOMAIN_META);

/* The single registry every screen reads: the patient's game list, the
 * router, the game shell header and finishGame() all come from here. */
const GAMES = [
  {
    key: 'game-familyfaces', domain: 'memory', icon: '👴',
    name: 'Family Faces', title: () => t('familyFaces'), instructions: () => t('familyFacesInstructions'),
  },
  {
    key: 'game-memorymatch', domain: 'memory', icon: '🃏',
    name: 'Memory Match', title: () => t('memoryMatch'), instructions: () => t('memoryMatchInstructions'),
  },
  {
    key: 'game-sequence', domain: 'problem_solving', icon: '🔢',
    name: 'Sequence Recall', title: () => t('sequenceRecall'), instructions: () => t('sequenceRecallInstructions'),
  },
  {
    key: 'game-wordrecall', domain: 'language', icon: '💬',
    name: 'Word Recall', title: () => t('wordRecall'), instructions: () => t('wordRecallInstructions'),
  },
  {
    key: 'game-oddone', domain: 'attention', icon: '👀',
    name: 'Spot the Odd One', title: () => t('spotOddOne'), instructions: () => t('spotOddOneInstructions'),
  },
  {
    key: 'game-weaving', domain: 'pattern', icon: '🧩',
    name: 'Weaving Completion', title: () => t('weavingCompletion'), instructions: () => t('weavingInstructions'),
  },
  {
    key: 'game-orientation', domain: 'orientation', icon: '📅',
    name: 'Day and Date', title: () => t('dayAndDate'), instructions: () => t('dayAndDateInstructions'),
  },
];

function gameByKey(key) { return GAMES.find((g) => g.key === key) || null; }

const SYMBOLS = ['●', '■', '▲', '◆', '★', '⬢'];
const SHAPE_COLORS = ['#6B2737', '#C88B2E', '#3E5C3A', '#4A5C7A', '#8B5E34'];
const NORMAL_EMOJI = ['🌿', '🍵', '🎋', '🧺'];
const ODD_EMOJI = ['🍃', '🫖', '🎍', '🧶'];
const MATCH_ICONS = ['🌻', '🫖', '🧺', '🪔', '🥭', '🐘', '🪕', '🧿'];
const DIMS = { 1: [3, 3], 2: [3, 4], 3: [4, 4], 4: [4, 5], 5: [5, 5] };
const TOTAL_ROUNDS = 5;

function computeLevels(sessions) {
  const levels = {};
  DOMAIN_KEYS.forEach((d) => {
    const arr = (sessions || []).filter((s) => s.domain === d);
    levels[d] = arr.length ? (arr[arr.length - 1].level || 1) : 1;
  });
  return levels;
}

/* The patient dashboard, reminders and voice control moved to patient.js
 * in Part 2. This file is now the game engine and the games themselves. */

function startGame(key) {
  if (!state.patient) { showToast(t('pleaseLoginFirst')); return; }
  state.game = { round: 1, correctCount: 0, times: [], feedback: null, answers: [] };
  // Set the screen and build the first round BEFORE rendering. Rendering
  // first would run the game renderer while state.game has no target/grid
  // yet, which threw "Cannot read properties of undefined".
  state.screen = key;
  nextRound();
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------- GAME SHELL */
function gameShellHtml(title, domain, bodyHtml) {
  return `
  ${patientTopBar()}
  <div class="max-w-3xl mx-auto px-5 py-6 fade-in">
    <button onclick="exitGame()" class="text-maroon text-sm mb-3">${t('backHome')}</button>
    <div class="flex items-center justify-between flex-wrap gap-2 mb-5">
      <h1 class="font-serif2 text-xl text-maroonDark">${title}</h1>
      <div class="text-xs bg-[#EDE7D8] text-inksoft px-3 py-1.5 rounded-full">
        ${DOMAIN_META[domain].label()} · ${t('level')} ${state.levels[domain]} · ${t('round')} ${state.game.round}/${TOTAL_ROUNDS}
      </div>
    </div>
    ${bodyHtml}
  </div>`;
}
/** Leaving a game must also cancel its pending timers, or a "show the
 * cards / hide the cards" callback can fire into a screen that has moved
 * on and overwrite it. */
function clearGameTimers() {
  if (!state.game) return;
  clearTimeout(state.game.matchTimer);
  clearTimeout(state.game.seqTimer);
}

function exitGame() {
  clearGameTimers();
  state.game = null;
  goto('patient-home');
}
function resultCardHtml(accuracy, avgTimeMs, domain) {
  const pct = Math.round(accuracy * 100);
  return `
  <div class="card-textile rounded-2xl p-8 text-center max-w-md mx-auto">
    <div class="text-3xl mb-2">🎉</div>
    <div class="font-serif2 text-xl mb-3">${t('activityComplete')}</div>
    <div class="text-sm text-inksoft mb-1">${t('score')}: <strong class="text-ink">${state.game.correctCount} / ${TOTAL_ROUNDS}</strong></div>
    <div class="text-sm text-inksoft mb-1">${t('accuracy')}: <strong class="text-ink">${pct}%</strong></div>
    <div class="text-sm text-inksoft mb-6">${t('avgResponseTime')}: <strong class="text-ink">${(avgTimeMs / 1000).toFixed(1)}s</strong></div>
    <div class="flex flex-col sm:flex-row gap-2.5 justify-center">
      <button onclick="speakResult(${state.game.correctCount},${TOTAL_ROUNDS},${pct})" class="px-5 py-3 rounded-lg bg-white border border-linec font-semibold">🔊 ${t('hearReminder')}</button>
      <button onclick="startGame('${state.screen}')" class="px-5 py-3 rounded-lg bg-ochre text-white font-semibold">${t('playAgain')}</button>
      <button onclick="finishGame('${domain}',${accuracy},${avgTimeMs})" class="px-5 py-3 rounded-lg bg-maroon text-white font-semibold">${t('backHome')}</button>
    </div>
  </div>`;
}
function speakResult(correct, total, pct) {
  const msg = `${t('score')} ${correct}/${total}. ${t('accuracy')} ${pct}%.`;
  voiceService.speak(msg, state.patient.lang);
}
async function finishGame(domain, accuracy, avgTimeMs) {
  const game = gameByKey(state.screen);
  state.levels[domain] = nextLevel(state.levels[domain] || 1, accuracy);
  const result = {
    patientId: state.patientId,
    gameType: game ? game.name : domain,
    domain,
    level: state.levels[domain], score: state.game.correctCount, totalRounds: TOTAL_ROUNDS,
    accuracy, avgTimeMs, answers: state.game.answers,
  };
  const res = await api.saveGameResult(result);
  if (!res.ok) {
    showToast(res.error || t('sessionNotSaved'));
  } else {
    // Never trust the old in-memory copy — take the fresh record the
    // backend returned, which already includes this session.
    state.patient = res.data.patient;
    state.levels = computeLevels(state.patient.sessions || []);
    showToast(t('sessionSaved'));
  }
  clearGameTimers();
  state.game = null;
  await loadNextReminder();
  goto('patient-home');
}

/* --- round dispatcher --- */
const ROUND_BUILDERS = {
  'game-familyfaces': () => newFamilyFacesRound(),
  'game-memorymatch': () => newMemoryMatchRound(),
  'game-sequence': () => newSequenceRound(),
  'game-wordrecall': () => newWordRecallRound(),
  'game-oddone': () => newOddOneRound(),
  'game-weaving': () => newWeavingRound(),
  'game-orientation': () => newOrientationRound(),
};

function nextRound() {
  const build = ROUND_BUILDERS[state.screen];
  if (build) build();
}

/** Shared: record one answer, show feedback, then move to the next round. */
function scoreAnswer({ isCorrect, selected, correct, delayMs }) {
  const dt = Date.now() - state.game.startTs;
  state.game.times.push(dt);
  state.game.answers.push({
    q: state.game.round, selected, correct, isCorrect, responseTimeMs: dt,
  });
  if (isCorrect) state.game.correctCount += 1;
  state.game.feedback = isCorrect ? 'correct' : 'wrong';
  render();
  setTimeout(() => {
    if (!state.game) return;
    if (state.game.round >= TOTAL_ROUNDS) { state.game.finished = true; render(); }
    else { state.game.round += 1; nextRound(); }
  }, delayMs || 800);
}

/** Shared: the "Activity complete" screen for any game. */
function finishedShell(gameKey) {
  const game = gameByKey(gameKey);
  const accuracy = state.game.correctCount / TOTAL_ROUNDS;
  const times = state.game.times;
  const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  return gameShellHtml(game.title(), game.domain, resultCardHtml(accuracy, avgTime, game.domain));
}

/** Shared: the feedback line shown between rounds. */
function feedbackLine() {
  const fb = state.game.feedback;
  if (!fb) return '<div class="mb-3" aria-hidden="true">&nbsp;</div>';
  return `<div role="status" aria-live="polite" class="text-lg font-semibold mb-3 ${fb === 'correct' ? 'text-leafgreen' : 'text-alertc'}">
    ${fb === 'correct' ? t('correct') : t('tryNext')}
  </div>`;
}

/* ============================================ GAME 1: Family Faces */
function newFamilyFacesRound() {
  const FAMILY = state.patient.family || [];
  if (FAMILY.length < 2) {
    // Nothing to play with — send the patient back rather than crashing.
    showToast(t('needFamilyMembers'));
    state.game = null;
    goto('patient-home');
    return;
  }
  const level = state.levels.memory;
  const optionCount = Math.min(3 + Math.floor((level - 1) / 2), FAMILY.length);
  const target = FAMILY[Math.floor(Math.random() * FAMILY.length)];
  const distractors = shuffle(FAMILY.filter((f) => f.id !== target.id)).slice(0, optionCount - 1).map((f) => f.relation);
  state.game.target = target;
  state.game.options = shuffle([target.relation, ...distractors]);
  state.game.startTs = Date.now();
  state.game.feedback = null;
  render();
}
function renderFamilyFaces() {
  if (state.game.finished) {
    const accuracy = state.game.correctCount / TOTAL_ROUNDS;
    const avgTime = state.game.times.reduce((a, b) => a + b, 0) / state.game.times.length;
    return gameShellHtml(t('familyFaces'), 'memory', resultCardHtml(accuracy, avgTime, 'memory'));
  }
  const tgt = state.game.target;
  const fb = state.game.feedback;
  const body = `
  <div class="text-center">
    <div class="w-28 h-28 rounded-full text-white flex items-center justify-center text-3xl font-bold mx-auto mb-5" style="background:${tgt.color}">${tgt.initial}</div>
    <div class="text-lg text-inksoft mb-2">${t('familyFacesInstructions')}</div>
    ${fb ? `<div class="text-sm font-semibold mb-3 ${fb === 'correct' ? 'text-leafgreen' : 'text-alertc'}">${fb === 'correct' ? t('correct') : t('tryNext')}</div>` : '<div class="mb-3">&nbsp;</div>'}
    <div class="grid gap-3 max-w-lg mx-auto" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      ${state.game.options.map((rel) => `
        <button onclick="chooseFamilyFaces('${rel}')"
          class="px-3 py-4 rounded-xl text-base font-semibold border-2 ${fb && rel === tgt.relation ? 'border-leafgreen bg-[#E7F1E5]' : 'border-linec bg-white'}">
          ${rel}
        </button>`).join('')}
    </div>
  </div>`;
  return gameShellHtml(t('familyFaces'), 'memory', body);
}
function chooseFamilyFaces(rel) {
  if (state.game.feedback) return;
  const tgt = state.game.target;
  const ok = rel === tgt.relation;
  const dt = Date.now() - state.game.startTs;
  state.game.times.push(dt);
  state.game.answers.push({ q: state.game.round, selected: rel, correct: tgt.relation, isCorrect: ok, responseTimeMs: dt });
  if (ok) state.game.correctCount++;
  state.game.feedback = ok ? 'correct' : 'wrong';
  render();
  setTimeout(() => {
    if (state.game.round >= TOTAL_ROUNDS) { state.game.finished = true; render(); }
    else { state.game.round++; newFamilyFacesRound(); }
  }, 900);
}

/* ============================================ GAME 2: Spot the Odd One */
function newOddOneRound() {
  const level = state.levels.attention;
  const [rows, cols] = DIMS[level] || [3, 3];
  const idx = Math.floor(Math.random() * (rows * cols));
  const pick = Math.floor(Math.random() * NORMAL_EMOJI.length);
  state.game.grid = { rows, cols, normal: NORMAL_EMOJI[pick], odd: ODD_EMOJI[pick], oddIndex: idx };
  state.game.startTs = Date.now();
  state.game.feedback = null;
  render();
}
function renderOddOne() {
  if (state.game.finished) {
    const accuracy = state.game.correctCount / TOTAL_ROUNDS;
    const avgTime = state.game.times.reduce((a, b) => a + b, 0) / state.game.times.length;
    return gameShellHtml(t('spotOddOne'), 'attention', resultCardHtml(accuracy, avgTime, 'attention'));
  }
  const g = state.game.grid;
  const fb = state.game.feedback;
  const cells = Array.from({ length: g.rows * g.cols }, (_, i) => `
    <button onclick="chooseOddOne(${i})" class="aspect-square text-2xl rounded-lg bg-white border-2 ${fb && i === g.oddIndex ? 'border-leafgreen' : 'border-linec'}">
      ${i === g.oddIndex ? g.odd : g.normal}
    </button>`).join('');
  const body = `
  <div class="text-center">
    <div class="text-base text-inksoft mb-4">${t('spotOddOneInstructions')}</div>
    <div class="grid gap-2 mx-auto" style="grid-template-columns:repeat(${g.cols},1fr); max-width:${g.cols * 78}px">${cells}</div>
  </div>`;
  return gameShellHtml(t('spotOddOne'), 'attention', body);
}
function chooseOddOne(i) {
  if (state.game.feedback) return;
  const g = state.game.grid;
  const ok = i === g.oddIndex;
  const dt = Date.now() - state.game.startTs;
  state.game.times.push(dt);
  state.game.answers.push({ q: state.game.round, selected: i, correct: g.oddIndex, isCorrect: ok, responseTimeMs: dt });
  if (ok) state.game.correctCount++;
  state.game.feedback = ok ? 'correct' : 'wrong';
  render();
  setTimeout(() => {
    if (state.game.round >= TOTAL_ROUNDS) { state.game.finished = true; render(); }
    else { state.game.round++; newOddOneRound(); }
  }, 600);
}

/* ============================================ GAME 3: Weaving Completion */
function genPattern(level) {
  const unitLen = level <= 2 ? 2 : 3;
  const unit = Array.from({ length: unitLen }, () => ({
    sym: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
    color: SHAPE_COLORS[Math.floor(Math.random() * SHAPE_COLORS.length)],
  }));
  const seq = Array.from({ length: 6 }, (_, i) => unit[i % unitLen]);
  const answer = seq[5];
  const visible = seq.slice(0, 5);
  const options = [answer];
  while (options.length < 4) {
    const cand = { sym: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)], color: SHAPE_COLORS[Math.floor(Math.random() * SHAPE_COLORS.length)] };
    if (!options.some((o) => o.sym === cand.sym && o.color === cand.color)) options.push(cand);
  }
  return { visible, answer, options: shuffle(options) };
}
function newWeavingRound() {
  state.game.pat = genPattern(state.levels.pattern);
  state.game.startTs = Date.now();
  state.game.feedback = null;
  render();
}
function renderWeaving() {
  if (state.game.finished) {
    const accuracy = state.game.correctCount / TOTAL_ROUNDS;
    const avgTime = state.game.times.reduce((a, b) => a + b, 0) / state.game.times.length;
    return gameShellHtml(t('weavingCompletion'), 'pattern', resultCardHtml(accuracy, avgTime, 'pattern'));
  }
  const pat = state.game.pat;
  const fb = state.game.feedback;
  const visibleHtml = pat.visible.map((it) => `
    <div class="w-14 h-14 rounded-lg bg-white border border-linec flex items-center justify-center text-2xl" style="color:${it.color}">${it.sym}</div>`).join('');
  const optionsHtml = pat.options.map((opt, i) => {
    const isAnswer = opt.sym === pat.answer.sym && opt.color === pat.answer.color;
    return `<button onclick='chooseWeaving(${i})' class="w-16 h-16 rounded-xl bg-white border-2 ${fb && isAnswer ? 'border-leafgreen' : 'border-linec'} flex items-center justify-center text-3xl" style="color:${opt.color}">${opt.sym}</button>`;
  }).join('');
  const body = `
  <div class="text-center">
    <div class="text-base text-inksoft mb-5">${t('weavingInstructions')}</div>
    <div class="flex gap-2.5 justify-center flex-wrap mb-8">
      ${visibleHtml}
      <div class="w-14 h-14 rounded-lg bg-[#EDE7D8] border-2 border-dashed border-ochre flex items-center justify-center text-xl font-bold text-ochre">?</div>
    </div>
    <div class="flex gap-3 justify-center flex-wrap">${optionsHtml}</div>
  </div>`;
  return gameShellHtml(t('weavingCompletion'), 'pattern', body);
}
function chooseWeaving(i) {
  if (state.game.feedback) return;
  const pat = state.game.pat;
  const opt = pat.options[i];
  const ok = opt.sym === pat.answer.sym && opt.color === pat.answer.color;
  const dt = Date.now() - state.game.startTs;
  state.game.times.push(dt);
  state.game.answers.push({ q: state.game.round, selected: i, correct: 'match', isCorrect: ok, responseTimeMs: dt });
  if (ok) state.game.correctCount++;
  state.game.feedback = ok ? 'correct' : 'wrong';
  render();
  setTimeout(() => {
    if (state.game.round >= TOTAL_ROUNDS) { state.game.finished = true; render(); }
    else { state.game.round++; newWeavingRound(); }
  }, 700);
}
