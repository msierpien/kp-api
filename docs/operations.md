# Operations runtime

## Runtime roles

The same build can now run in separate process roles:

- `RUNTIME_ROLE=api` starts only the Fastify listener.
- `RUNTIME_ROLE=worker` starts only BullMQ workers.
- `RUNTIME_ROLE=scheduler` starts only scheduled jobs.
- `RUNTIME_ROLE=all` preserves the previous single-process behavior.

Manual overrides are still available:

- `API_ENABLED=false`
- `WORKERS_ENABLED=false`
- `SCHEDULER_ENABLED=false`

## Health and metrics

- `GET /health/live` checks whether the process is alive.
- `GET /health/ready` checks database, Redis and storage readiness.
- `GET /health` is an alias for readiness.
- `GET /metrics` exposes Prometheus-compatible process and dependency metrics.

## Load tests

Use `pnpm load:test` for quick local load checks. Defaults target `GET /health/live`
on `http://localhost:3001`.

Examples:

```bash
LOAD_REQUESTS=500 LOAD_CONCURRENCY=25 pnpm load:test
LOAD_PATH=/webhooks/prestashop/orders LOAD_METHOD=POST LOAD_BODY='{"id_order":123}' pnpm load:test
LOAD_PATH=/personalization/upload LOAD_METHOD=POST LOAD_FORM_FILE=./fixtures/sample.png pnpm load:test
```
