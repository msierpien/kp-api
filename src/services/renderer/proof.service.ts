import prisma from '../../lib/prisma';
import { getCaseLayout } from '../../lib/case-layout';
import { flattenCaseAnswers, normalizeCaseAnswers } from '../../lib/personalization-answers';
import { getTemplatePagesForAnswers } from '../../types/template-layout';
import { renderProofPagePng } from './fabric-renderer.service';
import { saveFile } from '../storage/local-storage.service';
import { resolveProofWatermarkText } from '../admin/print-settings.service';
import { addProofPdfJob } from '../queue/render.queue';
import { createLogger } from '../../lib/logger';

const logger = createLogger('proof');

const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;

/** Typ assetu dla PDF-a podgladowego (kolumna jest tekstowa, bez enuma w bazie). */
export const PROOF_ASSET_TYPE = 'PDF_PROOF';

/**
 * Ile sztuk trafia do PDF-a podgladowego.
 *
 * Lista gosci potrafi miec 150 pozycji - kazda jako osobna strona daloby
 * zalacznik nie do wyslania mailem. Klient dostaje poczatek kompletu i
 * informacje, ile sztuk pominieto; calosc widzi w portalu.
 */
const PROOF_MAX_ITEMS = Math.max(1, Number(process.env.PROOF_MAX_ITEMS) || 12);

/** Margines wokol projektu, pasek na podpis pod nim i wysokosc samego podpisu (mm). */
const PROOF_MARGIN_MM = 8;
const PROOF_FOOTER_MM = 12;
const PROOF_CAPTION_MM = 5;

const mmToPt = (mm: number) => (mm / MM_PER_INCH) * PT_PER_INCH;

export interface ProofPdfResult {
  buffer: Buffer;
  pageCount: number;
  itemsRendered: number;
  itemsTotal: number;
}

export interface RenderCaseProofPdfOptions {
  watermarkText?: string | null;
  maxItems?: number;
  dpi?: number;
}

/** Gotowa strona podgladu: obraz projektu i podpis pod nim. */
export interface ProofPage {
  jpeg: Buffer;
  widthMm: number;
  heightMm: number;
  caption: string;
}

/**
 * PDF podgladowy dla klienta: projekt tak, jak zostanie wydrukowany, w
 * obnizonej rozdzielczosci i ze znakiem wodnym na calej powierzchni.
 *
 * Renderujemy z layoutu, a nie z podgladu przyslanego przez przegladarke -
 * plik ma pokazywac to, co faktycznie pojdzie na maszyne, lacznie z
 * poprawkami naniesionymi per sztuka.
 */
export async function renderCaseProofPdf(
  caseId: string,
  options: RenderCaseProofPdfOptions = {}
): Promise<ProofPdfResult> {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id: caseId },
    include: {
      order: { select: { orderReference: true } },
      orderItem: { select: { quantity: true, productNameSnapshot: true } },
      template: {
        include: {
          forms: {
            include: { fields: { orderBy: { sortOrder: 'asc' } } },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  });

  if (!caseItem) throw new Error(`Case not found: ${caseId}`);

  const layout = getCaseLayout(caseItem);
  if (!layout) throw new Error('Template layout is required for proof rendering');

  const fields = caseItem.template.forms.flatMap((form) => form.fields);
  const itemsTotal = Math.max(1, Number(caseItem.orderItem?.quantity) || 1);
  const answers = normalizeCaseAnswers(caseItem.answersJson, fields, itemsTotal);
  const maxItems = Math.max(1, options.maxItems ?? PROOF_MAX_ITEMS);
  const itemsRendered = Math.min(itemsTotal, maxItems);

  const watermarkText = options.watermarkText?.trim() || null;
  const pages: ProofPage[] = [];

  for (let itemIndex = 0; itemIndex < itemsRendered; itemIndex += 1) {
    const flatAnswers = flattenCaseAnswers(answers, itemIndex);
    // Wariant szablonu wybiera odpowiedz klienta, wiec strony bierzemy per
    // sztuka - pozycje moga miec rozne warianty.
    const itemPages = getTemplatePagesForAnswers(layout, flatAnswers);

    for (let pageIndex = 0; pageIndex < itemPages.length; pageIndex += 1) {
      const rendered = await renderProofPagePng(
        itemPages[pageIndex],
        flatAnswers,
        caseItem.layoutOverrides || undefined,
        itemIndex,
        { watermarkText, dpi: options.dpi }
      );

      const pageName = itemPages[pageIndex].name || `Strona ${pageIndex + 1}`;
      const itemLabel = itemsTotal > 1 ? `Sztuka ${itemIndex + 1} z ${itemsTotal} · ` : '';
      pages.push({
        jpeg: rendered.buffer,
        widthMm: rendered.widthMm,
        heightMm: rendered.heightMm,
        caption: `${itemLabel}${pageName}`,
      });
    }
  }

  if (pages.length === 0) throw new Error('Proof has no pages to render');

  const buffer = await buildProofPdf(pages, {
    orderReference: caseItem.order?.orderReference || '',
    productName: caseItem.orderItem?.productNameSnapshot || caseItem.template.name,
    skippedItems: itemsTotal - itemsRendered,
  });

  logger.info(
    { caseId, pages: pages.length, itemsRendered, itemsTotal, bytes: buffer.length },
    'Proof PDF rendered'
  );

  return { buffer, pageCount: pages.length, itemsRendered, itemsTotal };
}

/**
 * Zleca wygenerowanie PDF-a podgladowego w tle.
 *
 * Znak wodny rozwiazujemy TU, a nie w workerze: worker nie ma kontekstu
 * tenanta, a publiczny submit zna go ze sprawy.
 */
export async function enqueueCaseProofPdf(
  caseId: string,
  options: { tenantId?: string; sendEmail?: boolean } = {}
): Promise<{ renderJobId: string; bullmqJobId?: string | number }> {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id: caseId },
    select: {
      orderId: true,
      templateId: true,
      templateVersionFrozen: true,
      template: { select: { name: true } },
      order: { select: { orderReference: true } },
    },
  });

  if (!caseItem) throw new Error(`Case not found: ${caseId}`);

  const watermarkText = await resolveProofWatermarkText(options.tenantId);

  const renderJob = await prisma.renderJob.create({
    data: {
      caseId,
      jobType: 'PDF_PROOF',
      status: 'PENDING',
      metadata: {
        mode: 'BULLMQ',
        templateId: caseItem.templateId,
        templateVersion: caseItem.templateVersionFrozen,
        watermarkText,
        sendEmail: Boolean(options.sendEmail),
      },
    },
  });

  const bullmqJob = await addProofPdfJob({
    caseId,
    renderJobId: renderJob.id,
    answers: {},
    templateName: caseItem.template?.name || 'default',
    templateVersion: caseItem.templateVersionFrozen,
    orderId: caseItem.orderId,
    orderReference: caseItem.order?.orderReference || undefined,
    proofOptions: { watermarkText, sendEmail: options.sendEmail },
  });

  await prisma.renderJob.update({
    where: { id: renderJob.id },
    data: {
      metadata: {
        ...(renderJob.metadata as object || {}),
        bullmqJobId: bullmqJob.id,
      },
    },
  });

  return { renderJobId: renderJob.id, bullmqJobId: bullmqJob.id };
}

/**
 * Podpis pod projektem jako obrazek, nie tekst PDF-a.
 *
 * Wbudowane czcionki pdfkita sa w WinAnsi i nie maja polskich znakow -
 * "PODGLĄD" wychodzilo z nich jako "PODGL DB r". node-canvas bierze krój
 * z systemu i te znaki ma, wiec pasek renderujemy tak samo jak projekt.
 */
async function renderCaptionPng(text: string, widthMm: number, heightMm: number): Promise<Buffer> {
  const { createCanvas } = await import('canvas');
  const dpi = 150;
  const widthPx = Math.max(1, Math.round((widthMm / MM_PER_INCH) * dpi));
  const heightPx = Math.max(1, Math.round((heightMm / MM_PER_INCH) * dpi));

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);

  ctx.fillStyle = '#6b7280';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Przy waskiej kartce podpis nie miesci sie w jednej linii - zmniejszamy
  // pismo, zamiast pozwolic mu wyjsc poza krawedz.
  let fontSize = Math.max(6, Math.round(heightPx * 0.5));
  ctx.font = `${fontSize}px sans-serif`;
  while (fontSize > 5 && Number(ctx.measureText(text).width) > widthPx * 0.96) {
    fontSize -= 1;
    ctx.font = `${fontSize}px sans-serif`;
  }

  ctx.fillText(text, widthPx / 2, heightPx / 2);
  return canvas.toBuffer('image/png');
}

/**
 * Sklada strony podgladu w jeden PDF. Wydzielone od pobierania danych, zeby
 * dalo sie sprawdzic sam sklad bez bazy.
 */
export async function buildProofPdf(
  pages: ProofPage[],
  meta: { orderReference: string; productName: string; skippedItems: number }
): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;

  // Podpisy renderujemy przed otwarciem dokumentu - w trakcie skladania
  // pdfkit nie zaczeka na obietnice.
  const captions = await Promise.all(
    pages.map((page, index) => {
      const orderPart = meta.orderReference ? ` · zamówienie ${meta.orderReference}` : '';
      const skippedPart =
        index === pages.length - 1 && meta.skippedItems > 0
          ? ` · pominięto ${meta.skippedItems} kolejnych sztuk`
          : '';
      return renderCaptionPng(
        `PODGLĄD — nie do druku · ${page.caption}${orderPart}${skippedPart}`,
        page.widthMm,
        PROOF_CAPTION_MM
      );
    })
  );

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      info: {
        Title: `Podglad projektu - zamowienie ${meta.orderReference}`,
        Author: 'Podglad - nie do druku',
        Subject: meta.productName,
      },
    });

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    pages.forEach((page, index) => {
      // Strona PDF = projekt + margines + pasek na podpis. Podpis obok
      // projektu, a nie na nim: klient ma widziec cala kartke bez przeslon.
      const contentWidthPt = mmToPt(page.widthMm);
      const contentHeightPt = mmToPt(page.heightMm);
      const marginPt = mmToPt(PROOF_MARGIN_MM);
      const footerPt = mmToPt(PROOF_FOOTER_MM);
      const pageWidthPt = contentWidthPt + marginPt * 2;
      const pageHeightPt = contentHeightPt + marginPt * 2 + footerPt;

      doc.addPage({ size: [pageWidthPt, pageHeightPt], margin: 0 });
      doc.rect(0, 0, pageWidthPt, pageHeightPt).fill('#ffffff');

      doc.image(page.jpeg, marginPt, marginPt, {
        width: contentWidthPt,
        height: contentHeightPt,
      });

      // Cienka ramka zaznacza linie ciecia - bez niej jasny projekt zlewa
      // sie z bialym tlem strony i nie widac formatu kartki.
      doc
        .rect(marginPt, marginPt, contentWidthPt, contentHeightPt)
        .lineWidth(0.5)
        .strokeColor('#c8c8c8')
        .stroke();

      doc.image(captions[index], marginPt, marginPt + contentHeightPt + mmToPt(3), {
        width: contentWidthPt,
        height: mmToPt(PROOF_CAPTION_MM),
      });
    });

    doc.end();
  });
}

/**
 * Renderuje PDF podgladowy i zapisuje go jako asset sprawy.
 *
 * Poprzedni podglad zastepujemy - klient ma miec jeden aktualny plik, a nie
 * liste wersji, w ktorej nie wiadomo, ktora zatwierdzil.
 */
export async function generateCaseProofPdf(
  caseId: string,
  options: RenderCaseProofPdfOptions = {}
): Promise<{ assetId: string; filePath: string; fileUrl: string; fileSize: number; pageCount: number }> {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id: caseId },
    select: {
      orderId: true,
      templateVersionFrozen: true,
      order: { select: { orderReference: true } },
    },
  });

  if (!caseItem) throw new Error(`Case not found: ${caseId}`);

  const proof = await renderCaseProofPdf(caseId, options);

  const baseName = (caseItem.order?.orderReference || caseId)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const savedFile = await saveFile(proof.buffer, {
    orderId: caseItem.orderId,
    templateVersion: caseItem.templateVersionFrozen,
    filename: `podglad-${baseName || caseId}`,
    extension: 'pdf',
  });

  const previousAssets = await prisma.asset.findMany({
    where: { caseId, assetType: PROOF_ASSET_TYPE },
    select: { id: true },
  });

  const asset = await prisma.asset.create({
    data: {
      caseId,
      assetType: PROOF_ASSET_TYPE,
      filePath: savedFile.relativePath,
      fileSize: savedFile.size,
      mimeType: 'application/pdf',
      metadata: {
        generatedAt: new Date().toISOString(),
        pageCount: proof.pageCount,
        itemsRendered: proof.itemsRendered,
        itemsTotal: proof.itemsTotal,
        watermark: options.watermarkText || undefined,
      },
    },
  });

  if (previousAssets.length > 0) {
    // Same wpisy - pliki sprzata cykliczny cleanup magazynu. Kasowanie ich
    // tutaj zrywaloby linki wyslane wczesniej mailem, zanim klient je otworzy.
    await prisma.asset.deleteMany({ where: { id: { in: previousAssets.map((item) => item.id) } } });
  }

  return {
    assetId: asset.id,
    filePath: savedFile.relativePath,
    fileUrl: savedFile.url,
    fileSize: savedFile.size,
    pageCount: proof.pageCount,
  };
}
