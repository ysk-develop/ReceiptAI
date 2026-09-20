"""Gemini API client for desktop (image / text memo)."""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from .config import CATEGORIES

API_BASE = "https://generativelanguage.googleapis.com/v1beta"

LINE_SCHEMA = {
    "type": "object",
    "properties": {
        "receipt_index": {"type": "integer"},
        "shop_name": {"type": "string"},
        "date": {"type": "string"},
        "total_amount": {"type": "number"},
        "name": {"type": "string"},
        "price": {"type": "number"},
        "category": {"type": "string"},
    },
    "required": [
        "receipt_index",
        "shop_name",
        "date",
        "total_amount",
        "name",
        "price",
        "category",
    ],
}

RECEIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "receipt_count": {"type": "integer"},
        "lines": {"type": "array", "items": LINE_SCHEMA},
    },
    "required": ["receipt_count", "lines"],
}


def _request(url: str, payload: dict[str, Any] | None = None, api_key: str = "") -> dict[str, Any]:
    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="GET" if data is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
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
    if isinstance(parsed.get("lines"), list) and parsed["lines"]:
        groups: dict[int, dict[str, Any]] = {}
        for line in parsed["lines"]:
            idx = int(line.get("receipt_index") or 1)
            if idx not in groups:
                date_str = str(line.get("date") or "").strip()
                if len(date_str) < 10:
                    date_str = today
                groups[idx] = {
                    "shop_name": str(line.get("shop_name") or "不明").strip() or "不明",
                    "date": date_str[:10],
                    "total_amount": float(line.get("total_amount") or 0),
                    "items": [],
                }
            g = groups[idx]
            name = str(line.get("name") or "").strip()
            price = float(line.get("price") or 0)
            if not name and not price:
                continue
            if re.match(r"^(小計|合計|税|消費税|内税|外税|お預り|お釣り|お会計)", name):
                continue
            g["items"].append(
                {
                    "name": name or "（未入力）",
                    "price": price,
                    "category": str(line.get("category") or "その他"),
                }
            )
            if float(line.get("total_amount") or 0) > 0:
                g["total_amount"] = float(line["total_amount"])
            if line.get("shop_name"):
                g["shop_name"] = str(line["shop_name"]).strip() or g["shop_name"]
            d = str(line.get("date") or "").strip()
            if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
                g["date"] = d

        out = []
        for i, key in enumerate(sorted(groups.keys())):
            r = groups[key]
            items_sum = sum(x["price"] for x in r["items"])
            total = float(r["total_amount"] or 0)
            if total <= 0:
                total = items_sum
            if not r["items"]:
                continue
            out.append({**r, "total_amount": total, "_index": i})
        return out

    if isinstance(parsed.get("receipts"), list) and parsed["receipts"]:
        raw_list = parsed["receipts"]
    elif parsed.get("items") or parsed.get("shop_name"):
        raw_list = [parsed]
    else:
        raw_list = []

    out = []
    for i, r in enumerate(raw_list):
        items = []
        for it in r.get("items") or []:
            items.append(
                {
                    "name": str(it.get("name") or "（未入力）"),
                    "price": float(it.get("price") or 0),
                    "category": str(it.get("category") or "その他"),
                }
            )
        items = [x for x in items if x["name"] or x["price"]]
        if not items:
            continue
        items_sum = sum(x["price"] for x in items)
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
                "_index": i,
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
日本の家計簿では税込の支払額を記録します。

【最重要・複数レシート】
- 画像の紙レシート枚数を数え receipt_count に入れる。
- 左右に並ぶレシートはすべて別番号 (1,2,3...)。同じ店でも紙が別なら別番号。
- lines に全レシートの全品目を漏れなく出す。1枚分だけの出力は誤り（1枚しかない場合を除く）。

【金額】price と total_amount は税込。小計・税・合計行は lines に入れない。
カテゴリ: [{cats}]
日付不明のみ {today}。JSONのみ。"""
    if memo.strip():
        prompt += f"\n\n【入力メモ】\n{memo.strip()}"

    media: list[dict[str, Any]] = []
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
        media.append({"inline_data": {"mime_type": mime, "data": b64}})

    if not media and not memo.strip():
        raise ValueError("画像またはテキストメモが必要です")

    def _call(parts: list[dict[str, Any]]) -> dict[str, Any]:
        body = {
            "contents": [{"parts": parts}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": RECEIPT_SCHEMA,
                "maxOutputTokens": 8192,
                "temperature": 0.1,
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

    parsed = _call([*media, {"text": prompt}])
    receipts = normalize_analysis_result(parsed, today)
    declared = int(parsed.get("receipt_count") or 0)

    if declared > len(receipts) and media:
        retry = (
            f"前回は receipt_count={declared} なのに {len(receipts)} 枚しか再構成できませんでした。"
            f"左から右へ全レシートの品目を lines に再出力してください。税込。JSONのみ。"
        )
        if memo.strip():
            retry += f"\n\n【入力メモ】\n{memo.strip()}"
        parsed2 = _call([*media, {"text": retry}])
        retried = normalize_analysis_result(parsed2, today)
        if len(retried) >= len(receipts):
            receipts = retried
            parsed = parsed2

    if not receipts:
        raise RuntimeError("レシートを検出できませんでした")
    return {"receipts": receipts, "raw": parsed, "receipt_count_declared": declared or len(receipts)}
