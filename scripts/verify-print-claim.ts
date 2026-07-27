/**
 * Weryfikacja kolejki druku na zywej bazie.
 *
 * Najwazniejszy jest TEST 1: dwaj agenci odpytujacy jednoczesnie nie moga wziac
 * tego samego zadania, bo kazde podwojne pobranie to podwojny naklad na papierze.
 *
 * Uruchomienie (baza z docker-compose):
 *   DATABASE_URL=... ENCRYPTION_KEY=... npx tsx scripts/verify-print-claim.ts
 *
 * Skrypt sprzata po sobie - tworzy wlasnego agenta, asset i zadania, a na koniec
 * je kasuje. Nie rusza istniejacych danych.
 */
import fs from 'fs';
import path from 'path';
import prisma from '../src/lib/prisma';
import {
  claimPrintJobs,
  createPrintJob,
  reclaimStalePrintJobs,
  reportJobStatus,
} from '../src/services/print/print-job.service';
import { createPrintAgent, handleAgentHello } from '../src/services/print/print-agent.service';

const TEST_PROFILE = {
  name: 'winietki-105x100',
  printer: 'L8180_Full',
  media: 'Custom.105x100mm',
  expectSizeMm: [105, 100],
  maxPages: 100,
  enabled: true,
};

/**
 * Tryb `--seed`: zostawia w bazie agenta, plik i zadanie, wypisujac token na
 * stdout. Sluzy do recznych testow trasy HTTP i do rozruchu `hotprint --agent`.
 */
async function seed() {
  const caseItem = await prisma.personalizationCase.findFirst({
    include: { order: { include: { shop: true } } },
  });
  const tenantId = caseItem?.order?.shop?.tenantId;
  if (!caseItem || !tenantId) throw new Error('Brak sprawy z tenantem - zasil baze seedem');

  // Plik musi realnie lezec w magazynie, inaczej nie da sie przetestowac pobrania.
  const relativePath = 'test/agent-e2e.pdf';
  const absolutePath = path.join(process.cwd(), 'storage', relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 297.64 283.46]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n'
  );
  fs.writeFileSync(absolutePath, pdf);

  const asset = await prisma.asset.create({
    data: {
      caseId: caseItem.id,
      assetType: 'PDF_PRINT',
      filePath: relativePath,
      fileSize: pdf.length,
      mimeType: 'application/pdf',
      metadata: { combined: true },
    },
  });

  const { agent, token } = await createPrintAgent('Agent testowy (seed)', tenantId);
  await handleAgentHello(agent.id, {
    agentVersion: 'seed',
    hostname: 'seed.local',
    printersOnline: ['L8180_Full'],
    profiles: [TEST_PROFILE],
  });

  const job = await createPrintJob({
    assetId: asset.id,
    agentId: agent.id,
    profile: TEST_PROFILE.name,
    copies: 1,
  });

  console.log(
    JSON.stringify({ token, agentId: agent.id, assetId: asset.id, jobId: job.id }, null, 2)
  );
  await prisma.$disconnect();
}

/** Tryb `--clean`: kasuje wszystko, co zostawil `--seed`. */
async function clean() {
  const agents = await prisma.printAgent.findMany({
    where: { name: { contains: 'Agent testowy' } },
  });
  for (const agent of agents) {
    await prisma.printJob.deleteMany({ where: { agentId: agent.id } });
    await prisma.printAgent.delete({ where: { id: agent.id } });
  }
  const assets = await prisma.asset.deleteMany({ where: { filePath: 'test/agent-e2e.pdf' } });
  console.log(`Usunieto agentow: ${agents.length}, plikow: ${assets.count}`);
  await prisma.$disconnect();
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  BLAD ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const caseItem = await prisma.personalizationCase.findFirst({
    include: { order: { include: { shop: true } } },
  });
  const tenantId = caseItem?.order?.shop?.tenantId;
  if (!caseItem || !tenantId) throw new Error('Brak sprawy z tenantem - zasil baze seedem');

  const asset = await prisma.asset.create({
    data: {
      caseId: caseItem.id,
      assetType: 'PDF_PRINT',
      filePath: 'test/verify-print-claim.pdf',
      fileSize: 12345,
      mimeType: 'application/pdf',
      metadata: { combined: true },
    },
  });

  const { agent } = await createPrintAgent('Agent weryfikacyjny', tenantId);
  await handleAgentHello(agent.id, {
    agentVersion: 'verify',
    hostname: 'verify.local',
    printersOnline: ['L8180_Full'],
    profiles: [
      {
        name: 'winietki-105x100',
        printer: 'L8180_Full',
        media: 'Custom.105x100mm',
        expectSizeMm: [105, 100],
        maxPages: 100,
        enabled: true,
      },
    ],
  });

  const ctx = { id: agent.id, tenantId, name: agent.name };
  const profiles = ['winietki-105x100'];

  try {
    console.log('\nTEST 1 — wyscig dwoch agentow o to samo zadanie');
    const job = await createPrintJob({
      assetId: asset.id,
      agentId: agent.id,
      profile: 'winietki-105x100',
      copies: 2,
    });
    const [a, b] = await Promise.all([
      claimPrintJobs(ctx, profiles, 1),
      claimPrintJobs(ctx, profiles, 1),
    ]);
    check('dokladnie jeden claim dostal zadanie', a.length + b.length === 1, `A=${a.length} B=${b.length}`);

    const claimed = [...a, ...b][0];
    check('zadanie niesie naklad z panelu', claimed?.copies === 2, `copies=${claimed?.copies}`);
    check(
      'zadanie niesie oczekiwany rozmiar arkusza',
      Array.isArray(claimed?.expectedPageMm) && claimed.expectedPageMm[0] === 105,
      JSON.stringify(claimed?.expectedPageMm)
    );

    console.log('\nTEST 2 — raportowanie postepu');
    const printing = await reportJobStatus(ctx, claimed.id, {
      status: 'PRINTING',
      cupsJobId: 'L8180_Full-999',
    });
    check('PRINTING zapisany z numerem zadania CUPS', printing.job.status === 'PRINTING' && printing.job.cupsJobId === 'L8180_Full-999');

    const done = await reportJobStatus(ctx, claimed.id, { status: 'DONE' });
    check('DONE zamyka zadanie', done.job.status === 'DONE' && done.job.completedAt !== null);

    const repeated = await reportJobStatus(ctx, claimed.id, { status: 'DONE' });
    check('powtorzony raport nie psuje stanu', repeated.job.status === 'DONE');

    console.log('\nTEST 3 — pusta kolejka');
    const empty = await claimPrintJobs(ctx, profiles, 1);
    check('nic nie wydano, gdy nie ma czego drukowac', empty.length === 0);

    console.log('\nTEST 4 — walidacja przy tworzeniu zlecenia');
    let rejected = false;
    try {
      await createPrintJob({ assetId: asset.id, agentId: agent.id, profile: 'nie-ma-takiego' });
    } catch {
      rejected = true;
    }
    check('nieznany profil odrzucony', rejected);

    let tooMany = false;
    try {
      await createPrintJob({
        assetId: asset.id,
        agentId: agent.id,
        profile: 'winietki-105x100',
        copies: 500,
      });
    } catch {
      tooMany = true;
    }
    check('naklad ponad limit odrzucony', tooMany);

    console.log('\nTEST 5 — reaper rozroznia CLAIMED i PRINTING');
    const stuckClaimed = await createPrintJob({
      assetId: asset.id,
      agentId: agent.id,
      profile: 'winietki-105x100',
    });
    await prisma.printJob.update({
      where: { id: stuckClaimed.id },
      data: { status: 'CLAIMED', claimExpiresAt: new Date(Date.now() - 60_000), claimToken: 'x' },
    });

    const stuckPrinting = await createPrintJob({
      assetId: asset.id,
      agentId: agent.id,
      profile: 'winietki-105x100',
    });
    await prisma.printJob.update({
      where: { id: stuckPrinting.id },
      data: { status: 'PRINTING', claimExpiresAt: new Date(Date.now() - 60_000), claimToken: 'y' },
    });

    await reclaimStalePrintJobs(tenantId, true);

    const afterClaimed = await prisma.printJob.findFirst({ where: { id: stuckClaimed.id } });
    const afterPrinting = await prisma.printJob.findFirst({ where: { id: stuckPrinting.id } });
    check(
      'porzucone CLAIMED wraca do kolejki (nic nie poszlo na papier)',
      afterClaimed?.status === 'QUEUED',
      `status=${afterClaimed?.status}`
    );
    check(
      'porzucone PRINTING idzie do STALE, nie do kolejki (papier mogl wyjechac)',
      afterPrinting?.status === 'STALE',
      `status=${afterPrinting?.status}`
    );
  } finally {
    await prisma.printJob.deleteMany({ where: { assetId: asset.id } });
    await prisma.printAgent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
  }

  console.log(`\nWynik: ${passed} przeszlo, ${failed} nie przeszlo`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

const mode = process.argv[2];
const entry = mode === '--seed' ? seed : mode === '--clean' ? clean : main;

entry().catch(async (error) => {
  console.error('Weryfikacja przerwana:', error);
  await prisma.$disconnect();
  process.exit(1);
});
