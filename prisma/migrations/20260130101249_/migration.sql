-- AlterTable
ALTER TABLE "personalization_cases" ADD COLUMN     "email_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "email_error" TEXT,
ADD COLUMN     "email_failed_at" TIMESTAMP(3),
ADD COLUMN     "email_sent_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "personalization_cases_email_sent_at_idx" ON "personalization_cases"("email_sent_at");
