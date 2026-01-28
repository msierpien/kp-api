/*
  Warnings:

  - You are about to drop the column `sku` on the `personalized_products` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[shop_id,identifier_type,identifier_value]` on the table `personalized_products` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `identifier_value` to the `personalized_products` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `personalized_products` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "IdentifierType" AS ENUM ('SKU', 'INDEX', 'EAN');

-- DropIndex
DROP INDEX "personalized_products_shop_id_sku_key";

-- DropIndex
DROP INDEX "personalized_products_sku_idx";

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "hash" TEXT,
ADD COLUMN     "pages" INTEGER,
ADD COLUMN     "public_url" TEXT;

-- AlterTable
ALTER TABLE "personalization_cases" ADD COLUMN     "answers_json" JSONB,
ADD COLUMN     "validation_summary" JSONB;

-- AlterTable
ALTER TABLE "personalized_products" DROP COLUMN "sku",
ADD COLUMN     "external_product_id" TEXT,
ADD COLUMN     "identifier_type" "IdentifierType" NOT NULL DEFAULT 'SKU',
ADD COLUMN     "identifier_value" TEXT NOT NULL,
ADD COLUMN     "name" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sync_interval" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "automations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automations_trigger_idx" ON "automations"("trigger");

-- CreateIndex
CREATE INDEX "automations_is_active_idx" ON "automations"("is_active");

-- CreateIndex
CREATE INDEX "automations_priority_idx" ON "automations"("priority");

-- CreateIndex
CREATE INDEX "assets_type_idx" ON "assets"("type");

-- CreateIndex
CREATE INDEX "personalized_products_identifier_value_idx" ON "personalized_products"("identifier_value");

-- CreateIndex
CREATE UNIQUE INDEX "personalized_products_shop_id_identifier_type_identifier_va_key" ON "personalized_products"("shop_id", "identifier_type", "identifier_value");

-- CreateIndex
CREATE INDEX "shops_sync_enabled_idx" ON "shops"("sync_enabled");
