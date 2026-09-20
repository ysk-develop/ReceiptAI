"""App configuration stored in user home."""

from __future__ import annotations

import json
from pathlib import Path

APP_DIR = Path.home() / ".receiptai"
CONFIG_PATH = APP_DIR / "config.json"
DB_PATH = APP_DIR / "receipts.db"

DEFAULT_CONFIG = {
    "gas_url": "",
    "sync_folder": "",
    "gemini_api_key": "",
    "gemini_model": "gemini-2.0-flash",
    "archive_imported": True,
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
    return merged


def save_config(cfg: dict) -> None:
    ensure_app_dir()
    out = DEFAULT_CONFIG.copy()
    out.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    CONFIG_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
