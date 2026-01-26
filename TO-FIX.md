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

### 1. Case Management - szczegóły i edycja
- [ ] Endpoint `GET /admin/cases/:id` - szczegóły przypadku
- [ ] Endpoint `PUT /admin/cases/:id/answers` - korekta odpowiedzi
- [ ] Endpoint `PUT /admin/cases/:id/status` - zarządzanie workflow
- [ ] Endpoint `POST /admin/cases/:id/notes` - notatki wewnętrzne

### 2. Templates Management - pełny CRUD
- [ ] Endpoint `POST /admin/templates` - tworzenie nowego szablonu
- [ ] Endpoint `PUT /admin/templates/:id` - edycja metadanych
- [ ] Endpoint `DELETE /admin/templates/:id` - usuwanie szablonu
- [ ] Endpoint `POST /admin/templates/:id/duplicate` - duplikacja

## 🚧 DO ZROBIENIA - Priorytet 2 (Frontend Admin)

### 3. Szczegóły przypadku personalizacji
- [ ] Strona `/dashboard/cases/[id]/page.tsx`
- [ ] Wyświetlanie odpowiedzi klienta
- [ ] Formularz edycji odpowiedzi
- [ ] Workflow statusów z przyciskami akcji
- [ ] Historia zmian i notatki

### 4. Zarządzanie integracjami - wiele sklepów
- [ ] Lista wszystkich sklepów w tabeli
- [ ] Modal dodawania nowego sklepu
- [ ] Edycja i usuwanie sklepów

### 5. Zarządzanie szablonami - pełny CRUD
- [ ] Przycisk "Dodaj szablon"
- [ ] Modal tworzenia szablonu
- [ ] Edycja metadanych szablonu
- [ ] Duplikacja i usuwanie

## 🚧 DO ZROBIENIA - Priorytet 3

### 6. Automatyzacja
- [ ] Cron Job / Worker synchronizacji (node-cron lub BullMQ)
- [ ] Konfiguracja interwału per sklep

### 7. Wysyłka e-maili
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
