-- AlterEnum
ALTER TYPE "WarehouseDocumentType" ADD VALUE 'INW';

-- AlterTable
ALTER TABLE "warehouse_document_items"
ADD COLUMN "system_quantity" DECIMAL(10, 3);

-- CreateIndex: jedna pozycja per produkt w obrębie dokumentu INW
-- Egzekwowane częściowym unikalnym indeksem, żeby nie kolidować z istniejącymi PZ/PW/WZ/RW
CREATE UNIQUE INDEX "warehouse_document_items_inw_product_uidx"
ON "warehouse_document_items"("document_id", "product_id")
WHERE "system_quantity" IS NOT NULL;
