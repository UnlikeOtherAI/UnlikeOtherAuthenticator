-- These financial guards compare UTC timestamp(3) fields with database time.
-- PostgreSQL otherwise interprets those fields in the caller's session zone,
-- admitting an expired credential or rejecting a current one. Bind only these
-- functions to UTC; PostgreSQL restores the caller's zone on function exit.
-- Preserve every existing authority, transition and historical-provenance rule.
ALTER FUNCTION billing_assert_credit_app_key(TEXT, TEXT) SET TimeZone = 'UTC';
ALTER FUNCTION billing_assert_credit_app_key_provenance(TEXT, BOOLEAN) SET TimeZone = 'UTC';
ALTER FUNCTION billing_credit_auto_top_up_disable_event_coherence() SET TimeZone = 'UTC';
ALTER FUNCTION billing_recurring_addon_cancellation_intent_coherence() SET TimeZone = 'UTC';
