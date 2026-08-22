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

/**
 * Sciezki noza z eksportu Silhouette Studio - do wyrzucenia z GRAFIKI.
 *
 * Silhouette zapisuje linie ciecia jako zwykle `path` z obrysem w umownym
 * kolorze i BEZ wypelnienia (`fill="none"`). Dla plotera to instrukcja, dla
 * drukarki zwykla kreska - wgrany bez czyszczenia podklad wychodzi z ramka
 * obrysowana na niebiesko albo czerwono.
 *
 * Rozpoznajemy je po samej strukturze (obrys bez wypelnienia), nie po
 * konkretnym kolorze: paleta warstw w Silhouette jest dowolna i nastepny
 * eksport moze uzyc innej.
 */
const CUT_PATH = /<path[^>]*fill\s*=\s*"none"[^>]*stroke\s*=\s*"(?!none)[^"]+"[^>]*\/?>/gi;
const CUT_PATH_REVERSED = /<path[^>]*stroke\s*=\s*"(?!none)[^"]+"[^>]*fill\s*=\s*"none"[^>]*\/?>/gi;

/** Ile sciezek noza zawiera plik - bez modyfikowania go. */
export function countCutPaths(svg: string): number {
  return (svg.match(CUT_PATH)?.length ?? 0) + (svg.match(CUT_PATH_REVERSED)?.length ?? 0);
}

/**
 * Elementy rysujace, ktorym wolno DOLOZYC brakujace wypelnienie.
 *
 * Eksport z Illustratora czy Figmy czesto nie zapisuje `fill` w ogole -
 * ksztalt dziedziczy wtedy domyslna czern SVG. Regex od `fill="#hex"` takiego
 * pliku nie widzi, wiec ozdobnik wchodzil do biblioteki „przygotowany”,
 * a na wydruku i tak wychodzil czarny.
 */
const TINTABLE_SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'polygon', 'polyline']);

/**
 * Poddrzewa, w ktorych `fill` nie jest kolorem rysunku, tylko sterowaniem:
 * w masce decyduje o przezroczystosci, w sciezce obcinajacej jest ignorowany.
 * Podmiana zrobilaby tam wiecej szkody niz pozytku.
 */
const FILL_SHIELDED = new Set(['clippath', 'mask']);

/** Czy ten kolor wolno oddac pod `currentColor`. */
function isTintableColor(value: string): boolean {
  const color = value.trim().toLowerCase();
  if (color === 'black') return true;
  if (!/^#[0-9a-f]{3,8}$/.test(color)) return false;
  // Biel zostaje biela: bywa swiadomym przykryciem, a nie kolorem rysunku.
  return !/^#(f{3,4}|f{6}|f{8})$/.test(color);
}

/**
 * Kolory z blokow `<style>` - druga typowa forma eksportu (`.cls-1{fill:#231f20}`).
 *
 * Zwraca takze dwa zbiory klas: te, ktorych wypelnienie wlasnie oddalismy pod
 * `currentColor`, i te, ktore w ogole deklaruja `fill` - bo elementowi z taka
 * klasa nie wolno juz dokladac atrybutu (regula z arkusza i tak by go pobila,
 * a przy `fill:none` zrobilaby z niewidzialnego ksztaltu widoczna plame).
 */
function tintStyleBlocks(svg: string): {
  svg: string;
  tintedClasses: Set<string>;
  classesWithFill: Set<string>;
} {
  const tintedClasses = new Set<string>();
  const classesWithFill = new Set<string>();

  const output = svg.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (block, css: string) => {
    const nextCss = css.replace(/([^{}]*)\{([^{}]*)\}/g, (rule, selector: string, body: string) => {
      if (!/\bfill\s*:/i.test(body)) return rule;

      const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
      for (const name of classes) classesWithFill.add(name);

      let changed = false;
      const nextBody = body.replace(/\bfill\s*:\s*([^;}]+)/gi, (declaration, color: string) => {
        if (!isTintableColor(color)) return declaration;
        changed = true;
        return 'fill:currentColor';
      });

      if (!changed) return rule;
      for (const name of classes) tintedClasses.add(name);
      return `${selector}{${nextBody}}`;
    });

    return nextCss === css ? block : block.replace(css, () => nextCss);
  });

  return { svg: output, tintedClasses, classesWithFill };
}

const OPEN_TAG = /<\s*(\/?)([a-zA-Z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;

/**
 * Przejscie po drzewie: zamiana twardych wypelnien na `currentColor` i
 * dolozenie ich tam, gdzie koloru nie ma wcale.
 *
 * Chodzimy po tagach zamiast strzelac samym regexem, bo `fill` sie dziedziczy:
 * ksztalt w `<g fill="none">` jest niewidoczny i dolozenie mu wypelnienia
 * wywalilo by na wydruk cos, czego projektant nigdy nie rysowal.
 */
function tintElements(
  svg: string,
  classes: { tintedClasses: Set<string>; classesWithFill: Set<string> }
): { svg: string; tinted: number } {
  const stack: Array<{ name: string; fill: boolean; shielded: boolean }> = [];
  let out = '';
  let last = 0;
  let tinted = 0;

  OPEN_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = OPEN_TAG.exec(svg)) !== null) {
    const [full, closing, rawName, rawAttrs] = match;
    const name = rawName.toLowerCase();

    if (closing) {
      const open = stack.map((entry) => entry.name).lastIndexOf(name);
      if (open >= 0) stack.length = open;
      continue;
    }

    // Tresc arkusza to CSS, nie znaczniki - `>` w selektorze rozjechalby skaner.
    if (name === 'style') {
      const end = svg.toLowerCase().indexOf('</style', OPEN_TAG.lastIndex);
      if (end >= 0) OPEN_TAG.lastIndex = end;
      continue;
    }

    const shielded = stack.some((entry) => entry.shielded) || FILL_SHIELDED.has(name);
    const inheritsFill = stack.some((entry) => entry.fill);
    const selfClosing = /\/\s*$/.test(rawAttrs);

    const styleValue = rawAttrs.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] ?? '';
    const classValue = rawAttrs.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] ?? '';
    const classNames = classValue.split(/\s+/).filter(Boolean);

    const hasFillAttr = /\bfill\s*=/i.test(rawAttrs);
    const hasStyleFill = /\bfill\s*:/i.test(styleValue);
    const hasClassFill = classNames.some((cls) => classes.classesWithFill.has(cls));
    const definesFill = hasFillAttr || hasStyleFill || hasClassFill;

    let attrs = rawAttrs;
    let touched = classNames.some((cls) => classes.tintedClasses.has(cls));

    if (!shielded) {
      attrs = attrs.replace(/\bfill\s*=\s*(["'])([\s\S]*?)\1/gi, (declaration, quote, color: string) => {
        if (!isTintableColor(color)) return declaration;
        touched = true;
        return `fill=${quote}currentColor${quote}`;
      });

      attrs = attrs.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (declaration, quote, value: string) => {
        const next = value.replace(/\bfill\s*:\s*([^;]+)/gi, (fill, color: string) => {
          if (!isTintableColor(color)) return fill;
          touched = true;
          return 'fill:currentColor';
        });
        return next === value ? declaration : `style=${quote}${next}${quote}`;
      });

      // Ksztalt bez zadnego zrodla koloru - to wlasnie ta domyslna czern.
      if (!definesFill && !inheritsFill && TINTABLE_SHAPES.has(name)) {
        attrs = ` fill="currentColor"${attrs}`;
        touched = true;
      }

      // Obrys na ksztalcie, ktory juz idzie za kolorem wiodacym.
      //
      // Silhouette Studio zapisuje TE SAMA sciezke raz jako grafike
      // (wypelnienie) i raz jako linie noza - cienki obrys w umownym kolorze,
      // np. `stroke="#FF0000" stroke-width="0.1"`. `CUT_PATH` takiego wiersza
      // nie widzi, bo tamten wzorzec szuka obrysu BEZ wypelnienia, a tu
      // wypelnienie jest. Zostawiony obrys wychodzi z drukarki jako czerwony
      // wlos i nie slucha pokretla koloru wiodacego.
      //
      // Zamiast zgadywac, ktory hex jest "kolorem noza" (paleta warstw
      // w Studio jest dowolna - patrz komentarz przy CUT_PATH), idziemy za
      // znaczeniem `currentColor`: ksztalt oddany pod kolor wiodacy ma isc za
      // nim CALY, razem z obrysem.
      //
      // Cena: ozdobnik swiadomie dwubarwny (bordowe wypelnienie + zlota
      // kreska) splaszczy sie do jednego koloru. Dlatego dzieje sie to
      // wylacznie przy `tintable`, czyli na wyrazne zyczenie, a panel pokazuje
      // liczbe ruszonych elementow.
      const fillFollowsTint =
        /\bfill\s*=\s*(["'])\s*currentColor\s*\1/i.test(attrs) || /\bfill\s*:\s*currentColor/i.test(attrs);

      if (fillFollowsTint) {
        attrs = attrs.replace(/\bstroke\s*=\s*(["'])([\s\S]*?)\1/gi, (declaration, quote, color: string) => {
          if (!isTintableColor(color)) return declaration;
          touched = true;
          return `stroke=${quote}currentColor${quote}`;
        });

        attrs = attrs.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (declaration, quote, value: string) => {
          const next = value.replace(/\bstroke\s*:\s*([^;]+)/gi, (stroke, color: string) => {
            if (!isTintableColor(color)) return stroke;
            touched = true;
            return 'stroke:currentColor';
          });
          return next === value ? declaration : `style=${quote}${next}${quote}`;
        });
      }
    }

    if (touched) tinted += 1;

    if (attrs !== rawAttrs) {
      out += svg.slice(last, match.index) + `<${rawName}${attrs}>`;
      last = match.index + full.length;
    }

    if (!selfClosing) {
      stack.push({
        name,
        fill: definesFill || attrs !== rawAttrs,
        shielded: FILL_SHIELDED.has(name),
      });
    }
  }

  return { svg: out + svg.slice(last), tinted };
}

/**
 * Zdejmuje z SVG sciezki noza i - opcjonalnie - przygotowuje go pod
 * przebarwianie, zamieniajac twarde wypelnienia na `currentColor`.
 *
 * Zamiana dotyczy WYLACZNIE wypelnien, nie obrysow: obrys, ktory przetrwal
 * czyszczenie, jest czescia rysunku (np. cienka kreska ozdobna) i ma
 * zachowac swoj kolor, dopoki projektant nie zdecyduje inaczej.
 *
 * `tintableFills` liczy ELEMENTY, ktore po przejsciu naprawde ida za kolorem
 * warstwy - nie deklaracje w pliku. Zero znaczy wiec „nic sie nie zmienilo”,
 * a nie „udalo sie”; panel ma o czym uczciwie powiedziec.
 */
export function prepareSvgArtwork(
  svg: string,
  options: { tintable?: boolean } = {}
): { svg: string; removedCutPaths: number; tintableFills: number } {
  const removedCutPaths = countCutPaths(svg);
  let output = svg.replace(CUT_PATH, '').replace(CUT_PATH_REVERSED, '');

  let tintableFills = 0;
  if (options.tintable) {
    const styled = tintStyleBlocks(output);
    const elements = tintElements(styled.svg, styled);
    output = elements.svg;
    tintableFills = elements.tinted;
  }

  return { svg: output, removedCutPaths, tintableFills };
}

/**
 * Plik ciecia: te same sciezki noza, ktore `prepareSvgArtwork` zdejmuje
 * z podkladu - tylko zamiast do kosza ida do osobnego SVG.
 *
 * Po co: kontur wycinanego ksztaltu istnieje WYLACZNIE w grafice. Owalu
 * z falowana krawedzia nie da sie odtworzyc z danych szablonu, ktory zna
 * jedynie prostokat uzytku. Jedno zrodlo (plik z Silhouette) daje wiec
 * i wydruk, i sciezke ciecia - bez ryzyka, ze ktos podmieni jedno, a drugie
 * zostanie stare.
 *
 * Sciezki zachowuja wspolrzedne oryginalu, wiec zaimportowane do Silhouette
 * Studio na arkuszu tego samego rozmiaru trafiaja tam, gdzie ma ciac nóż.
 * Paserow NIE dokladamy: Studio rysuje wlasne przy wlaczeniu Print & Cut,
 * a dwa komplety znakow to gotowa pomylka.
 *
 * Zwraca `null`, gdy plik nie ma zadnej sciezki noza - lepiej nie dawac
 * przycisku niz dawac pusty plik.
 */
export function extractCutPathsSvg(svg: string): string | null {
  const cuts = [...(svg.match(CUT_PATH) || []), ...(svg.match(CUT_PATH_REVERSED) || [])];
  if (cuts.length === 0) return null;

  // Naglowek oryginalu niesie rozmiar i viewBox - bez nich import wyladowalby
  // w losowej skali.
  const openTag = svg.match(/<svg[^>]*>/i)?.[0] ?? '<svg xmlns="http://www.w3.org/2000/svg">';

  // Sciezki bywaja zapisane w <defs> i wolane przez <use>; kopiujemy je
  // wprost, wiec odwolania po id nie sa potrzebne - i lepiej je zdjac, zeby
  // nie kolidowaly z niczym po imporcie.
  const body = cuts.map((path) => path.replace(/\sid="[^"]*"/i, '')).join('\n  ');

  return `<?xml version="1.0" encoding="utf-8"?>
${openTag}
  <!-- Sciezki ciecia wyodrebnione z grafiki szablonu. Import do Silhouette
       Studio na arkuszu tego samego rozmiaru; pasery wlacz w Studio. -->
  ${body}
</svg>
`;
}
