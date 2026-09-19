"""Shared Qt stylesheet — teal design system + .cursorrules widget rules."""

# Design tokens (aligned with PWA / EVCharge-Advisor)
PRIMARY = "#0f766e"
PRIMARY_HOVER = "#0d5f58"
ACCENT = "#14b8a6"
ACCENT_HOVER = "#0d9488"
BG = "#f0fdfa"
SURFACE = "#ffffff"
TEXT = "#134e4a"
MUTED = "#5f8a85"
BORDER = "#99f6e4"
ERROR = "#dc2626"
ERROR_HOVER = "#b91c1c"
DANGER_BG = "#fee2e2"

APP_STYLESHEET = f"""
QWidget {{
    background-color: {BG};
    color: {TEXT};
    font-family: "Yu Gothic UI", "Meiryo", "Segoe UI", sans-serif;
    font-size: 13px;
}}

QMainWindow, QDialog {{
    background-color: {BG};
}}

QLabel#HeaderTitle {{
    color: white;
    font-size: 18px;
    font-weight: 700;
    background: transparent;
}}

QLabel#HeaderSub {{
    color: #ccfbf1;
    font-size: 12px;
    background: transparent;
}}

QFrame#HeaderBar {{
    background-color: {PRIMARY};
    border: none;
}}

QFrame#Card {{
    background-color: {SURFACE};
    border: 1px solid {BORDER};
    border-radius: 12px;
}}

QLabel#SectionTitle {{
    color: {PRIMARY};
    font-weight: 700;
    font-size: 14px;
    background: transparent;
}}

QLabel#Muted {{
    color: {MUTED};
    background: transparent;
}}

QTabWidget::pane {{
    border: 1px solid {BORDER};
    border-radius: 12px;
    background: {SURFACE};
    top: -1px;
}}

QTabBar::tab {{
    background: {SURFACE};
    color: {MUTED};
    padding: 10px 18px;
    margin-right: 2px;
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    font-weight: 600;
}}

QTabBar::tab:selected {{
    color: {PRIMARY};
    background: {SURFACE};
    border-bottom: 3px solid {PRIMARY};
}}

QTabBar::tab:hover {{
    color: {PRIMARY};
}}

QLineEdit, QTextEdit, QPlainTextEdit {{
    background: white;
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 8px 10px;
    selection-background-color: {ACCENT};
}}

QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {{
    border: 1px solid {PRIMARY};
}}

/* cursorrules: QTableWidget cell editor must not inherit rounded global QLineEdit */
QTableWidget QLineEdit {{
    border: none;
    border-radius: 0;
    padding: 2px 4px;
    background: white;
}}

QComboBox {{
    background: white;
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 6px 10px;
    min-height: 28px;
}}

QComboBox:focus {{
    border: 1px solid {PRIMARY};
}}

QComboBox QAbstractItemView {{
    background: white;
    border: 1px solid {BORDER};
    selection-background-color: #e0f2f1;
    selection-color: {TEXT};
    outline: none;
}}

/* cursorrules: custom combo drop-down arrow */
QComboBox::drop-down {{
    width: 30px;
    border: none;
    background-color: #f0f0f0;
    border-top-right-radius: 8px;
    border-bottom-right-radius: 8px;
}}
QComboBox::down-arrow {{
    image: none;
    width: 0;
    height: 0;
    border-left: 6px solid #f0f0f0;
    border-right: 6px solid #f0f0f0;
    border-top: 8px solid #333;
}}

QSpinBox, QDoubleSpinBox {{
    background: white;
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 4px 8px;
    min-height: 28px;
}}

/* cursorrules: custom spin arrows */
QSpinBox::up-button, QSpinBox::down-button,
QDoubleSpinBox::up-button, QDoubleSpinBox::down-button {{
    width: 30px;
    border: none;
    background-color: #f0f0f0;
}}
QSpinBox::up-button, QDoubleSpinBox::up-button {{
    border-top-right-radius: 8px;
}}
QSpinBox::down-button, QDoubleSpinBox::down-button {{
    border-bottom-right-radius: 8px;
}}
QSpinBox::up-arrow, QDoubleSpinBox::up-arrow {{
    image: none;
    width: 0;
    height: 0;
    border-left: 5px solid #f0f0f0;
    border-right: 5px solid #f0f0f0;
    border-bottom: 7px solid #333;
}}
QSpinBox::down-arrow, QDoubleSpinBox::down-arrow {{
    image: none;
    width: 0;
    height: 0;
    border-left: 5px solid #f0f0f0;
    border-right: 5px solid #f0f0f0;
    border-top: 7px solid #333;
}}

QCheckBox {{
    spacing: 8px;
    background: transparent;
}}

QCheckBox::indicator {{
    width: 18px;
    height: 18px;
    border: 1px solid {BORDER};
    border-radius: 4px;
    background: white;
}}

QCheckBox::indicator:checked {{
    background: {PRIMARY};
    border-color: {PRIMARY};
}}

QTableWidget {{
    background: white;
    border: 1px solid {BORDER};
    border-radius: 8px;
    gridline-color: #e0f2f1;
    selection-background-color: #ccfbf1;
    selection-color: {TEXT};
}}

QHeaderView::section {{
    background: #e0f2f1;
    color: {PRIMARY};
    font-weight: 700;
    padding: 8px;
    border: none;
    border-right: 1px solid {BORDER};
    border-bottom: 1px solid {BORDER};
}}

QScrollArea {{
    border: none;
    background: transparent;
}}

/* cursorrules: every button needs :hover */
QPushButton {{
    background-color: {PRIMARY};
    color: white;
    border: none;
    border-radius: 10px;
    padding: 8px 14px;
    font-weight: 600;
    min-height: 32px;
}}
QPushButton:hover {{
    background-color: {PRIMARY_HOVER};
}}
QPushButton:disabled {{
    background-color: #99f6e4;
    color: {MUTED};
}}

QPushButton#SecondaryButton {{
    background-color: #e0f2f1;
    color: {PRIMARY};
}}
QPushButton#SecondaryButton:hover {{
    background-color: #b2dfdb;
}}

QPushButton#AccentButton {{
    background-color: {ACCENT};
    color: white;
}}
QPushButton#AccentButton:hover {{
    background-color: {ACCENT_HOVER};
}}

QPushButton#DangerButton {{
    background-color: {ERROR};
    color: white;
}}
QPushButton#DangerButton:hover {{
    background-color: {ERROR_HOVER};
}}

QPushButton#GhostDangerButton {{
    background-color: {DANGER_BG};
    color: {ERROR};
}}
QPushButton#GhostDangerButton:hover {{
    background-color: #fecaca;
}}

QStatusBar {{
    background: {SURFACE};
    color: {MUTED};
    border-top: 1px solid {BORDER};
}}
"""
