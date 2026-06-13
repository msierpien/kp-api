import nodemailer from 'nodemailer';
import type { SendMailOptions, Transporter } from 'nodemailer';
import { config } from '../../config';

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  fromName?: string | null;
}

export interface PersonalizationEmailData {
  to: string;
  customerName: string;
  orderReference: string;
  shopName: string;
  items: Array<{
    productName: string;
    quantity: number;
    personalizationUrl: string;
  }>;
  baseUrl: string;
}

export interface InvoiceEmailData {
  to: string;
  customerName?: string | null;
  orderReference: string;
  shopName: string;
  invoiceNumber?: string | null;
  pdfPath?: string | null;
}

export interface AutomationEmailData {
  to: string;
  subject: string;
  body: string;
  shopName: string;
}

export class EmailService {
  private transporter: Transporter | null = null;
  private config: EmailConfig | null = null;

  initialize(config: EmailConfig) {
    this.config = config;

    // MailHog i inne dev SMTP serwery nie wymagają autentykacji
    const isDevMailServer = config.port === 1025 || config.user === 'mailhog' || config.host === 'localhost';

    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      // Auth opcjonalny - tylko dla prawdziwych SMTP serwerów
      ...(isDevMailServer ? {} : {
        auth: {
          user: config.user,
          pass: config.pass,
        },
      }),
    });

    console.log('[Email] Service initialized with SMTP:', config.host, isDevMailServer ? '(dev mode, no auth)' : '(production mode, with auth)');
  }

  isConfigured(): boolean {
    return this.transporter !== null && this.config !== null;
  }

  async sendPersonalizationEmail(data: PersonalizationEmailData): Promise<boolean> {
    if (!this.transporter || !this.config) {
      console.warn('[Email] Service not configured, skipping email send');
      return false;
    }

    const html = this.generatePersonalizationEmailHtml(data);
    const text = this.generatePersonalizationEmailText(data);

    try {
      console.log('[Email] Sending personalization email to:', data.to);

      const result = await this.transporter.sendMail({
        from: this.formatFrom(data.shopName),
        to: data.to,
        subject: `Personalizacja zamówienia ${data.orderReference} - ${data.shopName}`,
        text,
        html,
      });

      console.log('[Email] ✅ Successfully sent personalization email to:', data.to, 'messageId:', result.messageId);
      return true;
    } catch (error) {
      console.error('[Email] ❌ Failed to send email to:', data.to);
      console.error('[Email] Error details:', error instanceof Error ? error.message : error);
      if (error instanceof Error && error.stack) {
        console.error('[Email] Stack trace:', error.stack);
      }
      return false;
    }
  }

  async sendAutomationEmail(data: AutomationEmailData): Promise<boolean> {
    if (!this.transporter || !this.config) {
      console.warn('[Email] Service not configured, skipping automation email');
      return false;
    }

    try {
      const result = await this.transporter.sendMail({
        from: this.formatFrom(data.shopName),
        to: data.to,
        subject: data.subject,
        text: data.body,
        html: data.body.replace(/\n/g, '<br>'),
      });
      console.log('[Email] ✅ Successfully sent automation email to:', data.to, 'messageId:', result.messageId);
      return true;
    } catch (error) {
      console.error('[Email] ❌ Failed to send automation email:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  async sendInvoiceEmail(data: InvoiceEmailData): Promise<{ success: boolean; messageId?: string }> {
    if (!this.transporter || !this.config) {
      console.warn('[Email] Service not configured, skipping invoice email send');
      return { success: false };
    }

    const invoiceLabel = data.invoiceNumber ? ` ${data.invoiceNumber}` : '';
    const subject = `Faktura${invoiceLabel} do zamówienia ${data.orderReference} - ${data.shopName}`;
    const text = this.generateInvoiceEmailText(data);
    const html = this.generateInvoiceEmailHtml(data);
    const attachments: SendMailOptions['attachments'] = data.pdfPath
      ? [{ filename: `faktura-${data.orderReference}.pdf`, path: data.pdfPath }]
      : undefined;

    try {
      const result = await this.transporter.sendMail({
        from: this.formatFrom(data.shopName),
        to: data.to,
        subject,
        text,
        html,
        attachments,
      });

      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('[Email] Failed to send invoice email:', error instanceof Error ? error.message : error);
      return { success: false };
    }
  }

  private formatFrom(fallbackName: string) {
    const name = this.config?.fromName?.trim() || fallbackName;
    return `"${name.replace(/"/g, "'")}" <${this.config?.from}>`;
  }

  private generatePersonalizationEmailHtml(data: PersonalizationEmailData): string {
    const itemsHtml = data.items
      .map(
        (item) => `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
            <strong>${item.productName}</strong>
            <br>
            <span style="color: #6b7280; font-size: 14px;">Ilość: ${item.quantity}</span>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
            <a href="${item.personalizationUrl}"
               style="display: inline-block; background-color: #2563eb; color: white;
                      padding: 10px 20px; text-decoration: none; border-radius: 6px;
                      font-weight: 500;">
              Personalizuj
            </a>
          </td>
        </tr>
      `
      )
      .join('');

    return `
<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Personalizacja zamówienia</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f2937; border-radius: 8px 8px 0 0; padding: 24px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">${data.shopName}</h1>
            </td>
          </tr>
        </table>

        <!-- Content -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: white; padding: 32px;">
          <tr>
            <td>
              <h2 style="color: #1f2937; margin: 0 0 16px 0; font-size: 20px;">
                Witaj${data.customerName ? ` ${data.customerName}` : ''}!
              </h2>

              <p style="color: #4b5563; line-height: 1.6; margin: 0 0 24px 0;">
                Dziękujemy za złożenie zamówienia <strong>${data.orderReference}</strong>.
                Twoje zamówienie zawiera produkty wymagające personalizacji.
                Prosimy o wypełnienie poniższych formularzy, abyśmy mogli przygotować Twoje zamówienie.
              </p>

              <!-- Products Table -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                <thead>
                  <tr style="background-color: #f9fafb;">
                    <th style="padding: 12px; text-align: left; color: #374151; font-weight: 600;">Produkt</th>
                    <th style="padding: 12px; text-align: center; color: #374151; font-weight: 600;">Akcja</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                </tbody>
              </table>

              <!-- Info Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fef3c7; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                <tr>
                  <td>
                    <p style="color: #92400e; margin: 0; font-size: 14px;">
                      <strong>Ważne:</strong> Link do personalizacji jest ważny przez 30 dni.
                      Po wypełnieniu formularza nie będzie możliwości edycji.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="color: #6b7280; font-size: 14px; margin: 0;">
                Jeśli masz pytania, skontaktuj się z nami odpowiadając na tego maila.
              </p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 0 0 8px 8px; padding: 24px;">
          <tr>
            <td style="text-align: center;">
              <p style="color: #6b7280; font-size: 12px; margin: 0;">
                ${data.shopName}<br>
                Ta wiadomość została wygenerowana automatycznie.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  private generatePersonalizationEmailText(data: PersonalizationEmailData): string {
    const itemsText = data.items
      .map((item) => `- ${item.productName} (ilość: ${item.quantity})\n  Link: ${item.personalizationUrl}`)
      .join('\n\n');

    return `
Witaj${data.customerName ? ` ${data.customerName}` : ''}!

Dziękujemy za złożenie zamówienia ${data.orderReference}.
Twoje zamówienie zawiera produkty wymagające personalizacji.

Produkty do personalizacji:
${itemsText}

WAŻNE: Link do personalizacji jest ważny przez 30 dni.
Po wypełnieniu formularza nie będzie możliwości edycji.

Pozdrawiamy,
${data.shopName}
    `.trim();
  }

  private generateInvoiceEmailHtml(data: InvoiceEmailData): string {
    return `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><title>Faktura</title></head>
<body style="font-family: Arial, sans-serif; color: #1f2937;">
  <p>Dzień dobry${data.customerName ? ` ${data.customerName}` : ''},</p>
  <p>W załączniku przesyłamy fakturę${data.invoiceNumber ? ` <strong>${data.invoiceNumber}</strong>` : ''} do zamówienia <strong>${data.orderReference}</strong>.</p>
  <p>Dziękujemy za zakupy.</p>
  <p>${data.shopName}</p>
</body>
</html>
    `.trim();
  }

  private generateInvoiceEmailText(data: InvoiceEmailData): string {
    return `
Dzień dobry${data.customerName ? ` ${data.customerName}` : ''},

W załączniku przesyłamy fakturę${data.invoiceNumber ? ` ${data.invoiceNumber}` : ''} do zamówienia ${data.orderReference}.

Dziękujemy za zakupy.
${data.shopName}
    `.trim();
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.transporter) {
      return { success: false, message: 'Email service not configured' };
    }

    try {
      await this.transporter.verify();
      return { success: true, message: 'SMTP connection successful' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message: `SMTP connection failed: ${message}` };
    }
  }
}

// Singleton instance
export const emailService = new EmailService();

// Initialize from environment variables
export function initializeEmailService() {
  const { host, port, user, pass, from } = config.smtp;

  if (!host || !user || !pass || !from) {
    console.warn('[Email] SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM environment variables.');
    return;
  }

  emailService.initialize({
    host,
    port,
    secure: port === 465,
    user,
    pass,
    from,
  });
}
