import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import prisma from './lib/prisma';
import { authRoutes } from './routes/auth.routes';
import { adminRoutes } from './routes/admin';
import { personalizationRoutes } from './routes/public/personalization.routes';
import { reloadEmailService } from './services/admin/email-settings.service';
import { initializeScheduler } from './services/scheduler/scheduler.service';

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
});

server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// JWT Plugin
server.register(jwt, {
  secret: process.env.JWT_ACCESS_SECRET || 'dev-secret-change-in-production',
});

// Routes
server.register(authRoutes, { prefix: '/auth' });
server.register(adminRoutes, { prefix: '/admin' });
server.register(personalizationRoutes, { prefix: '/personalization' });

// Health check
server.get('/health', async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: 'connected'
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

    // Załaduj ustawienia email z bazy danych przy starcie
    try {
      await reloadEmailService();
      server.log.info('✉️  Email service initialized from database');
    } catch (error) {
      server.log.warn('⚠️  Failed to initialize email service from database:', error);
    }

    // Zainicjalizuj scheduler automatycznej synchronizacji
    try {
      await initializeScheduler();
      server.log.info('📅 Order synchronization scheduler initialized');
    } catch (error) {
      server.log.warn('⚠️  Failed to initialize scheduler:', error);
    }

    await server.listen({ port, host });
    server.log.info(`🚀 Server is running on http://${host}:${port}`);
    server.log.info(`📊 Health check: http://${host}:${port}/health`);
    server.log.info(`🔒 Environment: ${process.env.NODE_ENV || 'development'}`);
  } catch (err) {
    server.log.error(err);
    await prisma.$disconnect();
    process.exit(1);
  }
};

start();
