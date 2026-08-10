/**
 * Linki do edytora dla WSZYSTKICH spraw jednego zamowienia.
 *
 * Zamowienie z dwoma produktami personalizowanymi zaklada dwie sprawy, kazda
 * z wlasnym tokenem - klient potrzebuje obu linkow, ale w JEDNEJ wiadomosci.
 * Osobny mail na kazda pozycje wyglada jak usterka systemu i drugi link
 * latwo ginie.
 */
import prisma from './prisma';
import { decrypt } from './encryption';
import { generateAccessToken, getTokenExpiryDate } from './token';

export interface PersonalizationLink {
  caseId: string;
  productName: string;
  quantity: number;
  url: string;
}

/** Token wielokrotnego uzytku, a gdy go nie ma - swiezy. */
async function resolveCaseToken(caseItem: {
  id: string;
  tokenActive: boolean;
  customerTokenEncrypted: string | null;
}): Promise<string> {
  if (caseItem.tokenActive && caseItem.customerTokenEncrypted) {
    try {
      return decrypt(caseItem.customerTokenEncrypted);
    } catch {
      // Nieodszyfrowywalny token traktujemy jak brak - wystawiamy nowy,
      // zeby jeden uszkodzony wpis nie zablokowal calej wysylki.
    }
  }

  const { token, hash, encrypted } = generateAccessToken();
  await prisma.personalizationCase.update({
    where: { id: caseItem.id },
    data: {
      customerTokenHash: hash,
      customerTokenEncrypted: encrypted,
      tokenActive: true,
      customerTokenExpiresAt: getTokenExpiryDate(),
      updatedAt: new Date(),
    },
  });
  return token;
}

/**
 * Sprawy zamowienia w kolejnosci pozycji, z gotowymi adresami edytora.
 *
 * Wolane z opoznieniem po zalozeniu pierwszej sprawy, wiec widzi juz komplet
 * pozycji - sprawy powstaja sekwencyjnie i przy pierwszej z nich kolejne
 * jeszcze nie istnieja.
 */
export async function getOrderPersonalizationLinks(
  orderId: string,
  portalUrl: string
): Promise<PersonalizationLink[]> {
  const cases = await prisma.personalizationCase.findMany({
    where: { orderId },
    include: { orderItem: true },
    orderBy: { createdAt: 'asc' },
  });

  const links: PersonalizationLink[] = [];
  for (const caseItem of cases) {
    const token = await resolveCaseToken(caseItem);
    links.push({
      caseId: caseItem.id,
      productName: caseItem.orderItem?.productNameSnapshot || 'Produkt personalizowany',
      quantity: caseItem.orderItem?.quantity || 1,
      url: `${portalUrl}/${token}`,
    });
  }

  return links;
}

/** Lista do wstawienia w tresc maila - jeden produkt na wiersz. */
export function formatLinksForEmail(links: PersonalizationLink[]): string {
  if (links.length === 1) return links[0].url;

  return links
    .map((link) => `${link.productName} (${link.quantity} szt.):\n${link.url}`)
    .join('\n\n');
}
