-- Migracja: uproszczenie ról — usunięcie roli SELLER
-- Wszystkie konta z rolą SELLER stają się ADMIN

UPDATE users SET role = 'ADMIN' WHERE role = 'SELLER';

-- Zmień domyślną wartość pola role (PostgreSQL wymaga ALTER COLUMN)
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'ADMIN';
