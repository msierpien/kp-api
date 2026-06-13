DO $$
DECLARE
  target_tenant_id text;
  tenant_count integer;
BEGIN
  SELECT id INTO target_tenant_id
  FROM tenants
  WHERE slug = 'kreatywne-papierki'
  ORDER BY created_at ASC
  LIMIT 1;

  IF target_tenant_id IS NULL THEN
    SELECT COUNT(*) INTO tenant_count FROM tenants;
    IF tenant_count = 1 THEN
      SELECT id INTO target_tenant_id FROM tenants ORDER BY created_at ASC LIMIT 1;
    ELSIF EXISTS (SELECT 1 FROM automations) THEN
      RAISE EXCEPTION 'Cannot backfill automations. Tenant kreatywne-papierki not found and tenant count is %.', tenant_count;
    END IF;
  END IF;

  ALTER TABLE automations ADD COLUMN IF NOT EXISTS tenant_id text;

  IF target_tenant_id IS NOT NULL THEN
    UPDATE automations
    SET tenant_id = target_tenant_id
    WHERE tenant_id IS NULL;
  END IF;
END $$;

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS run_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_run_at timestamp(3),
  ADD COLUMN IF NOT EXISTS last_error_at timestamp(3),
  ADD COLUMN IF NOT EXISTS last_error_message text;

ALTER TABLE automations
  ALTER COLUMN tenant_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'automations_tenant_id_fkey'
  ) THEN
    ALTER TABLE automations
      ADD CONSTRAINT automations_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS automations_tenant_id_idx ON automations(tenant_id);
CREATE INDEX IF NOT EXISTS automations_tenant_id_trigger_idx ON automations(tenant_id, trigger);
CREATE INDEX IF NOT EXISTS automations_tenant_id_is_active_idx ON automations(tenant_id, is_active);
