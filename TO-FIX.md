## Zamówienia
- ~~bład http://localhost:3000/dashboard/orders - TypeError: order.totalPaid.toFixed~~ ✅ NAPRAWIONE

## Błędy budowania Next.js
- ~~isLoading vs isPending (React Query v5)~~ ✅ NAPRAWIONE
- ~~useSearchParams() wymaga Suspense boundary~~ ✅ NAPRAWIONE

## Personalizacje - DO ZROBIENIA

### Zakładka Ustawienia → Produkty personalizowane
- [ ] Strona `/dashboard/settings/products`
- [ ] Lista produktów personalizowanych (sklep + identyfikator + template)
- [ ] Formularz dodawania/edycji produktu:
  - Sklep (dropdown z integracji)
  - Nazwa produktu
  - Typ identyfikatora (SKU/INDEX/EAN)
  - Wartość identyfikatora
  - Szablon personalizacji (dropdown)
- [ ] Endpoint API: `GET/POST/PUT/DELETE /admin/personalized-products`

### Zakładka Szablony personalizacji
- [ ] Strona `/dashboard/settings/templates`
- [ ] Lista szablonów (template_id) z bazy
- [ ] Edycja formularza personalizacji (pola, walidacje)
- [ ] Endpoint API: `GET/PUT /admin/templates/:id/form`
