/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id]` on the table `email_settings` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,code]` on the table `personalization_templates` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `tenant_id` to the `email_settings` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenant_id` to the `personalization_templates` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenant_id` to the `shops` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenant_id` to the `users` table without a default value. This is not possible if the table is not empty.

*/

-- ============================================
-- KROK 1: Utworzenie modelu Tenant
-- ============================================

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan" TEXT NOT NULL DEFAULT 'FREE',
    "limits_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
CREATE INDEX "tenants_status_idx" ON "tenants"("status");
CREATE INDEX "tenants_slug_idx" ON "tenants"("slug");

-- ============================================
-- KROK 2: Utworzenie default tenant
-- ============================================

INSERT INTO "tenants" ("id", "name", "slug", "status", "plan", "created_at", "updated_at")
VALUES (
    'default-tenant-id',
    'Default Tenant',
    'default',
    'ACTIVE',
    'FREE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- ============================================
-- KROK 3: Dodanie kolumn tenant_id jako NULLABLE
-- ============================================

-- DropIndex (usunięcie unique constraint przed zmianą)
DROP INDEX "personalization_templates_code_key";

-- AlterTable - dodaj kolumny jako nullable
ALTER TABLE "email_settings" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "personalization_templates" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "shops" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "users" ADD COLUMN "tenant_id" TEXT;

-- ============================================
-- KROK 4: Aktualizacja istniejących danych
-- ============================================

-- Przypisz wszystkie istniejące rekordy do default tenant
UPDATE "email_settings" SET "tenant_id" = 'default-tenant-id' WHERE "tenant_id" IS NULL;
UPDATE "personalization_templates" SET "tenant_id" = 'default-tenant-id' WHERE "tenant_id" IS NULL;
UPDATE "shops" SET "tenant_id" = 'default-tenant-id' WHERE "tenant_id" IS NULL;
UPDATE "users" SET "tenant_id" = 'default-tenant-id' WHERE "tenant_id" IS NULL;

-- ============================================
-- KROK 5: Zmiana kolumn na NOT NULL
-- ============================================

ALTER TABLE "email_settings" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "personalization_templates" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "shops" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;

-- ============================================
-- KROK 6: Dodanie indeksów i constraintów
-- ============================================

-- Unique constraints
CREATE UNIQUE INDEX "email_settings_tenant_id_key" ON "email_settings"("tenant_id");
CREATE UNIQUE INDEX "personalization_templates_tenant_id_code_key" ON "personalization_templates"("tenant_id", "code");

-- Regular indexes
CREATE INDEX "email_settings_tenant_id_idx" ON "email_settings"("tenant_id");
CREATE INDEX "personalization_templates_tenant_id_idx" ON "personalization_templates"("tenant_id");
CREATE INDEX "shops_tenant_id_idx" ON "shops"("tenant_id");
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- ============================================
-- KROK 7: Dodanie Foreign Keys
-- ============================================

ALTER TABLE "shops" ADD CONSTRAINT "shops_tenant_id_fkey" 
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "personalization_templates" ADD CONSTRAINT "personalization_templates_tenant_id_fkey" 
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_tenant_id_fkey" 
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" 
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

