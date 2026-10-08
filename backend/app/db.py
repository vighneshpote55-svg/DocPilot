from contextlib import contextmanager
from datetime import datetime, timezone
import urllib.parse

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal = None


def utcnow() -> datetime:
    """Naive UTC datetime. All timestamps in the DB are UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _normalize(url: str) -> str:
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if "://" in url:
        scheme, rest = url.split("://", 1)
        if "@" in rest:
            userinfo, hostpath = rest.rsplit("@", 1)
            if ":" in userinfo:
                user, pwd = userinfo.split(":", 1)
                pwd = urllib.parse.quote(urllib.parse.unquote(pwd), safe="")
                url = f"{scheme}://{user}:{pwd}@{hostpath}"
    if url.startswith("postgresql://"):
        url = "postgresql+pg8000://" + url[len("postgresql://"):]
    return url


def init_db(url: str | None = None, create_tables: bool = False):
    global _engine, _SessionLocal
    from .config import get_settings

    url = _normalize(url or get_settings().database_url)
    kwargs: dict = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        if url in ("sqlite://", "sqlite:///:memory:"):
            kwargs["poolclass"] = StaticPool
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_recycle"] = 300
        kwargs["connect_args"] = {"ssl_context": True}  # Supabase requires SSL
    _engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        from sqlalchemy import event

        @event.listens_for(_engine, "connect")
        def _set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
    _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    if create_tables:
        run_migrations(_engine)
    return _engine


def run_migrations(engine=None) -> None:
    import os
    import alembic.command
    import alembic.config

    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ini_path = os.path.join(backend_dir, "alembic.ini")
    cfg = alembic.config.Config(ini_path)

    eng = engine or _engine
    if eng is not None:
        with eng.begin() as conn:
            cfg.attributes["connection"] = conn
            alembic.command.upgrade(cfg, "head")
    else:
        alembic.command.upgrade(cfg, "head")


def ensure_db():
    if _engine is None:
        from .config import get_settings

        init_db(create_tables=get_settings().auto_create_tables)


def get_db():
    """FastAPI dependency. Route handlers commit explicitly."""
    ensure_db()
    db = _SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@contextmanager
def session_scope():
    ensure_db()
    db = _SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
