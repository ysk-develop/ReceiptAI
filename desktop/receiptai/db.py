"""SQLite persistence for receipts and line items."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from .config import DB_PATH, ensure_app_dir


def _connect(db_path: Path | None = None) -> sqlite3.Connection:
    ensure_app_dir()
    path = db_path or DB_PATH
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_conn(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    conn = _connect(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path: Path | None = None) -> None:
    with get_conn(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS receipts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shop_name TEXT NOT NULL,
                date TEXT NOT NULL,
                total_amount REAL NOT NULL DEFAULT 0,
                source_file TEXT,
                source_hash TEXT UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                note TEXT DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                receipt_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                price REAL NOT NULL DEFAULT 0,
                category TEXT NOT NULL DEFAULT 'その他',
                FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);
            CREATE INDEX IF NOT EXISTS idx_items_receipt ON items(receipt_id);
            CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
            """
        )


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def insert_receipt(
    shop_name: str,
    date: str,
    items: list[dict[str, Any]],
    *,
    source_file: str | None = None,
    source_hash: str | None = None,
    note: str = "",
    db_path: Path | None = None,
) -> tuple[int, bool]:
    """Insert receipt. Returns (id, created). created=False if source_hash already existed."""
    total = sum(float(i.get("price") or 0) for i in items)
    ts = _now()
    with get_conn(db_path) as conn:
        if source_hash:
            existing = conn.execute(
                "SELECT id FROM receipts WHERE source_hash = ?", (source_hash,)
            ).fetchone()
            if existing:
                return int(existing["id"]), False

        cur = conn.execute(
            """
            INSERT INTO receipts (shop_name, date, total_amount, source_file, source_hash, created_at, updated_at, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (shop_name or "不明", date, total, source_file, source_hash, ts, ts, note),
        )
        rid = int(cur.lastrowid)
        for item in items:
            conn.execute(
                "INSERT INTO items (receipt_id, name, price, category) VALUES (?, ?, ?, ?)",
                (
                    rid,
                    str(item.get("name") or "（未入力）"),
                    float(item.get("price") or 0),
                    str(item.get("category") or "その他"),
                ),
            )
        return rid, True


def update_receipt(
    receipt_id: int,
    shop_name: str,
    date: str,
    items: list[dict[str, Any]],
    note: str = "",
    db_path: Path | None = None,
) -> None:
    total = sum(float(i.get("price") or 0) for i in items)
    with get_conn(db_path) as conn:
        conn.execute(
            """
            UPDATE receipts
            SET shop_name = ?, date = ?, total_amount = ?, note = ?, updated_at = ?
            WHERE id = ?
            """,
            (shop_name, date, total, note, _now(), receipt_id),
        )
        conn.execute("DELETE FROM items WHERE receipt_id = ?", (receipt_id,))
        for item in items:
            conn.execute(
                "INSERT INTO items (receipt_id, name, price, category) VALUES (?, ?, ?, ?)",
                (
                    receipt_id,
                    str(item.get("name") or "（未入力）"),
                    float(item.get("price") or 0),
                    str(item.get("category") or "その他"),
                ),
            )


def delete_receipt(receipt_id: int, db_path: Path | None = None) -> None:
    with get_conn(db_path) as conn:
        conn.execute("DELETE FROM receipts WHERE id = ?", (receipt_id,))


def list_receipts(
    *,
    year_month: str | None = None,
    db_path: Path | None = None,
) -> list[dict[str, Any]]:
    with get_conn(db_path) as conn:
        if year_month:
            rows = conn.execute(
                """
                SELECT * FROM receipts
                WHERE date LIKE ?
                ORDER BY date DESC, id DESC
                """,
                (f"{year_month}%",),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM receipts ORDER BY date DESC, id DESC"
            ).fetchall()
        return [dict(r) for r in rows]


def get_receipt(receipt_id: int, db_path: Path | None = None) -> dict[str, Any] | None:
    with get_conn(db_path) as conn:
        row = conn.execute("SELECT * FROM receipts WHERE id = ?", (receipt_id,)).fetchone()
        if not row:
            return None
        items = conn.execute(
            "SELECT id, name, price, category FROM items WHERE receipt_id = ? ORDER BY id",
            (receipt_id,),
        ).fetchall()
        data = dict(row)
        data["items"] = [dict(i) for i in items]
        return data


def list_months(db_path: Path | None = None) -> list[str]:
    with get_conn(db_path) as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT substr(date, 1, 7) AS ym
            FROM receipts
            WHERE length(date) >= 7
            ORDER BY ym DESC
            """
        ).fetchall()
        return [r["ym"] for r in rows if r["ym"]]


def category_totals(
    year_month: str | None = None,
    db_path: Path | None = None,
) -> list[tuple[str, float]]:
    with get_conn(db_path) as conn:
        if year_month:
            rows = conn.execute(
                """
                SELECT i.category, SUM(i.price) AS total
                FROM items i
                JOIN receipts r ON r.id = i.receipt_id
                WHERE r.date LIKE ?
                GROUP BY i.category
                ORDER BY total DESC
                """,
                (f"{year_month}%",),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT category, SUM(price) AS total
                FROM items
                GROUP BY category
                ORDER BY total DESC
                """
            ).fetchall()
        return [(r["category"], float(r["total"] or 0)) for r in rows]


def monthly_totals(db_path: Path | None = None) -> list[tuple[str, float]]:
    with get_conn(db_path) as conn:
        rows = conn.execute(
            """
            SELECT substr(date, 1, 7) AS ym, SUM(total_amount) AS total
            FROM receipts
            WHERE length(date) >= 7
            GROUP BY ym
            ORDER BY ym
            """
        ).fetchall()
        return [(r["ym"], float(r["total"] or 0)) for r in rows]


def export_csv(path: Path, year_month: str | None = None, db_path: Path | None = None) -> int:
    import csv

    with get_conn(db_path) as conn:
        if year_month:
            rows = conn.execute(
                """
                SELECT r.date, r.shop_name, i.name, i.price, i.category, r.id
                FROM items i
                JOIN receipts r ON r.id = i.receipt_id
                WHERE r.date LIKE ?
                ORDER BY r.date, r.id, i.id
                """,
                (f"{year_month}%",),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT r.date, r.shop_name, i.name, i.price, i.category, r.id
                FROM items i
                JOIN receipts r ON r.id = i.receipt_id
                ORDER BY r.date, r.id, i.id
                """
            ).fetchall()

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["日付", "店舗", "品目", "金額", "カテゴリ", "レシートID"])
        for r in rows:
            writer.writerow([r["date"], r["shop_name"], r["name"], r["price"], r["category"], r["id"]])
    return len(rows)
