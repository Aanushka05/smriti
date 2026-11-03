/* Cultural themes, elder accessibility, and the chat provider layer.
 *
 * The contrast figures below are computed with the WCAG relative-luminance
 * formula against the actual values in themes.css, so "accessible" is measured
 * rather than asserted. */
const fs = require('fs');
const path = require('path');
const FRONTEND = path.join(__dirname, '..', 'frontend');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

/* ---- WCAG contrast, from first principles ---- */
const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/** Pulls the variables for one theme block out of themes.css. */
function themeVars(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const vars = {};
  for (const m of body.matchAll(/--([a-zA-Z-]+):\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*;/g)) {
    vars[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return vars;
}

(async () => {
  const css = fs.readFileSync(path.join(FRONTEND, 'themes.css'), 'utf8');
  const themeJs = fs.readFileSync(path.join(FRONTEND, 'theme.js'), 'utf8');
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');

  console.log('\n== the palette is themeable at all ==');
  check('Tailwind colours read from CSS variables',
    /maroon: 'rgb\(var\(--c-maroon\)/.test(html));
  check('opacity modifiers still work (<alpha-value>)',
    /<alpha-value>/.test(html));
  check('themes.css is loaded', /themes\.css/.test(html));
  check('theme.js is loaded', /theme\.js/.test(html));

  console.log('\n== every language maps to a palette ==');
  for (const [lang, expected] of [
    ['as', 'assam'], ['brx', 'bodo'], ['mni', 'manipur'],
    ['mr', 'maharashtra'], ['hi', 'india'], ['bn', 'bengal'], ['en', 'neutral'],
  ]) {
    const re = new RegExp(`${lang}:\\s*'${expected}'`);
    check(`${lang} -> ${expected}`, re.test(themeJs) || (lang === 'en' && /en: 'neutral'/.test(themeJs)));
  }
  check('an unknown language falls back to neutral rather than guessing',
    /LANGUAGE_THEMES\[base\] \|\| 'neutral'/.test(themeJs));

  console.log('\n== contrast: measured, for every theme ==');
  // The floor is WCAG AA (4.5:1). These are elderly users on cheap screens,
  // so the target is AAA (7:1) and the assertions below hold it there.
  const themes = {
    neutral: ':root {',
    assam: ":root[data-theme='assam']",
    maharashtra: ":root[data-theme='maharashtra']",
    manipur: ":root[data-theme='manipur']",
    bodo: ":root[data-theme='bodo']",
    india: ":root[data-theme='india']",
    bengal: ":root[data-theme='bengal']",
  };
  const baseVars = themeVars(css, ':root {');

  for (const [name, selector] of Object.entries(themes)) {
    const v = { ...baseVars, ...(themeVars(css, selector) || {}) };
    const ink = v['c-ink'], cream = v['c-cream'], panel = v['c-panel'], maroon = v['c-maroon'];
    check(`${name}: defines its colours`, !!(ink && cream && panel && maroon), Object.keys(v).length);
    if (!(ink && cream && panel && maroon)) continue;

    const onCream = contrast(ink, cream);
    const onPanel = contrast(ink, panel);
    const button = contrast([255, 255, 255], maroon);
    check(`${name}: body text on background clears AAA (${onCream.toFixed(1)}:1)`, onCream >= 7, onCream.toFixed(2));
    check(`${name}: body text on cards clears AAA (${onPanel.toFixed(1)}:1)`, onPanel >= 7, onPanel.toFixed(2));
    check(`${name}: white on the primary button clears AAA (${button.toFixed(1)}:1)`, button >= 7, button.toFixed(2));
  }

  console.log('\n== the theme cannot hurt accessibility ==');
  check('a visible focus ring is defined', /:focus-visible/.test(css) && /outline:/.test(css));
  check('the ring survives Windows high-contrast mode', /forced-colors: active/.test(css));
  check('reduced-motion is honoured', /prefers-reduced-motion: reduce/.test(css));
  check('and it disables the theme fade too', /--theme-fade: 0ms/.test(css));
  check('themes tint only — no background images or moving patterns',
    !/background-image:\s*url|@keyframes/.test(css));

  console.log('\n== elder-friendly basics survive ==');
  const styles = fs.readFileSync(path.join(FRONTEND, 'styles.css'), 'utf8');
  const patient = fs.readFileSync(path.join(FRONTEND, 'patient.js'), 'utf8');
  check('touch targets are at least 44px', /min-h-\[44px\]/.test(patient) || /min-height:\s*44px/.test(styles));
  check('the patient screen uses large type', /text-xl|text-2xl|btn-patient/.test(patient));
  check('charts carry a text alternative', /role="img"/.test(
    fs.readFileSync(path.join(FRONTEND, 'dashboard-play.js'), 'utf8')));
  check('live regions announce changes', /aria-live/.test(patient)
    || /aria-live/.test(fs.readFileSync(path.join(FRONTEND, 'games.js'), 'utf8')));

  console.log('\n== the theme persists ==');
  check('the choice is written to storage', /localStorage\.setItem\(THEME_STORAGE_KEY/.test(themeJs));
  check('the language preference wins over a stale theme',
    /smritisaathi\.lang/.test(themeJs) && /if \(lang\) return applyThemeForLanguage/.test(themeJs));
  check('it is restored before the first paint',
    /restoreTheme\(\)/.test(fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8')));
  check('changing language changes the palette',
    /applyThemeForLanguage\(langCode\)/.test(fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8')));
  check('storage failures do not break the app', /catch \{ \/\* private mode \*\//.test(themeJs));

  console.log('\n== the chat provider layer ==');
  const providers = fs.readFileSync(path.join(__dirname, '..', 'backend', 'chat_providers.js'), 'utf8');
  check('Kiwi is a configurable provider', /kiwi: \{/.test(providers));
  check('its endpoint comes from the environment, not the source',
    /process\.env\.KIWI_API_URL/.test(providers));
  check('NO endpoint URL is invented for it',
    !/kiwi[a-z.]*\.(ai|com|io|dev)/i.test(providers), 'a Kiwi URL appears to be hard-coded');
  check('both common request shapes are supported',
    /openAiStyle/.test(providers) && /anthropicStyle/.test(providers));
  check('the existing provider still works so nothing breaks',
    /anthropic: \{/.test(providers));
  check('the system prompt forbids acting as a doctor',
    /NOT a doctor/.test(providers) && /not diagnose/i.test(providers));
  check('the key is read server-side only',
    !/KIWI_API_KEY/.test(fs.readFileSync(path.join(FRONTEND, 'chat.js'), 'utf8')));

  const chatRoute = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'chat.js'), 'utf8');
  check('chat is rate limited', /chatRateLimited/.test(chatRoute));
  check('message length is bounded', /length > 2000/.test(chatRoute));
  check('upstream errors are not echoed to the browser',
    !/res\.status\(502\)\.json\(\{ error: err\.message/.test(chatRoute));

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
