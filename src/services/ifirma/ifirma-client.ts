import crypto from 'node:crypto';

export const IFIRMA_KEY_NAME_INVOICE = 'faktura';
export const IFIRMA_DOMESTIC_INVOICE_URL = 'https://www.ifirma.pl/iapi/fakturakraj.json';
export const IFIRMA_DOMESTIC_INVOICE_CORRECTION_BASE_URL = 'https://www.ifirma.pl/iapi/fakturakraj/korekta';
export const IFIRMA_INVOICE_PAYMENT_BASE_URL = 'https://www.ifirma.pl/iapi/faktury/wplaty/prz_faktura_kraj';

export interface IfirmaInvoicePaymentInput {
  amount: number;
  date: string;
}

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

  async registerDomesticInvoicePayment(invoiceNumber: string, payment: IfirmaInvoicePaymentInput): Promise<void> {
    const numberSegment = invoiceNumber.trim().replace(/\//g, '_');
    if (!numberSegment) throw new Error('iFirma invoice number is required to register a payment');

    const url = `${IFIRMA_INVOICE_PAYMENT_BASE_URL}/${encodeURIComponent(numberSegment)}.json`;
    const requestContent = JSON.stringify({ Kwota: payment.amount, Data: payment.date });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
        Authentication: createIfirmaAuthenticationHeader({
          url,
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
      throw new Error(`iFirma payment API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const normalized = normalizeIssueResponse(raw);
    if (normalized.code !== null && normalized.code !== 0) {
      throw new Error(normalized.information || `iFirma returned code ${normalized.code}`);
    }
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

  async issueDomesticInvoiceCorrection(invoiceIdentifier: string, payload: unknown): Promise<IfirmaIssueInvoiceResult> {
    const cleanIdentifier = invoiceIdentifier.trim();
    if (!cleanIdentifier) throw new Error('iFirma source invoice identifier is required');

    const url = `${IFIRMA_DOMESTIC_INVOICE_CORRECTION_BASE_URL}/${encodeURIComponent(cleanIdentifier)}.json`;
    const requestContent = JSON.stringify(payload);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
        Authentication: createIfirmaAuthenticationHeader({
          url,
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
      throw new Error(`iFirma correction API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const normalized = normalizeIssueResponse(raw);
    if (normalized.code !== null && normalized.code !== 0) {
      throw new Error(normalized.information || `iFirma returned code ${normalized.code}`);
    }

    return normalized;
  }

  async downloadDomesticInvoiceCorrectionPdf(identifier: string): Promise<Buffer> {
    const cleanIdentifier = identifier.trim();
    if (!cleanIdentifier) throw new Error('iFirma correction identifier is required');

    const url = `${IFIRMA_DOMESTIC_INVOICE_CORRECTION_BASE_URL}/${encodeURIComponent(cleanIdentifier)}.pdf`;
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
      throw new Error(`iFirma correction PDF download error ${response.status}: ${text.slice(0, 300)}`);
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
