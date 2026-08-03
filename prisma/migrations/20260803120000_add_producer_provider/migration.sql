-- Dodaje typ providera PRODUCER (producent wewnętrzny, zarządzany w panelu, bez feedu)
ALTER TYPE "WholesalePlatform" ADD VALUE IF NOT EXISTS 'PRODUCER';

-- feed_url opcjonalne (producent nie ma feedu)
ALTER TABLE "wholesale_providers" ALTER COLUMN "feed_url" DROP NOT NULL;
