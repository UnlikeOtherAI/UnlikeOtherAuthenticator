-- Browserbase bills started minutes with a one-minute minimum.
ALTER TABLE billing_browser_policies ADD CONSTRAINT browser_minute_rounding CHECK (rounding_seconds = 60);
