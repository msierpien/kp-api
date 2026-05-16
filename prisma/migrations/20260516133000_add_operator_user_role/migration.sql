-- Normalize legacy/free-form role values before converting to an enum.
UPDATE users
SET role = 'OPERATOR'
WHERE role = 'SELLER'
   OR role NOT IN ('SUPER_ADMIN', 'ADMIN', 'OPERATOR');

CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'OPERATOR');

ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users
  ALTER COLUMN role TYPE "UserRole"
  USING role::"UserRole";
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'OPERATOR';
