/**
 * Skrypt migracyjny - szyfrowanie istniejących kluczy API w bazie
 * 
 * Uruchom: npx ts-node src/scripts/encrypt-existing-keys.ts
 */

import { PrismaClient } from '@prisma/client';
import { encrypt } from '../lib/encryption';

const prisma = new PrismaClient();

async function main() {
  console.log('🔐 Rozpoczynam szyfrowanie istniejących kluczy API...');

  const shops = await prisma.shop.findMany();
  
  let encrypted = 0;
  let skipped = 0;

  for (const shop of shops) {
    // Sprawdź czy klucz wygląda jak już zaszyfrowany (zawiera ':' separator IV)
    const isAlreadyEncrypted = shop.apiKey.includes(':');
    
    if (isAlreadyEncrypted) {
      console.log(`⏭️  Pomijam ${shop.name} - klucze już zaszyfrowane`);
      skipped++;
      continue;
    }

    // Szyfruj klucze
    const encryptedApiKey = shop.apiKey ? encrypt(shop.apiKey) : '';
    const encryptedApiSecret = shop.apiSecret ? encrypt(shop.apiSecret) : null;

    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        apiKey: encryptedApiKey,
        apiSecret: encryptedApiSecret,
      },
    });

    console.log(`✅ Zaszyfrowano klucze dla: ${shop.name}`);
    encrypted++;
  }

  console.log(`\n✨ Zakończono!`);
  console.log(`   Zaszyfrowano: ${encrypted} sklepów`);
  console.log(`   Pominięto: ${skipped} sklepów (już zaszyfrowane)`);
}

main()
  .catch((error) => {
    console.error('❌ Błąd:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
