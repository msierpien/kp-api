import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getCaseLayout } from '../src/lib/case-layout';

const snapshotLayout = { version: 2, canvas: { width: 100 }, fonts: [], layers: [{ id: 'zamrozony' }] };
const currentLayout = { version: 2, canvas: { width: 999 }, fonts: [], layers: [{ id: 'zmieniony-po-submicie' }] };

test('zatwierdzona sprawa drukuje sie z zamrozonego layoutu, nie z biezacego szablonu', () => {
  const layout = getCaseLayout({
    layoutSnapshot: snapshotLayout,
    template: { layoutJson: currentLayout },
  });

  assert.deepEqual(layout, snapshotLayout);
});

test('sprawa bez snapshotu (sprzed tej funkcji) czyta biezacy layout szablonu', () => {
  const layout = getCaseLayout({
    layoutSnapshot: null,
    template: { layoutJson: currentLayout },
  });

  assert.deepEqual(layout, currentLayout);
});

test('brak jakiegokolwiek layoutu zwraca null - wolajacy podnosi blad', () => {
  assert.equal(getCaseLayout({ layoutSnapshot: null, template: { layoutJson: null } }), null);
});
