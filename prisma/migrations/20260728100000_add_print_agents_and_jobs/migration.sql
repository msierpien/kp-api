-- Druk fizyczny: agent lokalny przy drukarce + kolejka zlecen druku.
-- Serwer nie dosiega drukarki w sieci klienta, wiec to agent odpytuje API,
-- a tabela print_jobs pelni role kolejki (bez BullMQ - zadanie musi dac sie
-- "wydac" procesowi spoza serwera).

-- CreateTable
CREATE TABLE "print_agents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "token_hash" TEXT NOT NULL,
    "token_encrypted" TEXT,
    "token_prefix" TEXT NOT NULL,
    "token_rotated_at" TIMESTAMP(3),
    "profiles_json" JSONB,
    "printers_online" JSONB,
    "agent_version" TEXT,
    "hostname" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "last_ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "print_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "case_id" TEXT,
    "agent_id" TEXT,
    "profile" TEXT NOT NULL,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "claim_token" TEXT,
    "claimed_at" TIMESTAMP(3),
    "claim_expires_at" TIMESTAMP(3),
    "cups_job_id" TEXT,
    "error" TEXT,
    "metadata" JSONB,
    "requested_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "print_agents_token_hash_key" ON "print_agents"("token_hash");

-- CreateIndex
CREATE INDEX "print_agents_tenant_id_idx" ON "print_agents"("tenant_id");

-- CreateIndex
CREATE INDEX "print_agents_last_seen_at_idx" ON "print_agents"("last_seen_at");

-- CreateIndex
CREATE INDEX "print_jobs_tenant_id_status_idx" ON "print_jobs"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "print_jobs_agent_id_status_idx" ON "print_jobs"("agent_id", "status");

-- CreateIndex
CREATE INDEX "print_jobs_case_id_idx" ON "print_jobs"("case_id");

-- CreateIndex
CREATE INDEX "print_jobs_claim_expires_at_idx" ON "print_jobs"("claim_expires_at");

-- CreateIndex
CREATE INDEX "print_jobs_created_at_idx" ON "print_jobs"("created_at");

-- AddForeignKey
ALTER TABLE "print_agents" ADD CONSTRAINT "print_agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "personalization_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "print_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
