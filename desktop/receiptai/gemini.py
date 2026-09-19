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

RECEIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "shop_name": {"type": "string"},
        "date": {"type": "string"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "price": {"type": "number"},
                    "category": {"type": "string"},
                },
                "required": ["name", "price", "category"],
            },
        },
    },
    "required": ["shop_name", "date", "items"],
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
提供されたレシート画像またはテキストメモから情報を抽出してください。
- shop_name: 店舗名（不明なら「不明」）
- date: 日付 YYYY-MM-DD（不明なら {today}）
- items: 品目リスト（name, price, category）
カテゴリは次から選択: [{cats}]
JSONのみ出力してください。"""
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
    return json.loads(text)
