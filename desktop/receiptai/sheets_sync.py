"""Sync receipts from Google Spreadsheet (via GAS) into local SQLite cache."""

from __future__ import annotations

from typing import Any

from . import db, gas_client


def sync_from_sheet(
    gas_url: str,
    *,
    book_id: str = "",
    month: str = "",
    limit: int = 200,
) -> dict[str, Any]:
    """
    Pull sheet receipts into local DB, then remove local cloud-synced rows
    that no longer exist on the sheet (physical delete on phone is reflected).
    """
    if not book_id:
        raise ValueError("帳簿を選択してください")

    summaries = gas_client.list_receipts(
        gas_url, book_id=book_id, month=month, limit=limit
    )
    created = 0
    updated = 0
    errors: list[str] = []
    seen_ids: set[str] = set()

    for summary in summaries:
        rid = str(summary.get("receipt_id") or "")
        if not rid:
            continue
        seen_ids.add(rid)
        try:
            full = gas_client.get_receipt(gas_url, rid, book_id=book_id)
            items = full.get("items") or []
            if not items:
                continue
            _, is_new = db.upsert_cloud_receipt(
                rid,
                str(full.get("shop_name") or summary.get("shop_name") or "不明"),
                str(full.get("date") or summary.get("date") or ""),
                items,
                book_id=book_id,
                image_file_id=str(full.get("image_file_id") or summary.get("image_file_id") or ""),
                image_view_url=str(full.get("image_view_url") or summary.get("image_view_url") or ""),
            )
            if is_new:
                created += 1
            else:
                updated += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{rid}: {exc}")

    year_month = month.strip() or None
    removed = db.prune_cloud_receipts(
        seen_ids, book_id=book_id, year_month=year_month
    )

    return {
        "fetched": len(summaries),
        "created": created,
        "updated": updated,
        "removed": removed,
        "errors": errors,
    }
