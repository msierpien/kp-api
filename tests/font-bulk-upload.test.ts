import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);
// Rejestr czyta katalog przy kazdym listFonts - cache psulby kolejnosc asercji.
process.env.FONTS_LIST_CACHE_TTL_MS = '0';

const REPO_FONTS_DIR = path.join(process.cwd(), 'storage', 'fonts');

/** Prawdziwe pliki krojow wczytane PRZED chdir - potem cwd jest juz tymczasowy. */
const REAL_FONTS = new Map<string, Buffer>();
const originalCwd = process.cwd();
let tmpDir: string;

before(async () => {
  for (const name of ['Montserrat.ttf', 'AlexBrush-Regular.ttf', 'Poppins-Bold.ttf', 'Brother_Signature.otf']) {
    REAL_FONTS.set(name, fs.readFileSync(path.join(REPO_FONTS_DIR, name)));
  }

  // Serwis liczy FONTS_DIR od cwd. Podmiana cwd na katalog tymczasowy trzyma
  // test poza prawdziwym storage/fonts - inaczej kazde uruchomienie sypaloby
  // plikami do rejestru uzywanego przez panel i renderer.
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kp-fonts-test-'));
  process.chdir(tmpDir);
});

after(async () => {
  process.chdir(originalCwd);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function multipartBody(files: { field: string; fileName: string; content: Buffer }[]) {
  const boundary = '----kpfontstest';
  const chunks: Buffer[] = [];

  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${file.field}"; filename="${file.fileName}"\r\n` +
          'Content-Type: font/ttf\r\n\r\n'
      )
    );
    chunks.push(file.content);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return { boundary, payload: Buffer.concat(chunks) };
}

/**
 * Serwer z limitami multipart DOKLADNIE jak produkcyjny src/index.ts.
 *
 * Globalne `files: 1` jest tu istotne: gdyby limit per-request go nie
 * nadpisywal, busboy po cichu urwalby paczke po pierwszym pliku - odpowiedz
 * bylaby wtedy udanym 201 na jeden font, a reszta znikalaby bez sladu.
 */
async function buildServer(limits: Record<string, number> = { fileSize: 10 * 1024 * 1024, files: 1 }) {
  const Fastify = (await import('fastify')).default;
  const multipart = (await import('@fastify/multipart')).default;
  const { fontsRoutes } = await import('../src/routes/admin/fonts.routes');

  const app = Fastify();
  await app.register(multipart, { limits });
  await app.register(fontsRoutes, { prefix: '/admin/fonts' });
  await app.ready();
  return app;
}

test('POST /admin/fonts przyjmuje wiele plikow w jednym zadaniu', async () => {
  const app = await buildServer();

  const { boundary, payload } = multipartBody([
    { field: 'file', fileName: 'Montserrat.ttf', content: REAL_FONTS.get('Montserrat.ttf')! },
    { field: 'file', fileName: 'Poppins-Bold.ttf', content: REAL_FONTS.get('Poppins-Bold.ttf')! },
  ]);

  const response = await app.inject({
    method: 'POST',
    url: '/admin/fonts',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.fonts.length, 2);
  assert.deepEqual(body.errors, []);
  assert.deepEqual(
    body.fonts.map((font: any) => font.fileName).sort(),
    ['Montserrat.ttf', 'Poppins-Bold.ttf']
  );

  await app.close();
});

test('paczka przechodzi czesciowo - zly plik nie blokuje pozostalych', async () => {
  const app = await buildServer();

  const { boundary, payload } = multipartBody([
    { field: 'file', fileName: 'AlexBrush-Regular.ttf', content: REAL_FONTS.get('AlexBrush-Regular.ttf')! },
    // Sygnatura nie pasuje do rozszerzenia - assertAllowedFontUpload to odrzuci.
    { field: 'file', fileName: 'Fejk.ttf', content: Buffer.from('to nie jest font') },
  ]);

  const response = await app.inject({
    method: 'POST',
    url: '/admin/fonts',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.fonts.length, 1);
  assert.equal(body.fonts[0].fileName, 'AlexBrush-Regular.ttf');
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].fileName, 'Fejk.ttf');

  await app.close();
});

test('gdy odrzucone sa wszystkie pliki, odpowiedz to 400 z lista bledow', async () => {
  const app = await buildServer();

  const { boundary, payload } = multipartBody([
    { field: 'file', fileName: 'Zly1.ttf', content: Buffer.from('nie font') },
    { field: 'file', fileName: 'Zly2.ttf', content: Buffer.from('tez nie font') },
  ]);

  const response = await app.inject({
    method: 'POST',
    url: '/admin/fonts',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.errors.length, 2);
  assert.deepEqual(body.errors.map((item: any) => item.fileName).sort(), ['Zly1.ttf', 'Zly2.ttf']);

  await app.close();
});

test('listFonts raportuje komplet polskich znakow', async () => {
  const { listFonts, clearFontsListCache } = await import('../src/services/admin/fonts.service');
  clearFontsListCache();

  const fonts = await listFonts();
  const montserrat = fonts.find((font) => font.fileName === 'Montserrat.ttf');

  assert.ok(montserrat, 'Montserrat powinien byc w rejestrze po wgraniu');
  assert.equal(montserrat!.polishSupport.checked, true);
  assert.equal(montserrat!.polishSupport.complete, true);
  assert.deepEqual(montserrat!.polishSupport.missing, []);
});

test('krój bez ogonkow raportuje brakujace znaki', async () => {
  const app = await buildServer();
  const { listFonts, clearFontsListCache } = await import('../src/services/admin/fonts.service');

  // Brother Signature naprawde nie ma "ł" ani "Ł" - to jest ten przypadek,
  // dla ktorego ta informacja w panelu istnieje: bez niej nazwisko "Kowalski"
  // wychodzi na wydruku z pustym prostokatem w srodku.
  const { boundary, payload } = multipartBody([
    { field: 'file', fileName: 'Brother_Signature.otf', content: REAL_FONTS.get('Brother_Signature.otf')! },
  ]);

  const response = await app.inject({
    method: 'POST',
    url: '/admin/fonts',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().fonts[0].polishSupport.complete, false);
  assert.deepEqual(response.json().fonts[0].polishSupport.missing, ['ł', 'Ł']);

  clearFontsListCache();
  const listed = (await listFonts()).find((font) => font.fileName === 'Brother_Signature.otf');
  assert.equal(listed!.polishSupport.checked, true);
  assert.deepEqual(listed!.polishSupport.missing, ['ł', 'Ł']);

  await app.close();
});

test('nierozczytany plik nie udaje kompletu polskich znakow', async () => {
  const { listFonts, clearFontsListCache } = await import('../src/services/admin/fonts.service');

  const fontsDir = path.join(process.cwd(), 'storage', 'fonts');
  await fsp.mkdir(fontsDir, { recursive: true });
  // Poprawna sygnatura TTF, ale dalej smieci - fontkit nie rozczyta tabel.
  const brokenPath = path.join(fontsDir, 'Popsuty.ttf');
  await fsp.writeFile(brokenPath, Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(64)]));

  clearFontsListCache();
  const broken = (await listFonts()).find((font) => font.fileName === 'Popsuty.ttf');

  assert.ok(broken);
  assert.equal(broken!.polishSupport.checked, false);
  assert.equal(broken!.polishSupport.complete, false, 'nierozczytany plik nie moze udawac kompletu PL');

  await fsp.rm(brokenPath, { force: true });
});

test('50 krojow w jednym zadaniu przechodzi w calosci', async () => {
  const app = await buildServer();
  const source = REAL_FONTS.get('Poppins-Bold.ttf')!;

  // Tyle, ile realnie wgrywa sie przy zakupie paczki krojow. Nadmiar nie moze
  // zniknac po cichu: busboy przy przekroczeniu `files` URYWA strumien bez
  // bledu, wiec brak asercji na liczbe zapisanych plikow nie wykrylby regresji.
  const files = Array.from({ length: 50 }, (_, index) => ({
    field: 'file',
    fileName: `Paczka${String(index).padStart(2, '0')}.ttf`,
    content: source,
  }));

  const { boundary, payload } = multipartBody(files);
  const response = await app.inject({
    method: 'POST',
    url: '/admin/fonts',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.fonts.length, 50, `zapisano ${body.fonts.length} z 50`);
  assert.deepEqual(body.errors, []);

  await app.close();
});

test('przekroczenie limitu plikow daje czytelny komunikat, nie gole 413', async () => {
  const app = await buildServer();
  const source = REAL_FONTS.get('Poppins-Bold.ttf')!;

  const files = Array.from({ length: 70 }, (_, index) => ({
    field: 'file',
    fileName: `Nadmiar${String(index).padStart(2, '0')}.ttf`,
    content: source,
  }));

  const { boundary, payload } = multipartBody(files);
  const response = await app.inject({
    method: 'POST',
    url: '/admin/fonts',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });

  assert.equal(response.statusCode, 413);
  const body = response.json();
  assert.match(body.message, /limit 60/);
  // Pliki, ktore zdazyly przejsc, musza byc wymienione - panel odswieza po nich
  // liste, a uzytkownik wie, ile paczki jeszcze zostalo.
  assert.ok(body.fonts.length > 0, 'czesciowo zapisane pliki musza byc w odpowiedzi');

  await app.close();
});

test('ten sam plik wgrany drugi raz nadpisuje i jest oznaczony jako replaced', async () => {
  const app = await buildServer();
  const source = REAL_FONTS.get('AlexBrush-Regular.ttf')!;

  const send = async (fileName: string) => {
    const { boundary, payload } = multipartBody([{ field: 'file', fileName, content: source }]);
    return app.inject({
      method: 'POST',
      url: '/admin/fonts',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  };

  const first = await send('Duplikat.ttf');
  assert.equal(first.json().fonts[0].replaced, false, 'pierwsze wgranie nie jest nadpisaniem');

  const second = await send('Duplikat.ttf');
  assert.equal(second.json().fonts[0].replaced, true, 'drugie wgranie nadpisuje poprzedni plik');

  // Nadpisanie nie moze mnozyc pozycji w rejestrze.
  const { listFonts, clearFontsListCache } = await import('../src/services/admin/fonts.service');
  clearFontsListCache();
  const matching = (await listFonts()).filter((font) => font.fileName === 'Duplikat.ttf');
  assert.equal(matching.length, 1, 'rejestr trzyma jedna pozycje, nie dwie');

  await app.close();
});

test('nazwa sprowadzona sanityzacja do istniejacej tez liczy sie jako nadpisanie', async () => {
  const app = await buildServer();
  const source = REAL_FONTS.get('Poppins-Bold.ttf')!;

  const send = async (fileName: string) => {
    const { boundary, payload } = multipartBody([{ field: 'file', fileName, content: source }]);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/fonts',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    return response.json().fonts[0];
  };

  // Spacja i kropka lecza sie w "_", wiec oba pliki celuja w Moj_Krój.ttf.
  const first = await send('Moj Krój.ttf');
  assert.equal(first.replaced, false);
  const second = await send('Moj.Krój.ttf');
  assert.equal(second.fileName, first.fileName, 'sanityzacja daje te sama nazwe pliku');
  assert.equal(second.replaced, true, 'kolizja po sanityzacji to nadpisanie');

  await app.close();
});
