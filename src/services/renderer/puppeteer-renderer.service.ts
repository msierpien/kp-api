import puppeteer, { Browser } from 'puppeteer';
import Handlebars from 'handlebars';
import fs from 'fs/promises';
import path from 'path';

// Singleton browser instance
let browserInstance: Browser | null = null;

interface RenderOptions {
  width: number;
  height: number;
  scale?: number;
  format?: 'png' | 'pdf';
  includeWatermark?: boolean;
  quality?: number;
}

interface TemplateData {
  answers: Record<string, string | number | boolean>;
  templateName: string;
  layoutConfig?: LayoutConfig;
  watermark?: WatermarkConfig;
}

interface LayoutConfig {
  page: {
    width: number;
    height: number;
    unit: 'mm' | 'px';
    bleed?: number;
    safeArea?: number;
  };
  fonts?: FontConfig[];
  fields?: Record<string, FieldConfig>;
}

interface FontConfig {
  family: string;
  src: string;
  weight?: number;
  style?: string;
}

interface FieldConfig {
  x: number;
  y: number;
  width: number;
  maxLines?: number;
  font?: {
    family?: string;
    size?: number;
    weight?: number;
    color?: string;
  };
  align?: 'left' | 'center' | 'right';
  transform?: 'uppercase' | 'lowercase' | 'capitalize';
}

interface WatermarkConfig {
  text: string;
  opacity: number;
  angle: number;
  fontSize?: number;
}

const TEMPLATES_DIR = path.join(__dirname, '../../templates');

/**
 * Pobiera lub tworzy instancję przeglądarki
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
      ],
    });
    console.log('[Puppeteer] Browser launched');
  }
  return browserInstance;
}

/**
 * Zamyka przeglądarkę (do wywołania przy shutdown)
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    console.log('[Puppeteer] Browser closed');
  }
}

/**
 * Rejestruje Handlebars helpers
 */
function registerHelpers(): void {
  // Helper dla transformacji tekstu
  Handlebars.registerHelper('uppercase', (str: string) => str?.toUpperCase());
  Handlebars.registerHelper('lowercase', (str: string) => str?.toLowerCase());
  Handlebars.registerHelper('capitalize', (str: string) => {
    if (!str) return '';
    return str.replace(/\b\w/g, (char) => char.toUpperCase());
  });

  // Helper dla warunkowego renderowania
  Handlebars.registerHelper('ifEquals', function (this: unknown, arg1: unknown, arg2: unknown, options: Handlebars.HelperOptions) {
    return arg1 === arg2 ? options.fn(this) : options.inverse(this);
  });

  // Helper dla formatowania daty
  Handlebars.registerHelper('formatDate', (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('pl-PL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  });

  // Helper dla wielolinijkowego tekstu (zamienia \n na <br>)
  Handlebars.registerHelper('multiline', (str: string) => {
    if (!str) return '';
    return new Handlebars.SafeString(
      str.split('\n').map(line => Handlebars.escapeExpression(line)).join('<br>')
    );
  });
}

// Rejestruj helpers przy starcie
registerHelpers();

/**
 * Kompiluje szablon Handlebars
 */
async function compileTemplate(templatePath: string): Promise<Handlebars.TemplateDelegate> {
  const templateContent = await fs.readFile(templatePath, 'utf-8');
  return Handlebars.compile(templateContent);
}

/**
 * Generuje HTML z danych i szablonu
 */
async function generateHTML(data: TemplateData): Promise<string> {
  // Ścieżka do szablonu
  const templatePath = path.join(TEMPLATES_DIR, 'invitations', `${data.templateName}.hbs`);

  // Sprawdź czy szablon istnieje, jeśli nie - użyj domyślnego
  let actualTemplatePath = templatePath;
  try {
    await fs.access(templatePath);
    console.log(`[Puppeteer] Using template: ${actualTemplatePath}`);
  } catch {
    actualTemplatePath = path.join(TEMPLATES_DIR, 'invitations', 'default.hbs');
    console.log(`[Puppeteer] Template not found, using default: ${actualTemplatePath}`);
  }

  const template = await compileTemplate(actualTemplatePath);

  // Przygotuj dane dla szablonu
  const templateData = {
    ...data.answers,
    layout: data.layoutConfig,
    watermark: data.watermark,
    fontsDir: path.join(TEMPLATES_DIR, 'fonts'),
  };

  // DEBUG: Loguj dane przekazywane do szablonu
  console.log('[Puppeteer] Template data:', JSON.stringify(templateData, null, 2));

  return template(templateData);
}

/**
 * Renderuje PNG preview
 */
export async function renderPreview(
  data: TemplateData,
  options: RenderOptions = { width: 800, height: 1200, includeWatermark: true }
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Ustaw viewport
    await page.setViewport({
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale || 1,
    });

    // Dodaj watermark do danych jeśli włączony
    if (options.includeWatermark) {
      data.watermark = {
        text: 'PODGLĄD',
        opacity: 0.15,
        angle: -30,
        fontSize: 72,
      };
    }

    // Generuj HTML
    const html = await generateHTML(data);

    // Ustaw zawartość strony
    await page.setContent(html, {
      waitUntil: 'networkidle0',
    });

    // Poczekaj na załadowanie fontów
    await page.evaluate(() => document.fonts.ready);

    // Zrób screenshot
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: options.width,
        height: options.height,
      },
    });

    return Buffer.from(screenshot);
  } finally {
    await page.close();
  }
}

/**
 * Renderuje finalny PDF
 */
export async function renderPDF(
  data: TemplateData,
  options: RenderOptions = { width: 148, height: 210 }
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // PDF nie ma watermarku
    data.watermark = undefined;

    // Generuj HTML
    const html = await generateHTML(data);

    // Ustaw zawartość strony
    await page.setContent(html, {
      waitUntil: 'networkidle0',
    });

    // Poczekaj na załadowanie fontów
    await page.evaluate(() => document.fonts.ready);

    // Generuj PDF
    const pdfBuffer = await page.pdf({
      width: `${options.width}mm`,
      height: `${options.height}mm`,
      printBackground: true,
      preferCSSPageSize: true,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

/**
 * Renderuje wielostronicowy PDF (np. dla listy gości)
 */
export async function renderMultiPagePDF(
  pages: TemplateData[],
  options: RenderOptions = { width: 148, height: 210 }
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Generuj HTML dla wszystkich stron
    const htmlPages: string[] = [];
    for (const pageData of pages) {
      pageData.watermark = undefined;
      const html = await generateHTML(pageData);
      htmlPages.push(html);
    }

    // Połącz strony z page-break
    const combinedHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @page { size: ${options.width}mm ${options.height}mm; margin: 0; }
          .page { page-break-after: always; }
          .page:last-child { page-break-after: auto; }
        </style>
      </head>
      <body>
        ${htmlPages.map(html => `<div class="page">${html}</div>`).join('')}
      </body>
      </html>
    `;

    await page.setContent(combinedHtml, {
      waitUntil: 'networkidle0',
    });

    await page.evaluate(() => document.fonts.ready);

    const pdfBuffer = await page.pdf({
      width: `${options.width}mm`,
      height: `${options.height}mm`,
      printBackground: true,
      preferCSSPageSize: true,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

/**
 * Sprawdza czy przeglądarka jest dostępna
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const browser = await getBrowser();
    return browser.connected;
  } catch {
    return false;
  }
}
