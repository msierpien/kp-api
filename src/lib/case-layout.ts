import type { TemplateLayoutJson } from '../types/template-layout';

/** Sprawa w zakresie potrzebnym do wyboru layoutu. */
export interface CaseLayoutSource {
  layoutSnapshot?: unknown;
  template: { layoutJson: unknown };
}

/**
 * Layout, wedlug ktorego renderujemy i walidujemy sprawe.
 *
 * Po zatwierdzeniu obowiazuje snapshot zamrozony przy submicie: klient
 * zaakceptowal konkretny projekt i pozniejsza edycja szablonu w adminie nie
 * moze zmienic tego, co pojdzie do druku. Sprawy sprzed tej funkcji nie maja
 * snapshotu i czytaja biezacy layout szablonu (zachowanie sprzed zmiany).
 */
export function getCaseLayout(caseItem: CaseLayoutSource): TemplateLayoutJson | null {
  return (caseItem.layoutSnapshot || caseItem.template.layoutJson) as unknown as TemplateLayoutJson | null;
}
