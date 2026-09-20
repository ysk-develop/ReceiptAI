"""PyQt6 desktop UI for ReceiptAI."""

from __future__ import annotations

import base64
import sys
from datetime import date
from pathlib import Path

from PyQt6.QtCore import Qt, QThread, QUrl, pyqtSignal
from PyQt6.QtGui import QDesktopServices, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QStatusBar,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from . import charts, db, gas_client, gemini, importer, sheets_sync
from .config import CATEGORIES, DB_PATH, load_config, save_config
from .image_util import resize_to_jpeg_base64
from .styles import APP_STYLESHEET
from .tax_util import calc_inclusive, normalize_rate_type

LIST_ROW_HEIGHT = 40
TABLE_BTN_W = 72
TABLE_BTN_H = 26


def _btn(text: str, object_name: str | None = None) -> QPushButton:
    b = QPushButton(text)
    if object_name:
        b.setObjectName(object_name)
    return b


def _make_compact_button(
    text: str,
    object_name: str,
    *,
    width: int = TABLE_BTN_W,
    height: int = TABLE_BTN_H,
) -> QPushButton:
    """Fixed-size button; colors via inline sheet so global padding cannot inflate it."""
    colors = {
        "SecondaryButton": ("#e0f2f1", "#134e4a", "#b2dfdb"),
        "AccentButton": ("#14b8a6", "#ffffff", "#0d9488"),
        "DangerButton": ("#dc2626", "#ffffff", "#b91c1c"),
        "GhostDangerButton": ("#fee2e2", "#dc2626", "#fecaca"),
    }
    bg, fg, hover = colors.get(object_name, ("#0f766e", "#ffffff", "#0d5f58"))
    btn = QPushButton(text)
    btn.setObjectName(object_name)
    btn.setCursor(Qt.CursorShape.PointingHandCursor)
    btn.setFixedSize(width, height)
    btn.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
    btn.setStyleSheet(
        "QPushButton {"
        f"background-color:{bg}; color:{fg}; "
        f"min-height:{height}px; max-height:{height}px; "
        f"min-width:{width}px; max-width:{width}px; "
        "padding:0px; margin:0px; border:none; border-radius:6px; "
        "font-size:12px; font-weight:600;"
        "}"
        f"QPushButton:hover {{ background-color:{hover}; }}"
        "QPushButton:disabled { background-color:#ccfbf1; color:#5f8a85; }"
    )
    return btn


def _table_cell_button(
    text: str,
    object_name: str,
    callback,
    *,
    width: int = TABLE_BTN_W,
    height: int = TABLE_BTN_H,
) -> QWidget:
    """
    Center a compact button inside a table cell.
    Margins are derived from LIST_ROW_HEIGHT so the button never clips.
    """
    btn = _make_compact_button(text, object_name, width=width, height=height)
    btn.clicked.connect(callback)

    vpad = max(0, (LIST_ROW_HEIGHT - height) // 2)
    hpad = 8
    cell = QWidget()
    cell.setFixedHeight(LIST_ROW_HEIGHT)
    lay = QHBoxLayout(cell)
    lay.setContentsMargins(hpad, vpad, hpad, vpad)
    lay.setSpacing(0)
    lay.addStretch(1)
    lay.addWidget(btn, 0, Qt.AlignmentFlag.AlignCenter)
    lay.addStretch(1)
    return cell


def _card() -> QFrame:
    f = QFrame()
    f.setObjectName("Card")
    return f


class Worker(QThread):
    finished_ok = pyqtSignal(object)
    finished_err = pyqtSignal(str)

    def __init__(self, fn, *args, **kwargs):
        super().__init__()
        self._fn = fn
        self._args = args
        self._kwargs = kwargs

    def run(self) -> None:
        try:
            self.finished_ok.emit(self._fn(*self._args, **self._kwargs))
        except Exception as exc:  # noqa: BLE001
            self.finished_err.emit(str(exc))


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("レシート自動仕分け家計簿")
        self.resize(1040, 720)
        self.setMinimumSize(900, 600)

        self.cfg = load_config()
        db.init_db()
        self._selected_id: int | None = None
        self._workers: list[Worker] = []
        self._chart_widgets: list[QWidget] = []
        self._analyzed_receipts: list[dict] = []
        self._analysis_index: int = 0

        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        layout.addWidget(self._build_header())
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs, 1)

        self._build_list_tab()
        self._build_edit_tab()
        self._build_charts_tab()
        self._build_analyze_tab()
        self._build_settings_tab()

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.status.showMessage(f"DB: {DB_PATH}")

        self.refresh_all()

    def _build_header(self) -> QFrame:
        bar = QFrame()
        bar.setObjectName("HeaderBar")
        bar.setFixedHeight(72)
        v = QVBoxLayout(bar)
        v.setContentsMargins(16, 10, 16, 10)
        title = QLabel("🧾 レシート自動仕分け家計簿")
        title.setObjectName("HeaderTitle")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        sub = QLabel("スプレッドシート同期・集計・グラフ表示")
        sub.setObjectName("HeaderSub")
        sub.setAlignment(Qt.AlignmentFlag.AlignCenter)
        v.addWidget(title)
        v.addWidget(sub)
        return bar

    # ── list ───────────────────────────────────────────────
    def _build_list_tab(self) -> None:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(12, 12, 12, 12)

        card = _card()
        top = QHBoxLayout(card)
        top.setContentsMargins(12, 12, 12, 12)

        top.addWidget(QLabel("月"))
        self.month_combo = QComboBox()
        self.month_combo.addItem("すべて")
        self.month_combo.currentTextChanged.connect(lambda _t: self.refresh_list())
        top.addWidget(self.month_combo)

        btn_sync = _btn("シートから同期")
        btn_sync.clicked.connect(self.do_sync_sheet)
        top.addWidget(btn_sync)

        btn_import = _btn("JSON取込", "SecondaryButton")
        btn_import.clicked.connect(self.do_import)
        top.addWidget(btn_import)

        btn_csv = _btn("CSV出力", "AccentButton")
        btn_csv.clicked.connect(self.do_export_csv)
        top.addWidget(btn_csv)

        btn_new = _btn("新規手入力", "SecondaryButton")
        btn_new.clicked.connect(self.new_receipt)
        top.addWidget(btn_new)
        top.addStretch(1)

        layout.addWidget(card)

        self.summary_label = QLabel("")
        self.summary_label.setObjectName("Muted")
        layout.addWidget(self.summary_label)

        table_card = _card()
        tv = QVBoxLayout(table_card)
        tv.setContentsMargins(8, 8, 8, 8)
        self.list_table = QTableWidget(0, 6)
        self.list_table.setHorizontalHeaderLabels(["日付", "店舗", "合計", "編集", "画像", "削除"])
        self.list_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.list_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.list_table.verticalHeader().setVisible(False)
        self.list_table.setShowGrid(True)
        self.list_table.setAlternatingRowColors(True)
        hdr = self.list_table.horizontalHeader()
        hdr.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        hdr.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        hdr.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        hdr.setSectionResizeMode(3, QHeaderView.ResizeMode.Fixed)
        hdr.setSectionResizeMode(4, QHeaderView.ResizeMode.Fixed)
        hdr.setSectionResizeMode(5, QHeaderView.ResizeMode.Fixed)
        self.list_table.setColumnWidth(3, 88)
        self.list_table.setColumnWidth(4, 88)
        self.list_table.setColumnWidth(5, 88)
        self.list_table.verticalHeader().setDefaultSectionSize(LIST_ROW_HEIGHT)
        self.list_table.verticalHeader().setMinimumSectionSize(LIST_ROW_HEIGHT)
        tv.addWidget(self.list_table)
        layout.addWidget(table_card, 1)

        self.tabs.addTab(page, "一覧")

    def refresh_months(self) -> None:
        months = db.list_months()
        current = self.month_combo.currentText()
        self.month_combo.blockSignals(True)
        self.month_combo.clear()
        self.month_combo.addItem("すべて")
        self.month_combo.addItems(months)
        idx = self.month_combo.findText(current)
        self.month_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self.month_combo.blockSignals(False)

        self.chart_month_combo.blockSignals(True)
        cur2 = self.chart_month_combo.currentText()
        self.chart_month_combo.clear()
        self.chart_month_combo.addItem("すべて")
        self.chart_month_combo.addItems(months)
        idx2 = self.chart_month_combo.findText(cur2)
        self.chart_month_combo.setCurrentIndex(idx2 if idx2 >= 0 else 0)
        self.chart_month_combo.blockSignals(False)

    def refresh_list(self) -> None:
        ym = self.month_combo.currentText()
        year_month = None if ym == "すべて" else ym
        rows = db.list_receipts(year_month=year_month)
        total = sum(float(r["total_amount"] or 0) for r in rows)
        suffix = f"（{ym}）" if year_month else ""
        self.summary_label.setText(f"{len(rows)} 件 / 合計 {total:,.0f} 円{suffix}")

        self.list_table.setRowCount(0)
        for r in rows:
            row = self.list_table.rowCount()
            self.list_table.insertRow(row)
            self.list_table.setRowHeight(row, LIST_ROW_HEIGHT)
            self.list_table.setItem(row, 0, QTableWidgetItem(str(r["date"])))
            self.list_table.setItem(row, 1, QTableWidgetItem(str(r["shop_name"])))
            amt = QTableWidgetItem(f'{float(r["total_amount"]):,.0f} 円')
            amt.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.list_table.setItem(row, 2, amt)

            rid = int(r["id"])
            self.list_table.setCellWidget(
                row,
                3,
                _table_cell_button(
                    "編集",
                    "SecondaryButton",
                    lambda _=False, i=rid: self.open_receipt(i),
                ),
            )

            view_url = str(r.get("image_view_url") or "")
            file_id = str(r.get("image_file_id") or "")
            has_img = bool(view_url or file_id)
            img_cell = _table_cell_button(
                "画像",
                "AccentButton",
                lambda _=False, u=view_url, f=file_id: self.show_receipt_image(u, f),
            )
            img_btn = img_cell.findChild(QPushButton)
            if img_btn is not None:
                img_btn.setEnabled(has_img)
            self.list_table.setCellWidget(row, 4, img_cell)

            cloud_id = str(r.get("cloud_receipt_id") or "")
            self.list_table.setCellWidget(
                row,
                5,
                _table_cell_button(
                    "削除",
                    "DangerButton",
                    lambda _=False, i=rid, c=cloud_id, shop=str(r["shop_name"]), d=str(r["date"]):
                    self.delete_receipt_row(i, c, shop, d),
                ),
            )

    # ── edit ───────────────────────────────────────────────
    def _build_edit_tab(self) -> None:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(12, 12, 12, 12)

        form = _card()
        fl = QHBoxLayout(form)
        fl.setContentsMargins(12, 12, 12, 12)

        nav = QVBoxLayout()
        nav.addWidget(QLabel("検出レシート"))
        self.receipt_combo = QComboBox()
        self.receipt_combo.currentIndexChanged.connect(self._on_receipt_combo_changed)
        nav.addWidget(self.receipt_combo)
        fl.addLayout(nav, 1)

        left = QVBoxLayout()
        left.addWidget(QLabel("店舗名"))
        self.shop_edit = QLineEdit()
        left.addWidget(self.shop_edit)
        fl.addLayout(left, 2)

        right = QVBoxLayout()
        right.addWidget(QLabel("日付 (YYYY-MM-DD)"))
        self.date_edit = QLineEdit(date.today().isoformat())
        right.addWidget(self.date_edit)
        fl.addLayout(right, 1)
        layout.addWidget(form)

        items_card = _card()
        iv = QVBoxLayout(items_card)
        iv.setContentsMargins(12, 12, 12, 12)
        title = QLabel("明細")
        title.setObjectName("SectionTitle")
        iv.addWidget(title)

        self.items_table = QTableWidget(0, 6)
        self.items_table.setHorizontalHeaderLabels(["品目", "税抜", "税率", "税込", "カテゴリ", ""])
        self.items_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.items_table.verticalHeader().setVisible(False)
        self.items_table.setColumnWidth(1, 80)
        self.items_table.setColumnWidth(2, 100)
        self.items_table.setColumnWidth(3, 80)
        self.items_table.setColumnWidth(4, 120)
        self.items_table.setColumnWidth(5, 48)
        self.items_table.verticalHeader().setDefaultSectionSize(LIST_ROW_HEIGHT)
        self.items_table.itemChanged.connect(self._on_item_changed)
        iv.addWidget(self.items_table, 1)

        bottom = QHBoxLayout()
        add_btn = _btn("+ 行追加", "SecondaryButton")
        add_btn.clicked.connect(lambda: self._add_item_row())
        bottom.addWidget(add_btn)
        self.edit_total = QLabel("税込合計 0 円")
        self.edit_total.setObjectName("SectionTitle")
        bottom.addWidget(self.edit_total)
        bottom.addStretch(1)

        del_btn = _btn("削除", "DangerButton")
        del_btn.clicked.connect(self.delete_receipt)
        bottom.addWidget(del_btn)
        save_btn = _btn("保存")
        save_btn.clicked.connect(self.save_receipt)
        bottom.addWidget(save_btn)
        iv.addLayout(bottom)
        layout.addWidget(items_card, 1)

        self.tabs.addTab(page, "編集")

    def _clear_items(self) -> None:
        self.items_table.blockSignals(True)
        self.items_table.setRowCount(0)
        self.items_table.blockSignals(False)
        self._recalc_total()

    def _add_item_row(
        self,
        name: str = "",
        price: float | int | str = 0,
        category: str = "食費",
        tax_rate_type: str = "",
    ) -> None:
        self.items_table.blockSignals(True)
        row = self.items_table.rowCount()
        self.items_table.insertRow(row)
        self.items_table.setRowHeight(row, LIST_ROW_HEIGHT)
        self.items_table.setItem(row, 0, QTableWidgetItem(str(name)))

        spin = QSpinBox()
        spin.setRange(0, 10_000_000)
        try:
            spin.setValue(int(float(price or 0)))
        except (TypeError, ValueError):
            spin.setValue(0)
        spin.valueChanged.connect(self._recalc_total)
        self.items_table.setCellWidget(row, 1, spin)

        rate_type = normalize_rate_type(
            tax_rate_type or self.cfg.get("tax_default_rate_type"),
            self.cfg.get("tax_default_rate_type") or "standard",
        )
        tax_combo = QComboBox()
        std = self.cfg.get("tax_standard_rate", 10)
        red = self.cfg.get("tax_reduced_rate", 8)
        tax_combo.addItem(f"{std}%", "standard")
        tax_combo.addItem(f"{red}%", "reduced")
        tax_combo.setCurrentIndex(1 if rate_type == "reduced" else 0)
        tax_combo.currentIndexChanged.connect(self._recalc_total)
        self.items_table.setCellWidget(row, 2, tax_combo)

        incl_item = QTableWidgetItem("0")
        incl_item.setFlags(incl_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
        self.items_table.setItem(row, 3, incl_item)

        combo = QComboBox()
        combo.addItems(CATEGORIES)
        if category in CATEGORIES:
            combo.setCurrentText(category)
        else:
            combo.setCurrentText("その他")
        self.items_table.setCellWidget(row, 4, combo)

        rm = _make_compact_button("✕", "GhostDangerButton", width=28, height=TABLE_BTN_H)
        rm.clicked.connect(self._remove_item_row_by_button)
        vpad = max(0, (LIST_ROW_HEIGHT - TABLE_BTN_H) // 2)
        cell = QWidget()
        cell.setFixedHeight(LIST_ROW_HEIGHT)
        lay = QHBoxLayout(cell)
        lay.setContentsMargins(8, vpad, 8, vpad)
        lay.setSpacing(0)
        lay.addStretch(1)
        lay.addWidget(rm, 0, Qt.AlignmentFlag.AlignCenter)
        lay.addStretch(1)
        self.items_table.setCellWidget(row, 5, cell)
        self.items_table.blockSignals(False)
        self._recalc_total()

    def _remove_item_row_by_button(self) -> None:
        btn = self.sender()
        if btn is None:
            return
        for row in range(self.items_table.rowCount()):
            cell = self.items_table.cellWidget(row, 5)
            if cell is None:
                continue
            if cell is btn or cell.findChild(QPushButton) is btn:
                self.items_table.removeRow(row)
                self._recalc_total()
                return

    def _on_item_changed(self, _item: QTableWidgetItem) -> None:
        self._recalc_total()

    def _collect_items_raw(self) -> list[dict]:
        items = []
        for row in range(self.items_table.rowCount()):
            name_item = self.items_table.item(row, 0)
            name = name_item.text().strip() if name_item else ""
            spin = self.items_table.cellWidget(row, 1)
            price_excl = int(spin.value()) if isinstance(spin, QSpinBox) else 0
            tax_combo = self.items_table.cellWidget(row, 2)
            rate_type = "standard"
            if isinstance(tax_combo, QComboBox):
                rate_type = tax_combo.currentData() or "standard"
            cat_combo = self.items_table.cellWidget(row, 4)
            cat = cat_combo.currentText() if isinstance(cat_combo, QComboBox) else "その他"
            if name or price_excl:
                items.append(
                    {
                        "name": name or "（未入力）",
                        "price": price_excl,
                        "price_excl": price_excl,
                        "tax_rate_type": rate_type,
                        "category": cat,
                    }
                )
        return items

    def _collect_items(self) -> list[dict]:
        """税込 price で返す（保存・合計用）."""
        out = []
        for it in self._collect_items_raw():
            conv = calc_inclusive(it["price_excl"], it["tax_rate_type"], self.cfg)
            out.append(
                {
                    "name": it["name"],
                    "price": float(conv["incl"]),
                    "price_excl": it["price_excl"],
                    "tax_rate": conv["rate"],
                    "tax_rate_type": it["tax_rate_type"],
                    "category": it["category"],
                }
            )
        return out

    def _recalc_total(self) -> None:
        items = self._collect_items()
        for row, it in enumerate(self._collect_items_raw()):
            conv = calc_inclusive(it["price_excl"], it["tax_rate_type"], self.cfg)
            cell = self.items_table.item(row, 3)
            if cell:
                cell.setText(f'{int(conv["incl"]):,}')
        total = sum(i["price"] for i in items)
        self.edit_total.setText(f"税込合計 {total:,.0f} 円")

    def new_receipt(self) -> None:
        self._selected_id = None
        self.shop_edit.clear()
        self.date_edit.setText(date.today().isoformat())
        self._clear_items()
        self._add_item_row()
        self.tabs.setCurrentIndex(1)

    def open_receipt(self, receipt_id: int) -> None:
        data = db.get_receipt(receipt_id)
        if not data:
            QMessageBox.critical(self, "エラー", "レシートが見つかりません")
            return
        self._selected_id = receipt_id
        self.shop_edit.setText(data["shop_name"])
        self.date_edit.setText(data["date"])
        self._clear_items()
        for it in data["items"]:
            self._add_item_row(it["name"], it["price"], it["category"], it.get("tax_rate_type", ""))
        if not data["items"]:
            self._add_item_row()
        self.tabs.setCurrentIndex(1)

    def save_receipt(self) -> None:
        shop = self.shop_edit.text().strip() or "不明"
        d = self.date_edit.text().strip()
        items = self._collect_items()
        if not d:
            QMessageBox.warning(self, "入力", "日付を入力してください")
            return
        if not items:
            QMessageBox.warning(self, "入力", "明細を1件以上入力してください")
            return
        try:
            if self._selected_id is None:
                rid, _ = db.insert_receipt(shop, d, items)
                self._selected_id = rid
            else:
                db.update_receipt(self._selected_id, shop, d, items)
            QMessageBox.information(self, "保存", "保存しました")
            self.refresh_all()
            self.tabs.setCurrentIndex(0)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "保存エラー", str(exc))

    def delete_receipt(self) -> None:
        if self._selected_id is None:
            QMessageBox.information(self, "削除", "削除するレシートが選択されていません")
            return
        if QMessageBox.question(self, "確認", "このレシートを削除しますか？") != QMessageBox.StandardButton.Yes:
            return
        db.delete_receipt(self._selected_id)
        self._selected_id = None
        self.new_receipt()
        self.refresh_all()
        self.tabs.setCurrentIndex(0)

    # ── charts ─────────────────────────────────────────────
    def _build_charts_tab(self) -> None:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(12, 12, 12, 12)

        top = _card()
        hl = QHBoxLayout(top)
        hl.setContentsMargins(12, 12, 12, 12)
        hl.addWidget(QLabel("対象月"))
        self.chart_month_combo = QComboBox()
        self.chart_month_combo.addItem("すべて")
        self.chart_month_combo.currentTextChanged.connect(lambda _t: self.refresh_charts())
        hl.addWidget(self.chart_month_combo)
        refresh = _btn("更新")
        refresh.clicked.connect(self.refresh_charts)
        hl.addWidget(refresh)
        hl.addStretch(1)
        layout.addWidget(top)

        charts_row = QHBoxLayout()
        self.pie_host = _card()
        self.pie_layout = QVBoxLayout(self.pie_host)
        self.pie_layout.setContentsMargins(8, 8, 8, 8)
        self.bar_host = _card()
        self.bar_layout = QVBoxLayout(self.bar_host)
        self.bar_layout.setContentsMargins(8, 8, 8, 8)
        charts_row.addWidget(self.pie_host, 1)
        charts_row.addWidget(self.bar_host, 1)
        layout.addLayout(charts_row, 1)

        self.tabs.addTab(page, "グラフ")

    def refresh_charts(self) -> None:
        for w in self._chart_widgets:
            w.setParent(None)
            w.deleteLater()
        self._chart_widgets.clear()

        ym = self.chart_month_combo.currentText()
        year_month = None if ym == "すべて" else ym
        try:
            pie = charts.canvas_from_figure(
                charts.make_category_pie(db.category_totals(year_month))
            )
            bar = charts.canvas_from_figure(charts.make_monthly_bars(db.monthly_totals()))
        except Exception as exc:  # noqa: BLE001
            # Never block app startup / tab switch on chart errors
            err = QLabel(f"グラフを描画できませんでした\n{exc}")
            err.setObjectName("Muted")
            err.setWordWrap(True)
            self.pie_layout.addWidget(err)
            self._chart_widgets.append(err)
            return
        self.pie_layout.addWidget(pie)
        self.bar_layout.addWidget(bar)
        self._chart_widgets.extend([pie, bar])

    # ── AI ─────────────────────────────────────────────────
    def _build_analyze_tab(self) -> None:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(12, 12, 12, 12)

        card = _card()
        v = QVBoxLayout(card)
        v.setContentsMargins(12, 12, 12, 12)
        hint = QLabel("PC上の画像またはメモをGeminiで解析し、編集タブへ送ります。保存時にスプレッドシート＋画像(1280px)へ送れます。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)
        v.addWidget(hint)

        row = QHBoxLayout()
        self.image_edit = QLineEdit()
        row.addWidget(self.image_edit, 1)
        pick = _btn("画像選択")
        pick.clicked.connect(self.pick_image)
        row.addWidget(pick)
        v.addLayout(row)

        v.addWidget(QLabel("テキストメモ"))
        self.memo_edit = QTextEdit()
        self.memo_edit.setFixedHeight(100)
        v.addWidget(self.memo_edit)

        self.analyze_status = QLabel("")
        self.analyze_status.setObjectName("Muted")
        v.addWidget(self.analyze_status)

        run_btn = _btn("AIで解析して編集へ")
        run_btn.clicked.connect(self.do_analyze)
        v.addWidget(run_btn, alignment=Qt.AlignmentFlag.AlignLeft)

        save_cloud = _btn("解析結果をシートへ保存（画像付き）", "AccentButton")
        save_cloud.clicked.connect(self.save_current_to_sheet)
        v.addWidget(save_cloud, alignment=Qt.AlignmentFlag.AlignLeft)
        v.addStretch(1)
        layout.addWidget(card)
        self.tabs.addTab(page, "AI解析")

    def pick_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "レシート画像",
            "",
            "Images (*.png *.jpg *.jpeg *.webp *.gif);;All (*.*)",
        )
        if path:
            self.image_edit.setText(path)

    def do_analyze(self) -> None:
        key = self.cfg.get("gemini_api_key") or ""
        model = self.cfg.get("gemini_model") or "gemini-2.0-flash"
        if not key:
            QMessageBox.warning(self, "設定", "設定タブでGemini APIキーを保存してください")
            self.tabs.setCurrentIndex(4)
            return
        image = self.image_edit.text().strip()
        memo = self.memo_edit.toPlainText().strip()
        if not image and not memo:
            QMessageBox.warning(self, "入力", "画像またはメモを入力してください")
            return

        self.analyze_status.setText("解析中…")
        worker = Worker(
            gemini.analyze_receipt,
            key,
            model,
            image_path=Path(image) if image else None,
            memo=memo,
        )
        worker.finished_ok.connect(self._apply_analysis)
        worker.finished_err.connect(self._analyze_failed)
        self._workers.append(worker)
        worker.start()

    def _apply_analysis(self, result: object) -> None:
        data = result if isinstance(result, dict) else {}
        receipts = data.get("receipts") if isinstance(data.get("receipts"), list) else []
        if not receipts and (data.get("items") or data.get("shop_name")):
            receipts = [data]
        if not receipts:
            self._analyze_failed("レシートを検出できませんでした")
            return

        self._analyzed_receipts = receipts
        self._analysis_index = 0
        self._selected_id = None
        self.receipt_combo.blockSignals(True)
        self.receipt_combo.clear()
        for i, r in enumerate(receipts):
            label = f"{i + 1}. {r.get('shop_name') or '不明'} / {r.get('date') or ''} ({len(r.get('items') or [])}件)"
            self.receipt_combo.addItem(label)
        self.receipt_combo.blockSignals(False)
        self._load_analyzed_receipt(0)
        n = len(receipts)
        self.analyze_status.setText(
            f"解析完了。{n} 枚検出（税込）。編集タブで切り替えて確認してください。"
            if n > 1
            else "解析完了。税込金額を確認して保存してください。"
        )
        self.tabs.setCurrentIndex(1)

    def _on_receipt_combo_changed(self, index: int) -> None:
        if index < 0 or not self._analyzed_receipts:
            return
        self._stash_editor_to_analysis()
        self._load_analyzed_receipt(index)

    def _stash_editor_to_analysis(self) -> None:
        if not self._analyzed_receipts:
            return
        i = self._analysis_index
        if i < 0 or i >= len(self._analyzed_receipts):
            return
        items = self._collect_items_raw()
        self._analyzed_receipts[i] = {
            **self._analyzed_receipts[i],
            "shop_name": self.shop_edit.text().strip() or "不明",
            "date": self.date_edit.text().strip() or date.today().isoformat(),
            "items": items,
            "total_amount": self._analyzed_receipts[i].get("total_amount") or 0,
        }

    def _load_analyzed_receipt(self, index: int) -> None:
        if index < 0 or index >= len(self._analyzed_receipts):
            return
        self._analysis_index = index
        r = self._analyzed_receipts[index]
        self.shop_edit.setText(str(r.get("shop_name") or ""))
        self.date_edit.setText(str(r.get("date") or date.today().isoformat()))
        self._clear_items()
        for it in r.get("items") or []:
            self._add_item_row(
                it.get("name", ""),
                it.get("price", 0),
                it.get("category", "その他"),
                it.get("tax_rate_type", ""),
            )
        if self.items_table.rowCount() == 0:
            self._add_item_row()
        if self.receipt_combo.currentIndex() != index:
            self.receipt_combo.blockSignals(True)
            self.receipt_combo.setCurrentIndex(index)
            self.receipt_combo.blockSignals(False)

    def _analyze_failed(self, msg: str) -> None:
        self.analyze_status.setText("解析失敗")
        QMessageBox.critical(self, "解析エラー", msg)

    # ── settings ───────────────────────────────────────────
    def _build_settings_tab(self) -> None:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(0)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)

        content = QWidget()
        content.setMinimumWidth(520)
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(12, 12, 12, 12)
        content_layout.setSpacing(12)

        card = _card()
        v = QVBoxLayout(card)
        v.setContentsMargins(16, 16, 16, 16)
        v.setSpacing(12)

        def _section(title: str) -> None:
            lbl = QLabel(title)
            lbl.setObjectName("SectionTitle")
            lbl.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
            v.addWidget(lbl)

        def _hint(text: str) -> QLabel:
            lbl = QLabel(text)
            lbl.setObjectName("Muted")
            lbl.setWordWrap(True)
            lbl.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Minimum)
            v.addWidget(lbl)
            return lbl

        def _fix_btn(btn: QPushButton) -> QPushButton:
            btn.setMinimumHeight(36)
            btn.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
            return btn

        def _fix_edit(w: QWidget) -> QWidget:
            w.setMinimumHeight(36)
            w.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            return w

        _section("スプレッドシート連携（GAS）")
        _hint(
            "スマホと同じ GAS /exec URL。正本はスプレッドシートです。"
            "PCの一覧はローカルキャッシュ（SQLite）なので、シートで消しても同期するまで残ることがあります。"
        )
        grow = QHBoxLayout()
        grow.setSpacing(8)
        self.gas_edit = QLineEdit(self.cfg.get("gas_url") or "")
        self.gas_edit.setPlaceholderText("https://script.google.com/macros/s/.../exec")
        _fix_edit(self.gas_edit)
        grow.addWidget(self.gas_edit, 1)
        test_gas = _fix_btn(_btn("接続テスト", "SecondaryButton"))
        test_gas.clicked.connect(self.test_gas)
        grow.addWidget(test_gas)
        v.addLayout(grow)

        clear_btn = _fix_btn(_btn("ローカル一覧を全消去", "DangerButton"))
        clear_btn.clicked.connect(self.clear_local_db)
        v.addWidget(clear_btn, alignment=Qt.AlignmentFlag.AlignLeft)
        _hint(f"PC内のキャッシュ DB だけ消します（シートは消えません）。\n{DB_PATH}")

        _section("（任意）旧JSON同期フォルダ")
        _hint("以前の JSON 取込用。新規運用ではシート同期を使ってください。")
        row = QHBoxLayout()
        row.setSpacing(8)
        self.sync_edit = QLineEdit(self.cfg.get("sync_folder") or "")
        _fix_edit(self.sync_edit)
        row.addWidget(self.sync_edit, 1)
        browse = _fix_btn(_btn("参照", "SecondaryButton"))
        browse.clicked.connect(self.pick_sync_folder)
        row.addWidget(browse)
        v.addLayout(row)

        self.archive_check = QCheckBox("取込後に JSON を _imported フォルダへ移動")
        self.archive_check.setChecked(bool(self.cfg.get("archive_imported", True)))
        self.archive_check.setMinimumHeight(28)
        v.addWidget(self.archive_check)

        _section("消費税設定")
        _hint("税抜の個別金額に対し、設定税率で税込を自動計算します（初期は税額切り捨て）。")
        tax_row = QHBoxLayout()
        tax_row.setSpacing(8)
        self.tax_std = QSpinBox()
        self.tax_std.setRange(0, 100)
        self.tax_std.setValue(int(self.cfg.get("tax_standard_rate") or 10))
        _fix_edit(self.tax_std)
        self.tax_red = QSpinBox()
        self.tax_red.setRange(0, 100)
        self.tax_red.setValue(int(self.cfg.get("tax_reduced_rate") or 8))
        _fix_edit(self.tax_red)
        tax_row.addWidget(QLabel("標準%"))
        tax_row.addWidget(self.tax_std)
        tax_row.addWidget(QLabel("軽減%"))
        tax_row.addWidget(self.tax_red)
        tax_row.addStretch(1)
        v.addLayout(tax_row)

        tax_opts = QHBoxLayout()
        tax_opts.setSpacing(8)
        self.tax_default = QComboBox()
        self.tax_default.addItem("初期=標準税率", "standard")
        self.tax_default.addItem("初期=軽減税率", "reduced")
        if self.cfg.get("tax_default_rate_type") == "reduced":
            self.tax_default.setCurrentIndex(1)
        _fix_edit(self.tax_default)
        self.tax_round = QComboBox()
        self.tax_round.addItem("税額切り捨て", "floor")
        self.tax_round.addItem("四捨五入", "round")
        if self.cfg.get("tax_rounding") == "round":
            self.tax_round.setCurrentIndex(1)
        _fix_edit(self.tax_round)
        tax_opts.addWidget(self.tax_default, 1)
        tax_opts.addWidget(self.tax_round, 1)
        v.addLayout(tax_opts)

        _section("Gemini API")
        self.api_edit = QLineEdit(self.cfg.get("gemini_api_key") or "")
        self.api_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.api_edit.setPlaceholderText("AIza...")
        _fix_edit(self.api_edit)
        v.addWidget(self.api_edit)

        mrow = QHBoxLayout()
        mrow.setSpacing(8)
        mrow.addWidget(QLabel("モデル"))
        self.model_combo = QComboBox()
        model = self.cfg.get("gemini_model") or "gemini-2.0-flash"
        self.model_combo.addItem(model)
        _fix_edit(self.model_combo)
        mrow.addWidget(self.model_combo, 1)
        fetch = _fix_btn(_btn("モデル一覧取得", "SecondaryButton"))
        fetch.clicked.connect(self.fetch_models)
        mrow.addWidget(fetch)
        v.addLayout(mrow)

        save = _fix_btn(_btn("設定を保存"))
        save.clicked.connect(self.save_settings)
        v.addWidget(save, alignment=Qt.AlignmentFlag.AlignLeft)

        path_lbl = QLabel(f"データ保存先: {DB_PATH}")
        path_lbl.setObjectName("Muted")
        path_lbl.setWordWrap(True)
        path_lbl.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Minimum)
        v.addWidget(path_lbl)

        content_layout.addWidget(card)
        content_layout.addStretch(1)
        scroll.setWidget(content)
        page_layout.addWidget(scroll)
        self.tabs.addTab(page, "設定")

    def pick_sync_folder(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "ReceiptAI 同期フォルダを選択")
        if path:
            self.sync_edit.setText(path)

    def save_settings(self) -> None:
        self.cfg["gas_url"] = self.gas_edit.text().strip()
        self.cfg["sync_folder"] = self.sync_edit.text().strip()
        self.cfg["gemini_api_key"] = self.api_edit.text().strip()
        self.cfg["gemini_model"] = self.model_combo.currentText().strip()
        self.cfg["archive_imported"] = self.archive_check.isChecked()
        self.cfg["tax_standard_rate"] = int(self.tax_std.value())
        self.cfg["tax_reduced_rate"] = int(self.tax_red.value())
        self.cfg["tax_default_rate_type"] = self.tax_default.currentData() or "standard"
        self.cfg["tax_rounding"] = self.tax_round.currentData() or "floor"
        save_config(self.cfg)
        self._recalc_total()
        QMessageBox.information(self, "設定", "保存しました")

    def test_gas(self) -> None:
        url = self.gas_edit.text().strip() or self.cfg.get("gas_url") or ""
        if not url:
            QMessageBox.warning(self, "GAS", "URLを入力してください")
            return
        try:
            data = gas_client.ping(url)
            self.cfg["gas_url"] = url
            save_config(self.cfg)
            QMessageBox.information(
                self,
                "接続OK",
                f"シート: {data.get('spreadsheetUrl') or data.get('sheetName')}\n画像: {data.get('imagesFolderUrl') or ''}",
            )
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "接続失敗", str(exc))

    def clear_local_db(self) -> None:
        reply = QMessageBox.question(
            self,
            "ローカル一覧の全消去",
            "PC内のレシート一覧キャッシュをすべて削除しますか？\n"
            "（スプレッドシート側のデータは消えません）\n\n"
            f"{DB_PATH}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        n = db.clear_all_receipts()
        self._selected_id = None
        self.refresh_all()
        QMessageBox.information(
            self,
            "消去完了",
            f"ローカルから {n} 件削除しました。\n"
            "シートの内容を再取得する場合は「シートから同期」を押してください。",
        )

    def delete_receipt_row(
        self,
        receipt_id: int,
        cloud_id: str,
        shop: str,
        date_str: str,
    ) -> None:
        label = f"{shop} / {date_str}"
        reply = QMessageBox.question(
            self,
            "削除の確認",
            f"このレシートを完全に削除しますか？\n（復元できません）\n\n{label}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        gas_url = self.cfg.get("gas_url") or self.gas_edit.text().strip()
        sheet_msg = ""
        if cloud_id and gas_url:
            try:
                result = gas_client.delete_receipt(gas_url, cloud_id, delete_image=True)
                sheet_msg = (
                    f"シート: {result.get('deleted_rows', 0)} 行削除"
                    + (
                        f" / 画像 {len(result.get('deleted_images') or [])}"
                        if result.get("deleted_images")
                        else ""
                    )
                )
            except Exception as exc:  # noqa: BLE001
                QMessageBox.critical(
                    self,
                    "削除エラー",
                    f"スプレッドシート側の削除に失敗しました。\n"
                    f"ローカルDBはまだ残しています。\n\n{exc}",
                )
                return
        elif cloud_id and not gas_url:
            QMessageBox.warning(
                self,
                "削除",
                "クラウドIDがありますが GAS URL 未設定です。\n"
                "設定でURLを保存するか、シート側は手動で削除してください。\n"
                "このままローカルのみ削除します。",
            )

        db.delete_receipt(receipt_id)
        self.refresh_all()
        QMessageBox.information(
            self,
            "削除完了",
            "ローカルDBから削除しました。" + (f"\n{sheet_msg}" if sheet_msg else ""),
        )

    def show_receipt_image(self, view_url: str, file_id: str) -> None:
        gas_url = self.cfg.get("gas_url") or self.gas_edit.text().strip()
        if file_id and gas_url:
            try:
                data = gas_client.get_image(gas_url, file_id)
                raw = base64.b64decode(data["data_base64"])
                pix = QPixmap()
                if not pix.loadFromData(raw):
                    raise RuntimeError("画像のデコードに失敗しました")
                dlg = QDialog(self)
                dlg.setWindowTitle(str(data.get("name") or "レシート画像"))
                dlg.resize(min(720, pix.width() + 40), min(900, pix.height() + 40))
                lay = QVBoxLayout(dlg)
                scroll = QScrollArea()
                scroll.setWidgetResizable(True)
                label = QLabel()
                label.setAlignment(Qt.AlignmentFlag.AlignCenter)
                label.setPixmap(
                    pix.scaled(
                        680,
                        860,
                        Qt.AspectRatioMode.KeepAspectRatio,
                        Qt.TransformationMode.SmoothTransformation,
                    )
                )
                scroll.setWidget(label)
                lay.addWidget(scroll)
                close_btn = _btn("閉じる", "SecondaryButton")
                close_btn.clicked.connect(dlg.accept)
                lay.addWidget(close_btn)
                dlg.exec()
                return
            except Exception as exc:  # noqa: BLE001
                QMessageBox.critical(self, "画像", str(exc))
                return

        url = view_url or (f"https://drive.google.com/uc?export=view&id={file_id}" if file_id else "")
        if not url:
            QMessageBox.information(self, "画像", "画像がありません")
            return
        QDesktopServices.openUrl(QUrl(url))

    def do_sync_sheet(self) -> None:
        url = self.cfg.get("gas_url") or self.gas_edit.text().strip()
        if not url:
            QMessageBox.warning(self, "同期", "設定でGAS URLを保存してください")
            self.tabs.setCurrentIndex(4)
            return
        ym = self.month_combo.currentText()
        month = "" if ym == "すべて" else ym
        self.status.showMessage("シートから同期中…")

        def work() -> dict:
            return sheets_sync.sync_from_sheet(url, month=month, limit=200)

        worker = Worker(work)
        worker.finished_ok.connect(self._sync_done)
        worker.finished_err.connect(lambda m: QMessageBox.critical(self, "同期エラー", m))
        self._workers.append(worker)
        worker.start()

    def _sync_done(self, result: object) -> None:
        data = result if isinstance(result, dict) else {}
        msg = (
            f"取得 {data.get('fetched', 0)} 件\n"
            f"新規 {data.get('created', 0)} / 更新 {data.get('updated', 0)} / "
            f"削除反映 {data.get('removed', 0)}"
        )
        errs = data.get("errors") or []
        if errs:
            msg += "\n\nエラー:\n" + "\n".join(errs[:8])
        QMessageBox.information(self, "同期結果", msg)
        self.status.showMessage(f"DB: {DB_PATH}")
        self.refresh_all()

    def save_current_to_sheet(self) -> None:
        url = self.cfg.get("gas_url") or self.gas_edit.text().strip()
        if not url:
            QMessageBox.warning(self, "保存", "設定でGAS URLを保存してください")
            self.tabs.setCurrentIndex(4)
            return
        items = self._collect_items()
        if not items:
            QMessageBox.warning(self, "保存", "先に解析するか明細を入力してください")
            return
        payload = {
            "shop_name": self.shop_edit.text().strip() or "不明",
            "date": self.date_edit.text().strip() or date.today().isoformat(),
            "total_amount": sum(i["price"] for i in items),
            "items": items,
            "timestamp": date.today().isoformat(),
        }

        # 重複確認（シート → ローカル）
        dup_lines: list[str] = []
        try:
            sheet_dupes = gas_client.find_duplicates(
                url,
                shop_name=payload["shop_name"],
                date=payload["date"],
                total_amount=payload["total_amount"],
            )
            for d in sheet_dupes[:3]:
                dup_lines.append(
                    f"・[シート] {d.get('shop_name')} / {d.get('created_at') or d.get('date')} / "
                    f"{int(d.get('total_amount') or 0):,} 円"
                )
        except Exception:  # noqa: BLE001
            sheet_dupes = []

        local_dupes = db.find_local_duplicates(
            shop_name=payload["shop_name"],
            date=payload["date"],
            total_amount=payload["total_amount"],
        )
        for d in local_dupes[:3]:
            dup_lines.append(
                f"・[ローカル] {d.get('shop_name')} / {d.get('date')} / "
                f"{int(float(d.get('total_amount') or 0)):,} 円"
            )

        if dup_lines:
            msg = (
                "同じようなレシートがすでに保存されています。\n"
                "（店名＋日付＋合計が一致）\n\n"
                f"今回: {payload['shop_name']} / {payload['date']} / "
                f"{int(payload['total_amount']):,} 円\n\n"
                "既存:\n"
                + "\n".join(dup_lines)
                + "\n\nそれでも新規として保存しますか？"
            )
            reply = QMessageBox.question(
                self,
                "重複の確認",
                msg,
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                return

        image_path = self.image_edit.text().strip() if hasattr(self, "image_edit") else ""
        try:
            if image_path:
                b64, mime = resize_to_jpeg_base64(Path(image_path), 1280)
                payload["image_base64"] = b64
                payload["image_mime"] = mime
            result = gas_client.save_receipt(url, payload)
            cloud_id = str(result.get("receipt_id") or "")
            if cloud_id:
                db.upsert_cloud_receipt(
                    cloud_id,
                    payload["shop_name"],
                    payload["date"],
                    items,
                    image_file_id=str(result.get("image_file_id") or ""),
                    image_view_url=str(result.get("image_view_url") or ""),
                )
            QMessageBox.information(self, "保存", "スプレッドシートへ保存しました")
            self.refresh_all()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "保存エラー", str(exc))

    def fetch_models(self) -> None:
        key = self.api_edit.text().strip() or self.cfg.get("gemini_api_key") or ""
        if not key:
            QMessageBox.warning(self, "設定", "APIキーを入力してください")
            return
        worker = Worker(gemini.fetch_models, key)
        worker.finished_ok.connect(self._set_models)
        worker.finished_err.connect(lambda m: QMessageBox.critical(self, "モデル取得", m))
        self._workers.append(worker)
        worker.start()

    def _set_models(self, models: object) -> None:
        ids = [m["id"] for m in models] if isinstance(models, list) else []
        if not ids:
            ids = [self.model_combo.currentText() or "gemini-2.0-flash"]
        current = self.model_combo.currentText()
        self.model_combo.clear()
        self.model_combo.addItems(ids)
        idx = self.model_combo.findText(current)
        self.model_combo.setCurrentIndex(idx if idx >= 0 else 0)
        QMessageBox.information(self, "モデル", f"{len(ids)} 件取得しました")

    # ── import / export ────────────────────────────────────
    def do_import(self) -> None:
        folder = self.cfg.get("sync_folder") or self.sync_edit.text().strip()
        if not folder:
            QMessageBox.warning(self, "取込", "設定で同期フォルダを指定してください")
            self.tabs.setCurrentIndex(4)
            return
        result = importer.import_folder(folder, archive=bool(self.cfg.get("archive_imported", True)))
        msg = f"新規取込: {result['imported']} 件\nスキップ: {result['skipped']} 件"
        if result["errors"]:
            msg += "\n\nエラー:\n" + "\n".join(result["errors"][:8])
        QMessageBox.information(self, "取込結果", msg)
        self.refresh_all()

    def do_export_csv(self) -> None:
        ym = self.month_combo.currentText()
        year_month = None if ym == "すべて" else ym
        path, _ = QFileDialog.getSaveFileName(
            self,
            "CSV出力",
            f"receipts_{year_month or 'all'}.csv",
            "CSV (*.csv)",
        )
        if not path:
            return
        n = db.export_csv(Path(path), year_month=year_month)
        QMessageBox.information(self, "CSV", f"{n} 行を出力しました")

    def refresh_all(self) -> None:
        self.cfg = load_config()
        self.refresh_months()
        self.refresh_list()
        self.refresh_charts()


def run() -> None:
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setStyleSheet(APP_STYLESHEET)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())
