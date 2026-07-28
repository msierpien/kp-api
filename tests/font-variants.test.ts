import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

type Variant = {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  variable?: boolean;
};

function makeVariant({ family, weight, style, variable = false }: Variant) {
  return {
    id: family,
    family,
    fileName: `${family}.ttf`,
    filePath: `fonts/${family}.ttf`,
    fileSize: 1000,
    format: 'ttf',
    printable: true,
    typographicFamily: 'Lobster Two',
    weight,
    style,
    variantLabel: style === 'italic' ? 'Italic' : 'Regular',
    variable,
  };
}

const LOBSTER = [
  makeVariant({ family: 'LobsterTwo-Regular', weight: 400, style: 'normal' }),
  makeVariant({ family: 'LobsterTwo-Italic', weight: 400, style: 'italic' }),
  makeVariant({ family: 'LobsterTwo-Bold', weight: 700, style: 'normal' }),
  makeVariant({ family: 'LobsterTwo-BoldItalic', weight: 700, style: 'italic' }),
];

test('pickFontVariant trafia w wage i styl wariantu', async () => {
  const { pickFontVariant } = await import('../src/services/admin/fonts.service');

  assert.equal(pickFontVariant(LOBSTER, 400, 'normal').family, 'LobsterTwo-Regular');
  assert.equal(pickFontVariant(LOBSTER, 700, 'normal').family, 'LobsterTwo-Bold');
  assert.equal(pickFontVariant(LOBSTER, 400, 'italic').family, 'LobsterTwo-Italic');
  assert.equal(pickFontVariant(LOBSTER, 700, 'italic').family, 'LobsterTwo-BoldItalic');
});

test('pickFontVariant bierze najblizsza dostepna wage', async () => {
  const { pickFontVariant } = await import('../src/services/admin/fonts.service');

  // 600 nie istnieje jako plik - blizej mu do 700 niz do 400.
  assert.equal(pickFontVariant(LOBSTER, 600, 'normal').family, 'LobsterTwo-Bold');
  // 300 nie istnieje - najblizszy jest regular.
  assert.equal(pickFontVariant(LOBSTER, 300, 'normal').family, 'LobsterTwo-Regular');
});

test('pickFontVariant nie zgaduje kursywy, gdy rodzina jej nie ma', async () => {
  const { pickFontVariant } = await import('../src/services/admin/fonts.service');

  const uprightOnly = LOBSTER.filter((font) => font.style === 'normal');
  const picked = pickFontVariant(uprightOnly, 400, 'italic');

  assert.equal(picked.family, 'LobsterTwo-Regular');
  assert.equal(picked.style, 'normal');
});

test('pickFontVariant woli plik staly od kroju zmiennego', async () => {
  const { pickFontVariant } = await import('../src/services/admin/fonts.service');

  // node-canvas nie rusza osi wagi kroju zmiennego - wydrukowalby Light
  // zamiast SemiBold, mimo ze plik SemiBold lezy obok.
  const mixed = [
    makeVariant({ family: 'Cormorant-SemiBold', weight: 600, style: 'normal' }),
    makeVariant({ family: 'Cormorant-Variable', weight: 300, style: 'normal', variable: true }),
  ];

  assert.equal(pickFontVariant(mixed, 600, 'normal').family, 'Cormorant-SemiBold');
});

test('pickFontVariant siega po krój zmienny, gdy nie ma plikow stalych', async () => {
  const { pickFontVariant } = await import('../src/services/admin/fonts.service');

  const onlyVariable = [
    makeVariant({ family: 'CormorantGaramond-Variable', weight: 300, style: 'normal', variable: true }),
  ];

  assert.equal(pickFontVariant(onlyVariable, 700, 'normal').family, 'CormorantGaramond-Variable');
});
