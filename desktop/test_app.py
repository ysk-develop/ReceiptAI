"""Smoke tests for PyQt desktop app (offscreen)."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication, QMessageBox, QPushButton

from receiptai import charts, db, importer
from receiptai.app import MainWindow
from receiptai.styles import APP_STYLESHEET


class DesktopAppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication(sys.argv)
        cls.app.setStyleSheet(APP_STYLESHEET)

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._db = Path(self._td.name) / "test.db"
        self._patches = [
            patch("receiptai.db.DB_PATH", self._db),
            patch("receiptai.config.DB_PATH", self._db),
            patch("receiptai.app.DB_PATH", self._db),
        ]
        for p in self._patches:
            p.start()
        db.init_db(self._db)

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._td.cleanup()

    def test_stylesheet_cursorrules(self) -> None:
        self.assertIn("QComboBox::drop-down", APP_STYLESHEET)
        self.assertIn("QComboBox::down-arrow", APP_STYLESHEET)
        self.assertIn("QSpinBox::up-arrow", APP_STYLESHEET)
        self.assertIn("QSpinBox::down-arrow", APP_STYLESHEET)
        self.assertIn("QPushButton:hover", APP_STYLESHEET)
        self.assertIn("QTableWidget QLineEdit", APP_STYLESHEET)

    def test_db_and_import(self) -> None:
        digest = f"unittest_{date.today().isoformat()}_{os.getpid()}"
        rid, created = db.insert_receipt(
            "テスト店",
            date.today().isoformat(),
            [{"name": "牛乳", "price": 198, "category": "食費"}],
            source_hash=digest,
            db_path=self._db,
        )
        self.assertTrue(created or rid > 0)
        rid2, created2 = db.insert_receipt(
            "テスト店",
            date.today().isoformat(),
            [{"name": "牛乳", "price": 198, "category": "食費"}],
            source_hash=digest,
            db_path=self._db,
        )
        self.assertFalse(created2)
        self.assertEqual(rid, rid2)

        cloud_id = f"cloud_{os.getpid()}"
        rid3, created3 = db.upsert_cloud_receipt(
            cloud_id,
            "クラウド店",
            "2026-09-20",
            [{"name": "お茶", "price": 100, "category": "食費"}],
            image_file_id="img123",
            image_view_url="https://example.com/x",
            db_path=self._db,
        )
        self.assertTrue(created3)
        rid4, created4 = db.upsert_cloud_receipt(
            cloud_id,
            "クラウド店",
            "2026-09-20",
            [{"name": "お茶", "price": 120, "category": "食費"}],
            image_file_id="img123",
            image_view_url="https://example.com/x",
            db_path=self._db,
        )
        self.assertFalse(created4)
        self.assertEqual(rid3, rid4)

        with tempfile.TemporaryDirectory() as td:
            folder = Path(td)
            payload = {
                "shop_name": f"ABC-{os.getpid()}",
                "date": "2026-09-18",
                "total_amount": 335,
                "items": [
                    {"name": f"お茶-{os.getpid()}", "price": 100, "category": "食費"},
                    {"name": "ティッシュ", "price": 235, "category": "日用品"},
                ],
            }
            import json

            (folder / "receipt_x.json").write_text(
                json.dumps(payload, ensure_ascii=False), encoding="utf-8"
            )
            with patch("receiptai.importer.db.DB_PATH", self._db):
                result = importer.import_folder(folder, archive=True)
            self.assertEqual(result["imported"], 1)
            self.assertFalse((folder / "receipt_x.json").exists())
            self.assertTrue((folder / "_imported" / "receipt_x.json").exists())

        n = db.clear_all_receipts(self._db)
        self.assertGreaterEqual(n, 1)
        self.assertEqual(len(db.list_receipts(db_path=self._db)), 0)

    def test_charts(self) -> None:
        c1 = charts.canvas_from_figure(charts.make_category_pie([("食費", 100)]))
        c2 = charts.canvas_from_figure(charts.make_monthly_bars([("2026-09", 100)]))
        self.assertIsNotNone(c1)
        self.assertIsNotNone(c2)
        # 端数調整のマイナスでも落ちない
        c3 = charts.canvas_from_figure(
            charts.make_category_pie([("食費", 100), ("その他", -50)])
        )
        self.assertIsNotNone(c3)

    @patch.object(QMessageBox, "information", return_value=QMessageBox.StandardButton.Ok)
    @patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok)
    @patch.object(QMessageBox, "critical", return_value=QMessageBox.StandardButton.Ok)
    @patch.object(QMessageBox, "question", return_value=QMessageBox.StandardButton.Yes)
    def test_main_window(self, *_mocks) -> None:
        win = MainWindow()
        win.show()
        win.refresh_all()
        win.new_receipt()
        win.shop_edit.setText("手入力店")
        win._clear_items()
        win._add_item_row("お茶", 100, "食費")
        self.assertEqual(win.items_table.rowCount(), 1)
        items = win._collect_items()
        self.assertEqual(items[0]["price_excl"], 100)
        self.assertEqual(items[0]["price"], 110)  # 10% 外税
        raw = win._collect_items_raw()
        self.assertEqual(raw[0]["price"], 100)
        win.save_receipt()
        self.assertIsNotNone(win._selected_id)
        win.open_receipt(win._selected_id)
        win.refresh_charts()
        win.refresh_list()
        # remove row via button
        win._add_item_row("パン", 120, "食費")
        self.assertEqual(win.items_table.rowCount(), 2)
        btn = win.items_table.cellWidget(1, 5)
        self.assertIsNotNone(btn)
        push = btn if isinstance(btn, QPushButton) else btn.findChild(QPushButton)
        self.assertIsNotNone(push)
        push.click()
        self.assertEqual(win.items_table.rowCount(), 1)
        win.close()


if __name__ == "__main__":
    unittest.main()
