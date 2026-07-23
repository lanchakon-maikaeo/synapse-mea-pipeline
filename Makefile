.PHONY: test ci workspace-ci api-test pipeline-test intelligence-test dashboard-test openapi openapi-check shell-check secrets-check compose-check worker-image database-contract-local delivery-check

COMPOSE ?= $(shell if docker compose version >/dev/null 2>&1; then echo "docker compose"; elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; fi)

test: api-test pipeline-test openapi-check delivery-check

ci: test database-contract-local

# Backward-compatible alias for the full monorepo verification.
workspace-ci: ci dashboard-test

api-test:
	.venv/bin/python -m unittest discover -s api/tests -v

pipeline-test:
	.venv/bin/python -m unittest discover -s pipeline/tests -v

intelligence-test:
	.venv/bin/python -m unittest discover -s intelligence/tests -v

dashboard-test:
	@test -f dashboard/package.json || { echo "tracked dashboard/package.json is missing"; exit 1; }
	cd dashboard && npm run verify

openapi:
	.venv/bin/python api/scripts/export_openapi.py

openapi-check:
	.venv/bin/python api/scripts/export_openapi.py --check

shell-check:
	bash -n scripts/backup_database.sh scripts/deploy_database_migrations.sh scripts/restore_database.sh scripts/restore_drill.sh scripts/scan_secrets.sh scripts/test_restore_drill_local.sh scripts/test_supabase_migrations_local.sh

secrets-check:
	bash scripts/scan_secrets.sh

compose-check:
	@test -n "$(COMPOSE)" || { echo "Docker Compose is required (docker compose or docker-compose)"; exit 1; }
	@env_file=.env; \
	  cleanup=false; \
	  if [ ! -f "$$env_file" ]; then cp .env.example .env.test; env_file=.env.test; cleanup=true; fi; \
	  trap 'if [ "$$cleanup" = true ]; then rm -f .env.test; fi' EXIT; \
	  SYNAPSE_ENV_FILE="$$env_file" $(COMPOSE) --env-file "$$env_file" config --quiet

worker-image:
	docker build --file deploy/docker/worker.Dockerfile --tag synapse-worker:1.0.0 .

database-contract-local:
	bash scripts/test_supabase_migrations_local.sh

delivery-check: shell-check compose-check secrets-check
