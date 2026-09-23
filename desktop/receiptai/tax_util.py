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


def calc_exclusive_from_incl(price_incl: float, rate_type: str, cfg: dict) -> dict[str, float | int]:
    incl = max(0, int(round(float(price_incl or 0))))
    rate = float(cfg.get("tax_reduced_rate") if rate_type == "reduced" else cfg.get("tax_standard_rate") or 10)
    if rate <= 0:
        return {"excl": incl, "tax": 0, "rate": rate}
    excl = int((incl * 100) // (100 + rate))
    while excl < incl and int(calc_inclusive(excl, rate_type, cfg)["incl"]) < incl:
        excl += 1
    while excl > 0 and int(calc_inclusive(excl, rate_type, cfg)["incl"]) > incl:
        excl -= 1
    tax = int(calc_inclusive(excl, rate_type, cfg)["tax"])
    return {"excl": excl, "tax": tax, "rate": rate}


def suggest_price_basis(receipt: dict[str, Any], cfg: dict | None = None) -> tuple[str, str]:
    """Return (basis, reason). basis is 'exclusive' or 'inclusive'."""
    settings = cfg or {}
    items = receipt.get("items") or []
    printed_sum = sum(float(it.get("price_excl", it.get("price", 0)) or 0) for it in items)
    total = float(receipt.get("total_amount") or 0)
    if printed_sum <= 0 or total <= 0:
        return "exclusive", ""
    tol = max(2, int(round(total * 0.02)))
    as_printed = abs(printed_sum - total)
    converted = 0.0
    default_rt = str(settings.get("tax_default_rate_type") or "standard")
    for it in items:
        excl = float(it.get("price_excl", it.get("price", 0)) or 0)
        rt = normalize_rate_type(it.get("tax_rate_type"), default_rt)
        converted += float(calc_inclusive(excl, rt, settings)["incl"])
    as_excl = abs(converted - total)
    if as_printed <= tol and as_printed <= as_excl:
        return "inclusive", "合計と品目合計が近いため税込印字と推定"
    return "exclusive", ""

