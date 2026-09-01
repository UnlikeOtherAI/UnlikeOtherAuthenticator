-- Users may own and join more than one organisation on an origin domain. The
-- hosted workspace chooser offers those existing organisations alongside a
-- server-authorized "create a new organisation" destination, so the former
-- one-active-org-per-user-per-domain index would reject a valid membership
-- write for an otherwise authorised new organisation.
--
-- `org_members_one_active_org_per_domain` was introduced in
-- 20260730180000_org_member_active_org_domain_constraint. It only enforced the
-- retired placement rule; org-membership uniqueness within each exact org
-- remains protected by the existing `(org_id, user_id)` key.
--
-- Dropping an index is transactional but still needs a short lock timeout so a
-- migration cannot queue behind a stalled operation and freeze normal traffic.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

DROP INDEX IF EXISTS "org_members_one_active_org_per_domain";
