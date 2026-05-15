CREATE TABLE "warehouse_catalogs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "warehouse_catalogs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_catalogs_tenant_id_code_key"
ON "warehouse_catalogs"("tenant_id", "code");

CREATE INDEX "warehouse_catalogs_tenant_id_idx"
ON "warehouse_catalogs"("tenant_id");

CREATE INDEX "warehouse_catalogs_tenant_id_is_active_idx"
ON "warehouse_catalogs"("tenant_id", "is_active");

ALTER TABLE "warehouse_catalogs"
ADD CONSTRAINT "warehouse_catalogs_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "warehouse_catalogs" (
  "id",
  "tenant_id",
  "code",
  "name",
  "description",
  "is_default",
  "is_active",
  "created_at",
  "updated_at"
)
SELECT
  CONCAT('warehouse_catalog_default_', "id"),
  "id",
  'default',
  'Katalog główny',
  'Domyślny katalog produktów magazynowych',
  true,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "tenants";

ALTER TABLE "warehouse_products"
ADD COLUMN "catalog_id" TEXT;

UPDATE "warehouse_products" AS "product"
SET "catalog_id" = "catalog"."id"
FROM "warehouse_catalogs" AS "catalog"
WHERE "catalog"."tenant_id" = "product"."tenant_id"
  AND "catalog"."code" = 'default';

ALTER TABLE "warehouse_products"
ALTER COLUMN "catalog_id" SET NOT NULL;

CREATE INDEX "warehouse_products_catalog_id_idx"
ON "warehouse_products"("catalog_id");

ALTER TABLE "warehouse_products"
ADD CONSTRAINT "warehouse_products_catalog_id_fkey"
FOREIGN KEY ("catalog_id") REFERENCES "warehouse_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
