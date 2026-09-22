"""App configuration stored in user home."""

from __future__ import annotations

import json
from pathlib import Path

APP_DIR = Path.home() / ".receiptai"
CONFIG_PATH = APP_DIR / "config.json"
DB_PATH = APP_DIR / "receipts.db"

DEFAULT_PAYMENT_METHODS = ["現金", "WAON", "PayPay"]

DEFAULT_CONFIG = {
    "gas_url": "",
    "book_id": "",
    "sync_folder": "",
    "gemini_api_key": "",
    "gemini_model": "gemini-2.0-flash",
    "archive_imported": True,
    "tax_standard_rate": 10,
    "tax_reduced_rate": 8,
    "tax_default_rate_type": "standard",
    "tax_rounding": "floor",
    "payment_methods": list(DEFAULT_PAYMENT_METHODS),
}

CATEGORIES = [
    "食費",
    "日用品",
    "交通費",
    "交際費",
    "衣服・美容",
    "趣味・教養",
    "医療・健康",
    "水道・光熱費",
    "その他",
]


def ensure_app_dir() -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    ensure_app_dir()
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG.copy())
        return DEFAULT_CONFIG.copy()
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {}
    merged = DEFAULT_CONFIG.copy()
    merged.update({k: v for k, v in data.items() if k in DEFAULT_CONFIG})
    merged["payment_methods"] = normalize_payment_methods(merged.get("payment_methods"))
    return merged


def save_config(cfg: dict) -> None:
    ensure_app_dir()
    out = DEFAULT_CONFIG.copy()
    out.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    out["payment_methods"] = normalize_payment_methods(out.get("payment_methods"))
    CONFIG_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize_payment_methods(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return list(DEFAULT_PAYMENT_METHODS)
    cleaned: list[str] = []
    for x in raw:
        name = str(x or "").strip()
        if name and name not in cleaned:
            cleaned.append(name)
    return cleaned or list(DEFAULT_PAYMENT_METHODS)


def get_payment_methods(cfg: dict | None = None) -> list[str]:
    data = cfg if cfg is not None else load_config()
    return normalize_payment_methods(data.get("payment_methods"))


def ensure_payment_method(name: str, cfg: dict | None = None) -> list[str]:
    data = cfg if cfg is not None else load_config()
    methods = get_payment_methods(data)
    n = str(name or "").strip()
    if n and n not in methods:
        methods.append(n)
        data["payment_methods"] = methods
        save_config(data)
    return methods
