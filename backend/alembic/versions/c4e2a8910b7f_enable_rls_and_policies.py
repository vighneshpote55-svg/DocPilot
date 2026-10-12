"""enable RLS and least-privilege policies

Revision ID: c4e2a8910b7f
Revises: 07648b259a0d
Create Date: 2026-10-12 18:05:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4e2a8910b7f'
down_revision: Union[str, Sequence[str], None] = '07648b259a0d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = [
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


def upgrade() -> None:
    """Enable RLS and least-privilege policies on PostgreSQL."""
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for t in TABLES:
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY;")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY;")
        op.execute(f"""
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_policies WHERE tablename = '{t}' AND policyname = 'service_role_all_{t}'
                    ) THEN
                        EXECUTE 'CREATE POLICY service_role_all_{t} ON {t} FOR ALL TO service_role USING (true) WITH CHECK (true)';
                    END IF;
                END IF;
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_policies WHERE tablename = '{t}' AND policyname = 'postgres_all_{t}'
                    ) THEN
                        EXECUTE 'CREATE POLICY postgres_all_{t} ON {t} FOR ALL TO postgres USING (true) WITH CHECK (true)';
                    END IF;
                END IF;
            END $$;
        """)


def downgrade() -> None:
    """Drop policies and disable RLS on PostgreSQL."""
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for t in TABLES:
        op.execute(f"DROP POLICY IF EXISTS service_role_all_{t} ON {t};")
        op.execute(f"DROP POLICY IF EXISTS postgres_all_{t} ON {t};")
        op.execute(f"ALTER TABLE {t} NO FORCE ROW LEVEL SECURITY;")
        op.execute(f"ALTER TABLE {t} DISABLE ROW LEVEL SECURITY;")
