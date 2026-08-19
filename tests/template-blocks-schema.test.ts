import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTemplateBlockSchema } from '../src/schemas/admin.schema';

const layer = (id: string, groupId?: string) => ({
  id,
  name: id,
  type: 'text',
  visible: true,
  locked: false,
  opacity: 1,
  zIndex: 0,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  rotation: 0,
  ...(groupId ? { groupId } : {}),
  properties: {
    type: 'text',
    fieldKey: 'imiona',
    placeholder: '{{ imiona }}',
    fontSize: 24,
    fontFamily: 'Cormorant Garamond',
  },
});

test('blok niesie warstwy, grupy, fonty i liste assetow', () => {
  const parsed = createTemplateBlockSchema.parse({
    name: 'Stopka RSVP',
    category: 'STOPKI',
    widthMm: 80,
    heightMm: 24,
    tags: ['rsvp', 'ślubne'],
    payload: {
      layers: [layer('text_1', 'g1')],
      groups: [{ id: 'g1', name: 'Stopka' }],
      fonts: [{ family: 'Cormorant Garamond', src: '/storage/fonts/cormorant.woff2' }],
      assets: ['templates/ZAP_90X130/image/ozdobnik.svg'],
    },
  });

  assert.equal(parsed.payload.version, 1, 'wersja payloadu ma domyslna wartosc');
  assert.equal(parsed.payload.layers[0].groupId, 'g1', 'grupa jedzie razem z warstwa');
  assert.equal(parsed.payload.fonts?.[0].family, 'Cormorant Garamond');
  assert.equal(parsed.payload.assets?.length, 1);
});

test('blok bez warstw jest odrzucany', () => {
  // Pusty blok nie ma czego wstawic, a w bibliotece wygladalby jak sprawny.
  const result = createTemplateBlockSchema.safeParse({
    name: 'Pusty',
    category: 'INNE',
    widthMm: 10,
    heightMm: 10,
    payload: { layers: [] },
  });

  assert.equal(result.success, false);
});

test('warstwa w ksztalcie, ktorego layout nie przyjmie, nie wejdzie do bloku', () => {
  // Payload reuzywa layerBaseSchema wlasnie po to: blad ma wyjsc przy zapisie
  // bloku, a nie dopiero przy zapisie szablonu, do ktorego ktos go wstawil.
  const result = createTemplateBlockSchema.safeParse({
    name: 'Zły',
    category: 'INNE',
    widthMm: 10,
    heightMm: 10,
    payload: {
      layers: [{ ...layer('text_1'), properties: { type: 'text', fieldKey: 'x' } }],
    },
  });

  assert.equal(result.success, false, 'brak fontSize/fontFamily w properties');
});
