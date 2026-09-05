/* games-part2.js — the activities added in Part 2.
 *
 *   Memory Match     (memory)          — find the matching pair
 *   Sequence Recall  (problem solving) — repeat the sequence you were shown
 *   Word Recall      (language)        — which word belongs to the group
 *   Day and Date     (orientation)     — today's day, part of day, month
 *
 * They use the same engine as the original three (startGame, scoreAnswer,
 * finishGame) so every completed round is scored, timed and written to the
 * database in exactly the same way.
 */

/* ==================================================== MEMORY MATCH (memory)
 * Cards are shown face up for a moment, then turned over; the patient taps
 * the two that carry the same picture. Grid grows with the level. */

const MATCH_PAIRS_BY_LEVEL = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 };
const MEMORISE_MS = 3000;

function newMemoryMatchRound() {
  const level = state.levels.memory || 1;
  const pairCount = MATCH_PAIRS_BY_LEVEL[level] || 3;
  const icons = shuffle(MATCH_ICONS).slice(0, pairCount);
  const cards = shuffle([...icons, ...icons]).map((icon, i) => ({ id: i, icon, matched: false }));

  state.game.match = { cards, revealed: true, picked: [], pairsFound: 0, pairCount, mistakes: 0 };
  state.game.startTs = Date.now();
  state.game.feedback = null;
  render();

  // Show the cards briefly, then hide them. The timer is cleared on exit so
  // it can never fire into a screen that has moved on.
  clearTimeout(state.game.matchTimer);
  state.game.matchTimer = setTimeout(() => {
    if (!state.game || !state.game.match) return;
    state.game.match.revealed = false;
    state.game.startTs = Date.now(); // timing starts when the cards go down
    render();
  }, MEMORISE_MS);
}

function renderMemoryMatch() {
  if (state.game.finished) return finishedShell('game-memorymatch');
  const m = state.game.match;
  const cols = m.cards.length <= 4 ? 2 : m.cards.length <= 8 ? 4 : 4;

  const cells = m.cards.map((c) => {
    const shown = m.revealed || c.matched || m.picked.includes(c.id);
    const cls = c.matched
      ? 'bg-[#E7F1E5] border-leafgreen'
      : shown ? 'bg-white border-ochre' : 'bg-[#EDE7D8] border-linec';
    return `
      <button onclick="pickMatchCard(${c.id})" ${c.matched || m.revealed ? 'disabled' : ''}
        aria-label="${shown ? escapeHtml(c.icon) : t('hiddenCard')}"
        class="aspect-square rounded-2xl border-4 ${cls} flex items-center justify-center text-4xl sm:text-5xl transition disabled:opacity-100">
        ${shown ? c.icon : '❔'}
      </button>`;
  }).join('');

  const body = `
  <div class="text-center">
    <p class="text-lg sm:text-xl text-inksoft mb-4">${m.revealed ? t('memorise') : t('memoryMatchInstructions')}</p>
    ${feedbackLine()}
    <div class="grid gap-3 sm:gap-4 mx-auto" style="grid-template-columns:repeat(${cols},minmax(0,1fr));max-width:${cols * 120}px">
      ${cells}
    </div>
    <p class="text-base text-inksoft mt-5">${t('pairsFound')}: <strong>${m.pairsFound}/${m.pairCount}</strong></p>
  </div>`;
  return gameShellHtml(t('memoryMatch'), 'memory', body);
}

function pickMatchCard(id) {
  const m = state.game && state.game.match;
  if (!m || m.revealed || state.game.feedback) return;
  const card = m.cards.find((c) => c.id === id);
  if (!card || card.matched || m.picked.includes(id)) return;
  if (m.picked.length >= 2) return;

  m.picked.push(id);
  render();
  if (m.picked.length < 2) return;

  const [a, b] = m.picked.map((cid) => m.cards.find((c) => c.id === cid));
  const isPair = a.icon === b.icon;

  setTimeout(() => {
    if (!state.game || !state.game.match) return;
    if (isPair) {
      a.matched = true; b.matched = true;
      m.pairsFound += 1;
    } else {
      m.mistakes += 1;
    }
    m.picked = [];

    if (m.pairsFound >= m.pairCount) {
      // One round is solved when every pair is found; it counts as correct
      // if it took no more wrong turns than there were pairs.
      scoreAnswer({
        isCorrect: m.mistakes <= m.pairCount,
        selected: `${m.pairsFound} pairs, ${m.mistakes} wrong turns`,
        correct: `${m.pairCount} pairs`,
        delayMs: 900,
      });
    } else {
      render();
    }
  }, isPair ? 350 : 750);
}

/* ============================================ SEQUENCE RECALL (problem solving)
 * A row of coloured shapes flashes up; the patient taps them back in the
 * same order. Length grows with the level. */

const SEQ_ITEMS = [
  { icon: '🔴', name: 'red' }, { icon: '🔵', name: 'blue' }, { icon: '🟢', name: 'green' },
  { icon: '🟡', name: 'yellow' }, { icon: '🟣', name: 'purple' }, { icon: '🟠', name: 'orange' },
];
const SEQ_LENGTH_BY_LEVEL = { 1: 3, 2: 4, 3: 4, 4: 5, 5: 6 };
const SEQ_SHOW_MS = 2600;

function newSequenceRound() {
  const level = state.levels.problem_solving || 1;
  const len = SEQ_LENGTH_BY_LEVEL[level] || 3;
  const sequence = Array.from({ length: len }, () => SEQ_ITEMS[Math.floor(Math.random() * SEQ_ITEMS.length)]);

  state.game.seq = { sequence, entered: [], showing: true };
  state.game.startTs = Date.now();
  state.game.feedback = null;
  render();

  clearTimeout(state.game.seqTimer);
  state.game.seqTimer = setTimeout(() => {
    if (!state.game || !state.game.seq) return;
    state.game.seq.showing = false;
    state.game.startTs = Date.now(); // timing starts when they may answer
    render();
  }, SEQ_SHOW_MS);
}

function renderSequence() {
  if (state.game.finished) return finishedShell('game-sequence');
  const s = state.game.seq;

  const strip = s.showing
    ? s.sequence.map((it) => `<span class="text-4xl sm:text-5xl">${it.icon}</span>`).join('')
    : s.sequence.map((_, i) => `<span class="text-4xl sm:text-5xl">${s.entered[i] ? s.entered[i].icon : '⬜'}</span>`).join('');

  const buttons = SEQ_ITEMS.map((it, i) => `
    <button onclick="pickSequenceItem(${i})" ${s.showing ? 'disabled' : ''} aria-label="${it.name}"
      class="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl border-4 border-linec bg-white text-3xl sm:text-4xl flex items-center justify-center disabled:opacity-40">
      ${it.icon}
    </button>`).join('');

  const body = `
  <div class="text-center">
    <p class="text-lg sm:text-xl text-inksoft mb-4">${s.showing ? t('watchTheOrder') : t('sequenceRecallInstructions')}</p>
    ${feedbackLine()}
    <div class="flex gap-3 justify-center flex-wrap mb-6 min-h-[64px] items-center">${strip}</div>
    <div class="flex gap-3 justify-center flex-wrap">${buttons}</div>
    ${!s.showing && s.entered.length ? `
      <button onclick="undoSequenceItem()" class="mt-5 px-5 py-3 rounded-xl border-2 border-linec bg-white text-base font-semibold">↩ ${t('undo')}</button>` : ''}
  </div>`;
  return gameShellHtml(t('sequenceRecall'), 'problem_solving', body);
}

function pickSequenceItem(index) {
  const s = state.game && state.game.seq;
  if (!s || s.showing || state.game.feedback) return;
  if (s.entered.length >= s.sequence.length) return;

  s.entered.push(SEQ_ITEMS[index]);
  if (s.entered.length < s.sequence.length) { render(); return; }

  const isCorrect = s.entered.every((it, i) => it.icon === s.sequence[i].icon);
  scoreAnswer({
    isCorrect,
    selected: s.entered.map((it) => it.name).join(','),
    correct: s.sequence.map((it) => it.name).join(','),
    delayMs: 1000,
  });
}

function undoSequenceItem() {
  const s = state.game && state.game.seq;
  if (!s || s.showing || state.game.feedback) return;
  s.entered.pop();
  render();
}

/* ==================================================== WORD RECALL (language)
 * A small category task: four words, three belong together. Language work
 * without needing text input, which is hard on a touch screen. */

const WORD_SETS = [
  { category: 'Fruits', words: ['Mango', 'Banana', 'Guava'], odd: 'Chair' },
  { category: 'Animals', words: ['Cow', 'Goat', 'Elephant'], odd: 'River' },
  { category: 'Vegetables', words: ['Potato', 'Onion', 'Brinjal'], odd: 'Bicycle' },
  { category: 'Clothes', words: ['Saree', 'Shirt', 'Shawl'], odd: 'Spoon' },
  { category: 'Kitchen things', words: ['Pot', 'Spoon', 'Plate'], odd: 'Cloud' },
  { category: 'Family', words: ['Mother', 'Brother', 'Sister'], odd: 'Window' },
  { category: 'Weather', words: ['Rain', 'Cloud', 'Wind'], odd: 'Pencil' },
  { category: 'Body', words: ['Hand', 'Eye', 'Foot'], odd: 'Bucket' },
];

function newWordRecallRound() {
  const set = WORD_SETS[Math.floor(Math.random() * WORD_SETS.length)];
  state.game.word = {
    category: set.category,
    options: shuffle([...set.words, set.odd]),
    odd: set.odd,
  };
  state.game.startTs = Date.now();
  state.game.feedback = null;
  render();
}

function renderWordRecall() {
  if (state.game.finished) return finishedShell('game-wordrecall');
  const w = state.game.word;
  const fb = state.game.feedback;

  const options = w.options.map((word) => {
    const highlight = fb && word === w.odd ? 'border-leafgreen bg-[#E7F1E5]' : 'border-linec bg-white';
    return `
      <button onclick="chooseWord('${jsAttr(word)}')" ${fb ? 'disabled' : ''}
        class="px-4 py-5 rounded-2xl border-4 ${highlight} text-xl sm:text-2xl font-semibold">
        ${escapeHtml(word)}
      </button>`;
  }).join('');

  const body = `
  <div class="text-center">
    <p class="text-lg sm:text-xl text-inksoft mb-2">${t('wordRecallInstructions')}</p>
    <p class="text-2xl sm:text-3xl font-serif2 text-maroon mb-4">${escapeHtml(w.category)}</p>
    ${feedbackLine()}
    <div class="grid gap-3 sm:gap-4 max-w-xl mx-auto" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${options}
    </div>
    <button onclick="speakWordPrompt()" class="mt-6 px-5 py-3 rounded-xl border-2 border-linec bg-white text-base font-semibold">
      🔊 ${t('readAloud')}
    </button>
  </div>`;
  return gameShellHtml(t('wordRecall'), 'language', body);
}

function chooseWord(word) {
  if (!state.game || !state.game.word || state.game.feedback) return;
  const w = state.game.word;
  scoreAnswer({ isCorrect: word === w.odd, selected: word, correct: w.odd, delayMs: 900 });
}

function speakWordPrompt() {
  const w = state.game && state.game.word;
  if (!w) return;
  voiceService.speak(`${w.category}. ${w.options.join(', ')}`, state.patient.lang);
}

/* ================================================ DAY AND DATE (orientation)
 * A standard orientation check used in memory care: the day, the part of
 * the day and the month. The correct answer is taken from the device
 * clock, so it is always genuinely verifiable. */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function partOfDay(hour) {
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  if (hour < 21) return 'Evening';
  return 'Night';
}

function newOrientationRound() {
  const now = new Date();
  const kinds = ['day', 'partOfDay', 'month', 'date', 'season'];
  const kind = kinds[(state.game.round - 1) % kinds.length];

  let question;
  let answer;
  let options;

  if (kind === 'day') {
    answer = DAY_NAMES[now.getDay()];
    question = t('whichDayToday');
    options = shuffle([answer, ...shuffle(DAY_NAMES.filter((d) => d !== answer)).slice(0, 3)]);
  } else if (kind === 'partOfDay') {
    answer = partOfDay(now.getHours());
    question = t('whichPartOfDay');
    options = shuffle(['Morning', 'Afternoon', 'Evening', 'Night']);
  } else if (kind === 'month') {
    answer = MONTH_NAMES[now.getMonth()];
    question = t('whichMonth');
    options = shuffle([answer, ...shuffle(MONTH_NAMES.filter((m) => m !== answer)).slice(0, 3)]);
  } else if (kind === 'date') {
    answer = String(now.getDate());
    question = t('whichDateToday');
    const others = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => {
      const d = now.getDate() + (n % 2 ? n : -n);
      return d;
    }).filter((d) => d >= 1 && d <= 31 && d !== now.getDate())).slice(0, 3).map(String);
    options = shuffle([answer, ...others]);
  } else {
    const month = now.getMonth();
    answer = month >= 2 && month <= 5 ? 'Summer' : month >= 6 && month <= 9 ? 'Monsoon' : 'Winter';
    question = t('whichSeason');
    options = shuffle(['Summer', 'Monsoon', 'Winter', 'Spring']);
  }

  state.game.orient = { question, answer, options };
  state.game.startTs = Date.now();
  state.game.feedback = null;
  render();
}

function renderOrientation() {
  if (state.game.finished) return finishedShell('game-orientation');
  const o = state.game.orient;
  const fb = state.game.feedback;

  const options = o.options.map((opt) => {
    const highlight = fb && opt === o.answer ? 'border-leafgreen bg-[#E7F1E5]' : 'border-linec bg-white';
    return `
      <button onclick="chooseOrientation('${jsAttr(opt)}')" ${fb ? 'disabled' : ''}
        class="px-4 py-5 rounded-2xl border-4 ${highlight} text-xl sm:text-2xl font-semibold">
        ${escapeHtml(opt)}
      </button>`;
  }).join('');

  const body = `
  <div class="text-center">
    <p class="text-2xl sm:text-3xl font-serif2 text-maroonDark mb-5">${escapeHtml(o.question)}</p>
    ${feedbackLine()}
    <div class="grid gap-3 sm:gap-4 max-w-xl mx-auto" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${options}
    </div>
    <button onclick="voiceService.speak(${JSON.stringify(o.question)}, state.patient.lang)"
      class="mt-6 px-5 py-3 rounded-xl border-2 border-linec bg-white text-base font-semibold">
      🔊 ${t('readAloud')}
    </button>
  </div>`;
  return gameShellHtml(t('dayAndDate'), 'orientation', body);
}

function chooseOrientation(choice) {
  if (!state.game || !state.game.orient || state.game.feedback) return;
  const o = state.game.orient;
  scoreAnswer({ isCorrect: choice === o.answer, selected: choice, correct: o.answer, delayMs: 900 });
}
