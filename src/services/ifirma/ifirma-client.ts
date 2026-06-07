import crypto from 'node:crypto';

export const IFIRMA_KEY_NAME_INVOICE = 'faktura';
export const IFIRMA_DOMESTIC_INVOICE_URL = 'https://www.ifirma.pl/iapi/fakturakraj.json';

export interface IfirmaClientConfig {
  login: string;
  invoiceKey: string;
}

export interface IfirmaIssueInvoiceResult {
  raw: unknown;
  code: number | null;
  information: string | null;
  identifier: string | null;
  number: string | null;
}

export function createIfirmaHmac(input: {
  url: string;
  user: string;
  keyName: string;
  requestContent: string;
  key: string;
}) {
  const key = normalizeIfirmaKey(input.key);
  return crypto
    .createHmac('sha1', key)
    .update(`${input.url}${input.user}${input.keyName}${input.requestContent}`, 'utf8')
    .digest('hex');
}

export function createIfirmaAuthenticationHeader(input: {
  url: string;
  user: string;
  keyName: string;
  requestContent: string;
  key: string;
}) {
  const hmac = createIfirmaHmac(input);
  return `IAPIS user=${input.user}, hmac-sha1=${hmac}`;
}

export class IfirmaClient {
  constructor(private readonly config: IfirmaClientConfig) {}

  async issueDomesticInvoice(payload: unknown): Promise<IfirmaIssueInvoiceResult> {
    const requestContent = JSON.stringify(payload);
    const response = await fetch(IFIRMA_DOMESTIC_INVOICE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
        Authentication: createIfirmaAuthenticationHeader({
          url: IFIRMA_DOMESTIC_INVOICE_URL,
          user: this.config.login,
          keyName: IFIRMA_KEY_NAME_INVOICE,
          requestContent,
          key: this.config.invoiceKey,
        }),
      },
      body: requestContent,
    });

    const text = await response.text();
    const raw = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new Error(`iFirma API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const normalized = normalizeIssueResponse(raw);
    if (normalized.code !== null && normalized.code !== 0) {
      throw new Error(normalized.information || `iFirma returned code ${normalized.code}`);
    }

    return normalized;
  }

  async downloadDomesticInvoicePdf(identifier: string): Promise<Buffer> {
    const cleanIdentifier = identifier.trim();
    if (!cleanIdentifier) throw new Error('iFirma invoice identifier is required');

    const url = `https://www.ifirma.pl/iapi/fakturakraj/${encodeURIComponent(cleanIdentifier)}.pdf`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/pdf',
        Authentication: createIfirmaAuthenticationHeader({
          url,
          user: this.config.login,
          keyName: IFIRMA_KEY_NAME_INVOICE,
          requestContent: '',
          key: this.config.invoiceKey,
        }),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`iFirma PDF download error ${response.status}: ${text.slice(0, 300)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}

function normalizeIfirmaKey(key: string) {
  const trimmed = key.trim();
  return /^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'utf8');
}

function normalizeIssueResponse(raw: any): IfirmaIssueInvoiceResult {
  const response = raw?.response ?? raw?.Response ?? raw;
  const code = response?.Kod ?? response?.kod ?? null;

  return {
    raw,
    code: code === null || code === undefined ? null : Number(code),
    information: response?.Informacja ?? response?.informacja ?? null,
    identifier: response?.Identyfikator == null ? null : String(response.Identyfikator),
    number: response?.Numer == null ? null : String(response.Numer),
  };
}
