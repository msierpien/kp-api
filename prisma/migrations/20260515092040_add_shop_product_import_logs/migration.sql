-- DropForeignKey
ALTER TABLE "warehouse_document_items" DROP CONSTRAINT "warehouse_document_items_product_id_fkey";

-- AddForeignKey
ALTER TABLE "warehouse_document_items" ADD CONSTRAINT "warehouse_document_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "warehouse_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
