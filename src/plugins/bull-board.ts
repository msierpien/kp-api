import { FastifyInstance } from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { getRenderQueue } from '../services/queue/render.queue';
import { getEmailQueue } from '../services/queue/email.queue';
import { getStockSyncQueue } from '../services/queue/stock-sync.queue';
import { getPriceSyncQueue } from '../services/queue/price-sync.queue';

/**
 * Plugin Fastify dla Bull Board - dashboard do monitorowania kolejek
 */
export async function bullBoardPlugin(fastify: FastifyInstance): Promise<void> {
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath('/admin/bull-board');

  const renderQueue = getRenderQueue();
  const emailQueue = getEmailQueue();
  const stockSyncQueue = getStockSyncQueue();
  const priceSyncQueue = getPriceSyncQueue();

  createBullBoard({
    queues: [
      new BullMQAdapter(renderQueue),
      new BullMQAdapter(emailQueue),
      new BullMQAdapter(stockSyncQueue),
      new BullMQAdapter(priceSyncQueue),
    ],
    serverAdapter,
  });

  // Rejestruj plugin Bull Board
  await fastify.register(serverAdapter.registerPlugin(), {
    prefix: '/admin/bull-board',
  });

  fastify.log.info('[BullBoard] Dashboard available at /admin/bull-board');
}

export default bullBoardPlugin;
