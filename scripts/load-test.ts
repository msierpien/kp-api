import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

type LoadConfig = {
  targetUrl: string;
  path: string;
  method: string;
  requests: number;
  concurrency: number;
  headers: Record<string, string>;
  body?: string | Blob;
  formFile?: Blob;
  formFileName?: string;
  formFileField: string;
  formFields: Record<string, string>;
  failOnError: boolean;
};

type Result = {
  ok: boolean;
  status: number;
  durationMs: number;
  bytes: number;
  error?: string;
};

function readInt(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value !== 'false';
}

function readJsonObject(name: string): Record<string, string> {
  const value = process.env[name];
  if (!value) return {};

  const parsed = JSON.parse(value) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).map(([key, fieldValue]) => [key, String(fieldValue)])
  );
}

function bufferToBlob(buffer: Buffer) {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return new Blob([copy.buffer]);
}

async function readConfig(): Promise<LoadConfig> {
  const bodyFile = process.env.LOAD_BODY_FILE;
  const formFile = process.env.LOAD_FORM_FILE;

  return {
    targetUrl: process.env.LOAD_TARGET_URL || 'http://localhost:3001',
    path: process.env.LOAD_PATH || '/health/live',
    method: process.env.LOAD_METHOD || 'GET',
    requests: readInt('LOAD_REQUESTS', 100),
    concurrency: readInt('LOAD_CONCURRENCY', 10),
    headers: readJsonObject('LOAD_HEADERS'),
    body: bodyFile ? bufferToBlob(await fs.readFile(bodyFile)) : process.env.LOAD_BODY,
    formFile: formFile ? bufferToBlob(await fs.readFile(formFile)) : undefined,
    formFileName: formFile ? path.basename(formFile) : undefined,
    formFileField: process.env.LOAD_FORM_FILE_FIELD || 'file',
    formFields: readJsonObject('LOAD_FORM_FIELDS'),
    failOnError: readBoolean('LOAD_FAIL_ON_ERROR', true),
  };
}

function buildUrl(config: LoadConfig) {
  return new URL(config.path, config.targetUrl).toString();
}

function buildRequestInit(config: LoadConfig): RequestInit {
  const headers = { ...config.headers };

  if (config.formFile) {
    const form = new FormData();

    Object.entries(config.formFields).forEach(([key, value]) => {
      form.append(key, value);
    });

    form.append(
      config.formFileField,
      config.formFile,
      config.formFileName || 'upload.bin'
    );

    return {
      method: config.method,
      headers,
      body: form,
    };
  }

  if (typeof config.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  return {
    method: config.method,
    headers,
    body: config.body,
  };
}

async function executeRequest(config: LoadConfig, url: string): Promise<Result> {
  const startedAt = performance.now();

  try {
    const response = await fetch(url, buildRequestInit(config));
    const payload = await response.arrayBuffer();

    return {
      ok: response.ok,
      status: response.status,
      durationMs: performance.now() - startedAt,
      bytes: payload.byteLength,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: performance.now() - startedAt,
      bytes: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1);
  return values[index];
}

async function run() {
  const config = await readConfig();
  const url = buildUrl(config);
  const results: Result[] = [];
  let nextRequest = 0;

  const startedAt = performance.now();
  const workers = Array.from({ length: config.concurrency }, async () => {
    while (nextRequest < config.requests) {
      nextRequest += 1;
      results.push(await executeRequest(config, url));
    }
  });

  await Promise.all(workers);

  const totalMs = performance.now() - startedAt;
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const ok = results.filter((result) => result.ok).length;
  const failed = results.length - ok;
  const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);
  const statusCounts = results.reduce<Record<string, number>>((counts, result) => {
    const key = String(result.status);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  console.log(JSON.stringify({
    target: url,
    method: config.method,
    requests: config.requests,
    concurrency: config.concurrency,
    ok,
    failed,
    statusCounts,
    rps: Number((results.length / (totalMs / 1000)).toFixed(2)),
    bytes: totalBytes,
    latencyMs: {
      min: Number((durations[0] || 0).toFixed(2)),
      p50: Number(percentile(durations, 50).toFixed(2)),
      p95: Number(percentile(durations, 95).toFixed(2)),
      p99: Number(percentile(durations, 99).toFixed(2)),
      max: Number((durations[durations.length - 1] || 0).toFixed(2)),
    },
    sampleErrors: results
      .filter((result) => result.error)
      .slice(0, 3)
      .map((result) => result.error),
  }, null, 2));

  if (config.failOnError && failed > 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
