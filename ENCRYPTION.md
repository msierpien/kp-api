# 🔐 Szyfrowanie kluczy API

## Implementacja

Klucze API (`apiKey`, `apiSecret`) są **automatycznie szyfrowane** przed zapisem do bazy danych i **deszyfrowane** przy odczycie.

### Algorytm
- **AES-256-CBC** - standard szyfrowania symetrycznego
- Każdy klucz ma unikalny IV (Initialization Vector)
- Format w bazie: `IV:encryptedText` (hex)

## Konfiguracja

### 1. Ustaw klucz szyfrowania w `.env`

```bash
# MUSI mieć dokładnie 32 znaki!
ENCRYPTION_KEY=your-super-secret-32-byte-key!
```

⚠️ **KRYTYCZNE**: 
- Użyj silnego, losowego klucza w produkcji
- **NIGDY nie commituj** `.env` do repozytorium
- Jeśli zmienisz klucz, stare dane będą nieodczytywalne

### 2. Wygeneruj bezpieczny klucz

```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

# OpenSSL
openssl rand -hex 16

# Python
python3 -c "import secrets; print(secrets.token_hex(16))"
```

## Migracja istniejących danych

Jeśli masz niezaszyfrowane klucze w bazie (przed implementacją):

```bash
cd api
npx ts-node src/scripts/encrypt-existing-keys.ts
```

Skrypt:
- Sprawdza czy klucze są już zaszyfrowane (format `IV:encrypted`)
- Szyfruje tylko niezaszyfrowane klucze
- Pomija już zaszyfrowane dane
- Loguje postęp dla każdego sklepu

## Działanie

### Zapis (Create/Update Shop)
```typescript
// Frontend wysyła plain text
{ apiKey: "ABC123XYZ", apiSecret: "secret456" }

// Backend szyfruje przed zapisem do DB
shops.service.ts → encrypt() → DB zapisuje: "a1b2c3d4:e5f6g7h8..."
```

### Odczyt (Get Shop)
```typescript
// DB zwraca zaszyfrowane
{ apiKey: "a1b2c3d4:e5f6g7h8..." }

// Backend deszyfruje przed zwróceniem
shops.service.ts → decrypt() → Frontend otrzymuje: "ABC123XYZ"
```

### Użycie w PrestaShop Client
```typescript
// PrestaShopClient otrzymuje już odszyfrowany klucz
const client = new PrestaShopClient({
  baseUrl: shop.baseUrl,
  apiKey: shop.apiKey  // już odszyfrowany przez mapShop()
});
```

## Backup & Recovery

### Backup klucza szyfrowania
```bash
# Zapisz klucz w bezpiecznym miejscu (np. password manager)
echo $ENCRYPTION_KEY > encryption_key.backup

# Przechowuj poza repozytorium!
chmod 600 encryption_key.backup
```

### Recovery po utracie klucza
⚠️ **Jeśli stracisz klucz szyfrowania**:
- Zaszyfrowane dane będą nieodczytywalne
- Musisz ręcznie wprowadzić klucze API ponownie
- Usuń i utwórz na nowo integracje

### Backup bazy danych
```bash
# Export z zaszyfrowanymi kluczami
docker exec -t postgres pg_dump -U postgres personalization > backup.sql

# Import (wymaga tego samego ENCRYPTION_KEY!)
docker exec -i postgres psql -U postgres personalization < backup.sql
```

## Bezpieczeństwo

### ✅ Dobre praktyki
- Używaj różnych kluczy dla dev/staging/production
- Rotuj klucz co 6-12 miesięcy
- Przechowuj backupy klucza w vault (np. AWS Secrets Manager, HashiCorp Vault)
- Loguj próby dostępu do kluczy (audit trail)

### ❌ Czego unikać
- Nie hardcoduj klucza w kodzie
- Nie commituj `.env` do repo
- Nie udostępniaj klucza przez Slack/email
- Nie używaj słabych kluczy (`password123`)

## Testowanie

```bash
# Test szyfrowania/deszyfrowania
node -e "
const { encrypt, decrypt } = require('./dist/lib/encryption');
const text = 'test-api-key';
const encrypted = encrypt(text);
const decrypted = decrypt(encrypted);
console.log('Original:', text);
console.log('Encrypted:', encrypted);
console.log('Decrypted:', decrypted);
console.log('Match:', text === decrypted);
"
```

## Troubleshooting

### "Decryption failed" w logach
- Sprawdź czy `ENCRYPTION_KEY` jest ustawiony
- Sprawdź czy klucz ma 32 znaki
- Sprawdź czy używasz tego samego klucza co przy szyfrowaniu

### Stare dane nie działają
```bash
# Uruchom ponownie skrypt migracji
npx ts-node src/scripts/encrypt-existing-keys.ts
```

### Reset wszystkich kluczy (development only!)
```sql
-- ⚠️ UWAGA: Usuwa wszystkie zaszyfrowane klucze!
UPDATE shops SET api_key = '', api_secret = NULL;
```
