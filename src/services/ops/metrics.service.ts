import { getReadinessHealth } from './health.service';

function line(name: string, value: string | number, labels?: Record<string, string>) {
  const serializedLabels = labels
    ? `{${Object.entries(labels).map(([key, labelValue]) => `${key}="${labelValue}"`).join(',')}}`
    : '';

  return `${name}${serializedLabels} ${value}`;
}

export async function getPrometheusMetrics() {
  const memory = process.memoryUsage();
  const health = await getReadinessHealth();
  const lines = [
    '# HELP app_uptime_seconds Process uptime in seconds.',
    '# TYPE app_uptime_seconds gauge',
    line('app_uptime_seconds', Math.round(process.uptime())),
    '# HELP app_memory_bytes Process memory usage in bytes.',
    '# TYPE app_memory_bytes gauge',
    line('app_memory_bytes', memory.rss, { type: 'rss' }),
    line('app_memory_bytes', memory.heapUsed, { type: 'heap_used' }),
    line('app_memory_bytes', memory.heapTotal, { type: 'heap_total' }),
    '# HELP app_dependency_up Dependency health, 1 means healthy.',
    '# TYPE app_dependency_up gauge',
    ...Object.entries(health.dependencies).map(([dependency, status]) =>
      line('app_dependency_up', status.status === 'ok' ? 1 : 0, { dependency })
    ),
    '# HELP app_dependency_latency_ms Dependency health check latency in milliseconds.',
    '# TYPE app_dependency_latency_ms gauge',
    ...Object.entries(health.dependencies).map(([dependency, status]) =>
      line('app_dependency_latency_ms', status.latencyMs, { dependency })
    ),
  ];

  return `${lines.join('\n')}\n`;
}
