-- Sprawdź produkty personalizowane i ich identyfikatory
SELECT 
  pp.id,
  pp.name,
  pp.identifier_type,
  pp.identifier_value,
  pp.is_active,
  s.name as shop_name,
  t.name as template_name,
  t.code as template_code
FROM personalized_products pp
JOIN shops s ON pp.shop_id = s.id
JOIN templates t ON pp.template_id = t.id
ORDER BY pp.created_at DESC;

-- Sprawdź ostatnie synchronizacje
SELECT 
  sl.id,
  s.name as shop_name,
  sl.sync_type,
  sl.status,
  sl.orders_fetched,
  sl.orders_created,
  sl.orders_skipped,
  sl.cases_created,
  sl.error_message,
  sl.started_at,
  sl.finished_at
FROM sync_logs sl
JOIN shops s ON sl.shop_id = s.id
ORDER BY sl.started_at DESC
LIMIT 10;
