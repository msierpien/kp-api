import type { Layer, TemplateLayoutJson } from '../types/template-layout';

/**
 * Merge layoutu z overrides (zmiany wprowadzone przez klienta w portalu).
 *
 * `pageId` decyduje, ktore elementy dodane przez klienta (addedLayers)
 * dokleic do warstw - kazdy zyje na konkretnej stronie projektu. Dodana
 * warstwa jest zwykla warstwa, wiec nadpisania (pozycja, styl, per sztuka)
 * dzialaja na niej ta sama sciezka co na warstwach szablonu.
 *
 * Funkcja mieszka w `lib`, a nie w rendererze, bo korzysta z niej rowniez
 * walidacja odpowiedzi - inaczej mierzylaby tekst wzgledem geometrii
 * szablonu, podczas gdy klient zdazyl juz zmniejszyc czcionke albo poszerzyc
 * ramke, i komunikat "za dlugie" klamalby wzgledem wydruku.
 */
export function mergeLayoutWithOverrides(
  layout: TemplateLayoutJson,
  overrides?: any,
  itemIndex?: number,
  pageId?: string
): TemplateLayoutJson {
  const addedLayers: Layer[] = Array.isArray(overrides?.addedLayers)
    ? overrides.addedLayers
        .filter((entry: any) => entry?.layer && (!pageId || entry.pageId === pageId))
        .map((entry: any) => entry.layer as Layer)
    : [];

  if (!overrides?.layers && !overrides?.items && addedLayers.length === 0) return layout;

  const baseLayers = addedLayers.length ? [...layout.layers, ...addedLayers] : layout.layers;

  return {
    ...layout,
    layers: baseLayers.map(layer => {
      // Nadpisanie konkretnej sztuki wygrywa nad wspolnym - klient moze
      // zmniejszyc czcionke tylko tam, gdzie nazwisko sie nie miescilo.
      const shared = overrides?.layers?.[layer.id];
      const perItem =
        itemIndex === undefined
          ? undefined
          : overrides?.items?.[String(itemIndex)]?.layers?.[layer.id];
      const override = shared || perItem ? { ...(shared || {}), ...(perItem || {}) } : undefined;
      if (!override) return layer;

      // Styl wybrany przez klienta (o ile szablon na to pozwolil) trafia do
      // properties warstwy. Bez tego wybory z portalu byly widoczne wylacznie
      // w podgladzie, a wydruk zachowywal ustawienia projektanta.
      // `text` to tresc nadpisana edycja wprost na projekcie (np. imie
      // i nazwisko w jednej linii zamiast entera z szablonu).
      const style: Record<string, unknown> = {};
      for (const key of ['fontSize', 'fontFamily', 'fill', 'textAlign', 'fontWeight', 'text', 'tint'] as const) {
        const value = (override as Record<string, unknown>)[key];
        if (value !== undefined && value !== null) {
          style[key] = value;
        }
      }

      return {
        ...layer,
        x: override.x ?? layer.x,
        y: override.y ?? layer.y,
        width: override.width ?? layer.width,
        height: override.height ?? layer.height,
        rotation: override.rotation ?? layer.rotation,
        // zIndex i visible to pola warstwy, nie properties: pierwsze decyduje
        // o kolejnosci rysowania, drugie o tym, czy warstwa w ogole trafia
        // na wydruk (klient moze ukryc element w edytorze).
        zIndex: override.zIndex ?? layer.zIndex,
        visible: override.visible ?? layer.visible,
        properties: Object.keys(style).length
          ? { ...(layer.properties as unknown as Record<string, unknown>), ...style }
          : layer.properties,
      } as typeof layer;
    })
  };
}
