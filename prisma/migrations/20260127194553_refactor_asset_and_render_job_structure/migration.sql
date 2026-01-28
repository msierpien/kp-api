/*
  Warnings:

  - You are about to drop the column `expires_at` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `hash` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `mime` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `pages` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `public_url` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `size_bytes` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `storage_key` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `assets` table. All the data in the column will be lost.
  - You are about to drop the column `finished_at` on the `render_jobs` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `render_jobs` table. All the data in the column will be lost.
  - Added the required column `asset_type` to the `assets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `file_path` to the `assets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `file_size` to the `assets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `mime_type` to the `assets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `job_type` to the `render_jobs` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "assets_type_idx";

-- AlterTable
ALTER TABLE "assets" DROP COLUMN "expires_at",
DROP COLUMN "hash",
DROP COLUMN "mime",
DROP COLUMN "pages",
DROP COLUMN "public_url",
DROP COLUMN "size_bytes",
DROP COLUMN "storage_key",
DROP COLUMN "type",
ADD COLUMN     "asset_type" TEXT NOT NULL,
ADD COLUMN     "file_path" TEXT NOT NULL,
ADD COLUMN     "file_size" INTEGER NOT NULL,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "mime_type" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "render_jobs" DROP COLUMN "finished_at",
DROP COLUMN "type",
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "job_type" TEXT NOT NULL,
ADD COLUMN     "metadata" JSONB,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "assets_asset_type_idx" ON "assets"("asset_type");

-- CreateIndex
CREATE INDEX "render_jobs_job_type_idx" ON "render_jobs"("job_type");
