SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TYPE "BillingAppKeyPurpose" ADD VALUE 'BROWSER_RUNTIME';
ALTER TYPE "BillingCreditEntryKind" ADD VALUE 'BROWSER_PREPAID_USAGE';
