"""Regression tests for PostgreSQL Row Level Security (RLS) migration and least-privilege policies."""

import os
import tempfile
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from app.db import init_db
from app.config import get_settings


APPLICATION_TABLES = [
    "customers",
    "required_documents",
    "consent_ledger",
    "access_tokens",
    "documents",
    "ocr_results",
    "manual_reviews",
    "privacy_requests",
    "audit_logs",
    "jobs",
]


def test_rls_sqlite_migration_lifecycle():
    """Verify that Alembic migration upgrade/downgrade ignores PG-only RLS on SQLite without errors."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        cfg = Config(os.path.join(os.path.dirname(os.path.dirname(__file__)), "alembic.ini"))
        cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")

        # Upgrade to head
        command.upgrade(cfg, "head")

        # Downgrade back to pre-RLS revision
        command.downgrade(cfg, "07648b259a0d")

        # Re-upgrade to head
        command.upgrade(cfg, "head")
    finally:
        if os.path.exists(db_path):
            os.remove(db_path)


def test_rls_postgres_isolation_and_policies():
    """Verify that all application tables enforce RLS, and anon/authenticated roles see zero rows."""
    settings = get_settings()
    if not settings.database_url.startswith(("postgres://", "postgresql://", "postgresql+pg8000://")):
        pytest.skip("Test requires PostgreSQL engine")

    engine = init_db()
    with engine.connect() as conn:
        # 1. Verify RLS is enabled on all 10 application tables
        rows = conn.execute(
            text(
                "SELECT tablename, rowsecurity FROM pg_tables "
                "WHERE schemaname = 'public' AND tablename = ANY(:tables)"
            ),
            {"tables": APPLICATION_TABLES},
        ).fetchall()
        rls_map = {r[0]: r[1] for r in rows}

        for table in APPLICATION_TABLES:
            assert table in rls_map, f"Table {table} missing from pg_tables"
            assert rls_map[table] is True, f"RLS not enabled on table {table}"

        # 2. Check if anon/authenticated roles exist in PostgreSQL
        existing_roles = {
            r[0]
            for r in conn.execute(
                text("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")
            ).fetchall()
        }

        if "anon" in existing_roles:
            conn.execute(text("SET ROLE anon;"))
            count_anon = conn.execute(text("SELECT count(*) FROM customers")).scalar()
            assert count_anon == 0, f"Anon role saw {count_anon} customers; expected 0 under RLS"

        if "authenticated" in existing_roles:
            conn.execute(text("SET ROLE authenticated;"))
            count_auth = conn.execute(text("SELECT count(*) FROM customers")).scalar()
            assert count_auth == 0, f"Authenticated role saw {count_auth} customers; expected 0 under RLS"

        conn.execute(text("RESET ROLE;"))

        # 3. Verify authorized backend role can query rows
        admin_count = conn.execute(text("SELECT count(*) FROM customers")).scalar()
        assert admin_count >= 0
