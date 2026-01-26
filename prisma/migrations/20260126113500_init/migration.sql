-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "webhook_secret" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "prestashop_order_id" TEXT NOT NULL,
    "order_reference" TEXT NOT NULL,
    "customer_email" TEXT NOT NULL,
    "customer_name" TEXT,
    "language" TEXT NOT NULL DEFAULT 'pl',
    "currency" TEXT NOT NULL DEFAULT 'PLN',
    "total_paid" DECIMAL(10,2) NOT NULL,
    "created_at_shop" TIMESTAMP(3) NOT NULL,
    "payload_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "prestashop_order_detail_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_attribute_id" TEXT,
    "product_name_snapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "template_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personalization_templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personalization_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_fields" (
    "id" TEXT NOT NULL,
    "form_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "min_length" INTEGER,
    "max_length" INTEGER,
    "pattern" TEXT,
    "placeholder" TEXT,
    "help_text" TEXT,
    "default_value" TEXT,
    "options_json" JSONB,
    "repeater_group_key" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "validation_rules_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personalization_cases" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_version_frozen" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "customer_token_hash" TEXT,
    "token_active" BOOLEAN NOT NULL DEFAULT true,
    "submitted_at" TIMESTAMP(3),
    "notes_internal" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personalization_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personalization_answers" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "value_text" TEXT,
    "value_json" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personalization_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personalization_answer_versions" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "changes_json" JSONB NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personalization_answer_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_access_pins" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_access_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "render_jobs" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "render_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'SELLER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_shop_id_order_reference_idx" ON "orders"("shop_id", "order_reference");

-- CreateIndex
CREATE INDEX "orders_customer_email_idx" ON "orders"("customer_email");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shop_id_prestashop_order_id_key" ON "orders"("shop_id", "prestashop_order_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_product_attribute_id_idx" ON "order_items"("product_id", "product_attribute_id");

-- CreateIndex
CREATE INDEX "order_items_template_id_idx" ON "order_items"("template_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_shop_id_external_id_event_type_payload_hash_key" ON "webhook_events"("shop_id", "external_id", "event_type", "payload_hash");

-- CreateIndex
CREATE UNIQUE INDEX "personalization_templates_code_key" ON "personalization_templates"("code");

-- CreateIndex
CREATE INDEX "personalization_templates_code_idx" ON "personalization_templates"("code");

-- CreateIndex
CREATE INDEX "personalization_templates_is_active_idx" ON "personalization_templates"("is_active");

-- CreateIndex
CREATE INDEX "forms_template_id_idx" ON "forms"("template_id");

-- CreateIndex
CREATE INDEX "form_fields_form_id_idx" ON "form_fields"("form_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_fields_form_id_key_key" ON "form_fields"("form_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "personalization_cases_order_item_id_key" ON "personalization_cases"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "personalization_cases_customer_token_hash_key" ON "personalization_cases"("customer_token_hash");

-- CreateIndex
CREATE INDEX "personalization_cases_order_id_idx" ON "personalization_cases"("order_id");

-- CreateIndex
CREATE INDEX "personalization_cases_status_idx" ON "personalization_cases"("status");

-- CreateIndex
CREATE INDEX "personalization_cases_customer_token_hash_idx" ON "personalization_cases"("customer_token_hash");

-- CreateIndex
CREATE INDEX "personalization_answers_case_id_idx" ON "personalization_answers"("case_id");

-- CreateIndex
CREATE UNIQUE INDEX "personalization_answers_case_id_field_id_key" ON "personalization_answers"("case_id", "field_id");

-- CreateIndex
CREATE INDEX "personalization_answer_versions_case_id_idx" ON "personalization_answer_versions"("case_id");

-- CreateIndex
CREATE INDEX "personalization_answer_versions_created_at_idx" ON "personalization_answer_versions"("created_at");

-- CreateIndex
CREATE INDEX "order_access_pins_order_id_idx" ON "order_access_pins"("order_id");

-- CreateIndex
CREATE INDEX "order_access_pins_expires_at_idx" ON "order_access_pins"("expires_at");

-- CreateIndex
CREATE INDEX "render_jobs_case_id_idx" ON "render_jobs"("case_id");

-- CreateIndex
CREATE INDEX "render_jobs_status_idx" ON "render_jobs"("status");

-- CreateIndex
CREATE INDEX "assets_case_id_idx" ON "assets"("case_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "personalization_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "personalization_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personalization_cases" ADD CONSTRAINT "personalization_cases_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personalization_cases" ADD CONSTRAINT "personalization_cases_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personalization_cases" ADD CONSTRAINT "personalization_cases_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "personalization_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personalization_answers" ADD CONSTRAINT "personalization_answers_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "personalization_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personalization_answers" ADD CONSTRAINT "personalization_answers_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "form_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personalization_answer_versions" ADD CONSTRAINT "personalization_answer_versions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "personalization_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_access_pins" ADD CONSTRAINT "order_access_pins_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "personalization_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "personalization_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
