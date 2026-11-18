import type pg from 'pg';

// Explicit development migration; never executed as part of application startup.
export async function migrateCatalogRetries(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 5]);
    for (const schema of ['kabadi_authz', 'kabadi_catalog']) {
      const marker = await c.query<{marker:string | null}>(`SELECT to_regclass('${schema}.schema_version')::text AS marker`);
      if (!marker.rows[0]?.marker) throw Error('Prerequisite schema missing');
      const version = await c.query<{version:number}>(`SELECT version FROM ${schema}.schema_version`);
      if (version.rows.length !== 1 || version.rows[0]?.version !== 1) throw Error('Unsupported prerequisite schema');
    }
    const exists = await c.query<{exists:boolean}>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='kabadi_catalog_retry') AS exists");
    if (exists.rows[0]?.exists) {
      const marker = await c.query<{marker:string | null}>("SELECT to_regclass('kabadi_catalog_retry.schema_version')::text AS marker");
      if (!marker.rows[0]?.marker) throw Error('Unrecognized retry schema');
      const version = await c.query<{version:number}>('SELECT version FROM kabadi_catalog_retry.schema_version');
      if (version.rows.length !== 1 || version.rows[0]?.version !== 1) throw Error('Unsupported retry schema');
    } else {
      await c.query('CREATE SCHEMA kabadi_catalog_retry');
      await c.query('CREATE TABLE kabadi_catalog_retry.schema_version (version integer PRIMARY KEY CHECK (version = 1))');
      await c.query(`CREATE TABLE kabadi_catalog_retry.successes (
        actor_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        request_key uuid NOT NULL, operation text NOT NULL CHECK (operation IN ('category', 'rate')),
        payload jsonb NOT NULL, category_id uuid NOT NULL REFERENCES kabadi_catalog.categories(id) ON DELETE RESTRICT,
        rate_id uuid REFERENCES kabadi_catalog.rates(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (actor_id, request_key),
        CHECK ((operation = 'category' AND rate_id IS NULL) OR (operation = 'rate' AND rate_id IS NOT NULL))
      )`);
      await c.query('INSERT INTO kabadi_catalog_retry.schema_version VALUES (1)');
    }
    await c.query('COMMIT');
  } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
}
