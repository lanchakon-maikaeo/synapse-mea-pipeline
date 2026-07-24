# Database migration source

The historical Drizzle files in this directory are retained only for schema
contract regression tests. They are not a deployment path.

Production database changes must use the ordered migrations in
`../../supabase/migrations/` and the guarded repository command:

```bash
bash scripts/deploy_database_migrations.sh
```

The deploy command verifies the registered Production project, creates a
pre-migration backup, applies only pending migrations, runs the 65-check schema
contract, and records release evidence.
