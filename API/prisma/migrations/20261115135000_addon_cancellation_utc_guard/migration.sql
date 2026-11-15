-- The organisation-authority function replacement must retain the UTC financial clock.
-- Preserve that newer authority body and all existing historical evidence.
ALTER FUNCTION billing_recurring_addon_cancellation_intent_coherence() SET TimeZone = 'UTC';
