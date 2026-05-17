CREATE TABLE "shop_webhook_events" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "prestashop_shop_id" TEXT,
    "order_status_id" TEXT NOT NULL,
    "order_status_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload_hash" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_webhook_events_event_key_key" ON "shop_webhook_events"("event_key");
CREATE INDEX "shop_webhook_events_shop_id_received_at_idx" ON "shop_webhook_events"("shop_id", "received_at");
CREATE INDEX "shop_webhook_events_shop_id_status_idx" ON "shop_webhook_events"("shop_id", "status");
CREATE INDEX "shop_webhook_events_event_type_idx" ON "shop_webhook_events"("event_type");
CREATE INDEX "shop_webhook_events_external_order_id_idx" ON "shop_webhook_events"("external_order_id");

ALTER TABLE "shop_webhook_events" ADD CONSTRAINT "shop_webhook_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
