WITH normalized AS (
  SELECT
    "id",
    (
      jsonb_set(
        COALESCE("config_json", '{}'::jsonb),
        '{orderSync}',
        COALESCE("config_json"->'orderSync', '{}'::jsonb)
          || '{"orderStatus":"ALL","currentStateIds":[]}'::jsonb,
        true
      )
      #- '{orderSync,paidStatusIds}'
      #- '{orderSync,currentStates}'
    ) AS "next_config_json"
  FROM "shops"
  WHERE "platform" = 'PRESTASHOP'
    AND COALESCE("config_json"->'orderSync'->>'orderStatus', 'PAID') = 'PAID'
)
UPDATE "shops" AS "s"
SET "config_json" = "n"."next_config_json"
FROM "normalized" AS "n"
WHERE "s"."id" = "n"."id";
