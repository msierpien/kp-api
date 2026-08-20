# Statusy InPost, powiadomienia i szablony wiadomości

Skąd biorą się statusy przesyłek, co je odświeża i jak podpiąć pod nie maile
do klienta.

## Skąd pochodzą statusy

Statusy żyją w tabeli `inpost_shipment` **po stronie PrestaShop** — pisze do
niej oficjalny moduł InPost. Nasz connector `kp_adminconnector` je czyta:

- `inpostshipmentstatus` — jedno zamówienie, tylko odczyt tabeli sklepu,
- `inpostshipmentrefresh` — jedno zamówienie, wymusza odpytanie ShipX,
- `inpostshipmentsbatch` — **paczka do 25 zamówień**, z opcjonalnym
  odświeżeniem z ShipX jednym wywołaniem handlera (`refresh: true`).

Ostatni endpoint powstał dla panelu: statusy trzeba odpytywać cyklicznie dla
wszystkich paczek w drodze, a pytanie o każdą osobno oznaczałoby tyle rundek
HTTP, ile przesyłek.

## Co się dzieje po naszej stronie

1. `syncShipmentsForShop` ([order-shipments.service.ts](../src/services/admin/order-shipments.service.ts))
   wybiera zamówienia z nie-finałową przesyłką oraz świeże zamówienia bez
   zapisanej przesyłki (21 dni wstecz, bez `NEW` i `CANCELLED`).
2. Dzieli je na paczki po 25 i pyta connector.
3. Zapisuje wynik w tabeli `order_shipments`; surowy status przewoźnika ląduje
   w `status`, a wyliczony z niego etap w `stage`
   ([inpost-statuses.ts](../src/lib/inpost-statuses.ts)).
4. Każda **realna zmiana statusu** uruchamia automatyzacje wyzwalacza
   `ORDER_SHIPMENT_STATUS_CHANGED`.

Scheduler robi to co 20 minut (`scheduleShipmentStatusSync`). Ręcznie:

```bash
curl -X POST https://api.example/admin/orders/shipments/sync \
  -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"shopId":"<id>"}'
```

### Etapy doręczenia

`CREATED` · `IN_TRANSIT` · `OUT_FOR_DELIVERY` (kurier dziś) · `READY_TO_PICKUP`
(czeka w paczkomacie) · `PICKUP_REMINDER` · `DELIVERED` · `PROBLEM` ·
`RETURNED` · `CANCELLED` · `UNKNOWN`.

Warunki reguł pisz na **etapie** (`shipment.stage`), nie na surowej nazwie:
ShipX ma kilkadziesiąt statusów i dokłada nowe. Nieznany status wpada do
`IN_TRANSIT`, więc przesyłka nadal jest odpytywana — nigdy nie zamyka się jako
finałowa przez pomyłkę.

Etapy `DELIVERED`, `RETURNED` i `CANCELLED` są finałowe: synchronizacja
przestaje o takie przesyłki pytać.

## Powiadomienia dla klienta

Akcja `SEND_ORDER_EMAIL` wysyła maila w kontekście zamówienia (nadawcą jest
konfiguracja SMTP sklepu, tak samo jak przy pozostałych mailach). Zmienne:
`{{customerName}}`, `{{orderReference}}`, `{{shopName}}`, `{{trackingNumber}}`,
`{{trackingUrl}}`, `{{carrierService}}`, `{{pickupPoint}}`, `{{shipmentStage}}`.

**InPost sam wysyła powiadomienia SMS-em i mailem.** Nasze wiadomości je
dublują — dlatego gotowe scenariusze przesyłkowe powstają **wyłączone**.
Włącz je świadomie, po przeczytaniu treści.

### Dlaczego klient nie dostanie dwóch takich samych maili

Każde uruchomienie reguły zapisuje się w `automation_runs`. Dla wyzwalacza
przesyłki wpis dostaje klucz `shipment:<id>:<status>` z indeksem unikalnym —
wpis powstaje **przed** wykonaniem akcji, więc powtórzony przebieg
synchronizacji trafia na kolizję i pomija regułę. Status wracający tam
i z powrotem też nie wygeneruje drugiej wiadomości.

Wpisy z kluczem żyją dłużej niż zwykłe (retencja w
[job-retention.service.ts](../src/services/maintenance/job-retention.service.ts)):
skasowany klucz pozwoliłby wysłać maila po raz drugi.

## Szablony wiadomości

`/email-templates` w panelu. Szablon ma klucz, zakres (`ORDER` albo `CASE`),
opcjonalny sklep i treść ze zmiennymi. Akcje `SEND_EMAIL` i `SEND_ORDER_EMAIL`
mogą wskazać `templateId` — wtedy treść z biblioteki **wygrywa** nad wklejoną
w regule. Reguły bez `templateId` działają dokładnie jak wcześniej.

## Wdrożenie — kolejność ma znaczenie

1. **Najpierw moduł sklepu.** Wgraj `kp_adminconnector` w wersji ≥ 0.6.0 na
   PrestaShop. Bez niego `inpostshipmentsbatch` zwraca 404 i synchronizacja
   nie ma czego czytać.
2. **Potem kp-api** — `prisma migrate deploy` przed restartem (migracje
   `order_shipments`, `automation_runs`, `email_templates`).
3. Panel idzie zwykłym pushem na Vercel.

Sprawdzenie po wdrożeniu: ręczny `POST /admin/orders/shipments/sync` dla
jednego sklepu i porównanie kolumny „Przesyłka" na `/orders` z panelem InPost
dla dwóch–trzech realnych paczek.
