UPDATE "shop_order_statuses"
SET "operational_status" = CASE
  WHEN LOWER("name") LIKE '%częściowy zwrot%'
    OR LOWER("name") LIKE '%czesciowy zwrot%'
    OR LOWER("name") LIKE '%partial refund%'
    OR "external_status_id" = '15'
    THEN 'PARTIALLY_RETURNED'
  WHEN LOWER("name") LIKE '%zwrócon%'
    OR LOWER("name") LIKE '%zwrocon%'
    OR LOWER("name") LIKE '%refund%'
    OR "external_status_id" = '7'
    THEN 'RETURNED'
  WHEN LOWER("name") LIKE '%anulowan%'
    OR LOWER("name") LIKE '%cancel%'
    OR "external_status_id" = '6'
    THEN 'CANCELLED'
  WHEN LOWER("name") LIKE '%dostarczone%'
    OR LOWER("name") LIKE '%delivered%'
    OR "external_status_id" = '5'
    THEN 'DELIVERED'
  WHEN LOWER("name") LIKE '%dostarczane%'
    OR LOWER("name") LIKE '%wysłan%'
    OR LOWER("name") LIKE '%wyslan%'
    OR LOWER("name") LIKE '%shipped%'
    OR "external_status_id" = '4'
    THEN 'SHIPPED'
  WHEN LOWER("name") LIKE '%przygotowanie%'
    OR LOWER("name") LIKE '%realizacji%'
    OR LOWER("name") LIKE '%processing%'
    OR "external_status_id" = '3'
    THEN 'PROCESSING'
  WHEN LOWER("name") LIKE '%zaakceptowan%'
    OR LOWER("name") LIKE '%przyjęta%'
    OR LOWER("name") LIKE '%przyjeta%'
    OR LOWER("name") LIKE '%opłacone%'
    OR LOWER("name") LIKE '%oplacone%'
    OR LOWER("name") LIKE '%paid%'
    OR "external_status_id" IN ('2', '9', '11')
    OR "is_paid" = TRUE
    THEN 'PAID'
  ELSE 'NEW'
END
WHERE "operational_status" IS NULL;

UPDATE "orders" AS "o"
SET
  "operational_status" = "s"."operational_status",
  "external_status_name" = COALESCE("o"."external_status_name", "s"."name"),
  "status_synced_at" = COALESCE("o"."status_synced_at", NOW())
FROM "shop_order_statuses" AS "s"
WHERE "o"."shop_id" = "s"."shop_id"
  AND "o"."external_status_id" = "s"."external_status_id"
  AND "s"."operational_status" IS NOT NULL
  AND (
    "o"."operational_status" IS NULL
    OR "o"."operational_status" = 'NEW'
    OR "o"."operational_status" <> "s"."operational_status"
  );
