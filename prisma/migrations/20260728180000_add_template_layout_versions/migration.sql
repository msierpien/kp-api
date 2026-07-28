-- Historia layoutu szablonu.
--
-- "Cofnij" w edytorze zyje tylko w sesji przegladarki, a layoutSnapshot przy
-- sprawie chroni wydruk, nie projektanta. Ta tabela trzyma stan SPRZED
-- kazdego nadpisania, wiec da sie wrocic do ukladu sprzed kilku dni.

-- CreateTable
CREATE TABLE "template_layout_versions" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "layout_json" JSONB NOT NULL,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_layout_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "template_layout_versions_template_id_created_at_idx" ON "template_layout_versions"("template_id", "created_at");

-- AddForeignKey
ALTER TABLE "template_layout_versions" ADD CONSTRAINT "template_layout_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "personalization_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
