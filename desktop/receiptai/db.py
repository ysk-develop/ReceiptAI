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
                cloud_receipt_id TEXT UNIQUE,
                book_id TEXT DEFAULT '',
                image_file_id TEXT DEFAULT '',
                image_view_url TEXT DEFAULT '',
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
        _migrate_columns(conn)


def _migrate_columns(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(receipts)").fetchall()}
    alter = []
    if "cloud_receipt_id" not in cols:
        alter.append("ALTER TABLE receipts ADD COLUMN cloud_receipt_id TEXT")
    if "image_file_id" not in cols:
        alter.append("ALTER TABLE receipts ADD COLUMN image_file_id TEXT DEFAULT ''")
    if "image_view_url" not in cols:
        alter.append("ALTER TABLE receipts ADD COLUMN image_view_url TEXT DEFAULT ''")
    if "book_id" not in cols:
        alter.append("ALTER TABLE receipts ADD COLUMN book_id TEXT DEFAULT ''")
    if "payment_method" not in cols:
        alter.append("ALTER TABLE receipts ADD COLUMN payment_method TEXT DEFAULT '現金'")
    for sql in alter:
        conn.execute(sql)
    # unique index for cloud id (ignore nulls / empties via partial not available on older sqlite — use unique where possible)
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_cloud_id ON receipts(cloud_receipt_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_receipts_book_id ON receipts(book_id)"
    )


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def insert_receipt(
    shop_name: str,
    date: str,
    items: list[dict[str, Any]],
    *,
    payment_method: str = "現金",
    source_file: str | None = None,
    source_hash: str | None = None,
    cloud_receipt_id: str | None = None,
    book_id: str = "",
    image_file_id: str = "",
    image_view_url: str = "",
    note: str = "",
    db_path: Path | None = None,
) -> tuple[int, bool]:
    """Insert receipt. Returns (id, created). Skip if source_hash or cloud_receipt_id exists."""
    total = sum(float(i.get("price") or 0) for i in items)
    payment = str(payment_method or "現金").strip() or "現金"
    ts = _now()
    with get_conn(db_path) as conn:
        if source_hash:
            existing = conn.execute(
                "SELECT id FROM receipts WHERE source_hash = ?", (source_hash,)
            ).fetchone()
            if existing:
                return int(existing["id"]), False
        if cloud_receipt_id:
            existing = conn.execute(
                "SELECT id FROM receipts WHERE cloud_receipt_id = ?", (cloud_receipt_id,)
            ).fetchone()
            if existing:
                return int(existing["id"]), False

        cur = conn.execute(
            """
            INSERT INTO receipts (
                shop_name, date, total_amount, source_file, source_hash,
                cloud_receipt_id, book_id, image_file_id, image_view_url,
                created_at, updated_at, note, payment_method
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                shop_name or "不明",
                date,
                total,
                source_file,
                source_hash,
                cloud_receipt_id,
                book_id or "",
                image_file_id or "",
                image_view_url or "",
                ts,
                ts,
                note,
                payment,
            ),
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


def upsert_cloud_receipt(
    cloud_receipt_id: str,
    shop_name: str,
    date: str,
    items: list[dict[str, Any]],
    *,
    payment_method: str = "現金",
    book_id: str = "",
    image_file_id: str = "",
    image_view_url: str = "",
    db_path: Path | None = None,
) -> tuple[int, bool]:
    """Insert or refresh a receipt keyed by cloud_receipt_id. Returns (id, created)."""
    total = sum(float(i.get("price") or 0) for i in items)
    payment = str(payment_method or "現金").strip() or "現金"
    ts = _now()
    with get_conn(db_path) as conn:
        existing = conn.execute(
            "SELECT id FROM receipts WHERE cloud_receipt_id = ?", (cloud_receipt_id,)
        ).fetchone()
        if existing:
            rid = int(existing["id"])
            conn.execute(
                """
                UPDATE receipts
                SET shop_name = ?, date = ?, total_amount = ?, payment_method = ?,
                    book_id = ?, image_file_id = ?, image_view_url = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    shop_name,
                    date,
                    total,
                    payment,
                    book_id or "",
                    image_file_id or "",
                    image_view_url or "",
                    ts,
                    rid,
                ),
            )
            conn.execute("DELETE FROM items WHERE receipt_id = ?", (rid,))
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
            return rid, False

        cur = conn.execute(
            """
            INSERT INTO receipts (
                shop_name, date, total_amount, cloud_receipt_id, book_id,
                image_file_id, image_view_url, created_at, updated_at, note, payment_method
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
            """,
            (
                shop_name,
                date,
                total,
                cloud_receipt_id,
                book_id or "",
                image_file_id or "",
                image_view_url or "",
                ts,
                ts,
                payment,
            ),
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
    payment_method: str = "現金",
    db_path: Path | None = None,
) -> None:
    total = sum(float(i.get("price") or 0) for i in items)
    payment = str(payment_method or "現金").strip() or "現金"
    with get_conn(db_path) as conn:
        conn.execute(
            """
            UPDATE receipts
            SET shop_name = ?, date = ?, total_amount = ?, note = ?,
                payment_method = ?, updated_at = ?
            WHERE id = ?
            """,
            (shop_name, date, total, note, payment, _now(), receipt_id),
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


def clear_all_receipts(db_path: Path | None = None) -> int:
    """Delete all local receipts (and items via CASCADE). Returns deleted receipt count."""
    with get_conn(db_path) as conn:
        cur = conn.execute("SELECT COUNT(*) AS n FROM receipts")
        n = int(cur.fetchone()["n"])
        conn.execute("DELETE FROM items")
        conn.execute("DELETE FROM receipts")
        return n


def delete_by_cloud_id(cloud_receipt_id: str, db_path: Path | None = None) -> int:
    """Delete local row matching cloud_receipt_id. Returns deleted count."""
    if not cloud_receipt_id:
        return 0
    with get_conn(db_path) as conn:
        cur = conn.execute(
            "DELETE FROM receipts WHERE cloud_receipt_id = ?",
            (cloud_receipt_id,),
        )
        return int(cur.rowcount or 0)


def prune_cloud_receipts(
    keep_cloud_ids: set[str] | list[str],
    *,
    book_id: str = "",
    year_month: str | None = None,
    db_path: Path | None = None,
) -> int:
    """
    Remove local rows that came from the sheet (have cloud_receipt_id)
    but are no longer present in keep_cloud_ids.

    If year_month is set (YYYY-MM), only prune rows whose date falls in that month.
    If book_id is set, only prune that book's rows.
    Local-only rows (no cloud_receipt_id) are never deleted.
    """
    keep = {str(x) for x in keep_cloud_ids if x}
    ym = (year_month or "").strip()
    bid = (book_id or "").strip()
    with get_conn(db_path) as conn:
        if bid:
            rows = conn.execute(
                """
                SELECT id, cloud_receipt_id, date FROM receipts
                WHERE cloud_receipt_id IS NOT NULL
                  AND cloud_receipt_id != ''
                  AND book_id = ?
                """,
                (bid,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, cloud_receipt_id, date FROM receipts
                WHERE cloud_receipt_id IS NOT NULL
                  AND cloud_receipt_id != ''
                """
            ).fetchall()

        deleted = 0
        for row in rows:
            cid = str(row["cloud_receipt_id"] or "")
            if not cid or cid in keep:
                continue
            if ym:
                day = _day_key(str(row["date"] or ""))
                if not day.startswith(ym):
                    continue
            conn.execute("DELETE FROM receipts WHERE id = ?", (int(row["id"]),))
            deleted += 1
        return deleted


def _norm_shop(s: str) -> str:
    return "".join(str(s or "").split()).lower()


def _day_key(date_str: str) -> str:
    import re

    m = re.search(r"(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})", str(date_str or ""))
    if not m:
        return ""
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def find_local_duplicates(
    *,
    shop_name: str,
    date: str,
    total_amount: float | int,
    item_count: int | None = None,
    db_path: Path | None = None,
) -> list[dict[str, Any]]:
    """Find local receipts matching shop + day + total (+ optional item count)."""
    shop_key = _norm_shop(shop_name)
    day = _day_key(date)
    total_n = int(round(float(total_amount or 0)))
    if not shop_key or not day:
        return []
    rows = list_receipts(db_path=db_path)
    out: list[dict[str, Any]] = []
    for r in rows:
        if _norm_shop(str(r.get("shop_name") or "")) != shop_key:
            continue
        if _day_key(str(r.get("date") or "")) != day:
            continue
        if int(round(float(r.get("total_amount") or 0))) != total_n:
            continue
        if item_count is not None:
            items = get_receipt(int(r["id"]), db_path=db_path)
            n = len((items or {}).get("items") or [])
            if n != int(item_count):
                continue
        out.append(dict(r))
    return out


def list_receipts(
    *,
    year_month: str | None = None,
    book_id: str | None = None,
    db_path: Path | None = None,
) -> list[dict[str, Any]]:
    bid = (book_id or "").strip()
    with get_conn(db_path) as conn:
        clauses: list[str] = []
        params: list[Any] = []
        if year_month:
            ym = year_month.strip().replace("/", "-")[:7]
            clauses.append("replace(substr(date, 1, 7), '/', '-') = ?")
            params.append(ym)
        if bid:
            clauses.append("book_id = ?")
            params.append(bid)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            f"SELECT * FROM receipts{where} ORDER BY date DESC, id DESC",
            params,
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


def list_months(book_id: str | None = None, db_path: Path | None = None) -> list[str]:
    bid = (book_id or "").strip()
    with get_conn(db_path) as conn:
        if bid:
            rows = conn.execute(
                """
                SELECT DISTINCT replace(substr(date, 1, 7), '/', '-') AS ym
                FROM receipts
                WHERE length(date) >= 7 AND book_id = ?
                ORDER BY ym DESC
                """,
                (bid,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT DISTINCT replace(substr(date, 1, 7), '/', '-') AS ym
                FROM receipts
                WHERE length(date) >= 7
                ORDER BY ym DESC
                """
            ).fetchall()
        return [r["ym"] for r in rows if r["ym"]]


def category_totals(
    year_month: str | None = None,
    book_id: str | None = None,
    db_path: Path | None = None,
) -> list[tuple[str, float]]:
    bid = (book_id or "").strip()
    with get_conn(db_path) as conn:
        clauses: list[str] = []
        params: list[Any] = []
        if year_month:
            ym = year_month.strip().replace("/", "-")[:7]
            clauses.append("replace(substr(r.date, 1, 7), '/', '-') = ?")
            params.append(ym)
        if bid:
            clauses.append("r.book_id = ?")
            params.append(bid)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            f"""
            SELECT i.category, SUM(i.price) AS total
            FROM items i
            JOIN receipts r ON r.id = i.receipt_id
            {where}
            GROUP BY i.category
            ORDER BY total DESC
            """,
            params,
        ).fetchall()
        return [(str(r["category"]), float(r["total"] or 0)) for r in rows]


def monthly_totals(
    book_id: str | None = None, db_path: Path | None = None
) -> list[tuple[str, float]]:
    bid = (book_id or "").strip()
    with get_conn(db_path) as conn:
        if bid:
            rows = conn.execute(
                """
                SELECT replace(substr(date, 1, 7), '/', '-') AS ym, SUM(total_amount) AS total
                FROM receipts
                WHERE length(date) >= 7 AND book_id = ?
                GROUP BY ym
                ORDER BY ym
                """,
                (bid,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT replace(substr(date, 1, 7), '/', '-') AS ym, SUM(total_amount) AS total
                FROM receipts
                WHERE length(date) >= 7
                GROUP BY ym
                ORDER BY ym
                """
            ).fetchall()
        return [(r["ym"], float(r["total"] or 0)) for r in rows]


def export_csv(
    path: Path,
    year_month: str | None = None,
    book_id: str | None = None,
    db_path: Path | None = None,
) -> int:
    import csv

    bid = (book_id or "").strip()
    with get_conn(db_path) as conn:
        clauses: list[str] = []
        params: list[Any] = []
        if year_month:
            ym = year_month.strip().replace("/", "-")[:7]
            clauses.append("replace(substr(r.date, 1, 7), '/', '-') = ?")
            params.append(ym)
        if bid:
            clauses.append("r.book_id = ?")
            params.append(bid)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            f"""
            SELECT r.date, r.shop_name, i.name, i.price, i.category, r.id
            FROM items i
            JOIN receipts r ON r.id = i.receipt_id
            {where}
            ORDER BY r.date, r.id, i.id
            """,
            params,
        ).fetchall()

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["日付", "店舗", "品目", "金額", "カテゴリ", "レシートID"])
        for r in rows:
            writer.writerow([r["date"], r["shop_name"], r["name"], r["price"], r["category"], r["id"]])
    return len(rows)
