"""Gemini API client for desktop (image / text memo)."""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from .config import CATEGORIES

API_BASE = "https://generativelanguage.googleapis.com/v1beta"

RECEIPT_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "price": {"type": "number", "description": "税込金額"},
        "category": {"type": "string"},
    },
    "required": ["name", "price", "category"],
}

SINGLE_RECEIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "shop_name": {"type": "string"},
        "date": {"type": "string"},
        "total_amount": {"type": "number", "description": "税込合計"},
        "items": {"type": "array", "items": RECEIPT_ITEM_SCHEMA},
    },
    "required": ["shop_name", "date", "total_amount", "items"],
}

RECEIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "receipts": {
            "type": "array",
            "description": "画像内のレシートごと（店舗・日付が違うものは分ける）",
            "items": SINGLE_RECEIPT_SCHEMA,
        }
    },
    "required": ["receipts"],
}


def _request(url: str, payload: dict[str, Any] | None = None, api_key: str = "") -> dict[str, Any]:
    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="GET" if data is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body[:500]}") from e


def fetch_models(api_key: str) -> list[dict[str, str]]:
    url = f"{API_BASE}/models?key={urllib.parse.quote(api_key)}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body[:500]}") from e

    models = []
    for m in data.get("models") or []:
        name = m.get("name") or ""
        methods = m.get("supportedGenerationMethods") or []
        if "generateContent" not in methods:
            continue
        mid = name.replace("models/", "")
        if "gemini" not in mid.lower():
            continue
        models.append({"id": mid, "name": m.get("displayName") or mid})
    return models


def normalize_analysis_result(parsed: dict[str, Any], today: str) -> list[dict[str, Any]]:
    if isinstance(parsed.get("receipts"), list) and parsed["receipts"]:
        raw_list = parsed["receipts"]
    elif parsed.get("items") or parsed.get("shop_name"):
        raw_list = [parsed]
    else:
        raw_list = []

    out: list[dict[str, Any]] = []
    for r in raw_list:
        items = []
        for it in r.get("items") or []:
            items.append(
                {
                    "name": str(it.get("name") or "（未入力）"),
                    "price": float(it.get("price") or 0),
                    "category": str(it.get("category") or "その他"),
                }
            )
        items = [i for i in items if i["name"] or i["price"]]
        if not items:
            continue
        items_sum = sum(i["price"] for i in items)
        total = float(r.get("total_amount") or 0)
        if total <= 0:
            total = items_sum
        date_str = str(r.get("date") or "").strip()
        if len(date_str) < 10:
            date_str = today
        out.append(
            {
                "shop_name": str(r.get("shop_name") or "不明").strip() or "不明",
                "date": date_str[:10],
                "total_amount": total,
                "items": items,
            }
        )
    return out


def analyze_receipt(
    api_key: str,
    model: str,
    *,
    image_path: Path | None = None,
    memo: str = "",
    today: str = "",
) -> dict[str, Any]:
    from datetime import date as date_cls

    today = today or date_cls.today().isoformat()
    cats = ", ".join(CATEGORIES)
    prompt = f"""あなたは優秀な家計簿アシスタントです。
日本の家計簿では「実際に支払った税込金額」を記録します。

【金額ルール・最重要】
- 各品目の price は必ず税込（円）。
- 税抜単価しか無い場合は税込に換算し、total_amount はレシートの税込合計行を使う。
- 小計・消費税・合計の行は items に入れない。

【複数レシート・最重要】
- 1枚の写真に複数レシートがある場合、receipts を枚数分作る。
- 店舗・日付が違うものを1つにまとめない。
- 日付が読めないものだけ {today} を使う。

カテゴリ: [{cats}]
JSONのみ出力。"""
    if memo.strip():
        prompt += f"\n\n【入力メモ】\n{memo.strip()}"

    parts: list[dict[str, Any]] = []
    if image_path:
        raw = image_path.read_bytes()
        b64 = base64.b64encode(raw).decode("ascii")
        suffix = image_path.suffix.lower()
        mime = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(suffix, "image/jpeg")
        parts.append({"inline_data": {"mime_type": mime, "data": b64}})
    parts.append({"text": prompt})

    if len(parts) == 1 and not memo.strip():
        raise ValueError("画像またはテキストメモが必要です")

    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RECEIPT_SCHEMA,
        },
    }
    url = f"{API_BASE}/models/{model}:generateContent"
    data = _request(url, body, api_key=api_key)
    text = ""
    for p in (data.get("candidates") or [{}])[0].get("content", {}).get("parts") or []:
        text += p.get("text") or ""
    if not text:
        raise RuntimeError("AIからの応答が空です")
    parsed = json.loads(text)
    receipts = normalize_analysis_result(parsed, today)
    if not receipts:
        raise RuntimeError("レシートを検出できませんでした")
    return {"receipts": receipts, "raw": parsed}
