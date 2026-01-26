/*
  Warnings:

  - You are about to drop the column `prestashop_order_detail_id` on the `order_items` table. All the data in the column will be lost.
  - You are about to drop the column `product_attribute_id` on the `order_items` table. All the data in the column will be lost.
  - You are about to drop the column `product_id` on the `order_items` table. All the data in the column will be lost.
  - You are about to drop the column `template_id` on the `order_items` table. All the data in the column will be lost.
  - You are about to drop the column `prestashop_order_id` on the `orders` table. All the data in the column will be lost.
  - You are about to drop the column `webhook_secret` on the `shops` table. All the data in the column will be lost.
  - You are about to drop the `webhook_events` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[shop_id,external_order_id]` on the table `orders` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `external_item_id` to the `order_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sku` to the `order_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `external_order_id` to the `orders` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ShopPlatform" AS ENUM ('PRESTASHOP', 'WOOCOMMERCE', 'SHOPIFY', 'MAGENTO', 'OTHER');

-- DropForeignKey
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_template_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_shop_id_fkey";

-- DropIndex
DROP INDEX "order_items_product_id_product_attribute_id_idx";

-- DropIndex
DROP INDEX "order_items_template_id_idx";

-- DropIndex
DROP INDEX "orders_shop_id_prestashop_order_id_key";

-- AlterTable
ALTER TABLE "order_items" DROP COLUMN "prestashop_order_detail_id",
DROP COLUMN "product_attribute_id",
DROP COLUMN "product_id",
DROP COLUMN "template_id",
ADD COLUMN     "external_item_id" TEXT NOT NULL,
ADD COLUMN     "personalized_product_id" TEXT,
ADD COLUMN     "sku" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "prestashop_order_id",
ADD COLUMN     "external_order_id" TEXT NOT NULL,
ADD COLUMN     "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "shops" DROP COLUMN "webhook_secret",
ADD COLUMN     "api_key" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "api_secret" TEXT,
ADD COLUMN     "config_json" JSONB,
ADD COLUMN     "last_sync_at" TIMESTAMP(3),
ADD COLUMN     "platform" "ShopPlatform" NOT NULL DEFAULT 'PRESTASHOP',
ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- DropTable
DROP TABLE "webhook_events";

-- CreateTable
CREATE TABLE "personalized_products" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personalized_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "sync_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "orders_fetched" INTEGER NOT NULL DEFAULT 0,
    "orders_created" INTEGER NOT NULL DEFAULT 0,
    "orders_skipped" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "personalized_products_shop_id_idx" ON "personalized_products"("shop_id");

-- CreateIndex
CREATE INDEX "personalized_products_sku_idx" ON "personalized_products"("sku");

-- CreateIndex
CREATE INDEX "personalized_products_is_active_idx" ON "personalized_products"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "personalized_products_shop_id_sku_key" ON "personalized_products"("shop_id", "sku");

-- CreateIndex
CREATE INDEX "sync_logs_shop_id_idx" ON "sync_logs"("shop_id");

-- CreateIndex
CREATE INDEX "sync_logs_started_at_idx" ON "sync_logs"("started_at");

-- CreateIndex
CREATE INDEX "sync_logs_status_idx" ON "sync_logs"("status");

-- CreateIndex
CREATE INDEX "order_items_sku_idx" ON "order_items"("sku");

-- CreateIndex
CREATE INDEX "order_items_personalized_product_id_idx" ON "order_items"("personalized_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shop_id_external_order_id_key" ON "orders"("shop_id", "external_order_id");

-- CreateIndex
CREATE INDEX "shops_status_idx" ON "shops"("status");

-- CreateIndex
CREATE INDEX "shops_platform_idx" ON "shops"("platform");

-- AddForeignKey
ALTER TABLE "personalized_products" ADD CONSTRAINT "personalized_products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personalized_products" ADD CONSTRAINT "personalized_products_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "personalization_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_personalized_product_id_fkey" FOREIGN KEY ("personalized_product_id") REFERENCES "personalized_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
