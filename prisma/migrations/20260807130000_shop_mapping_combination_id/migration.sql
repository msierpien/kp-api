-- Mapowania per kombinacja PrestaShop: '0' = produkt-rodzic
ALTER TABLE "shop_product_mappings"
  ADD COLUMN "external_combination_id" TEXT NOT NULL DEFAULT '0';

DROP INDEX "shop_product_mappings_shop_id_external_product_id_key";

CREATE UNIQUE INDEX "shop_product_mappings_shop_id_external_product_id_external__key"
  ON "shop_product_mappings"("shop_id", "external_product_id", "external_combination_id");
