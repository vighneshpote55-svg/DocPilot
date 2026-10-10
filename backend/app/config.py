from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_PATH, extra="ignore", case_sensitive=False)

    # --- core ---
    database_url: str = "sqlite:///./dev.db"
    auto_create_tables: bool = False
    cors_origins: str = "http://localhost:3000,http://localhost:5180,http://localhost:5173"
    public_base_url: str = "http://localhost:3000"  # where the customer portal frontend lives

    @field_validator("public_base_url")
    @classmethod
    def clean_public_base_url(cls, v: str) -> str:
        return v.rstrip("/") if v else v

    # --- storage (files are always AES-256-GCM encrypted before they are stored) ---
    storage_backend: str = "local"  # local | supabase
    local_storage_dir: str = "./storage"
    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_bucket: str = "case-documents"
    encryption_key: str = ""  # urlsafe-base64 of 32 random bytes

    # --- admin auth (Supabase JWT, HS256) ---
    supabase_jwt_secret: str = ""
    admin_emails: str = ""

    # --- OCR service ---
    ocr_url: str = "http://127.0.0.1:8000"
    ocr_api_key: str = ""
    ocr_timeout_seconds: int = 180
    ocr_max_attempts: int = 3
    ocr_pass_expected_name: bool = True
    mock_ocr_mode: bool = False


    # --- uploads ---
    max_upload_mb: int = 10

    # --- policy (all tunable) ---
    upload_token_hours: int = 72
    consent_token_hours: int = 168
    privacy_token_minutes: int = 30
    retention_days: int = 7
    case_expiry_days: int = 30
    reminder_days: str = "3,7,14"
    min_overall_confidence: float = 0.90
    min_field_confidence: float = 0.80
    allow_download: bool = False

    # --- security & abuse protection (Phase B4) ---
    upload_otp_enabled: bool = False
    upload_otp_expiry_minutes: int = 10
    rate_limit_enabled: bool = True
    rate_limit_portal_per_minute: int = 60
    rate_limit_upload_per_minute: int = 15
    rate_limit_consent_per_minute: int = 20
    rate_limit_privacy_per_minute: int = 10

    # --- email ---
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "no-reply@example.com"

    # --- optional AI fallback (OpenAI-compatible API, e.g. OpenRouter) ---
    ai_enabled: bool = False
    ai_base_url: str = "https://openrouter.ai/api/v1"
    ai_api_key: str = ""
    ai_model: str = ""

    # --- worker ---
    scheduler_interval_seconds: int = 300

    @property
    def admin_email_list(self) -> list[str]:
        return [e.strip().lower() for e in self.admin_emails.split(",") if e.strip()]

    @property
    def reminder_day_list(self) -> list[int]:
        return sorted({int(x) for x in self.reminder_days.split(",") if x.strip()})

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
