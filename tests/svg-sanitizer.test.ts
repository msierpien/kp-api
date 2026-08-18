// Musi byc pierwszy: serwis ozdobnikow ciagnie config, ktory waliduje env.
import './helpers/test-env';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applySvgTint,
  prepareSvgArtwork,
  sanitizeSvg,
  svgSupportsTint,
  SvgSanitizeError,
} from '../src/lib/svg-sanitizer';
import { slugifyCategory } from '../src/services/admin/decorations.service';

const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`;

test('wycina skrypt razem z zawartoscia', () => {
  const out = sanitizeSvg(wrap('<script>alert(1)</script><circle r="5"/>'));
  assert.ok(!/script/i.test(out));
  assert.ok(out.includes('<circle r="5"/>'));
});

test('wycina foreignObject - najczestszy nosnik HTML w SVG', () => {
  const out = sanitizeSvg(wrap('<foreignObject><body onload="x()"/></foreignObject><path d="M0 0"/>'));
  assert.ok(!/foreignObject/i.test(out));
  assert.ok(out.includes('<path d="M0 0"/>'));
});

test('usuwa handlery zdarzen w kazdym zapisie cudzyslowu', () => {
  const out = sanitizeSvg(wrap('<circle onload="a()" onclick=\'b()\' onmouseover=c() r="1"/>'));
  assert.ok(!/onload|onclick|onmouseover/i.test(out));
  assert.ok(out.includes('r="1"'), 'zwykle atrybuty maja zostac');
});

test('zewnetrzne href znika, lokalna kotwica zostaje', () => {
  const external = sanitizeSvg(wrap('<image href="https://evil.example/x.png"/>'));
  assert.ok(!external.includes('evil.example'));

  const local = sanitizeSvg(wrap('<use href="#ikona"/>'));
  assert.ok(local.includes('href="#ikona"'), 'odwolanie wewnatrz pliku jest bezpieczne');
});

test('url() do zewnetrznego zasobu zamieniane na none', () => {
  const out = sanitizeSvg(wrap('<rect style="fill:url(https://evil.example/a.svg)"/>'));
  assert.ok(!out.includes('evil.example'));
  assert.ok(out.includes('none'));
});

test('komentarz nie przemyci skryptu', () => {
  const out = sanitizeSvg(wrap('<!-- <script>alert(1)</script> --><circle r="2"/>'));
  assert.ok(!/script/i.test(out));
});

test('odrzuca plik z encjami (XXE)', () => {
  assert.throws(
    () => sanitizeSvg('<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>'),
    SvgSanitizeError
  );
});

test('odrzuca plik, ktory nie jest SVG', () => {
  assert.throws(() => sanitizeSvg('<html><body>nope</body></html>'), SvgSanitizeError);
});

test('przebarwienie dziala tylko dla svg z currentColor i poprawnego hexa', () => {
  const tintable = wrap('<path fill="currentColor" d="M0 0"/>');
  assert.equal(svgSupportsTint(tintable), true);
  assert.ok(applySvgTint(tintable, '#ff0000').includes('#ff0000'));

  // Nieprawidlowy kolor nie moze wstrzyknac niczego do pliku.
  assert.equal(applySvgTint(tintable, 'red; x'), tintable);

  assert.equal(svgSupportsTint(wrap('<path fill="#000" d="M0 0"/>')), false);
});

test('ozdobnik z twardym wypelnieniem daje sie przygotowac do przebarwiania', () => {
  // Sedno sprawy: typowy eksport ma `fill="#000000"`, wiec sam upload
  // (sanitize + svgSupportsTint) uznawal go za nieprzebarwialny na zawsze.
  const raw = wrap('<path fill="#000000" d="M0 0"/><path fill="#FFFFFF" d="M1 1"/>');
  assert.equal(svgSupportsTint(sanitizeSvg(raw)), false);

  const prepared = prepareSvgArtwork(sanitizeSvg(raw), { tintable: true });
  assert.equal(svgSupportsTint(prepared.svg), true);
  assert.equal(prepared.tintableFills, 1, 'biel zostaje biela');
  assert.ok(prepared.svg.includes('fill="#FFFFFF"'));

  // Bez flagi plik przechodzi jak dotad - wielokolorowy ozdobnik nie traci barw.
  assert.equal(svgSupportsTint(prepareSvgArtwork(sanitizeSvg(raw)).svg), false);
});

test('ozdobnik bez atrybutu fill dostaje wypelnienie pod kolor', () => {
  // Eksport z Illustratora/Figmy: same sciezki, kolor bierze sie z domyslnej
  // czerni SVG. Do tej pory taki plik przechodzil przygotowanie bez zmiany,
  // a warstwa z `tint` drukowala sie na czarno.
  const raw = wrap('<path d="M0 0"/><circle cx="1" cy="1" r="1"/>');

  const prepared = prepareSvgArtwork(sanitizeSvg(raw), { tintable: true });
  assert.equal(svgSupportsTint(prepared.svg), true);
  assert.equal(prepared.tintableFills, 2);
  assert.ok(prepared.svg.includes('<path fill="currentColor" d="M0 0"/>'));
  assert.ok(prepared.svg.includes('<circle fill="currentColor" cx="1"'));
});

test('obrys bez wypelnienia zostaje nietkniety', () => {
  // `fill="none"` + `stroke` znaczy: kolor niesie kreska. Dolozenie wypelnienia
  // zalaloby ksztalt, ktory mial byc pusty.
  const raw = wrap('<rect fill="none" stroke="#112233" x="0" y="0" width="4" height="4"/>');

  const prepared = prepareSvgArtwork(sanitizeSvg(raw), { tintable: true });
  assert.ok(prepared.svg.includes('fill="none"'));
  assert.ok(prepared.svg.includes('stroke="#112233"'), 'obrys zachowuje swoj kolor');
  assert.equal(prepared.tintableFills, 0);
});

test('ksztalt w grupie bez wypelnienia nie dostaje koloru', () => {
  // `fill` sie dziedziczy - dziecko `<g fill="none">` jest niewidoczne
  // celowo i ma takie zostac.
  const raw = wrap('<g fill="none" stroke="#0a0a0a"><path d="M0 0"/></g>');

  const prepared = prepareSvgArtwork(sanitizeSvg(raw), { tintable: true });
  assert.equal(svgSupportsTint(prepared.svg), false);
  assert.equal(prepared.tintableFills, 0);
});

test('kolor z bloku <style> idzie pod currentColor', () => {
  // Druga typowa forma eksportu: kolory siedza w arkuszu, a element ma sama klase.
  const raw = wrap(
    '<style>.cls-1{fill:#231f20;}.cls-2{fill:none;stroke:#123456;}</style>' +
      '<path class="cls-1" d="M0 0"/><path class="cls-2" d="M1 1"/>'
  );

  const prepared = prepareSvgArtwork(sanitizeSvg(raw), { tintable: true });
  assert.ok(prepared.svg.includes('.cls-1{fill:currentColor;}'));
  assert.ok(prepared.svg.includes('fill:none'), 'klasa bez wypelnienia zostaje bez wypelnienia');
  assert.ok(
    !/<path class="cls-2" fill=|fill="currentColor" class="cls-2"/.test(prepared.svg),
    'element z klasa nie dostaje atrybutu, ktory arkusz i tak by pobil'
  );
  assert.equal(prepared.tintableFills, 1, 'liczymy elementy, nie deklaracje');
});

test('maski i sciezki obcinajace zostaja bez zmian', () => {
  const raw = wrap('<defs><clipPath id="c"><path d="M0 0"/></clipPath></defs><path d="M1 1"/>');

  const prepared = prepareSvgArtwork(sanitizeSvg(raw), { tintable: true });
  assert.ok(prepared.svg.includes('<clipPath id="c"><path d="M0 0"/></clipPath>'));
  assert.equal(prepared.tintableFills, 1);
});

test('plik bez czego przebarwiac raportuje zero', () => {
  // Komunikat w panelu ma nie chwalic sie sukcesem przy zerowej zmianie.
  const prepared = prepareSvgArtwork(sanitizeSvg(wrap('<path fill="#ffffff" d="M0 0"/>')), {
    tintable: true,
  });
  assert.equal(prepared.tintableFills, 0);
  assert.equal(svgSupportsTint(prepared.svg), false);
});

test('slug kategorii jest bezogonkowy i stabilny', () => {
  // Slug siedzi w decoration_assets.category, wiec musi byc przewidywalny -
  // i taki sam jak SLUBNE z pierwszej, zaszytej w kodzie wersji.
  assert.equal(slugifyCategory('Ślubne'), 'SLUBNE');
  assert.equal(slugifyCategory('  boho & rustykalne  '), 'BOHO_RUSTYKALNE');
  assert.equal(slugifyCategory('Zażółć gęślą'), 'ZAZOLC_GESLA');
  assert.equal(slugifyCategory('!!!'), '');
});
