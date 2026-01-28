import { FastifyInstance } from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { getRenderQueue } from '../services/queue/render.queue';

/**
 * Plugin Fastify dla Bull Board - dashboard do monitorowania kolejek
 */
export async function bullBoardPlugin(fastify: FastifyInstance): Promise<void> {
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath('/admin/queues');

  const renderQueue = getRenderQueue();

  createBullBoard({
    queues: [new BullMQAdapter(renderQueue)],
    serverAdapter,
  });

  // Rejestruj plugin Bull Board
  await fastify.register(serverAdapter.registerPlugin(), {
    prefix: '/admin/queues',
  });

  fastify.log.info('[BullBoard] Dashboard available at /admin/queues');
}

export default bullBoardPlugin;
