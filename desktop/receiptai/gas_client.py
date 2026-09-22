"""GAS web app client (spreadsheet primary, multi-book)."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def normalize_gas_url(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if not u:
        raise ValueError("GAS URLが空です")
    if "script.google.com/macros/s/" not in u:
        raise ValueError("GASの /exec URL を指定してください")
    if "/dev" in u:
        raise ValueError("/dev ではなく /exec を使ってください")
    return u


def _get(url: str, params: dict[str, Any], timeout: int = 120) -> dict[str, Any]:
    q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None and v != ""})
    full = f"{normalize_gas_url(url)}?{q}"
    req = urllib.request.Request(full, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body[:400]}") from e


def _post(url: str, payload: dict[str, Any], timeout: int = 180) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        normalize_gas_url(url),
        data=body,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {err[:400]}") from e


def ping(gas_url: str, *, book_id: str = "") -> dict[str, Any]:
    params: dict[str, Any] = {"action": "ping"}
    if book_id:
        params["book"] = book_id
    data = _get(gas_url, params)
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "ping failed")
    return data


def list_books(gas_url: str) -> list[dict[str, Any]]:
    data = _get(gas_url, {"action": "books"})
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "books failed")
    return list(data.get("books") or [])


def add_book(gas_url: str, name: str) -> dict[str, Any]:
    data = _get(gas_url, {"action": "book_add", "name": name}, timeout=120)
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "book_add failed")
    return data


def rename_book(gas_url: str, book_id: str, name: str) -> dict[str, Any]:
    data = _get(
        gas_url,
        {"action": "book_rename", "id": book_id, "name": name},
        timeout=120,
    )
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "book_rename failed")
    return data


def delete_book(gas_url: str, book_id: str, *, delete_data: bool = True) -> dict[str, Any]:
    data = _get(
        gas_url,
        {
            "action": "book_delete",
            "id": book_id,
            "delete_data": "1" if delete_data else "0",
        },
        timeout=120,
    )
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "book_delete failed")
    return data


def list_receipts(
    gas_url: str,
    *,
    book_id: str = "",
    month: str = "",
    limit: int = 100,
) -> list[dict[str, Any]]:
    data = _get(
        gas_url,
        {
            "action": "list",
            "book": book_id,
            "month": month,
            "limit": str(limit),
        },
    )
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "list failed")
    return list(data.get("receipts") or [])


def get_receipt(gas_url: str, receipt_id: str, *, book_id: str = "") -> dict[str, Any]:
    data = _get(gas_url, {"action": "receipt", "book": book_id, "id": receipt_id})
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "receipt failed")
    return data


def get_image(gas_url: str, file_id: str) -> dict[str, Any]:
    data = _get(gas_url, {"action": "image", "id": file_id, "data": "1"}, timeout=180)
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "image failed")
    if not data.get("data_base64"):
        raise RuntimeError("画像データが空です")
    return data


def delete_receipt(
    gas_url: str,
    receipt_id: str,
    *,
    book_id: str = "",
    delete_image: bool = True,
) -> dict[str, Any]:
    data = _get(
        gas_url,
        {
            "action": "delete",
            "book": book_id,
            "id": receipt_id,
            "delete_image": "1" if delete_image else "0",
        },
        timeout=120,
    )
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "delete failed")
    return data


def find_duplicates(
    gas_url: str,
    *,
    book_id: str = "",
    shop_name: str,
    date: str,
    total_amount: float | int,
    item_count: int | None = None,
) -> list[dict[str, Any]]:
    params: dict[str, Any] = {
        "action": "duplicates",
        "book": book_id,
        "shop": shop_name,
        "date": date,
        "total": str(int(round(float(total_amount or 0)))),
    }
    if item_count is not None:
        params["items"] = str(int(item_count))
    data = _get(gas_url, params, timeout=60)
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "duplicates failed")
    return list(data.get("duplicates") or [])


def save_receipt(gas_url: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = {"action": "save", **payload}
    if payload.get("book") or payload.get("book_id"):
        body["book"] = payload.get("book") or payload.get("book_id")
    data = _post(gas_url, body)
    if data.get("status") == "error":
        raise RuntimeError(data.get("message") or "save failed")
    return data
