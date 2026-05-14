import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import path from 'path';
import { config } from './config';
import prisma from './lib/prisma';
import requestContext from '@fastify/request-context';
import { authRoutes } from './routes/auth.routes';
import { adminRoutes } from './routes/admin';
import { personalizationRoutes } from './routes/public/personalization.routes';
import { reloadEmailService } from './services/admin/email-settings.service';
import { initializeEmailService } from './services/email/email.service';
import { initializeScheduler } from './services/scheduler/scheduler.service';
import { initStorage } from './services/storage/local-storage.service';
import { startRenderWorker, stopRenderWorker } from './services/queue/render.worker';
import { startEmailWorker, stopEmailWorker } from './services/queue/email.worker';
import { closeQueue, getQueueStats } from './services/queue/render.queue';
import { closeEmailQueue } from './services/queue/email.queue';
// Puppeteer removed - no browser to close anymore
import bullBoardPlugin from './plugins/bull-board';
import { errorHandlerPlugin } from './plugins/error-handler.plugin';
import { validationPlugin } from './plugins/validation.plugin';
import type { JwtPayload } from './types';

const server = Fastify({
  logger: {
    level: 'info',
    transport: config.app.isDevelopment
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

// Async request context for tenant isolation
server.register(requestContext, {
  defaultStoreValues: {
    tenantContext: null,
  },
});

// Tenant context hook - runs for every request
server.addHook('onRequest', async (request) => {
  // Prepare context data
  let contextData = { tenantId: '', userId: '', role: '' };

  try {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = (await server.jwt.verify(token)) as JwtPayload;

      // Build context with user data
      contextData = {
        tenantId: decoded.tenantId,
        userId: decoded.userId,
        role: decoded.role,
      };

      // SUPER_ADMIN can override tenantId via query param
      if (decoded.role === 'SUPER_ADMIN') {
        const overrideTenantId = (request.query as any)?.tenantId;
        if (overrideTenantId && typeof overrideTenantId === 'string') {
          (contextData as any).overrideTenantId = overrideTenantId;
        }
      }
    }
  } catch {
    // Token invalid or missing - continue with empty context
    // Public routes don't need auth
  }

  request.requestContext.set('tenantContext', contextData);
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
// Error handler (musi być pierwszy)
server.register(errorHandlerPlugin);

// Validation plugin
server.register(validationPlugin);

// CORS - dozwolone origins (admin panel + portal klienta)
const allowedOrigins = [
  config.frontend.adminUrl,
  config.frontend.publicPortalBaseUrl,
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
    if (config.app.isDevelopment && origin.includes('localhost')) {
      cb(null, true);
      return;
    }
    cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
});

server.register(helmet, {
  contentSecurityPolicy: config.app.isProduction,
  crossOriginResourcePolicy: false, // Wyłącz - ustawiamy ręcznie dla /storage/
  crossOriginEmbedderPolicy: false, // Pozwól na cross-origin embedding
});

server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// JWT Plugin
server.register(jwt, {
  secret: config.auth.jwtAccessSecret,
});

// Multipart (file upload) - limit 10MB
server.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1,
  },
});

// Static files - storage (z CORS dla cross-origin requests)
const storagePath = path.isAbsolute(config.storage.path)
  ? config.storage.path
  : path.join(process.cwd(), config.storage.path);

server.register(fastifyStatic, {
  root: storagePath,
  prefix: '/storage/',
  decorateReply: false,
  setHeaders: (res) => {
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
if (config.app.isDevelopment) {
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
    environment: config.app.env,
  };
});

// Graceful shutdown
const gracefulShutdown = async () => {
  server.log.info('Shutting down gracefully...');

  // Zatrzymuj BullMQ workers
  try {
    await stopRenderWorker();
    await stopEmailWorker();
    await closeQueue();
    await closeEmailQueue();
    server.log.info('🛑 Workers and queues stopped');
  } catch (error) {
    server.log.error({ err: error }, 'Error stopping workers');
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
    const { port, host } = config.app;

    // Inicjalizuj storage
    try {
      await initStorage();
      server.log.info('📁 Storage initialized');
    } catch (error) {
      server.log.error({ err: error }, '❌ Failed to initialize storage');
    }

    // Initialize email service (global SMTP config)
    try {
      initializeEmailService();
      server.log.info('📧 Email service initialized (global config)');
    } catch (error) {
      server.log.warn({ err: error }, '⚠️  Failed to initialize global email service');
    }

    // Załaduj ustawienia email z bazy danych przy starcie (tenant-specific)
    try {
      await reloadEmailService();
      server.log.info('✉️  Tenant email settings loaded from database');
    } catch (error) {
      server.log.warn({ err: error }, '⚠️  Failed to load tenant email settings');
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
      server.log.info('🎨 Render worker started (Fabric.js + BullMQ)');
    } catch (error) {
      server.log.error({ err: error }, '❌ Failed to start render worker');
    }

    // Uruchom BullMQ email worker
    try {
      startEmailWorker();
      server.log.info('📧 Email worker started (BullMQ)');
    } catch (error) {
      server.log.error({ err: error }, '❌ Failed to start email worker');
    }

    await server.listen({ port, host });
    server.log.info(`🚀 Server is running on http://${host}:${port}`);
    server.log.info(`📊 Health check: http://${host}:${port}/health`);
    server.log.info(`🔒 Environment: ${config.app.env}`);
    if (config.app.isDevelopment) {
      server.log.info(`📋 Bull Board: http://${host}:${port}/admin/queues`);
    }
  } catch (err) {
    server.log.error(err);
    await prisma.$disconnect();
    process.exit(1);
  }
};

start();
