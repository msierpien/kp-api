-- Speed up the warehouse documents list after adding source/search/filter metadata.
CREATE INDEX "warehouse_documents_tenant_type_status_date_created_at_idx"
ON "warehouse_documents"("tenant_id", "type", "status", "date", "created_at");

CREATE INDEX "warehouse_documents_tenant_order_id_idx"
ON "warehouse_documents"("tenant_id", "order_id");

CREATE INDEX "warehouse_documents_tenant_is_auto_generated_idx"
ON "warehouse_documents"("tenant_id", "is_auto_generated");

CREATE INDEX "warehouse_documents_tenant_stock_warning_idx"
ON "warehouse_documents"("tenant_id", ((metadata_json ->> 'stockWarning')));
