/* ============================================================================
 * adaptive.js — difficulty that follows the patient, and a grade that means
 * something.
 *
 * WHY A LOCAL MODEL, NOT A CLOUD ONE
 * A patient with no signal must still get questions pitched at the right
 * level; a difficulty engine that needs the internet is a difficulty engine
 * that fails exactly when the patient is most isolated. So the decision rules
 * live here, on the device, and run in microseconds against the current
 * session. Everything they observe is recorded and synced, which is what makes
 * a trained per-patient model possible later WITHOUT changing any caller:
 * `adaptiveDecide()` is the only place a decision is made, and its inputs are
 * already the feature vector such a model would want.
 *
 * The ladder is deliberately the existing 1-5 level scale, so nothing that
 * already reads `session.level` has to change:
 *
 *   1 Easy · 2 Easy-Medium · 3 Medium · 4 Medium-Hard · 5 Hard
 *
 * Movement is ONE step at a time, never a jump. A patient who is doing well
 * should feel gently stretched, not ambushed.
 * ==========================================================================*/

const DIFFICULTY_LEVELS = [
  { level: 1, key: 'easy' },
  { level: 2, key: 'easy_medium' },
  { level: 3, key: 'medium' },
  { level: 4, key: 'medium_hard' },
  { level: 5, key: 'hard' },
];

function difficultyKey(level) {
  const found = DIFFICULTY_LEVELS.find((d) => d.level === Number(level));
  return (found || DIFFICULTY_LEVELS[0]).key;
}

/** "Medium-Hard" etc., in the patient's language. */
function difficultyLabel(level) {
  return t('diff_' + difficultyKey(level));
}

/* ------------------------------------------------------------- tuning
 * These are the numbers a future trained model would learn. They are named
 * and gathered here so that swapping rules for a model is a local change.
 */
const ADAPTIVE = {
  STUCK_MS: 12000,          // offer a hint after this long on one question
  TIMEOUT_MS: 25000,        // offer to move on after this long
  PROMOTE_STREAK: 3,        // consecutive correct answers before stepping up
  DEMOTE_STREAK: 2,         // consecutive wrong answers before stepping down
  FAST_ENOUGH_MS: 9000,     // a promotion also wants answers that are not laboured
  MIN_LEVEL: 1,
  MAX_LEVEL: 5,
};

/* --------------------------------------------------------- the tracker */

/**
 * Starts tracking one play-through. `startLevel` is where the patient left
 * off, so a session begins where the last one ended rather than at zero.
 */
function adaptiveStart(domain, startLevel) {
  const level = clampLevel(startLevel || 1);
  return {
    domain,
    startLevel: level,
    level,
    maxLevel: level,
    correct: 0,
    wrong: 0,
    hints: 0,
    skips: 0,
    timeouts: 0,
    streakCorrect: 0,
    streakWrong: 0,
    times: [],            // response time per answered question
    perRound: [],         // { round, level, isCorrect, responseTimeMs, usedHint, skipped, timedOut }
    changes: [],          // { round, from, to, reason }
    startedAt: Date.now(),
  };
}

function clampLevel(level) {
  return Math.min(ADAPTIVE.MAX_LEVEL, Math.max(ADAPTIVE.MIN_LEVEL, Number(level) || 1));
}

/**
 * Records one question's outcome and returns the difficulty decision.
 *
 * The rules, in the order they are checked:
 *   - a skipped or timed-out question steps DOWN, because the patient just
 *     told us the question was out of reach;
 *   - DEMOTE_STREAK wrong answers in a row step down;
 *   - PROMOTE_STREAK correct answers in a row step up, but only if they were
 *     not laboured and no hint was needed — otherwise the patient is coping,
 *     not mastering, and raising the bar would punish them for persevering.
 */
function adaptiveObserve(tracker, outcome) {
  if (!tracker) return { level: 1, direction: 'none', reason: 'no_tracker' };
  const {
    round = tracker.perRound.length + 1,
    isCorrect = false,
    responseTimeMs = 0,
    usedHint = false,
    skipped = false,
    timedOut = false,
  } = outcome || {};

  if (usedHint) tracker.hints += 1;
  if (skipped) tracker.skips += 1;
  if (timedOut) tracker.timeouts += 1;

  const answered = !skipped;
  if (answered) {
    tracker.times.push(responseTimeMs);
    if (isCorrect) {
      tracker.correct += 1;
      tracker.streakCorrect += 1;
      tracker.streakWrong = 0;
    } else {
      tracker.wrong += 1;
      tracker.streakWrong += 1;
      tracker.streakCorrect = 0;
    }
  } else {
    // A skip breaks a good run without counting as a wrong answer: the patient
    // did not get it wrong, they were not able to engage with it.
    tracker.streakCorrect = 0;
  }

  tracker.perRound.push({
    round, level: tracker.level, isCorrect: answered ? isCorrect : null,
    responseTimeMs: answered ? responseTimeMs : null, usedHint, skipped, timedOut,
  });

  const decision = adaptiveDecide(tracker, { usedHint, skipped, timedOut, responseTimeMs });
  if (decision.direction !== 'none') {
    tracker.changes.push({
      round, from: tracker.level, to: decision.level, reason: decision.reason,
    });
    tracker.level = decision.level;
    tracker.maxLevel = Math.max(tracker.maxLevel, decision.level);
    // A step resets both streaks: the next questions are a different problem,
    // so judging them on a run built at another level would compound.
    tracker.streakCorrect = 0;
    tracker.streakWrong = 0;
  }
  return decision;
}

/**
 * The single decision point. Everything it reads is on the tracker, so a
 * trained model can replace the body without touching a single caller.
 */
function adaptiveDecide(tracker, ctx = {}) {
  const level = tracker.level;

  if (ctx.skipped || ctx.timedOut) {
    const next = clampLevel(level - 1);
    return next === level
      ? { level, direction: 'none', reason: 'already_easiest' }
      : { level: next, direction: 'down', reason: ctx.skipped ? 'skipped' : 'timed_out' };
  }

  if (tracker.streakWrong >= ADAPTIVE.DEMOTE_STREAK) {
    const next = clampLevel(level - 1);
    return next === level
      ? { level, direction: 'none', reason: 'already_easiest' }
      : { level: next, direction: 'down', reason: 'consecutive_wrong' };
  }

  if (tracker.streakCorrect >= ADAPTIVE.PROMOTE_STREAK) {
    const recent = tracker.times.slice(-ADAPTIVE.PROMOTE_STREAK);
    const laboured = recent.some((ms) => ms > ADAPTIVE.FAST_ENOUGH_MS);
    if (laboured || ctx.usedHint) {
      return { level, direction: 'none', reason: 'correct_but_effortful' };
    }
    const next = clampLevel(level + 1);
    return next === level
      ? { level, direction: 'none', reason: 'already_hardest' }
      : { level: next, direction: 'up', reason: 'consecutive_correct' };
  }

  return { level, direction: 'none', reason: 'steady' };
}

/** Has the patient been sitting on this question long enough to want help? */
function adaptiveIsStuck(startedAt, now) {
  return (now || Date.now()) - startedAt >= ADAPTIVE.STUCK_MS;
}

/** Long enough that the kind thing is to let them move on? */
function adaptiveCanSkip(startedAt, now) {
  return (now || Date.now()) - startedAt >= ADAPTIVE.TIMEOUT_MS;
}

/* ---------------------------------------------------------- the grade
 * Counting right answers rewards a patient who never leaves the easiest
 * level and punishes one who is being stretched. So the score is built from
 * what actually happened.
 */

const GRADE_WEIGHTS = {
  accuracy: 55,        // still the biggest single factor, but not the only one
  difficulty: 20,      // how hard the questions they answered actually were
  speed: 10,
  consistency: 10,
  improvement: 5,
};

const GRADE_PENALTIES = {
  perHint: 2, maxHint: 10,
  perSkip: 3, maxSkip: 12,
  perTimeout: 2, maxTimeout: 8,
};

function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A 0-100 score from the whole picture, plus the parts it was built from so
 * the caregiver can see WHY — a bare number invites the wrong conclusions.
 */
function gradeSession(tracker) {
  const answered = tracker.correct + tracker.wrong;
  const accuracy = answered ? tracker.correct / answered : 0;

  // Difficulty actually faced, not merely reached: the average level of the
  // questions they answered. Coasting on level 1 scores lower than working at 4.
  const levels = tracker.perRound.filter((r) => !r.skipped).map((r) => r.level);
  const avgLevel = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : tracker.startLevel;

  // Speed, scored against a generous target. Elderly patients must never be
  // punished for being deliberate, so this is a small bonus, not a penalty.
  const med = median(tracker.times.filter((n) => n > 0));
  const speedRatio = med ? Math.max(0, Math.min(1, (ADAPTIVE.FAST_ENOUGH_MS * 1.5 - med) / (ADAPTIVE.FAST_ENOUGH_MS * 1.5))) : 0;

  // Consistency: how little the answers wobbled. One bad run among good ones
  // matters less than alternating right and wrong all the way through.
  const marks = tracker.perRound.filter((r) => r.isCorrect !== null).map((r) => (r.isCorrect ? 1 : 0));
  let flips = 0;
  for (let i = 1; i < marks.length; i++) if (marks[i] !== marks[i - 1]) flips += 1;
  const consistency = marks.length > 1 ? 1 - flips / (marks.length - 1) : 1;

  // Improvement within the session: second half against first half.
  const half = Math.floor(marks.length / 2);
  const firstHalf = marks.slice(0, half);
  const secondHalf = marks.slice(half);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const improvement = marks.length >= 4
    ? Math.max(0, Math.min(1, (mean(secondHalf) - mean(firstHalf) + 1) / 2))
    : 0.5;

  const points =
    accuracy * GRADE_WEIGHTS.accuracy +
    ((avgLevel - 1) / 4) * GRADE_WEIGHTS.difficulty +
    speedRatio * GRADE_WEIGHTS.speed +
    consistency * GRADE_WEIGHTS.consistency +
    improvement * GRADE_WEIGHTS.improvement;

  const penalty =
    Math.min(tracker.hints * GRADE_PENALTIES.perHint, GRADE_PENALTIES.maxHint) +
    Math.min(tracker.skips * GRADE_PENALTIES.perSkip, GRADE_PENALTIES.maxSkip) +
    Math.min(tracker.timeouts * GRADE_PENALTIES.perTimeout, GRADE_PENALTIES.maxTimeout);

  const score = Math.round(Math.max(0, Math.min(100, points - penalty)));

  return {
    score,
    band: gradeBand(score),
    parts: {
      accuracy: Math.round(accuracy * 100),
      avgLevel: Math.round(avgLevel * 10) / 10,
      medianTimeMs: Math.round(med),
      consistency: Math.round(consistency * 100),
      improvement: Math.round(improvement * 100),
      penalty: Math.round(penalty),
    },
  };
}

function gradeBand(score) {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'steady';
  return 'needs_support';
}

/**
 * A plain-language status for the caregiver. Deliberately descriptive, never
 * diagnostic — this describes an activity, not a person's health.
 */
function adaptiveStatus(tracker) {
  if (!tracker) return 'stable';
  const up = tracker.changes.filter((c) => c.to > c.from).length;
  const down = tracker.changes.filter((c) => c.to < c.from).length;
  if (tracker.skips + tracker.timeouts >= 2) return 'needs_assistance';
  if (down > up) return 'difficulty_reduced';
  if (up > down) return 'difficulty_increased';
  if (tracker.correct > tracker.wrong) return 'improving';
  return 'stable';
}

/** Everything worth storing about a play-through, ready to sync. */
function adaptiveSummary(tracker) {
  const grade = gradeSession(tracker);
  return {
    startLevel: tracker.startLevel,
    endLevel: tracker.level,
    maxLevel: tracker.maxLevel,
    correct: tracker.correct,
    wrong: tracker.wrong,
    hints: tracker.hints,
    skips: tracker.skips,
    timeouts: tracker.timeouts,
    difficultyChanges: tracker.changes,
    perRound: tracker.perRound,
    durationMs: Date.now() - tracker.startedAt,
    score: grade.score,
    band: grade.band,
    gradeParts: grade.parts,
    status: adaptiveStatus(tracker),
  };
}
