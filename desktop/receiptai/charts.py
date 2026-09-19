"""Matplotlib chart helpers for Qt embedding."""

from __future__ import annotations

from typing import Sequence

import matplotlib

matplotlib.use("QtAgg")
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.figure import Figure
import matplotlib.pyplot as plt

PRIMARY = "#0f766e"
ACCENT = "#14b8a6"
MUTED = "#5f8a85"
COLORS = [
    "#0f766e",
    "#14b8a6",
    "#2dd4bf",
    "#5eead4",
    "#099268",
    "#0ca678",
    "#12b886",
    "#20c997",
    "#66d9e8",
]


def setup_japanese_font() -> None:
    plt.rcParams["font.family"] = [
        "Yu Gothic",
        "Meiryo",
        "MS Gothic",
        "DejaVu Sans",
    ]
    plt.rcParams["axes.unicode_minus"] = False


def make_category_pie(pairs: Sequence[tuple[str, float]]) -> Figure:
    setup_japanese_font()
    fig = Figure(figsize=(5.0, 3.4), dpi=100, facecolor="#f0fdfa")
    ax = fig.add_subplot(111)
    ax.set_facecolor("#f0fdfa")
    if not pairs:
        ax.text(0.5, 0.5, "データがありません", ha="center", va="center", color=MUTED)
        ax.axis("off")
        return fig
    labels = [p[0] for p in pairs]
    sizes = [p[1] for p in pairs]
    ax.pie(
        sizes,
        labels=labels,
        autopct=lambda pct: f"{pct:.0f}%" if pct >= 5 else "",
        colors=COLORS[: len(labels)],
        startangle=90,
        textprops={"fontsize": 8, "color": "#134e4a"},
    )
    ax.set_title("カテゴリ別割合", color=PRIMARY, fontsize=11, fontweight="bold")
    fig.tight_layout()
    return fig


def make_monthly_bars(pairs: Sequence[tuple[str, float]]) -> Figure:
    setup_japanese_font()
    fig = Figure(figsize=(5.0, 3.4), dpi=100, facecolor="#f0fdfa")
    ax = fig.add_subplot(111)
    ax.set_facecolor("#ffffff")
    if not pairs:
        ax.text(0.5, 0.5, "データがありません", ha="center", va="center", color=MUTED)
        ax.set_xticks([])
        ax.set_yticks([])
        return fig
    labels = [p[0] for p in pairs]
    values = [p[1] for p in pairs]
    ax.bar(labels, values, color=ACCENT, edgecolor=PRIMARY, linewidth=0.5)
    ax.set_title("月別支出", color=PRIMARY, fontsize=11, fontweight="bold")
    ax.tick_params(axis="x", labelrotation=45, labelsize=8)
    ax.tick_params(axis="y", labelsize=8)
    ax.set_ylabel("円", fontsize=8, color=MUTED)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    fig.tight_layout()
    return fig


def canvas_from_figure(fig: Figure) -> FigureCanvasQTAgg:
    return FigureCanvasQTAgg(fig)
