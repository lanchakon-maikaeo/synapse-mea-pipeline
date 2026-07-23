from __future__ import annotations

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    database_url: str
    supabase_jwt_secret: str
    cors_origins: list[str]
    supabase_url: str = ""
    supabase_jwks_url: str = ""
    environment: str = "development"
    rate_limit_per_minute: int = 120
    max_request_body_bytes: int = 1_048_576
    metrics_token: str = ""

    @classmethod
    def from_environment(cls) -> "Settings":
        database_url = os.environ.get("DATABASE_URL", "")
        jwt_secret = os.environ.get("SUPABASE_JWT_SECRET", "")
        supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        jwks_url = os.environ.get("SUPABASE_JWKS_URL", "")
        if not jwks_url and supabase_url:
            jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        if not database_url or not (jwt_secret or jwks_url):
            raise RuntimeError("DATABASE_URL and either SUPABASE_JWT_SECRET or SUPABASE_URL/SUPABASE_JWKS_URL are required")
        origins = [origin.strip() for origin in os.environ.get("API_CORS_ORIGINS", "").split(",") if origin.strip()]
        return cls(
            database_url=database_url,
            supabase_jwt_secret=jwt_secret,
            cors_origins=origins,
            supabase_url=supabase_url,
            supabase_jwks_url=jwks_url,
            environment=os.environ.get("SYNAPSE_ENVIRONMENT", "development"),
            rate_limit_per_minute=max(1, int(os.environ.get("API_RATE_LIMIT_PER_MINUTE", "120"))),
            max_request_body_bytes=max(1024, int(os.environ.get("API_MAX_REQUEST_BODY_BYTES", "1048576"))),
            metrics_token=os.environ.get("METRICS_TOKEN", ""),
        )
