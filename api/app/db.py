import sqlite3
from contextlib import contextmanager
from pathlib import Path

from . import config


class Database:
    """Small SQL adapter; shared catalog schema in local and distributed modes."""

    def __init__(self, path=None, url=None):
        self.path = str(path or config.DATABASE_PATH)
        self.url = config.DATABASE_URL if url is None else url

    @contextmanager
    def connect(self, write=False):
        if self.url:
            import psycopg
            from psycopg.rows import dict_row

            with psycopg.connect(self.url, row_factory=dict_row) as conn:
                yield Connection(conn, postgres=True)
        else:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA busy_timeout = 30000")
            try:
                if write:
                    conn.execute("BEGIN IMMEDIATE")
                yield Connection(conn)
                if write:
                    conn.commit()
            except Exception:
                if write:
                    conn.rollback()
                raise
            finally:
                conn.close()

    def initialize(self):
        schema = (config.ROOT / "infra" / "postgres" / "schema.sql").read_text()
        with self.connect() as db:
            if db.postgres:
                db.conn.execute(schema)
            else:
                db.conn.execute("PRAGMA journal_mode = WAL")
                db.conn.executescript(schema)


class Connection:
    def __init__(self, conn, postgres=False):
        self.conn = conn
        self.postgres = postgres

    def execute(self, sql, params=()):
        return self.conn.execute(sql.replace("?", "%s") if self.postgres else sql, params)

    def one(self, sql, params=()):
        row = self.execute(sql, params).fetchone()
        return dict(row) if row else None

    def all(self, sql, params=()):
        return [dict(row) for row in self.execute(sql, params).fetchall()]
