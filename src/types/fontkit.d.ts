/**
 * fontkit 2.x nie ma wlasnych typow ani paczki @types.
 *
 * Deklarujemy tylko to, czego uzywa rejestr czcionek: nazwy z tablicy `name`,
 * wage z OS/2 i osie kroju zmiennego. Reszta zostaje `unknown`, zeby nikt nie
 * siegal po nieopisane pola w ciemno.
 */
declare module 'fontkit' {
  export interface FontNameRecords {
    preferredFamily?: string | Record<string, string>;
    preferredSubfamily?: string | Record<string, string>;
    fontFamily?: string | Record<string, string>;
    fontSubfamily?: string | Record<string, string>;
    [key: string]: string | Record<string, string> | undefined;
  }

  export interface Font {
    type?: string;
    familyName?: string;
    subfamilyName?: string;
    postscriptName?: string;
    italicAngle?: number;
    variationAxes?: Record<string, unknown>;
    name?: { records?: FontNameRecords };
    'OS/2'?: { usWeightClass?: number };
  }

  /** Kolekcja (.ttc/.dfont) - nie obslugujemy jej w rejestrze. */
  export interface FontCollection {
    type: 'TTC' | 'DFont';
    fonts?: Font[];
  }

  export function open(path: string, postscriptName?: string): Promise<Font | FontCollection>;
  export function openSync(path: string, postscriptName?: string): Font | FontCollection;
  export function create(buffer: Buffer, postscriptName?: string): Font | FontCollection;
}
