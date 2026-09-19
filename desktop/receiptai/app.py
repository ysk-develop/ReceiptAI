"""CustomTkinter desktop UI for ReceiptAI."""

from __future__ import annotations

import threading
import tkinter as tk
from datetime import date
from pathlib import Path
from tkinter import filedialog, messagebox

import customtkinter as ctk

from . import charts, db, gemini, importer
from .config import CATEGORIES, DB_PATH, load_config, save_config

# Web PWA-aligned teal theme
PRIMARY = "#0f766e"
ACCENT = "#14b8a6"
BG = "#f0fdfa"
SURFACE = "#ffffff"
TEXT = "#134e4a"
MUTED = "#5f8a85"


class ReceiptAIApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("レシート自動仕分け家計簿")
        self.geometry("1040x720")
        self.minsize(900, 600)

        ctk.set_appearance_mode("light")
        ctk.set_default_color_theme("green")

        self.configure(fg_color=BG)
        self.cfg = load_config()
        db.init_db()

        self._chart_canvases: list = []
        self._item_rows: list[dict] = []
        self._selected_id: int | None = None

        self._build_header()
        self._build_tabs()
        self.refresh_all()

    # ── layout ─────────────────────────────────────────────
    def _build_header(self) -> None:
        header = ctk.CTkFrame(self, fg_color=PRIMARY, corner_radius=0, height=72)
        header.pack(fill="x")
        header.pack_propagate(False)
        ctk.CTkLabel(
            header,
            text="🧾 レシート自動仕分け家計簿",
            font=ctk.CTkFont(size=20, weight="bold"),
            text_color="white",
        ).pack(pady=(14, 0))
        ctk.CTkLabel(
            header,
            text="GoogleドライブのJSONを取り込み、集計・グラフ表示",
            font=ctk.CTkFont(size=12),
            text_color="#ccfbf1",
        ).pack()

    def _build_tabs(self) -> None:
        self.tabs = ctk.CTkTabview(self, fg_color=BG, segmented_button_selected_color=PRIMARY)
        self.tabs.pack(fill="both", expand=True, padx=12, pady=12)
        self.tab_list = self.tabs.add("一覧")
        self.tab_edit = self.tabs.add("編集")
        self.tab_charts = self.tabs.add("グラフ")
        self.tab_analyze = self.tabs.add("AI解析")
        self.tab_settings = self.tabs.add("設定")

        self._build_list_tab()
        self._build_edit_tab()
        self._build_charts_tab()
        self._build_analyze_tab()
        self._build_settings_tab()

    def _card(self, parent, **kwargs) -> ctk.CTkFrame:
        opts = {"fg_color": SURFACE, "corner_radius": 12, "border_width": 1, "border_color": "#99f6e4"}
        opts.update(kwargs)
        return ctk.CTkFrame(parent, **opts)

    # ── list ───────────────────────────────────────────────
    def _build_list_tab(self) -> None:
        top = self._card(self.tab_list)
        top.pack(fill="x", padx=4, pady=4)

        row = ctk.CTkFrame(top, fg_color="transparent")
        row.pack(fill="x", padx=12, pady=12)

        ctk.CTkLabel(row, text="月", text_color=TEXT).pack(side="left")
        self.month_var = tk.StringVar(value="すべて")
        self.month_menu = ctk.CTkOptionMenu(
            row,
            variable=self.month_var,
            values=["すべて"],
            command=lambda _v: self.refresh_list(),
            fg_color=PRIMARY,
            button_color=PRIMARY,
            width=120,
        )
        self.month_menu.pack(side="left", padx=8)

        ctk.CTkButton(row, text="Driveから取込", command=self.do_import, fg_color=PRIMARY, width=130).pack(
            side="left", padx=4
        )
        ctk.CTkButton(row, text="CSV出力", command=self.do_export_csv, fg_color=ACCENT, text_color="white", width=100).pack(
            side="left", padx=4
        )
        ctk.CTkButton(row, text="新規手入力", command=self.new_receipt, fg_color="#e0f2f1", text_color=PRIMARY, width=110).pack(
            side="left", padx=4
        )

        self.summary_label = ctk.CTkLabel(top, text="", text_color=MUTED, anchor="w")
        self.summary_label.pack(fill="x", padx=12, pady=(0, 8))

        body = self._card(self.tab_list)
        body.pack(fill="both", expand=True, padx=4, pady=4)

        self.list_box = ctk.CTkScrollableFrame(body, fg_color=SURFACE)
        self.list_box.pack(fill="both", expand=True, padx=8, pady=8)

    def refresh_months(self) -> None:
        months = db.list_months()
        values = ["すべて"] + months
        current = self.month_var.get()
        self.month_menu.configure(values=values)
        if current not in values:
            self.month_var.set("すべて")

    def refresh_list(self) -> None:
        for w in self.list_box.winfo_children():
            w.destroy()

        ym = self.month_var.get()
        year_month = None if ym == "すべて" else ym
        rows = db.list_receipts(year_month=year_month)
        total = sum(float(r["total_amount"] or 0) for r in rows)
        self.summary_label.configure(
            text=f"{len(rows)} 件 / 合計 {total:,.0f} 円"
            + (f"（{ym}）" if year_month else "")
        )

        if not rows:
            ctk.CTkLabel(self.list_box, text="レシートがありません。Driveから取り込むか手入力してください。", text_color=MUTED).pack(
                pady=24
            )
            return

        header = ctk.CTkFrame(self.list_box, fg_color="#e0f2f1", corner_radius=8)
        header.pack(fill="x", pady=(0, 4))
        for text, width in (("日付", 100), ("店舗", 220), ("合計", 100), ("", 80)):
            ctk.CTkLabel(header, text=text, width=width, anchor="w", text_color=PRIMARY, font=ctk.CTkFont(weight="bold")).pack(
                side="left", padx=6, pady=6
            )

        for r in rows:
            line = ctk.CTkFrame(self.list_box, fg_color="transparent")
            line.pack(fill="x", pady=2)
            ctk.CTkLabel(line, text=r["date"], width=100, anchor="w", text_color=TEXT).pack(side="left", padx=6)
            ctk.CTkLabel(line, text=r["shop_name"], width=220, anchor="w", text_color=TEXT).pack(side="left", padx=6)
            ctk.CTkLabel(line, text=f'{float(r["total_amount"]):,.0f} 円', width=100, anchor="e", text_color=PRIMARY).pack(
                side="left", padx=6
            )
            ctk.CTkButton(
                line,
                text="編集",
                width=70,
                height=28,
                fg_color=PRIMARY,
                command=lambda rid=r["id"]: self.open_receipt(rid),
            ).pack(side="left", padx=6)

    # ── edit ───────────────────────────────────────────────
    def _build_edit_tab(self) -> None:
        form = self._card(self.tab_edit)
        form.pack(fill="x", padx=4, pady=4)

        grid = ctk.CTkFrame(form, fg_color="transparent")
        grid.pack(fill="x", padx=12, pady=12)

        ctk.CTkLabel(grid, text="店舗名", text_color=TEXT).grid(row=0, column=0, sticky="w")
        self.shop_entry = ctk.CTkEntry(grid, width=260)
        self.shop_entry.grid(row=1, column=0, padx=(0, 12), pady=(0, 8), sticky="w")

        ctk.CTkLabel(grid, text="日付 (YYYY-MM-DD)", text_color=TEXT).grid(row=0, column=1, sticky="w")
        self.date_entry = ctk.CTkEntry(grid, width=160)
        self.date_entry.grid(row=1, column=1, pady=(0, 8), sticky="w")
        self.date_entry.insert(0, date.today().isoformat())

        items_card = self._card(self.tab_edit)
        items_card.pack(fill="both", expand=True, padx=4, pady=4)
        ctk.CTkLabel(items_card, text="明細", text_color=PRIMARY, font=ctk.CTkFont(weight="bold")).pack(
            anchor="w", padx=12, pady=(12, 4)
        )

        head = ctk.CTkFrame(items_card, fg_color="transparent")
        head.pack(fill="x", padx=12)
        for t, w in (("品目", 260), ("金額", 100), ("カテゴリ", 140), ("", 40)):
            ctk.CTkLabel(head, text=t, width=w, anchor="w", text_color=MUTED, font=ctk.CTkFont(size=12)).pack(
                side="left", padx=2
            )

        self.items_frame = ctk.CTkScrollableFrame(items_card, fg_color=SURFACE, height=280)
        self.items_frame.pack(fill="both", expand=True, padx=8, pady=8)

        bottom = ctk.CTkFrame(items_card, fg_color="transparent")
        bottom.pack(fill="x", padx=12, pady=(0, 12))
        ctk.CTkButton(bottom, text="+ 行追加", command=lambda: self._add_item_row(), fg_color="#e0f2f1", text_color=PRIMARY, width=100).pack(
            side="left"
        )
        self.edit_total = ctk.CTkLabel(bottom, text="合計 0 円", text_color=PRIMARY, font=ctk.CTkFont(size=16, weight="bold"))
        self.edit_total.pack(side="left", padx=16)

        ctk.CTkButton(bottom, text="保存", command=self.save_receipt, fg_color=PRIMARY, width=100).pack(side="right", padx=4)
        ctk.CTkButton(bottom, text="削除", command=self.delete_receipt, fg_color="#dc2626", width=80).pack(side="right", padx=4)

    def _clear_item_rows(self) -> None:
        for row in self._item_rows:
            row["frame"].destroy()
        self._item_rows.clear()

    def _add_item_row(self, name: str = "", price: float | str = "", category: str = "食費") -> None:
        frame = ctk.CTkFrame(self.items_frame, fg_color="transparent")
        frame.pack(fill="x", pady=2)
        name_e = ctk.CTkEntry(frame, width=260, placeholder_text="品目名")
        name_e.pack(side="left", padx=2)
        if name:
            name_e.insert(0, name)
        price_e = ctk.CTkEntry(frame, width=100, placeholder_text="金額")
        price_e.pack(side="left", padx=2)
        if price != "" and price is not None:
            price_e.insert(0, str(int(price) if float(price) == int(float(price)) else price))
        cat_var = tk.StringVar(value=category if category in CATEGORIES else "その他")
        cat_m = ctk.CTkOptionMenu(frame, variable=cat_var, values=CATEGORIES, width=140, fg_color=PRIMARY)
        cat_m.pack(side="left", padx=2)

        def on_change(*_a: object) -> None:
            self._recalc_edit_total()

        price_e.bind("<KeyRelease>", on_change)

        def remove() -> None:
            frame.destroy()
            self._item_rows[:] = [r for r in self._item_rows if r["frame"] is not frame]
            self._recalc_edit_total()

        ctk.CTkButton(frame, text="✕", width=36, height=28, fg_color="#fee2e2", text_color="#dc2626", command=remove).pack(
            side="left", padx=2
        )
        self._item_rows.append({"frame": frame, "name": name_e, "price": price_e, "cat": cat_var})
        self._recalc_edit_total()

    def _collect_items(self) -> list[dict]:
        items = []
        for r in self._item_rows:
            name = r["name"].get().strip()
            try:
                price = float(r["price"].get().strip() or 0)
            except ValueError:
                price = 0.0
            cat = r["cat"].get()
            if name or price:
                items.append({"name": name or "（未入力）", "price": price, "category": cat})
        return items

    def _recalc_edit_total(self) -> None:
        total = sum(i["price"] for i in self._collect_items())
        self.edit_total.configure(text=f"合計 {total:,.0f} 円")

    def new_receipt(self) -> None:
        self._selected_id = None
        self.shop_entry.delete(0, "end")
        self.date_entry.delete(0, "end")
        self.date_entry.insert(0, date.today().isoformat())
        self._clear_item_rows()
        self._add_item_row()
        self.tabs.set("編集")

    def open_receipt(self, receipt_id: int) -> None:
        data = db.get_receipt(receipt_id)
        if not data:
            messagebox.showerror("エラー", "レシートが見つかりません")
            return
        self._selected_id = receipt_id
        self.shop_entry.delete(0, "end")
        self.shop_entry.insert(0, data["shop_name"])
        self.date_entry.delete(0, "end")
        self.date_entry.insert(0, data["date"])
        self._clear_item_rows()
        for it in data["items"]:
            self._add_item_row(it["name"], it["price"], it["category"])
        if not data["items"]:
            self._add_item_row()
        self.tabs.set("編集")

    def save_receipt(self) -> None:
        shop = self.shop_entry.get().strip() or "不明"
        d = self.date_entry.get().strip()
        items = self._collect_items()
        if not d:
            messagebox.showwarning("入力", "日付を入力してください")
            return
        if not items:
            messagebox.showwarning("入力", "明細を1件以上入力してください")
            return
        try:
            if self._selected_id is None:
                rid, _ = db.insert_receipt(shop, d, items)
                self._selected_id = rid
            else:
                db.update_receipt(self._selected_id, shop, d, items)
            messagebox.showinfo("保存", "保存しました")
            self.refresh_all()
            self.tabs.set("一覧")
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("保存エラー", str(exc))

    def delete_receipt(self) -> None:
        if self._selected_id is None:
            messagebox.showinfo("削除", "削除するレシートが選択されていません")
            return
        if not messagebox.askyesno("確認", "このレシートを削除しますか？"):
            return
        db.delete_receipt(self._selected_id)
        self._selected_id = None
        self.new_receipt()
        self.refresh_all()
        self.tabs.set("一覧")

    # ── charts ─────────────────────────────────────────────
    def _build_charts_tab(self) -> None:
        top = self._card(self.tab_charts)
        top.pack(fill="x", padx=4, pady=4)
        row = ctk.CTkFrame(top, fg_color="transparent")
        row.pack(fill="x", padx=12, pady=12)
        ctk.CTkLabel(row, text="対象月", text_color=TEXT).pack(side="left")
        self.chart_month_var = tk.StringVar(value="すべて")
        self.chart_month_menu = ctk.CTkOptionMenu(
            row,
            variable=self.chart_month_var,
            values=["すべて"],
            command=lambda _v: self.refresh_charts(),
            fg_color=PRIMARY,
            width=120,
        )
        self.chart_month_menu.pack(side="left", padx=8)
        ctk.CTkButton(row, text="更新", command=self.refresh_charts, fg_color=PRIMARY, width=80).pack(side="left")

        body = ctk.CTkFrame(self.tab_charts, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=4, pady=4)
        self.pie_host = self._card(body)
        self.pie_host.pack(side="left", fill="both", expand=True, padx=(0, 4))
        self.bar_host = self._card(body)
        self.bar_host.pack(side="left", fill="both", expand=True, padx=(4, 0))

    def refresh_charts(self) -> None:
        for c in self._chart_canvases:
            try:
                c.get_tk_widget().destroy()
            except Exception:  # noqa: BLE001
                pass
        self._chart_canvases.clear()
        for host in (self.pie_host, self.bar_host):
            for w in host.winfo_children():
                w.destroy()

        months = db.list_months()
        values = ["すべて"] + months
        cur = self.chart_month_var.get()
        self.chart_month_menu.configure(values=values)
        if cur not in values:
            self.chart_month_var.set("すべて")

        ym = self.chart_month_var.get()
        year_month = None if ym == "すべて" else ym
        pie = charts.make_category_pie(db.category_totals(year_month))
        bar = charts.make_monthly_bars(db.monthly_totals())
        self._chart_canvases.append(charts.embed_figure(self.pie_host, pie))
        self._chart_canvases.append(charts.embed_figure(self.bar_host, bar))

    # ── AI analyze ─────────────────────────────────────────
    def _build_analyze_tab(self) -> None:
        card = self._card(self.tab_analyze)
        card.pack(fill="both", expand=True, padx=4, pady=4)

        ctk.CTkLabel(
            card,
            text="PC上の画像またはメモをGeminiで解析し、編集タブへ送ります",
            text_color=MUTED,
        ).pack(anchor="w", padx=12, pady=(12, 4))

        row = ctk.CTkFrame(card, fg_color="transparent")
        row.pack(fill="x", padx=12, pady=8)
        self.image_path_var = tk.StringVar(value="")
        ctk.CTkEntry(row, textvariable=self.image_path_var, width=420).pack(side="left")
        ctk.CTkButton(row, text="画像選択", command=self.pick_image, fg_color=PRIMARY, width=100).pack(side="left", padx=8)

        ctk.CTkLabel(card, text="テキストメモ", text_color=TEXT).pack(anchor="w", padx=12)
        self.memo_box = ctk.CTkTextbox(card, height=80)
        self.memo_box.pack(fill="x", padx=12, pady=4)

        self.analyze_status = ctk.CTkLabel(card, text="", text_color=MUTED)
        self.analyze_status.pack(anchor="w", padx=12, pady=4)

        ctk.CTkButton(card, text="AIで解析して編集へ", command=self.do_analyze, fg_color=PRIMARY, height=40).pack(
            padx=12, pady=12, anchor="w"
        )

    def pick_image(self) -> None:
        path = filedialog.askopenfilename(
            title="レシート画像",
            filetypes=[("Images", "*.png;*.jpg;*.jpeg;*.webp;*.gif"), ("All", "*.*")],
        )
        if path:
            self.image_path_var.set(path)

    def do_analyze(self) -> None:
        key = self.cfg.get("gemini_api_key") or ""
        model = self.cfg.get("gemini_model") or "gemini-2.0-flash"
        if not key:
            messagebox.showwarning("設定", "設定タブでGemini APIキーを保存してください")
            self.tabs.set("設定")
            return
        image = self.image_path_var.get().strip()
        memo = self.memo_box.get("1.0", "end").strip()
        if not image and not memo:
            messagebox.showwarning("入力", "画像またはメモを入力してください")
            return

        self.analyze_status.configure(text="解析中…")
        self.update_idletasks()

        def work() -> None:
            try:
                result = gemini.analyze_receipt(
                    key,
                    model,
                    image_path=Path(image) if image else None,
                    memo=memo,
                )
                self.after(0, lambda: self._apply_analysis(result))
            except Exception as exc:  # noqa: BLE001
                self.after(0, lambda: self._analyze_failed(str(exc)))

        threading.Thread(target=work, daemon=True).start()

    def _apply_analysis(self, result: dict) -> None:
        self._selected_id = None
        self.shop_entry.delete(0, "end")
        self.shop_entry.insert(0, result.get("shop_name") or "")
        self.date_entry.delete(0, "end")
        d = result.get("date") or date.today().isoformat()
        self.date_entry.insert(0, d)
        self._clear_item_rows()
        for it in result.get("items") or []:
            self._add_item_row(it.get("name", ""), it.get("price", 0), it.get("category", "その他"))
        if not self._item_rows:
            self._add_item_row()
        self.analyze_status.configure(text="解析完了。内容を確認して保存してください。")
        self.tabs.set("編集")

    def _analyze_failed(self, msg: str) -> None:
        self.analyze_status.configure(text="解析失敗")
        messagebox.showerror("解析エラー", msg)

    # ── settings ───────────────────────────────────────────
    def _build_settings_tab(self) -> None:
        card = self._card(self.tab_settings)
        card.pack(fill="both", expand=True, padx=4, pady=4)

        ctk.CTkLabel(card, text="Googleドライブ同期フォルダ", text_color=PRIMARY, font=ctk.CTkFont(weight="bold")).pack(
            anchor="w", padx=12, pady=(12, 4)
        )
        ctk.CTkLabel(
            card,
            text="スマホアプリが保存する ReceiptAI フォルダ（Google Drive for Desktop のローカルパス）",
            text_color=MUTED,
            wraplength=700,
            justify="left",
        ).pack(anchor="w", padx=12)

        row = ctk.CTkFrame(card, fg_color="transparent")
        row.pack(fill="x", padx=12, pady=8)
        self.sync_var = tk.StringVar(value=self.cfg.get("sync_folder") or "")
        ctk.CTkEntry(row, textvariable=self.sync_var, width=480).pack(side="left")
        ctk.CTkButton(row, text="参照", command=self.pick_sync_folder, fg_color=PRIMARY, width=80).pack(side="left", padx=8)

        self.archive_var = tk.BooleanVar(value=bool(self.cfg.get("archive_imported", True)))
        ctk.CTkCheckBox(
            card,
            text="取込後に JSON を _imported フォルダへ移動",
            variable=self.archive_var,
            text_color=TEXT,
        ).pack(anchor="w", padx=12, pady=4)

        ctk.CTkLabel(card, text="Gemini API", text_color=PRIMARY, font=ctk.CTkFont(weight="bold")).pack(
            anchor="w", padx=12, pady=(16, 4)
        )
        self.api_entry = ctk.CTkEntry(card, width=420, show="*", placeholder_text="AIza...")
        self.api_entry.pack(anchor="w", padx=12, pady=4)
        if self.cfg.get("gemini_api_key"):
            self.api_entry.insert(0, self.cfg["gemini_api_key"])

        mrow = ctk.CTkFrame(card, fg_color="transparent")
        mrow.pack(fill="x", padx=12, pady=8)
        ctk.CTkLabel(mrow, text="モデル", text_color=TEXT).pack(side="left")
        self.model_var = tk.StringVar(value=self.cfg.get("gemini_model") or "gemini-2.0-flash")
        self.model_menu = ctk.CTkOptionMenu(
            mrow, variable=self.model_var, values=[self.model_var.get()], fg_color=PRIMARY, width=260
        )
        self.model_menu.pack(side="left", padx=8)
        ctk.CTkButton(mrow, text="モデル一覧取得", command=self.fetch_models, fg_color="#e0f2f1", text_color=PRIMARY, width=120).pack(
            side="left"
        )

        ctk.CTkButton(card, text="設定を保存", command=self.save_settings, fg_color=PRIMARY, width=140, height=36).pack(
            anchor="w", padx=12, pady=16
        )

        ctk.CTkLabel(
            card,
            text=f"データ保存先: {DB_PATH}",
            text_color=MUTED,
            font=ctk.CTkFont(size=11),
        ).pack(anchor="w", padx=12, pady=(0, 12))

    def pick_sync_folder(self) -> None:
        path = filedialog.askdirectory(title="ReceiptAI 同期フォルダを選択")
        if path:
            self.sync_var.set(path)

    def save_settings(self) -> None:
        self.cfg["sync_folder"] = self.sync_var.get().strip()
        self.cfg["gemini_api_key"] = self.api_entry.get().strip()
        self.cfg["gemini_model"] = self.model_var.get().strip()
        self.cfg["archive_imported"] = bool(self.archive_var.get())
        save_config(self.cfg)
        messagebox.showinfo("設定", "保存しました")

    def fetch_models(self) -> None:
        key = self.api_entry.get().strip() or self.cfg.get("gemini_api_key") or ""
        if not key:
            messagebox.showwarning("設定", "APIキーを入力してください")
            return

        def work() -> None:
            try:
                models = gemini.fetch_models(key)
                ids = [m["id"] for m in models] or [self.model_var.get()]
                self.after(0, lambda: self._set_models(ids))
            except Exception as exc:  # noqa: BLE001
                self.after(0, lambda: messagebox.showerror("モデル取得", str(exc)))

        threading.Thread(target=work, daemon=True).start()

    def _set_models(self, ids: list[str]) -> None:
        self.model_menu.configure(values=ids)
        if self.model_var.get() not in ids:
            self.model_var.set(ids[0])
        messagebox.showinfo("モデル", f"{len(ids)} 件取得しました")

    # ── import / export ────────────────────────────────────
    def do_import(self) -> None:
        folder = self.cfg.get("sync_folder") or self.sync_var.get().strip()
        if not folder:
            messagebox.showwarning("取込", "設定で同期フォルダを指定してください")
            self.tabs.set("設定")
            return
        result = importer.import_folder(folder, archive=bool(self.cfg.get("archive_imported", True)))
        msg = f"新規取込: {result['imported']} 件\nスキップ: {result['skipped']} 件"
        if result["errors"]:
            msg += "\n\nエラー:\n" + "\n".join(result["errors"][:8])
        messagebox.showinfo("取込結果", msg)
        self.refresh_all()

    def do_export_csv(self) -> None:
        ym = self.month_var.get()
        year_month = None if ym == "すべて" else ym
        path = filedialog.asksaveasfilename(
            title="CSV出力",
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile=f"receipts_{year_month or 'all'}.csv",
        )
        if not path:
            return
        n = db.export_csv(Path(path), year_month=year_month)
        messagebox.showinfo("CSV", f"{n} 行を出力しました")

    def refresh_all(self) -> None:
        self.cfg = load_config()
        self.refresh_months()
        self.refresh_list()
        self.refresh_charts()


def run() -> None:
    app = ReceiptAIApp()
    app.mainloop()
