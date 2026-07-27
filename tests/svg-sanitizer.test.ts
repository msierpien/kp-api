import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySvgTint, sanitizeSvg, svgSupportsTint, SvgSanitizeError } from '../src/lib/svg-sanitizer';

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
