import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { getAdminCompatibilityFromHeaders } from '../services/ops/version.service';

export function requireAdminApiCompatibility() {
  return async function checkAdminApiCompatibility(request: FastifyRequest, reply: FastifyReply) {
    if (request.method === 'OPTIONS') return;

    const compatibility = getAdminCompatibilityFromHeaders(request.headers, config.app.env);
    if (compatibility.compatible) return;

    return reply.status(compatibility.statusCode).send({
      error: 'Upgrade Required',
      message: compatibility.reason,
      statusCode: compatibility.statusCode,
      details: {
        label: compatibility.label,
        client: compatibility.client,
        api: compatibility.api,
      },
    });
  };
}
