"""GAS web app client (spreadsheet primary)."""

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


def ping(gas_url: str) -> dict[str, Any]:
    data = _get(gas_url, {"action": "ping"})
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "ping failed")
    return data


def list_receipts(gas_url: str, *, month: str = "", limit: int = 100) -> list[dict[str, Any]]:
    data = _get(gas_url, {"action": "list", "month": month, "limit": str(limit)})
    if data.get("status") != "ok":
        raise RuntimeError(data.get("message") or "list failed")
    return list(data.get("receipts") or [])


def get_receipt(gas_url: str, receipt_id: str) -> dict[str, Any]:
    data = _get(gas_url, {"action": "receipt", "id": receipt_id})
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


def save_receipt(gas_url: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = {"action": "save", **payload}
    data = _post(gas_url, body)
    if data.get("status") == "error":
        raise RuntimeError(data.get("message") or "save failed")
    return data
