import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import path from 'path';
import prisma from './lib/prisma';
import { authRoutes } from './routes/auth.routes';
import { adminRoutes } from './routes/admin';
import { personalizationRoutes } from './routes/public/personalization.routes';
import { reloadEmailService } from './services/admin/email-settings.service';
import { initializeScheduler } from './services/scheduler/scheduler.service';
import { initStorage } from './services/storage/local-storage.service';
import { startRenderWorker, stopRenderWorker } from './services/queue/render.worker';
import { closeQueue, getQueueStats } from './services/queue/render.queue';
import { closeBrowser } from './services/renderer/puppeteer-renderer.service';
import bullBoardPlugin from './plugins/bull-board';

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development' 
      ? {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  },
});

// Custom content type parser to allow empty JSON bodies (Fastify v5 fix)
server.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
  try {
    const json = body === '' ? {} : JSON.parse(body as string);
    done(null, json);
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

// Plugins
// CORS - dozwolone origins (admin panel + portal klienta)
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  process.env.PUBLIC_PORTAL_BASE_URL || 'http://localhost:3002',
];

server.register(cors, {
  origin: (origin, cb) => {
    // Pozwól na requesty bez origin (np. curl, Postman)
    if (!origin) {
      cb(null, true);
      return;
    }
    // Sprawdź czy origin jest na liście dozwolonych
    if (allowedOrigins.includes(origin)) {
      cb(null, true);
      return;
    }
    // W trybie dev pozwól na wszystkie localhost
    if (process.env.NODE_ENV === 'development' && origin.includes('localhost')) {
      cb(null, true);
      return;
    }
    cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
});

server.register(helmet, {
  contentSecurityPolicy: process.env.NODE_ENV === 'production',
  crossOriginResourcePolicy: false, // Wyłącz - ustawiamy ręcznie dla /storage/
  crossOriginEmbedderPolicy: false, // Pozwól na cross-origin embedding
});

server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// JWT Plugin
server.register(jwt, {
  secret: process.env.JWT_ACCESS_SECRET || 'dev-secret-change-in-production',
});

// Multipart (file upload) - limit 10MB
server.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1,
  },
});

// Static files - storage (z CORS dla cross-origin requests)
const storagePath = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
server.register(fastifyStatic, {
  root: storagePath,
  prefix: '/storage/',
  decorateReply: false,
  setHeaders: (res, _path) => {
    // Dodaj nagłówki CORS dla plików statycznych
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    // Pozwól na cross-origin embedding (dla <img>, <video> etc.)
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Cache dla obrazów (1 godzina)
    res.setHeader('Cache-Control', 'public, max-age=3600');
  },
});

// Routes
server.register(authRoutes, { prefix: '/auth' });
server.register(adminRoutes, { prefix: '/admin' });
server.register(personalizationRoutes, { prefix: '/personalization' });

// Bull Board Dashboard (tylko w development lub z flagą)
if (process.env.NODE_ENV === 'development' || process.env.ENABLE_BULL_BOARD === 'true') {
  server.register(bullBoardPlugin);
}

// Health check
server.get('/health', async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    // Pobierz statystyki kolejki renderowania
    let queueStats = null;
    try {
      queueStats = await getQueueStats();
    } catch {
      // Queue może nie być dostępna
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
      renderQueue: queueStats,
    };
  } catch (error) {
    return {
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Root endpoint
server.get('/', async () => {
  return { 
    name: 'Personalization API',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  };
});

// Graceful shutdown
const gracefulShutdown = async () => {
  server.log.info('Shutting down gracefully...');

  // Zatrzymaj BullMQ worker i zamknij przeglądarkę Puppeteer
  try {
    await stopRenderWorker();
    await closeQueue();
    await closeBrowser();
    server.log.info('🛑 Render worker and browser stopped');
  } catch (error) {
    server.log.error({ err: error }, 'Error stopping render worker');
  }

  await prisma.$disconnect();
  await server.close();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start server
const start = async () => {
  try {
    const port = Number(process.env.API_PORT) || 3001;
    const host = process.env.API_HOST || '0.0.0.0';

    // Inicjalizuj storage
    try {
      await initStorage();
      server.log.info('📁 Storage initialized');
    } catch (error) {
      server.log.error({ err: error }, '❌ Failed to initialize storage');
    }

    // Załaduj ustawienia email z bazy danych przy starcie
    try {
      await reloadEmailService();
      server.log.info('✉️  Email service initialized from database');
    } catch (error) {
      server.log.warn({ err: error }, '⚠️  Failed to initialize email service from database');
    }

    // Zainicjalizuj scheduler automatycznej synchronizacji
    try {
      await initializeScheduler();
      server.log.info('📅 Order synchronization scheduler initialized');
    } catch (error) {
      server.log.warn({ err: error }, '⚠️  Failed to initialize scheduler');
    }

    // Uruchom BullMQ render worker
    try {
      startRenderWorker();
      server.log.info('🎨 Render worker started (Puppeteer + BullMQ)');
    } catch (error) {
      server.log.error({ err: error }, '❌ Failed to start render worker');
    }

    await server.listen({ port, host });
    server.log.info(`🚀 Server is running on http://${host}:${port}`);
    server.log.info(`📊 Health check: http://${host}:${port}/health`);
    server.log.info(`🔒 Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.NODE_ENV === 'development' || process.env.ENABLE_BULL_BOARD === 'true') {
      server.log.info(`📋 Bull Board: http://${host}:${port}/admin/queues`);
    }
  } catch (err) {
    server.log.error(err);
    await prisma.$disconnect();
    process.exit(1);
  }
};

start();
