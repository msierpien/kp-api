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
import { prestashopWebhooksRoutes } from './routes/public/prestashop-webhooks.routes';
import { reloadEmailService } from './services/admin/email-settings.service';
import { initializeEmailService } from './services/email/email.service';
import { initializeScheduler } from './services/scheduler/scheduler.service';
import { initStorage } from './services/storage/local-storage.service';
import { startRenderWorker, stopRenderWorker } from './services/queue/render.worker';
import { startEmailWorker, stopEmailWorker } from './services/queue/email.worker';
import { startStockSyncWorker, stopStockSyncWorker } from './services/queue/stock-sync.worker';
import { startPriceSyncWorker, stopPriceSyncWorker } from './services/queue/price-sync.worker';
import { startWholesaleSyncWorker, stopWholesaleSyncWorker } from './services/queue/wholesale-sync.worker';
import { closeQueue } from './services/queue/render.queue';
import { closeEmailQueue } from './services/queue/email.queue';
import { closeStockSyncQueue } from './services/queue/stock-sync.queue';
import { closePriceSyncQueue } from './services/queue/price-sync.queue';
import { closeWholesaleSyncQueue } from './services/queue/wholesale-sync.queue';
// Puppeteer removed - no browser to close anymore
import bullBoardPlugin from './plugins/bull-board';
import swaggerDocsPlugin from './plugins/swagger-docs.plugin';
import { errorHandlerPlugin } from './plugins/error-handler.plugin';
import { validationPlugin } from './plugins/validation.plugin';
import type { JwtPayload } from './types';
import { getAccessTokenFromRequest } from './lib/auth-cookies';
import { getReadinessHealth } from './services/ops/health.service';
import { getPrometheusMetrics } from './services/ops/metrics.service';

type TenantContextData = Pick<JwtPayload, 'tenantId' | 'userId' | 'role'> & {
  overrideTenantId?: string;
};

const server = Fastify({
  trustProxy: config.app.trustProxy,
  routerOptions: {
    ignoreTrailingSlash: true,
  },
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
  let contextData: TenantContextData = { tenantId: '', userId: '', role: 'ADMIN' };

  try {
    const token = getAccessTokenFromRequest(request);
    if (token) {
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
          contextData.overrideTenantId = overrideTenantId;
        }
      }
    }
  } catch {
    // Token invalid or missing - continue with empty context
    // Public routes don't need auth
  }

  request.requestContext.set('tenantContext', contextData);
});

server.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Request-Id', request.id);
  return payload;
});

// Custom content type parser to allow empty JSON bodies (Fastify v5 fix)
server.addContentTypeParser('application/json', { parseAs: 'string' }, function (_req, body, done) {
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

function isAllowedOrigin(origin: string) {
  if (allowedOrigins.includes(origin)) return true;
  return config.app.isDevelopment && origin.includes('localhost');
}

server.register(cors, {
  origin: (origin, cb) => {
    // Pozwól na requesty bez origin (np. curl, Postman)
    if (!origin) {
      cb(null, true);
      return;
    }
    // Sprawdź czy origin jest na liście dozwolonych
    if (isAllowedOrigin(origin)) {
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
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.timeWindow,
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

server.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/storage/')) return;

  const origin = request.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Credentials', 'true');
  }
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    // Pozwól na cross-origin embedding (dla <img>, <video> etc.)
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Cache dla obrazów (1 godzina)
    res.setHeader('Cache-Control', 'public, max-age=3600');
  },
});

// API Docs (Swagger UI — dostępne za autentykacją)
if (process.env.DOCS_ENABLED !== 'false') {
  server.register(swaggerDocsPlugin);
}

// Routes
server.register(authRoutes, { prefix: '/auth' });
server.register(adminRoutes, { prefix: '/admin' });
server.register(personalizationRoutes, { prefix: '/personalization' });
server.register(prestashopWebhooksRoutes, { prefix: '/webhooks/prestashop' });

// Bull Board Dashboard (tylko w development lub z flagą)
if (config.app.isDevelopment) {
  server.register(bullBoardPlugin);
}

server.get('/health/live', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  uptimeSeconds: Math.round(process.uptime()),
  runtime: config.runtime,
}));

server.get('/health/ready', async (_request, reply) => {
  const health = await getReadinessHealth();
  return reply.status(health.status === 'ok' ? 200 : 503).send(health);
});

server.get('/health', async (_request, reply) => {
  const health = await getReadinessHealth();
  return reply.status(health.status === 'ok' ? 200 : 503).send(health);
});

server.get('/metrics', async (_request, reply) => {
  const metrics = await getPrometheusMetrics();
  return reply
    .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    .send(metrics);
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
    await stopStockSyncWorker();
    await stopPriceSyncWorker();
    await stopWholesaleSyncWorker();
    await closeStockSyncQueue();
    await closePriceSyncQueue();
    await closeWholesaleSyncQueue();
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
    server.log.info({ runtime: config.runtime }, 'Runtime role resolved');

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

    if (config.runtime.schedulerEnabled) {
      // Zainicjalizuj scheduler automatycznej synchronizacji
      try {
        await initializeScheduler();
        server.log.info('📅 Order synchronization scheduler initialized');
      } catch (error) {
        server.log.warn({ err: error }, '⚠️  Failed to initialize scheduler');
      }
    } else {
      server.log.info('Scheduler disabled for this runtime role');
    }

    if (config.runtime.workersEnabled) {
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

      try {
        startStockSyncWorker();
        server.log.info('Stock sync worker started (BullMQ)');
      } catch (error) {
        server.log.error({ err: error }, 'Failed to start stock sync worker');
      }

      try {
        startPriceSyncWorker();
        server.log.info('Price sync worker started (BullMQ)');
      } catch (error) {
        server.log.error({ err: error }, 'Failed to start price sync worker');
      }

      try {
        startWholesaleSyncWorker();
        server.log.info('Wholesale sync worker started (BullMQ)');
      } catch (error) {
        server.log.error({ err: error }, 'Failed to start wholesale sync worker');
      }
    } else {
      server.log.info('Workers disabled for this runtime role');
    }

    if (config.runtime.apiEnabled) {
      await server.listen({ port, host });
      server.log.info(`🚀 Server is running on http://${host}:${port}`);
      server.log.info(`📊 Health check: http://${host}:${port}/health`);
      server.log.info(`📈 Metrics: http://${host}:${port}/metrics`);
    } else {
      server.log.info('API listener disabled for this runtime role');
    }

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
