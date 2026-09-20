"""Tax helpers for desktop (外税 → 税込)."""

from __future__ import annotations

from typing import Any


def clamp_rate(n: Any) -> float:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(100.0, round(v, 1)))


def normalize_rate_type(value: Any, default: str = "standard") -> str:
    if value in ("reduced", 8, "8"):
        return "reduced"
    if value in ("standard", 10, "10"):
        return "standard"
    return "reduced" if default == "reduced" else "standard"


def calc_inclusive(price_excl: float, rate_type: str, cfg: dict) -> dict[str, float | int]:
    excl = max(0, int(round(float(price_excl or 0))))
    rate = float(cfg.get("tax_reduced_rate") if rate_type == "reduced" else cfg.get("tax_standard_rate") or 10)
    if cfg.get("tax_rounding") == "round":
        tax = int(round(excl * rate / 100))
    else:
        tax = int(excl * rate // 100)
    return {"tax": tax, "incl": excl + tax, "rate": rate}
