/**
 * Sanityzacja SVG wgrywanych przez klienta i sprzedawce.
 *
 * SVG to dokument XML z pelna moca skryptowa - wgrany bez czyszczenia
 * i zaserwowany z naszej domeny wykonalby dowolny JavaScript w kontekscie
 * portalu. Wycinamy wszystko, co potrafi wykonac kod albo pobrac zasob
 * z zewnatrz (skrypty, handlery on*, zewnetrzne odwolania, encje XXE).
 *
 * Swiadomie dzialamy na tekscie zamiast parsowac DOM: w Node nie ma
 * natywnego parsera SVG, a doklejanie zaleznosci pod jeden format pliku
 * niesie wiecej ryzyka niz kilka precyzyjnych regexow uzupelnionych
 * o twarde odrzucenie plikow z podejrzana zawartoscia.
 */

export class SvgSanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgSanitizeError';
  }
}

/** Elementy wycinane w calosci (razem z zawartoscia). */
const FORBIDDEN_ELEMENTS = [
  'script',
  'foreignObject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'animate',
  'set',
  'handler',
];

/** Nie da sie tego bezpiecznie oczyscic - plik odrzucamy w calosci. */
const HARD_REJECT = [
  { pattern: /<!ENTITY/i, message: 'SVG zawiera definicje encji (ryzyko XXE)' },
  { pattern: /<!DOCTYPE[^>]*\[/i, message: 'SVG zawiera wewnętrzny DTD' },
];

function stripElement(svg: string, tag: string): string {
  const paired = new RegExp(`<\\s*${tag}\\b[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, 'gi');
  const selfClosing = new RegExp(`<\\s*${tag}\\b[^>]*/\\s*>`, 'gi');
  return svg.replace(paired, '').replace(selfClosing, '');
}

/**
 * Czysci SVG albo rzuca SvgSanitizeError, gdy pliku nie da sie uratowac.
 * Zwraca bezpieczna tresc gotowa do zapisu w storage.
 */
export function sanitizeSvg(input: string): string {
  if (!/<svg[\s>]/i.test(input)) {
    throw new SvgSanitizeError('Plik nie wygląda na poprawny SVG');
  }

  for (const { pattern, message } of HARD_REJECT) {
    if (pattern.test(input)) throw new SvgSanitizeError(message);
  }

  let svg = input;

  // Komentarze potrafia ukryc ladunek przed prostszymi filtrami.
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');

  for (const tag of FORBIDDEN_ELEMENTS) {
    svg = stripElement(svg, tag);
  }

  // Handlery zdarzen: onload, onclick, onmouseover...
  svg = svg.replace(/\son[a-z-]+\s*=\s*"[^"]*"/gi, '');
  svg = svg.replace(/\son[a-z-]+\s*=\s*'[^']*'/gi, '');
  svg = svg.replace(/\son[a-z-]+\s*=\s*[^\s>]+/gi, '');

  // Odwolania do zasobow: zostawiamy wylacznie lokalne (#fragment).
  // javascript:, data: i http(s): ida precz - to zarowno wektor XSS,
  // jak i wyciek informacji przy rasteryzacji po stronie serwera.
  const stripHref = (match: string, attr: string, quote: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed.startsWith('#')) return match;
    return ` ${attr}=${quote}${quote}`;
  };
  svg = svg.replace(
    /\s(href|xlink:href)\s*=\s*(["'])([\s\S]*?)\2/gi,
    (match, attr, quote, value) => stripHref(match, attr, quote, value)
  );

  // url(...) w stylach - ta sama zasada co wyzej.
  svg = svg.replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, 'none');

  // Import zewnetrznych stylow.
  svg = svg.replace(/@import[^;]*;/gi, '');

  if (/javascript:/i.test(svg)) {
    throw new SvgSanitizeError('SVG zawiera odwołanie do javascript:');
  }

  return svg;
}

/**
 * Czy SVG uzywa `currentColor` - tylko takie da sie przebarwic na kolor
 * z palety projektu. Reszta zachowuje wlasne kolory.
 */
export function svgSupportsTint(svg: string): boolean {
  return /currentColor/i.test(svg);
}

/**
 * Podstawia kolor pod `currentColor` przed rasteryzacja. resvg nie zna
 * dziedziczenia `color` z CSS hosta, wiec robimy to podmiana tekstowa.
 */
export function applySvgTint(svg: string, color: string): string {
  if (!/^#[0-9a-f]{3,8}$/i.test(color)) return svg;
  return svg.replace(/currentColor/gi, color);
}
