/* ============================================================================
 * theme.js — the language chooses the palette.
 *
 * One idea: picking a language sets a `data-theme` attribute on <html>, and
 * every colour in the app follows, because the Tailwind palette is built from
 * CSS variables (see themes.css). No component knows a theme exists.
 *
 * The choice is stored next to the language preference, so it survives a
 * reload, a logout, and being offline — it is a local preference, not
 * something that needs the server.
 * ==========================================================================*/

/* Which palette belongs with which language. Anything not listed gets the
 * neutral one — a deliberate default rather than a guess at someone's
 * cultural context. */
const LANGUAGE_THEMES = {
  as: 'assam',        // Assamese
  brx: 'bodo',        // Bodo
  mni: 'manipur',     // Manipuri / Meitei
  mr: 'maharashtra',  // Marathi
  bn: 'bengal',       // Bengali
  hi: 'india',        // Hindi
  ne: 'assam',        // Nepali — widely spoken in the same hills
  or: 'bengal',
  ur: 'india',
  gu: 'india', kn: 'india', ml: 'india', pa: 'india', ta: 'india', te: 'india',
  en: 'neutral',
};

const THEME_STORAGE_KEY = 'smritisaathi.theme';
const VALID_THEMES = new Set(
  ['neutral', 'assam', 'bodo', 'manipur', 'maharashtra', 'bengal', 'india']);

/** The palette for a language code, e.g. "as-IN" -> "assam". */
function themeForLanguage(langCode) {
  const base = String(langCode || 'en').split('-')[0].toLowerCase();
  return LANGUAGE_THEMES[base] || 'neutral';
}

/**
 * Applies a palette. Called on boot and whenever the language changes.
 *
 * The neutral theme sets no attribute at all, so the default :root values in
 * themes.css apply — one less thing that can go wrong.
 */
function applyTheme(themeName) {
  const theme = VALID_THEMES.has(themeName) ? themeName : 'neutral';
  const root = document.documentElement;

  if (theme === 'neutral') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  // Keep the browser chrome in step with the app on mobile.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const maroon = getComputedStyle(root).getPropertyValue('--c-maroon').trim();
    if (maroon) meta.setAttribute('content', `rgb(${maroon})`);
  }

  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* private mode */ }
  state.theme = theme;
  return theme;
}

/** Applies the palette that belongs with a language. */
function applyThemeForLanguage(langCode) {
  return applyTheme(themeForLanguage(langCode));
}

/**
 * Restores the saved palette as early as possible.
 *
 * The language preference is the source of truth; the stored theme is only
 * used when no language has been chosen yet, so the two can never disagree.
 */
function restoreTheme() {
  let lang = null;
  try { lang = localStorage.getItem('smritisaathi.lang'); } catch { /* ignore */ }
  if (lang) return applyThemeForLanguage(lang);

  let saved = null;
  try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* ignore */ }
  return applyTheme(saved || 'neutral');
}

/** A human name for the active palette, for the language picker. */
function themeLabel(themeName) {
  return t('theme_' + (themeName || 'neutral')) || '';
}
