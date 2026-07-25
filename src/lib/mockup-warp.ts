/**
 * Nakladanie projektu na zdjecie produktu z perspektywa (mockup).
 *
 * Uzywa wylacznie API Canvas 2D, wiec ten sam kod dziala w node-canvas
 * (render serwerowy) i w przegladarce (podglad w adminie oraz u klienta).
 * Odpowiednik w kp-admin/kp-client: lib/template-editor/core/mockup-warp.ts -
 * przy zmianie geometrii trzeba zaktualizowac wszystkie kopie, inaczej podglad
 * rozjedzie sie z wydrukiem.
 */

export interface Point {
  x: number;
  y: number;
}

/** Rogi w kolejnosci: lewy-gorny, prawy-gorny, prawy-dolny, lewy-dolny. */
export type Quad = [Point, Point, Point, Point];

/**
 * Homografia kwadratu jednostkowego (0,0),(1,0),(1,1),(0,1) na dowolny
 * czworokat. Zwraca funkcje (u,v) -> punkt na zdjeciu.
 *
 * Bez rzutowania (samo bilinearne mieszanie rogow) srodek projektu "plywa" -
 * przy mocnej perspektywie roznica jest widoczna golym okiem.
 */
export function squareToQuad(quad: Quad): (u: number, v: number) => Point {
  const [p0, p1, p2, p3] = quad;

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let a11: number;
  let a21: number;
  let a12: number;
  let a22: number;
  let a13 = 0;
  let a23 = 0;

  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    // Czworokat jest rownoleglobokiem - wystarczy przeksztalcenie afiniczne.
    a11 = p1.x - p0.x;
    a21 = p2.x - p1.x;
    a12 = p1.y - p0.y;
    a22 = p2.y - p1.y;
  } else {
    const det = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(det) < 1e-12) {
      // Zdegenerowany czworokat (wspolliniowe rogi) - nie ma sensownej mapy.
      return () => ({ x: p0.x, y: p0.y });
    }
    a13 = (dx3 * dy2 - dy3 * dx2) / det;
    a23 = (dx1 * dy3 - dy1 * dx3) / det;
    a11 = p1.x - p0.x + a13 * p1.x;
    a21 = p3.x - p0.x + a23 * p3.x;
    a12 = p1.y - p0.y + a13 * p1.y;
    a22 = p3.y - p0.y + a23 * p3.y;
  }

  const a31 = p0.x;
  const a32 = p0.y;

  return (u: number, v: number) => {
    const w = a13 * u + a23 * v + 1;
    return {
      x: (a11 * u + a21 * v + a31) / w,
      y: (a12 * u + a22 * v + a32) / w,
    };
  };
}

/** Rozsuwa trojkat od srodka ciezkosci - zapobiega wlosowym szparom miedzy komorkami. */
function expandTriangle(a: Point, b: Point, c: Point, by: number): [Point, Point, Point] {
  const cx = (a.x + b.x + c.x) / 3;
  const cy = (a.y + b.y + c.y) / 3;

  const push = (p: Point): Point => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * by, y: p.y + (dy / len) * by };
  };

  return [push(a), push(b), push(c)];
}

/** Rysuje wycinek obrazu jako trojkat, dopasowujac go afinicznie do celu. */
function drawTexturedTriangle(
  ctx: any,
  image: any,
  src: [Point, Point, Point],
  dst: [Point, Point, Point]
): void {
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = expandTriangle(dst[0], dst[1], dst[2], 0.6);

  const denom = s0.x * (s2.y - s1.y) - s1.x * s2.y + s2.x * s1.y + (s1.x - s2.x) * s0.y;
  if (Math.abs(denom) < 1e-9) return;

  const m11 = -(s0.y * (d2.x - d1.x) - s1.y * d2.x + s2.y * d1.x + (s1.y - s2.y) * d0.x) / denom;
  const m12 = (s1.y * d2.y + s0.y * (d1.y - d2.y) - s2.y * d1.y + (s2.y - s1.y) * d0.y) / denom;
  const m21 = (s0.x * (d2.x - d1.x) - s1.x * d2.x + s2.x * d1.x + (s1.x - s2.x) * d0.x) / denom;
  const m22 = -(s1.x * d2.y + s0.x * (d1.y - d2.y) - s2.x * d1.y + (s2.x - s1.x) * d0.y) / denom;
  const dx =
    (s0.x * (s2.y * d1.x - s1.y * d2.x) +
      s0.y * (s1.x * d2.x - s2.x * d1.x) +
      (s2.x * s1.y - s1.x * s2.y) * d0.x) /
    denom;
  const dy =
    (s0.x * (s2.y * d1.y - s1.y * d2.y) +
      s0.y * (s1.x * d2.y - s2.x * d1.y) +
      (s2.x * s1.y - s1.x * s2.y) * d0.y) /
    denom;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m11, m12, m21, m22, dx, dy);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

export interface DrawImageInQuadOptions {
  /** Gestosc siatki. Wiecej = wierniejsza perspektywa, wolniejszy render. */
  subdivisions?: number;
  /** Tryb mieszania warstwy z fotografia (multiply = druk na papierze). */
  blendMode?: string;
  /** Krycie 0..1. */
  opacity?: number;
}

/**
 * Rysuje `image` w czworokacie `quad` z korekcja perspektywy.
 *
 * Obraz jest dzielony na siatke; kazda komorka trafia w miejsce wyliczone
 * homografia i jest rysowana jako dwa trojkaty (afinicznie). Przy 12+ podzialach
 * roznica wzgledem prawdziwego rzutowania jest ponizej piksela.
 */
export function drawImageInQuad(
  ctx: any,
  image: { width: number; height: number },
  quad: Quad,
  options: DrawImageInQuadOptions = {}
): void {
  const subdivisions = Math.max(1, Math.round(options.subdivisions ?? 16));
  const map = squareToQuad(quad);
  const sw = image.width;
  const sh = image.height;

  ctx.save();
  if (options.blendMode && options.blendMode !== 'normal') {
    ctx.globalCompositeOperation = options.blendMode;
  }
  if (options.opacity !== undefined && options.opacity < 1) {
    ctx.globalAlpha = Math.max(0, options.opacity);
  }

  for (let row = 0; row < subdivisions; row++) {
    for (let col = 0; col < subdivisions; col++) {
      const u0 = col / subdivisions;
      const u1 = (col + 1) / subdivisions;
      const v0 = row / subdivisions;
      const v1 = (row + 1) / subdivisions;

      const src: Quad = [
        { x: u0 * sw, y: v0 * sh },
        { x: u1 * sw, y: v0 * sh },
        { x: u1 * sw, y: v1 * sh },
        { x: u0 * sw, y: v1 * sh },
      ];
      const dst: Quad = [map(u0, v0), map(u1, v0), map(u1, v1), map(u0, v1)];

      drawTexturedTriangle(ctx, image, [src[0], src[1], src[2]], [dst[0], dst[1], dst[2]]);
      drawTexturedTriangle(ctx, image, [src[0], src[2], src[3]], [dst[0], dst[2], dst[3]]);
    }
  }

  ctx.restore();
}

/** Zamienia rogi znormalizowane (0..1) na piksele zdjecia. */
export function quadToPixels(quad: Quad, widthPx: number, heightPx: number): Quad {
  return quad.map((point) => ({
    x: point.x * widthPx,
    y: point.y * heightPx,
  })) as Quad;
}
