"""Import receipt JSON files from Google Drive sync folder."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from . import db


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def parse_receipt_json(raw: dict[str, Any]) -> dict[str, Any]:
    shop = str(raw.get("shop_name") or "不明")
    date = str(raw.get("date") or "")
    payment = str(raw.get("payment_method") or "現金").strip() or "現金"
    items_raw = raw.get("items") or []
    items = []
    for it in items_raw:
        if not isinstance(it, dict):
            continue
        items.append(
            {
                "name": str(it.get("name") or "（未入力）"),
                "price": float(it.get("price") or 0),
                "category": str(it.get("category") or "その他"),
            }
        )
    if not date and raw.get("timestamp"):
        date = str(raw["timestamp"])[:10]
    return {
        "shop_name": shop,
        "date": date,
        "payment_method": payment,
        "items": items,
        "total_amount": float(raw.get("total_amount") or sum(i["price"] for i in items)),
        "timestamp": raw.get("timestamp"),
    }


def discover_json_files(folder: Path) -> list[Path]:
    if not folder.exists() or not folder.is_dir():
        return []
    files = list(folder.glob("*.json"))
    seen: set[Path] = set()
    out: list[Path] = []
    for p in sorted(files, key=lambda x: x.stat().st_mtime, reverse=True):
        if p.parent.name == "_imported":
            continue
        rp = p.resolve()
        if rp in seen:
            continue
        seen.add(rp)
        out.append(p)
    return out


def _archive_file(path: Path, archive_dir: Path, digest: str) -> None:
    archive_dir.mkdir(exist_ok=True)
    dest = archive_dir / path.name
    if dest.exists():
        dest = archive_dir / f"{path.stem}_{digest[:8]}{path.suffix}"
    shutil.move(str(path), str(dest))


def import_folder(
    folder: str | Path,
    *,
    archive: bool = True,
) -> dict[str, Any]:
    """
    Import all JSON files from folder into SQLite.
    Already-imported files (by content hash) are skipped.
    Optionally move processed files into folder/_imported/
    """
    root = Path(folder).expanduser()
    result: dict[str, Any] = {
        "imported": 0,
        "skipped": 0,
        "errors": [],
        "files": [],
    }

    if not root.exists():
        result["errors"].append(f"フォルダがありません: {root}")
        return result

    archive_dir = root / "_imported"

    for path in discover_json_files(root):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("JSONルートがオブジェクトではありません")
            parsed = parse_receipt_json(raw)
            if not parsed["items"]:
                raise ValueError("明細が空です")
            if not parsed["date"]:
                raise ValueError("日付がありません")

            digest = file_hash(path)
            rid, created = db.insert_receipt(
                parsed["shop_name"],
                parsed["date"],
                parsed["items"],
                payment_method=parsed.get("payment_method") or "現金",
                source_file=str(path.name),
                source_hash=digest,
            )
            result["files"].append({"file": path.name, "receipt_id": rid, "created": created})
            if created:
                result["imported"] += 1
            else:
                result["skipped"] += 1

            if archive:
                _archive_file(path, archive_dir, digest)
        except Exception as exc:  # noqa: BLE001 — surface per-file errors in UI
            result["errors"].append(f"{path.name}: {exc}")

    return result


def import_payload(raw: dict[str, Any], *, source_file: str | None = None) -> int:
    parsed = parse_receipt_json(raw)
    if not parsed["items"]:
        raise ValueError("明細が空です")
    if not parsed["date"]:
        raise ValueError("日付がありません")
    rid, _ = db.insert_receipt(
        parsed["shop_name"],
        parsed["date"],
        parsed["items"],
        payment_method=parsed.get("payment_method") or "現金",
        source_file=source_file,
    )
    return rid
