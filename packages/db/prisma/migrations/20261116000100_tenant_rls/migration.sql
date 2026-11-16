-- Row-level security backs up the Prisma tenant extension (NFR-SEC-01).
--
-- Tenant transactions run `SET LOCAL ROLE datoflow_app` and
-- `set_config('app.organization_id', <id>, true)`. The policies below then hide every row
-- of another organization, even if a query forgets its filter.
-- The connecting role owns the tables and is not subject to RLS, which is what
-- system work (membership lookup, organization creation, background jobs) uses.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datoflow_app') THEN
    CREATE ROLE datoflow_app NOLOGIN;
  END IF;
END
$$;

GRANT datoflow_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO datoflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO datoflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO datoflow_app;

-- current_setting(..., true) returns NULL when unset, so an unset context matches nothing.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Organization" TO datoflow_app
  USING ("id" = current_setting('app.organization_id', true))
  WITH CHECK ("id" = current_setting('app.organization_id', true));

ALTER TABLE "OrganizationMembership" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OrganizationMembership" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Invitation" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "Pipeline" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Pipeline" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "PipelineStage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PipelineStage" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditLog" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

-- The audit log is append-only (AUD-01). UPDATE is always refused. DELETE is refused unless
-- the transaction has set app.audit_purge = 'on', which only the 30-day organization purge does.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- The tenant role cannot change audit rows at all, whatever the trigger says.
REVOKE UPDATE, DELETE ON "AuditLog" FROM datoflow_app;
