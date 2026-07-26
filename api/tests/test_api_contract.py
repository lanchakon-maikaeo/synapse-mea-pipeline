from __future__ import annotations

from datetime import date, datetime, timezone
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

USER_ID = UUID("11111111-1111-4111-8111-111111111111")
JWT_SECRET = "test-secret-with-enough-entropy-2026"

os.environ.setdefault("DATABASE_URL", "postgresql://unused")
os.environ.setdefault("SUPABASE_JWT_SECRET", JWT_SECRET)

from synapse_api.main import create_app
from synapse_api.settings import Settings

class FakeCursor:
    def __init__(self, role: str):
        self.role = role
        self.rows: list[dict] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query: str, params=()):
        normalized = " ".join(query.split()).lower()
        if "from public.user_profiles" in normalized:
            self.rows = [{"role": self.role, "district_id": "5501" if self.role == "district" else None}]
        elif normalized.startswith("select 1 as ok"):
            self.rows = [{"ok": 1}]
        elif "from analytics.v_contract_status" in normalized:
            self.rows = [{
                "contract_id": 1,
                "contract_key": "PO-1001",
                "purchase_order": 1001,
                "contract_number": "MEA-1001",
                "procurement_code": "P1",
                "vendor_name": "ผู้ขายที่ผ่านการตรวจสอบ",
                "start_date": date(2026, 1, 1),
                "document_date": date(2026, 1, 1),
                "end_date": date(2026, 12, 31),
                "contract_status": "ACTIVE",
                "source_item_count": 2,
                "material_line_count": 2,
                "service_or_unmapped_line_count": 0,
                "warning_line_count": 0,
                "source_batch_id": uuid4(),
                "updated_at": datetime.now(timezone.utc),
            }]
        elif "from analytics.v_wave3_readiness" in normalized:
            self.rows = [{"forecast_operational_ready": False, "route_operational_ready": False, "checked_at": datetime.now(timezone.utc)}]
        elif "core.queue_route_job" in normalized:
            self.rows = [{"route_job_id": UUID("22222222-2222-4222-8222-222222222222")}]
        else:
            self.rows = []

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class FakeConnection:
    def __init__(self, role: str):
        self.role = role

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return FakeCursor(self.role)


def token() -> str:
    return jwt.encode(
        {"sub": str(USER_ID), "aud": "authenticated", "exp": 4_102_444_800},
        JWT_SECRET,
        algorithm="HS256",
    )


def client(role: str = "viewer", rate_limit: int = 120) -> TestClient:
    settings = Settings(
        database_url="postgresql://unused",
        supabase_jwt_secret=JWT_SECRET,
        cors_origins=["https://dashboard.example"],
        environment="test",
        rate_limit_per_minute=rate_limit,
        metrics_token="metrics-test-token",
    )
    return TestClient(create_app(settings, connection_factory=lambda: FakeConnection(role)))


class ApiContractTests(unittest.TestCase):
    def test_asymmetric_supabase_token_uses_jwks_and_checks_issuer(self):
        private_key = ec.generate_private_key(ec.SECP256R1())
        asymmetric_token = jwt.encode(
            {
                "sub": str(USER_ID), "aud": "authenticated", "exp": 4_102_444_800,
                "iss": "https://project-test.supabase.co/auth/v1",
            },
            private_key,
            algorithm="ES256",
            headers={"kid": "test-signing-key"},
        )
        settings = Settings(
            database_url="postgresql://unused",
            supabase_jwt_secret="",
            cors_origins=[],
            supabase_url="https://project-test.supabase.co",
            supabase_jwks_url="https://project-test.supabase.co/auth/v1/.well-known/jwks.json",
        )
        fake_jwks = SimpleNamespace(get_signing_key_from_jwt=lambda _token: SimpleNamespace(key=private_key.public_key()))
        with patch("synapse_api.main.PyJWKClient", return_value=fake_jwks):
            api = TestClient(create_app(settings, connection_factory=lambda: FakeConnection("viewer")))
        response = api.get("/v1/me", headers={"Authorization": f"Bearer {asymmetric_token}"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user_id"], str(USER_ID))

    def test_unauthorized_request_uses_structured_error(self):
        response = client().get("/v1/contracts", headers={"X-Request-ID": "contract-test-1"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "unauthorized")
        self.assertEqual(response.json()["error"]["request_id"], "contract-test-1")
        self.assertEqual(response.headers["X-Request-ID"], "contract-test-1")

    def test_authenticated_identity_and_contract_schema(self):
        api = client("viewer")
        headers = {"Authorization": f"Bearer {token()}"}
        identity = api.get("/v1/me", headers=headers)
        contracts = api.get("/v1/contracts", headers=headers)
        self.assertEqual(identity.status_code, 200)
        self.assertEqual(identity.json(), {"user_id": str(USER_ID), "role": "viewer", "district_id": None})
        self.assertEqual(contracts.status_code, 200)
        self.assertEqual(contracts.json()[0]["contract_status"], "ACTIVE")
        self.assertEqual(contracts.json()[0]["source_item_count"], 2)

    def test_role_authorization_rejects_viewer_write(self):
        response = client("viewer").post(
            "/v1/replenishment/runs",
            headers={"Authorization": f"Bearer {token()}"},
            json={},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "forbidden")

    def test_not_ready_forecast_fails_closed(self):
        response = client("planner").post(
            "/v1/forecasts/runs",
            headers={"Authorization": f"Bearer {token()}"},
            json={"training_end": "2026-06-30", "horizon_months": 3},
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "conflict")

    def test_rate_limit_and_metrics_authentication(self):
        api = client(rate_limit=1)
        headers = {"Authorization": f"Bearer {token()}"}
        self.assertEqual(api.get("/v1/me", headers=headers).status_code, 200)
        limited = api.get("/v1/me", headers=headers)
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(api.get("/metrics").status_code, 401)
        metrics = api.get("/metrics", headers={"X-Metrics-Token": "metrics-test-token"})
        self.assertEqual(metrics.status_code, 200)
        self.assertIn("synapse_api_requests_total", metrics.text)
        bearer_metrics = api.get("/metrics", headers={"Authorization": "Bearer metrics-test-token"})
        self.assertEqual(bearer_metrics.status_code, 200)

    def test_openapi_has_versioned_response_contracts(self):
        schema = client().get("/openapi.json").json()
        self.assertEqual(schema["info"]["version"], "1.0.0")
        for path in ("/v1/contracts", "/v1/reference/materials", "/v1/warehouse-stock", "/v1/data-sources/legacy/status", "/v1/data-inputs/vmi", "/v1/data-inputs/vmi/context", "/v1/stock-health", "/v1/routes/plans", "/v1/wave3/readiness"):
            response_schema = schema["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
            self.assertTrue(response_schema)

    def test_route_queue_is_valhalla_only_and_uses_database_preflight(self):
        headers = {
            "Authorization": f"Bearer {token()}",
            "X-Request-ID": "route-api-contract-1",
        }
        response = client("planner").post(
            "/v1/routes/jobs",
            headers=headers,
            json={
                "replenishment_plan_id":
                    "33333333-3333-4333-8333-333333333333",
                "matrix_source": "valhalla",
            },
        )
        self.assertEqual(response.status_code, 202)
        self.assertEqual(
            response.json()["route_job_id"],
            "22222222-2222-4222-8222-222222222222",
        )

        rejected = client("planner").post(
            "/v1/routes/jobs",
            headers=headers,
            json={
                "replenishment_plan_id":
                    "33333333-3333-4333-8333-333333333333",
                "matrix_source": "haversine-test",
            },
        )
        self.assertEqual(rejected.status_code, 422)

        route_request_schema = client().get("/openapi.json").json()[
            "components"
        ]["schemas"]["RouteJobRequest"]
        self.assertEqual(
            route_request_schema["properties"]["matrix_source"]["const"],
            "valhalla",
        )

    def test_viewer_cannot_publish_operational_input(self):
        response = client("viewer").post(
            "/v1/data-inputs/vmi",
            headers={"Authorization": f"Bearer {token()}"},
            json={
                "material_id": "471050004000",
                "district_id": "5501",
                "snapshot_at": "2026-07-16T08:00:00+07:00",
                "current_stock": 10,
                "source_note": "verified source",
                "history": [
                    {"period": "2026-04", "demand_quantity": 1},
                    {"period": "2026-05", "demand_quantity": 1},
                    {"period": "2026-06", "demand_quantity": 1},
                ],
            },
        )
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
