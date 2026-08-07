/**
 * Konwencja rodzin wariantow po SKU: warianty jednego produktu wspoldziela
 * prefiks SKU rozdzielony myslnikami (np. ZAP-GOL-01, ZAP-GOL-02 -> baza ZAP-GOL).
 * Dla SKU dwuczlonowego baza to pierwszy czlon, o ile zawiera litere.
 */
export function skuFamilyBase(sku: string) {
  const normalized = sku.trim().replace(/\s+/g, '').toUpperCase();
  if (!normalized || !normalized.includes('-')) return null;
  const parts = normalized.split('-').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length >= 3) return parts.slice(0, -1).join('-');
  if (!/[A-Z]/.test(parts[0])) return null;
  return parts[0];
}
