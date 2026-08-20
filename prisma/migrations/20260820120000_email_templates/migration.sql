-- Biblioteka tresci wiadomosci do klienta. Dotad tresc maila mieszkala w polu
-- `body` akcji automatyzacji albo wprost w kodzie serwisu pocztowego: poprawka
-- jednego zdania wymagala wejscia w regule albo deployu, a ta sama tresc bywala
-- powielona w kilku regulach.
CREATE TABLE "email_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    -- Szablon konkretnego sklepu; NULL = wspolny dla tenanta.
    "shop_id" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    -- ORDER | CASE — decyduje, jakie zmienne widac w podgladzie
    "scope" TEXT NOT NULL DEFAULT 'ORDER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- Klucz jest stabilnym adresem szablonu dla regul i kodu.
CREATE UNIQUE INDEX "email_templates_tenant_id_key_key" ON "email_templates" ("tenant_id", "key");
CREATE INDEX "email_templates_tenant_id_scope_idx" ON "email_templates" ("tenant_id", "scope");

ALTER TABLE "email_templates"
    ADD CONSTRAINT "email_templates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "email_templates"
    ADD CONSTRAINT "email_templates_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
