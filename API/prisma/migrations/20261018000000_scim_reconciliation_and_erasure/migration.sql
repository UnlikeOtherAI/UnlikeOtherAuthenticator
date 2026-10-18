SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- AlterTable
ALTER TABLE "org_sso_connections" ADD COLUMN     "scim_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scim_revision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "external_identity_tombstones" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "client_domain" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "tuple_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_identity_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_identity_tombstones_tuple_hash_key" ON "external_identity_tombstones"("tuple_hash");

-- CreateIndex
CREATE UNIQUE INDEX "scim_resource_links_connection_id_resource_type_subject_bin_key" ON "scim_resource_links"("connection_id", "resource_type", "subject_binding");

ALTER TABLE external_identity_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identity_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_tombstone_deny_app ON external_identity_tombstones USING(false) WITH CHECK(false);
DO $$ BEGIN IF EXISTS(SELECT FROM pg_roles WHERE rolname='uoa_admin') THEN
 GRANT SELECT,INSERT ON external_identity_tombstones TO uoa_admin;
END IF; END $$;
CREATE FUNCTION preserve_scim_resource_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE erasure boolean;
BEGIN
 erasure := coalesce(current_setting('app.enterprise_identity_erasure',true) = 'true', false) AND pg_has_role(session_user,'uoa_admin','member');
 IF ROW(NEW.id,NEW.connection_id,NEW.client_domain,NEW.org_id,NEW.resource_type,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.connection_id,OLD.client_domain,OLD.org_id,OLD.resource_type,OLD.created_at)
 THEN RAISE EXCEPTION 'SCIM resource scope is immutable'; END IF;
 IF NOT erasure AND OLD.subject_binding IS NOT NULL AND
   ROW(NEW.subject_binding,NEW.user_id,NEW.external_id) IS DISTINCT FROM ROW(OLD.subject_binding,OLD.user_id,OLD.external_id)
 THEN RAISE EXCEPTION 'SCIM identity reconciliation is immutable'; END IF;
 IF NOT erasure AND OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.active)
 THEN RAISE EXCEPTION 'SCIM deleted resource cannot resurrect'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scim_resource_binding_immutable BEFORE UPDATE ON scim_resource_links
 FOR EACH ROW EXECUTE FUNCTION preserve_scim_resource_binding();

ALTER TABLE org_sso_link_intents ADD COLUMN candidate_user_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE external_identity_tombstones ADD CONSTRAINT identity_tombstone_shape CHECK(reason='erased' AND tuple_hash ~ '^[0-9a-f]{64}$');
CREATE FUNCTION preserve_identity_erasure_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'identity erasure tombstones are immutable';
END $$;
CREATE TRIGGER identity_erasure_tombstone_immutable BEFORE UPDATE OR DELETE ON external_identity_tombstones
 FOR EACH ROW EXECUTE FUNCTION preserve_identity_erasure_tombstone();
