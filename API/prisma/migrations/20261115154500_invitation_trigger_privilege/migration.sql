BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- The anniversary migration deliberately retained only row writes for uoa_admin.
-- Creating the invitation payment trigger also requires this explicit privilege,
-- even when the migration role owns the table. Do not grant it to uoa_app.
GRANT TRIGGER ON billing_automatic_seat_changes TO uoa_admin;
COMMIT;
