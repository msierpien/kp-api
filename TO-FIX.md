## Zamówienia
- ~~bład http://localhost:3000/dashboard/orders - TypeError: order.totalPaid.toFixed~~ ✅ NAPRAWIONE

## Błędy budowania Next.js
- ~~isLoading vs isPending (React Query v5)~~ ✅ NAPRAWIONE
- ~~useSearchParams() wymaga Suspense boundary~~ ✅ NAPRAWIONE

## Personalizacje - ✅ UKOŃCZONE (funkcje podstawowe)

### ✅ Zakładka Personalizacja → Produkty
- [x] Strona `/dashboard/personalization/products`
- [x] Lista produktów personalizowanych (sklep + identyfikator + template)
- [x] Formularz dodawania/edycji produktu z wszystkimi polami
- [x] Checkbox isActive (aktywny/nieaktywny)
- [x] Obsługa błędów API i walidacji
- [x] Loading states i komunikaty sukcesu/błędu
- [x] Endpoint API: `GET/POST/PUT/DELETE /admin/personalized-products`

### ✅ Zakładka Personalizacja → Szablony (edycja)
- [x] Strona `/dashboard/personalization/templates`
- [x] Lista szablonów (template_id) z bazy
- [x] **Graficzny konfigurator pół formularza** (bez ręcznej edycji JSON)
- [x] Dodawanie/edycja/usuwanie formularzy
- [x] Dodawanie/edycja/usuwanie pól w formularzach
- [x] Typy pól: text, textarea, number, email, date, select, radio, checkbox, file
- [x] Konfiguracja: key, label, type, required, placeholder, options
- [x] Podgląd JSON (opcjonalny)
- [x] Endpoint API: `GET/PUT /admin/templates/:id/form`

### ✅ Zakładka Personalizacja → Ustawienia
- [x] Strona `/dashboard/personalization/settings`
- [x] Konfiguracja powiadomień email (mockup)
- [x] Ustawienia plików i multimediów (mockup)
- [x] Konfiguracja formularzy publicznych (mockup)
- [x] Sekcja zaawansowana (funkcje przyszłe)

### ✅ Poprawki techniczne
- [x] Rozwijane menu w sidebarze dla sekcji Personalizacja
- [x] Zmiana `onSuccess` na `onSettled` w React Query hooks (v5)
- [x] Migracja ze starej lokalizacji `/dashboard/settings/*` na `/dashboard/personalization/*`

## 🚧 DO ZROBIENIA - Priorytet 1 (Backend API)

### 1. Case Management - szczegóły i edycja ✅ UKOŃCZONE
- [x] Endpoint `GET /admin/cases/:id` - szczegóły przypadku
- [x] Endpoint `PUT /admin/cases/:id/answers` - korekta odpowiedzi
- [x] Endpoint `PUT /admin/cases/:id/status` - zarządzanie workflow
- [x] Endpoint `POST /admin/cases/:id/notes` - notatki wewnętrzne
- [x] Frontend - strona `/dashboard/cases/[id]` z zakładkami (Info, Odpowiedzi, Notatki)
- [x] Frontend - workflow statusów z przyciskami (NEW → WAITING → SUBMITTED → READY → ARCHIVED)
- [x] Frontend - dodawanie notatek wewnętrznych
- [x] Linki w tabeli cases prowadzące do szczegółów
- [x] React Query hooks: useCaseDetails, useUpdateCaseStatus, useAddCaseNote

### 2. Templates Management - pełny CRUD ✅ UKOŃCZONE
- [x] Endpoint `POST /admin/templates` - tworzenie nowego szablonu
- [x] Endpoint `PUT /admin/templates/:id` - edycja metadanych
- [x] Endpoint `DELETE /admin/templates/:id` - usuwanie szablonu
- [x] Frontend: modal tworzenia, edycji, usuwania szablonów

### 3. Manual Orders - ręczne zamówienia ✅ UKOŃCZONE
- [x] Rozszerzenie `ShopPlatform` o MANUAL i CUSTOM_API
- [x] Endpoint `POST /admin/orders/manual` - tworzenie ręcznego zamówienia
- [x] Walidacja: tylko dla sklepów typu MANUAL
- [x] Automatyczne tworzenie cases dla personalizowanych produktów

## 🚧 DO ZROBIENIA - Priorytet 2 (Frontend Admin)

### 3. Szczegóły przypadku personalizacji
- [ ] Strona `/dashboard/cases/[id]/page.tsx`
- [ ] Wyświetlanie odpowiedzi klienta
- [ ] Formularz edycji odpowiedzi
- [ ] Workflow statusów z przyciskami akcji
- [ ] Historia zmian i notatki

### 4. Zarządzanie integracjami - wiele sklepów ✅ UKOŃCZONE
- [x] Lista wszystkich sklepów w tabeli
- [x] Modal dodawania nowego sklepu (wszystkie platformy)
- [x] Edycja i usuwanie sklepów
- [x] Elastyczna konfiguracja per platforma (JSON)
- [x] Badge platform i statusów
- [x] Akcje: Test/Sync dla API sklepów
- [x] Akcja: Dodaj zamówienie dla sklepów MANUAL

### 5. Zarządzanie szablonami - pełny CRUD ✅ UKOŃCZONE
- [x] Przycisk "Dodaj szablon"
- [x] Modal tworzenia szablonu
- [x] Edycja metadanych szablonu
- [x] Usuwanie szablonów

### 6. Filtrowanie zamówień wg produktów personalizowanych ✅ ZAIMPLEMENTOWANE
**Jak działa:**
- Synchronizacja pobiera zamówienia ze sklepu (ostatnie 7 dni lub od lastSyncAt)
- **Filtruje tylko zamówienia zawierające produkty personalizowane** (match po SKU/INDEX/EAN)
- Tworzy Order + OrderItem + PersonalizationCase tylko dla pasujących produktów
- Pozostałe zamówienia są skipowane (ordersSkipped counter)

**Lokalizacja kodu:** `sync-orders.service.ts` linie 120-128
```typescript
const personalizedItems = details.items.filter((item) => {
  const ref = (item.product_reference || '').toLowerCase();
  return productMap.SKU.has(ref);
});

if (personalizedItems.length === 0) {
  result.ordersSkipped++;
  continue; // Skipuje zamówienie bez personalizowanych produktów
}
```

**Możliwe optymalizacje (przyszłość):**
- [ ] Cache listy SKU produktów personalizowanych w Redis
- [ ] Webhook od PrestaShop zamiast pollingu (instant sync)
- [ ] Bulk processing zamówień (currently 3 for testing, max 100)

## 🚧 DO ZROBIENIA - Priorytet 3

### 7. Automatyzacja
- [ ] Cron Job / Worker synchronizacji (node-cron lub BullMQ)
- [ ] Konfiguracja interwału per sklep

### 8. Wysyłka e-maili
- [ ] Service email (Nodemailer/Sendgrid)
- [ ] Template HTML
- [ ] Wysyłka po utworzeniu case
- [ ] Ponowne wysyłanie linku

## Następne kroki (przyszłe features)

### Warstwa podglądu graficznego
- [ ] Wizualizacja szablonów w edytorze
- [ ] Preview danych klienta na szablonie
- [ ] Eksport do PDF/PNG z podglądem

### Zaawansowane funkcje
- [ ] Paginacja i filtrowanie listy produktów
- [ ] Walidacja unique constraint przed wysłaniem formularza
- [ ] Automatyczne przypomnienia email
- [ ] Integracja z drukarką
