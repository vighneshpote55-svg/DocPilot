"""Run database migrations:  python -m app.db_init"""
from .db import init_db, run_migrations

if __name__ == "__main__":
    init_db()
    run_migrations()
    print("Database migrations applied (head).")
