# -*- coding: utf-8 -*-
"""
ZCode Account Manager
=====================
GUI-менеджер аккаунтов для ZCode (start-plan, OAuth Z.ai).

Возможности:
  * Текущий активный аккаунт определяется по user_id из JWT в config.json.
  * Сохранение текущего логина как "профиль" (credentials.json + config.json).
  * Переключение между профилями в один клик (kill процесса -> копирование -> запуск).
  * Автообновление статуса: каждые AUTO_REFRESH_MS перечитываем config.json,
    так что менеджер сам видит, на каком аккаунте вы сейчас (без перезапуска).
  * Лимит на сегодня — флаг: 🟢 есть / 🔴 исчерпан. Вы помечаете красным вручную,
    а в 19:00 (обновление лимитов) он автоматически снова становится зелёным.
  * Подсветка подписки: истекла / истекает сегодня (с учётом 19:00).

Идентификация аккаунта: поле user_id в payload JWT провайдера
"builtin:zai-start-plan" (см. config.json).
"""

import json
import os
import sys
import shutil
import base64
import subprocess
import time
import uuid
import logging
import traceback
import datetime
import threading
import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path

# Логика опроса реальных лимитов (официальный billing API zcode.z.ai)
try:
    import billing as billing_mod
except Exception:
    billing_mod = None

# --- логирование в файл (видно даже под pythonw) ------------------------
_log_path = Path(__file__).resolve().parent / "data" / "app.log"
try:
    _log_path.parent.mkdir(parents=True, exist_ok=True)
except Exception:
    pass
logging.basicConfig(
    filename=str(_log_path),
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("zam")
log.info("=== Application module loaded ===")

# =========================================================================
# = КОНСТАНТЫ / ПУТИ                                                       =
# =========================================================================

HOME = Path.home()
ZCODE_V2 = HOME / ".zcode" / "v2"
LIVE_CRED = ZCODE_V2 / "credentials.json"
LIVE_CONFIG = ZCODE_V2 / "config.json"
ZCODE_APPDATA = HOME / "AppData" / "Roaming" / "ZCode"
LOCKFILE = ZCODE_APPDATA / "lockfile"


def _find_zcode_exe():
    """Авто-поиск ZCode.exe: сначала стандартные пути, затем среди процессов."""
    candidates = [
        r"C:\Program Files\ZCode\ZCode.exe",
        r"C:\Program Files (x86)\ZCode\ZCode.exe",
        str(HOME / "AppData" / "Local" / "Programs" / "ZCode" / "ZCode.exe"),
        str(HOME / "AppData" / "Local" / "ZCode" / "ZCode.exe"),
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    # fallback: поиск пути среди запущенных процессов (Windows API)
    try:
        import ctypes
        from ctypes import wintypes
        psapi = ctypes.WinDLL("psapi.dll")
        kernel32 = ctypes.WinDLL("kernel32.dll")

        EnumProcesses = psapi.EnumProcesses
        EnumProcesses.argtypes = [ctypes.POINTER(ctypes.c_ulong), ctypes.c_ulong,
                                  ctypes.POINTER(ctypes.c_ulong)]
        EnumProcesses.restype = ctypes.c_bool
        OpenProcess = kernel32.OpenProcess
        OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        OpenProcess.restype = wintypes.HANDLE
        GetModuleFileNameEx = psapi.GetModuleFileNameExW
        GetModuleFileNameEx.argtypes = [wintypes.HANDLE, wintypes.HMODULE,
                                        wintypes.LPWSTR, wintypes.DWORD]
        GetModuleFileNameEx.restype = wintypes.DWORD

        PROCESS_QUERY_INFORMATION = 0x0400
        PROCESS_VM_READ = 0x0010
        count = 1024
        pids = (ctypes.c_ulong * count)()
        needed = ctypes.c_ulong()
        if EnumProcesses(pids, ctypes.sizeof(pids), ctypes.byref(needed)):
            n = needed.value // ctypes.sizeof(ctypes.c_ulong)
            for i in range(n):
                h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                                False, pids[i])
                if not h:
                    continue
                buf = ctypes.create_unicode_buffer(260)
                if GetModuleFileNameEx(h, None, buf, 260):
                    if buf.value.lower().endswith("zcode.exe"):
                        return buf.value
    except Exception:
        pass
    return r"C:\Program Files\ZCode\ZCode.exe"  # дефолт, если ничего не нашли


ZCODE_EXE = _find_zcode_exe()

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
PROFILES_DIR = DATA_DIR / "profiles"
BACKUPS_DIR = DATA_DIR / "backups"
PROFILES_JSON = DATA_DIR / "profiles.json"

START_PLAN_KEY = "builtin:zai-start-plan"

# Лимиты обновляются в 19:00 — это граница "дня".
LIMIT_RESET_HOUR = 19
# Интервал автообновления статуса (мс).
AUTO_REFRESH_MS = 5000
# Интервал опроса РЕАЛЬНЫХ лимитов через billing API (мс). Реже, чем статус,
# чтобы не спамить API. ~2 минуты.
BILLING_REFRESH_MS = 120000
# Порог «почти исчерпан» в процентах: ниже этого строка краснеет.
EXHAUST_THRESHOLD_PCT = 5
# Модель, по которой считаем «исчерпан ли лимит» (GLM-5.2 — основная).
LIMIT_MODEL = "GLM-5.2"

for _d in (DATA_DIR, PROFILES_DIR, BACKUPS_DIR):
    _d.mkdir(parents=True, exist_ok=True)


# =========================================================================
# = НИЗКОУРОВНЕВЫЕ ОПЕРАЦИИ                                                =
# =========================================================================

def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_json_raw(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def b64url_decode(s):
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode("ascii"))


def get_jwt_user_id(jwt_str):
    """Достаём user_id из payload JWT. Не проверяем подпись — только читаем."""
    try:
        payload = jwt_str.split(".")[1]
        data = json.loads(b64url_decode(payload))
        return data.get("user_id")
    except Exception:
        return None


def get_live_user_id():
    """user_id аккаунта, который сейчас активен в ZCode."""
    cfg = read_json(LIVE_CONFIG)
    if not cfg:
        return None
    try:
        apikey = cfg["provider"][START_PLAN_KEY]["options"]["apiKey"]
        return get_jwt_user_id(apikey)
    except Exception:
        return None


# --- время / подписка / лимит --------------------------------------------

def now():
    return datetime.datetime.now()


def parse_date(s):
    """Гибкий парсер дат: 2026-12-31, 31.12.2026, 2026/12/31."""
    if not s:
        return None
    s = str(s).strip()
    fmts = ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y")
    for f in fmts:
        try:
            return datetime.datetime.strptime(s, f).date()
        except ValueError:
            continue
    return None


def last_limit_reset_time(t=None):
    """Момент последнего сброса лимитов (19:00).
    Если сейчас >= 19:00 — это 19:00 сегодня; иначе 19:00 вчера."""
    t = t or now()
    if t.hour >= LIMIT_RESET_HOUR:
        return t.replace(hour=LIMIT_RESET_HOUR, minute=0, second=0, microsecond=0)
    y = t - datetime.timedelta(days=1)
    return y.replace(hour=LIMIT_RESET_HOUR, minute=0, second=0, microsecond=0)


def subscription_status(info, t=None):
    """Статус подписки с учётом сброса в 19:00.
    Возвращает (key, short_text):
      'expired'       — истекла (дата в прошлом, либо сегодня и уже после 19:00)
      'expires_today' — истекает сегодня, но ещё до 19:00
      'soon'          — истекает в течение 3 дней
      'ok'            — всё нормально
      'unknown'       — дата не задана/не разобрана
    """
    t = t or now()
    exp = parse_date(info.get("expires"))
    if exp is None:
        return ("unknown", "—")
    today = t.date()
    if exp < today:
        return ("expired", "❌ истёк")
    if exp == today:
        if t.hour >= LIMIT_RESET_HOUR:
            return ("expired", "❌ истёк")
        return ("expires_today", "⚠ сегодня")
    delta = (exp - today).days
    if delta <= 3:
        return ("soon", f"⚠ {delta} дн.")
    return ("ok", f"{delta} дн.")


def limit_is_stale(info, t=None):
    """True если флаг лимита был выставлен ДО последнего сброса лимитов (19:00).
    Используется для авто-возврата 'исчерпан' -> 'есть' в 19:00."""
    updated = info.get("limit_updated")
    if not updated:
        return True
    try:
        dt = datetime.datetime.fromisoformat(updated)
    except Exception:
        return True
    return dt < last_limit_reset_time(t)


def normalize_limit_status(info, t=None):
    """Авто-сброс: если 'исчерпан' был помечен до последнего 19:00 — снова 'есть'."""
    t = t or now()
    if info.get("limit_status") == "exhausted" and limit_is_stale(info, t):
        info["limit_status"] = "available"
        info["limit_updated"] = t.isoformat(timespec="seconds")
        return True
    return False


def limit_label(info):
    """Отображаемый значок лимита: 🟢 / 🔴 / —."""
    st = info.get("limit_status", "")
    if st == "available":
        return "🟢"
    if st == "exhausted":
        return "🔴"
    return "—"


def fmt_remaining(n):
    """Красивое число токенов: 0 -> '0', 86544 -> '86.5k', 3000000 -> '3.00M'."""
    if not n or n <= 0:
        return "0"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


# --- профили -------------------------------------------------------------

def migrate_profile(info):
    """Совместимость со старым форматом (числовые remaining/limit_total)."""
    if "limit_status" not in info:
        info["limit_status"] = "available"  # по умолчанию считаем, что лимит есть
    info.setdefault("limit_updated", "")
    # выбрасываем устаревшие числовые поля, если есть
    for k in ("remaining", "limit_total", "remaining_updated", "daily_limit"):
        info.pop(k, None)
    return info


def load_store():
    data = read_json(PROFILES_JSON)
    if not data or not isinstance(data, dict) or "profiles" not in data:
        return {"profiles": {}, "active": None}
    data.setdefault("profiles", {})
    data.setdefault("active", None)
    for pid, info in data["profiles"].items():
        migrate_profile(info)
    return data


def save_store(data):
    write_json_raw(PROFILES_JSON, data)


def profile_dir(pid):
    return PROFILES_DIR / pid


def capture_live_to_profile(pid):
    """Копируем текущие живые credentials.json + config.json в профиль."""
    d = profile_dir(pid)
    d.mkdir(parents=True, exist_ok=True)
    for src in (LIVE_CRED, LIVE_CONFIG):
        if src.exists():
            shutil.copy2(src, d / src.name)
            log.info("copied %s -> %s", src, d / src.name)
        else:
            log.warning("source missing: %s", src)


def backup_live():
    """Делаем резервную копию живых файлов перед перезаписью."""
    ts = now().strftime("%Y%m%d_%H%M%S")
    bdir = BACKUPS_DIR / ts
    bdir.mkdir(parents=True, exist_ok=True)
    for src in (LIVE_CRED, LIVE_CONFIG):
        if src.exists():
            shutil.copy2(src, bdir / src.name)
    return bdir


def apply_profile_to_live(pid):
    """Копируем файлы профиля поверх живых (с бэкапом)."""
    d = profile_dir(pid)
    cred_src = d / "credentials.json"
    cfg_src = d / "config.json"
    if not cred_src.exists() or not cfg_src.exists():
        raise FileNotFoundError("У профиля нет сохранённых файлов аккаунта.")
    backup_live()
    shutil.copy2(cred_src, LIVE_CRED)
    shutil.copy2(cfg_src, LIVE_CONFIG)


def find_profile_by_user_id(data, uid):
    for pid, info in data["profiles"].items():
        if info.get("user_id") == uid:
            return pid
    return None


# --- процесс ZCode -------------------------------------------------------

def kill_zcode():
    subprocess.run("taskkill /F /IM ZCode.exe /T",
                   shell=True,
                   stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        if LOCKFILE.exists():
            LOCKFILE.unlink()
    except Exception:
        pass


def launch_zcode():
    try:
        subprocess.Popen([ZCODE_EXE], close_fds=True)
        return True
    except Exception as e:
        messagebox.showerror("Запуск ZCode", f"Не удалось запустить ZCode:\n{e}")
        return False


# =========================================================================
# = GUI                                                                    =
# =========================================================================

class AddAccountDialog(tk.Toplevel):
    """Диалог добавления текущего аккаунта."""

    def __init__(self, parent, default_name=""):
        super().__init__(parent)
        self.title("Добавить текущий аккаунт")
        self.resizable(False, False)
        self.grab_set()
        self.result = None

        pad = {"padx": 10, "pady": 6}
        frm = ttk.Frame(self, padding=14)
        frm.pack(fill="both", expand=True)

        ttk.Label(frm, text="Название *:").grid(row=0, column=0, sticky="w", **pad)
        self.name = tk.StringVar(value=default_name)
        self.name_entry = ttk.Entry(frm, textvariable=self.name, width=34)
        self.name_entry.grid(row=0, column=1, **pad)

        ttk.Label(frm, text="Подписка до:").grid(row=1, column=0, sticky="w", **pad)
        self.expires = tk.StringVar()
        ttk.Entry(frm, textvariable=self.expires, width=34).grid(row=1, column=1, **pad)
        ttk.Label(frm, text="напр. 2026-12-31", foreground="gray").grid(
            row=1, column=2, sticky="w")

        ttk.Label(frm, text="Лимит сегодня:").grid(row=2, column=0, sticky="nw", **pad)
        self.limit_status = tk.StringVar(value="available")
        lf = ttk.Frame(frm)
        lf.grid(row=2, column=1, sticky="w", **pad)
        ttk.Radiobutton(lf, text="🟢 Есть", value="available",
                        variable=self.limit_status).pack(side="left", padx=(0, 12))
        ttk.Radiobutton(lf, text="🔴 Исчерпан", value="exhausted",
                        variable=self.limit_status).pack(side="left")
        ttk.Label(frm, text="сброс в 19:00", foreground="gray").grid(
            row=2, column=2, sticky="w")

        ttk.Label(frm, text="Заметки:").grid(row=3, column=0, sticky="nw", **pad)
        self.notes = tk.Text(frm, width=34, height=3)
        self.notes.grid(row=3, column=1, **pad)

        btns = ttk.Frame(frm)
        btns.grid(row=4, column=0, columnspan=3, pady=(12, 0))
        ttk.Button(btns, text="Отмена", command=self._cancel).pack(side="left", padx=6)
        ttk.Button(btns, text="Сохранить", command=self._ok).pack(side="left", padx=6)

        self.transient(parent)
        self.attributes("-topmost", True)
        self.after(10, lambda: self.attributes("-topmost", False))
        self.geometry(f"+{parent.winfo_rootx() + 80}+{parent.winfo_rooty() + 80}")
        self.focus_force()
        self.name_entry.focus_set()
        self.bind("<Return>", lambda e: self._ok())
        self.bind("<Escape>", lambda e: self._cancel())
        self.wait_window()

    def _ok(self):
        if not self.name.get().strip():
            messagebox.showwarning("Имя", "Введите название аккаунта.", parent=self)
            return
        self.result = {
            "name": self.name.get().strip(),
            "expires": self.expires.get().strip(),
            "limit_status": self.limit_status.get(),
            "notes": self.notes.get("1.0", "end").strip(),
        }
        self.destroy()

    def _cancel(self):
        self.result = None
        self.destroy()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        log.info("App GUI initializing")
        self.title("ZCode Account Manager")
        self.geometry("880x540")
        self.minsize(820, 480)

        self.store = load_store()
        log.info("loaded store: %d profiles", len(self.store["profiles"]))
        self.selected_pid = tk.StringVar()

        # Кэш РЕАЛЬНЫХ лимитов из billing API: {user_id: {model_name: summary_model}}
        # Заполняется в фоне; None = ещё не опрошено, {} = ошибка.
        self.live_limits = {}
        self._billing_lock = threading.Lock()
        self._billing_in_progress = False

        self._build_ui()
        self.refresh()
        # запускаем автообновление статуса (без перезапуска менеджера)
        self.after(AUTO_REFRESH_MS, self._auto_refresh)
        # запускаем фоновый опрос реальных лимитов (отложенно)
        self.after(2000, self._refresh_billing_tick)
        log.info("App GUI ready")

    # --- построение интерфейса -------------------------------------------

    def _build_ui(self):
        # Верх: текущий аккаунт
        top = ttk.Frame(self, padding=(12, 10, 12, 4))
        top.pack(fill="x")
        ttk.Label(top, text="Текущий аккаунт:", font=("Segoe UI", 10, "bold")).pack(
            side="left")
        self.lbl_current = ttk.Label(top, text="…", foreground="#0a7")
        self.lbl_current.pack(side="left", padx=(6, 0))
        ttk.Label(top, text="  (статус 5с · лимиты реальные)",
                  foreground="gray").pack(side="left")
        ttk.Button(top, text="Обновить", command=self.refresh).pack(side="right")

        # Центр: список + детали
        mid = ttk.Frame(self, padding=(12, 4, 12, 4))
        mid.pack(fill="both", expand=True)

        # список
        left = ttk.LabelFrame(mid, text="Профили", padding=8)
        left.pack(side="left", fill="both", expand=True)

        cols = ("name", "limit", "sub", "uid")
        self.tree = ttk.Treeview(left, columns=cols, show="headings", height=12)
        self.tree.heading("name", text="Название")
        self.tree.heading("limit", text="Остаток")
        self.tree.heading("sub", text="Подписка")
        self.tree.heading("uid", text="ID аккаунта")
        self.tree.column("name", width=190, anchor="w")
        self.tree.column("limit", width=90, anchor="center")
        self.tree.column("sub", width=120, anchor="center")
        self.tree.column("uid", width=160, anchor="w")
        self.tree.pack(side="left", fill="both", expand=True)

        sb = ttk.Scrollbar(left, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")

        # подсветка строк: ЦВЕТ СТРОКИ ЗАВИСИТ ТОЛЬКО ОТ ЛИМИТА.
        # Статус подписки отображается текстом в колонке «Подписка» и НЕ красит строку.
        self.tree.tag_configure("exhausted", foreground="#c33",
                                font=("Segoe UI", 9, "bold"))
        self.tree.tag_configure("active", foreground="#0a7",
                                font=("Segoe UI", 9, "bold"))
        self.tree.tag_configure("normal", foreground="#222")  # читаемый тёмный, НЕ серый

        self.tree.bind("<<TreeviewSelect>>", self._on_select)
        self.tree.bind("<Double-1>", lambda e: self.switch_selected())

        # детали (косметика)
        right = ttk.LabelFrame(mid, text="Детали (косметика)", padding=10)
        right.pack(side="right", fill="both", padx=(10, 0))
        right.columnconfigure(1, weight=1)

        # Название
        ttk.Label(right, text="Название:").grid(row=0, column=0, sticky="w", pady=4)
        self.e_name = ttk.Entry(right, width=26)
        self.e_name.grid(row=0, column=1, columnspan=2, sticky="we", pady=4, padx=(8, 0))

        # Подписка до
        ttk.Label(right, text="Подписка до:").grid(row=1, column=0, sticky="w", pady=4)
        self.e_expires = ttk.Entry(right, width=26)
        self.e_expires.grid(row=1, column=1, sticky="we", pady=4, padx=(8, 0))
        ttk.Label(right, text="2026-12-31", foreground="gray").grid(
            row=1, column=2, sticky="w", padx=(4, 0))

        # Лимит сегодня (флаг)
        ttk.Label(right, text="Лимит сегодня:").grid(row=2, column=0, sticky="nw", pady=4)
        self.limit_status = tk.StringVar(value="available")
        lf = ttk.Frame(right)
        lf.grid(row=2, column=1, columnspan=2, sticky="w", pady=4, padx=(8, 0))
        ttk.Radiobutton(lf, text="🟢 Есть", value="available",
                        variable=self.limit_status).pack(side="left", padx=(0, 10))
        ttk.Radiobutton(lf, text="🔴 Исчерпан", value="exhausted",
                        variable=self.limit_status).pack(side="left")

        # Реальный остаток из billing API (только показ)
        ttk.Label(right, text="Остаток (API):").grid(row=3, column=0, sticky="nw", pady=4)
        self.lbl_real_limit = tk.Text(right, width=26, height=4, relief="flat",
                                      highlightthickness=0,
                                      font=("Segoe UI", 9), wrap="word")
        self.lbl_real_limit.grid(row=3, column=1, columnspan=2, sticky="we",
                                 pady=4, padx=(8, 0))
        self.lbl_real_limit.configure(state="disabled")

        # Заметки
        ttk.Label(right, text="Заметки:").grid(row=4, column=0, sticky="nw", pady=4)
        self.t_notes = tk.Text(right, width=26, height=4)
        self.t_notes.grid(row=4, column=1, columnspan=2, sticky="we", pady=4, padx=(8, 0))

        ttk.Button(right, text="Сохранить детали",
                   command=self.save_details).grid(row=5, column=0, columnspan=3,
                                                   sticky="we", pady=(8, 0))

        # Низ: действия
        bot = ttk.Frame(self, padding=(12, 4, 12, 12))
        bot.pack(fill="x")
        ttk.Button(bot, text="⇄ Переключиться на выбранный",
                   command=self.switch_selected).pack(side="left")
        ttk.Button(bot, text="+ Добавить текущий аккаунт",
                   command=self.add_current).pack(side="left", padx=6)
        ttk.Button(bot, text="🗑 Удалить",
                   command=self.delete_selected).pack(side="left")
        ttk.Button(bot, text="▶ Запустить ZCode",
                   command=launch_zcode).pack(side="right")

        # статус
        self.lbl_status = ttk.Label(self, text="", foreground="gray",
                                    padding=(12, 0, 12, 6))
        self.lbl_status.pack(fill="x")

    # --- отображение данных ----------------------------------------------

    def _maybe_auto_reset_limits(self):
        """После 19:00 (новый лимитный день) сбрасываем 'исчерпан' -> 'есть'."""
        changed = False
        for pid, info in self.store["profiles"].items():
            if normalize_limit_status(info):
                changed = True
                log.info("auto-reset limit for %s -> available", pid)
        if changed:
            save_store(self.store)

    def refresh(self):
        """Полное обновление (ручное или после действий)."""
        self.store = load_store()
        self._maybe_auto_reset_limits()
        self._refresh_current_label()
        self._refresh_tree()
        self._load_details()

    def _auto_refresh(self):
        """Тихое автообновление: статусы/текущий аккаунт, БЕЗ затирания полей деталей."""
        try:
            self.store = load_store()
            self._maybe_auto_reset_limits()
            self._refresh_current_label()
            self._refresh_tree_preserve_selection()
        except Exception:
            log.error("auto_refresh failed:\n%s", traceback.format_exc())
        finally:
            self.after(AUTO_REFRESH_MS, self._auto_refresh)

    def _refresh_current_label(self):
        uid = get_live_user_id()
        if not uid:
            self.lbl_current.config(
                text="(не определён — войдите в ZCode по start-plan)", foreground="#c33")
            return
        pid = find_profile_by_user_id(self.store, uid)
        if pid:
            name = self.store["profiles"][pid].get("name", uid)
            self.lbl_current.config(text=f"{name}   [{uid[:8]}…]", foreground="#0a7")
        else:
            self.lbl_current.config(
                text=f"не сохранён в менеджере   [{uid[:8]}…]", foreground="#a60")

    def _tree_rows(self):
        """Генератор строк дерева: (pid, disp_values, tag).

        Остаток и цвет строки берутся из РЕАЛЬНЫХ данных billing API.
        Пока биллинг не ответил — fallback на ручную отметку limit_status.
        """
        t = now()
        live_uid = get_live_user_id()
        items = sorted(self.store["profiles"].items(),
                       key=lambda kv: kv[1].get("name", "").lower())
        for pid, info in items:
            name = info.get("name", "?")
            uid = info.get("user_id") or ""
            is_active = (uid == live_uid)

            # подписка (текст в колонке, цвет строки НЕ трогает)
            sub_key, sub_text = subscription_status(info, t)

            disp_name = ("● " + name) if is_active else ("  " + name)

            # РЕАЛЬНЫЙ лимит из billing API
            real = self._real_limit_for(uid)
            if real is not None:
                # есть данные — цвет и текст по реальному остатку
                pct = real.get("pct_left", 0)
                limit_text = fmt_remaining(real.get("remaining", 0))
                real_exhausted = pct < EXHAUST_THRESHOLD_PCT
            else:
                # биллинг ещё не ответил — fallback на ручную отметку
                limit_text = limit_label(info)
                real_exhausted = (info.get("limit_status") == "exhausted")

            # ЦВЕТ СТРОКИ зависит ТОЛЬКО от лимита (не от подписки!).
            if real_exhausted:
                tag = "exhausted"
            elif is_active:
                tag = "active"
            else:
                tag = "normal"

            values = (disp_name, limit_text, sub_text, uid[:18] + "…")
            yield pid, values, tag

    def _refresh_tree(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        for pid, values, tag in self._tree_rows():
            self.tree.insert("", "end", iid=pid, values=values,
                             tags=(tag,) if tag else ())

    def _refresh_tree_preserve_selection(self):
        sel = self.tree.selection()
        for item in self.tree.get_children():
            self.tree.delete(item)
        for pid, values, tag in self._tree_rows():
            self.tree.insert("", "end", iid=pid, values=values,
                             tags=(tag,) if tag else ())
        if sel:
            try:
                self.tree.selection_set(sel)
            except Exception:
                pass

    def _on_select(self, _evt=None):
        self._load_details()

    def _load_details(self):
        sel = self.tree.selection()
        self.e_name.delete(0, "end")
        self.e_expires.delete(0, "end")
        self.limit_status.set("available")
        self.t_notes.delete("1.0", "end")
        self._load_real_limit(None)  # сброс блока реального остатка
        if not sel:
            return
        pid = sel[0]
        info = self.store["profiles"].get(pid, {})
        self.e_name.insert(0, info.get("name", ""))
        self.e_expires.insert(0, info.get("expires", ""))
        self.limit_status.set(info.get("limit_status") or "available")
        self.t_notes.insert("1.0", info.get("notes", ""))
        # реальный остаток для этого аккаунта
        self._load_real_limit(info.get("user_id"))

    def _load_real_limit(self, user_id):
        """Заполняет блок «Остаток (API)» реальными данными по всем моделям."""
        widget = self.lbl_real_limit
        widget.configure(state="normal")
        widget.delete("1.0", "end")
        if not user_id:
            widget.insert("1.0", "—")
            widget.configure(state="disabled")
            return
        models = None
        with self._billing_lock:
            cache = self.live_limits.get(user_id)
            if cache:
                models = list(cache.values())
        if not models:
            widget.insert("1.0", "загрузка… (обновляется в фоне)")
            widget.configure(state="disabled")
            return
        lines = []
        for m in sorted(models, key=lambda x: -x.get("total", 0)):
            pct = m.get("pct_left", 0)
            rem = fmt_remaining(m.get("remaining", 0))
            tot = fmt_remaining(m.get("total", 0))
            flag = " 🔴" if m.get("exhausted") else ""
            lines.append(f"{m.get('name','?')}: {rem} / {tot}  ({pct:.0f}%){flag}")
        widget.insert("1.0", "\n".join(lines))
        widget.configure(state="disabled")

    # --- действия --------------------------------------------------------

    def _status(self, text):
        self.lbl_status.config(text=text)

    # --- реальные лимиты через billing API (в фоне) ----------------------

    def _refresh_billing_tick(self):
        """Планировщик фонового опроса лимитов. Запускается по таймеру."""
        if billing_mod is None:
            return  # модуль биллинга недоступен — тихо работаем в старом режиме
        # не запускаем новый опрос, если предыдущий ещё идёт
        if not self._billing_in_progress:
            self._billing_in_progress = True
            th = threading.Thread(target=self._billing_worker, daemon=True)
            th.start()
        self.after(BILLING_REFRESH_MS, self._refresh_billing_tick)

    def _billing_worker(self):
        """В фоновом потоке: опрашивает все профили, складывает в кэш,
        затем просит главный поток перерисовать таблицу."""
        try:
            results = billing_mod.summarize_all(include_live=True)
            new_cache = {}
            for r in results:
                s = r.get("summary", {})
                uid = s.get("user_id")
                if not uid or not s.get("ok"):
                    continue
                # модель -> её сводка
                models = {m["name"]: m for m in s.get("models", [])}
                new_cache[uid] = models
            with self._billing_lock:
                self.live_limits = new_cache
            log.info("billing refreshed: %d accounts", len(new_cache))
        except Exception:
            log.exception("billing worker failed")
        finally:
            self._billing_in_progress = False
            # перерисовать таблицу в главном потоке
            try:
                self.after(0, self._safe_tree_refresh)
            except Exception:
                pass

    def _safe_tree_refresh(self):
        """Перерисовка таблицы + деталей в главном потоке после опроса биллинга."""
        try:
            self._refresh_tree_preserve_selection()
            # обновить блок реального остатка для выбранного аккаунта
            sel = self.tree.selection()
            if sel:
                info = self.store["profiles"].get(sel[0], {})
                self._load_real_limit(info.get("user_id"))
        except Exception:
            log.exception("tree refresh failed")

    def _real_limit_for(self, user_id, model=LIMIT_MODEL):
        """Возвращает summary-модель (dict) или None для данного аккаунта."""
        with self._billing_lock:
            models = self.live_limits.get(user_id)
        if not models:
            return None
        return models.get(model)

    def _real_limit_text(self, user_id):
        """Текст колонки «Остаток» из РЕАЛЬНЫХ данных, или заглушка."""
        m = self._real_limit_for(user_id)
        if m is None:
            return "…"  # ещё не опрошено / ошибка
        if m.get("remaining", 0) <= 0:
            return "0"
        return fmt_remaining(m["remaining"])

    def add_current(self):
        try:
            log.info("add_current clicked")
            uid = get_live_user_id()
            log.info("live user_id = %s", uid)
            if not uid:
                messagebox.showerror(
                    "Нет аккаунта",
                    "Не удалось определить текущий аккаунт start-plan.\n"
                    "Сначала войдите в ZCode через OAuth Z.ai (start-plan).")
                return

            existing = find_profile_by_user_id(self.store, uid)
            log.info("existing profile for this uid: %s", existing)
            if existing:
                if messagebox.askyesno(
                    "Уже есть",
                    "Этот аккаунт уже сохранён как «{}».\n"
                    "Обновить его файлы (перезаписать токены)?".format(
                        self.store["profiles"][existing].get("name", "?"))):
                    capture_live_to_profile(existing)
                    self._status("Токены аккаунта обновлены.")
                    self.refresh()
                return

            dlg = AddAccountDialog(self)
            log.info("dialog result keys: %s",
                     list(dlg.result.keys()) if dlg.result else None)
            if not dlg.result:
                log.info("user cancelled add dialog")
                return

            pid = uuid.uuid4().hex[:12]
            info = {
                "name": dlg.result["name"],
                "user_id": uid,
                "created": now().isoformat(timespec="seconds"),
                "expires": dlg.result["expires"],
                "limit_status": dlg.result["limit_status"],
                "limit_updated": now().isoformat(timespec="seconds"),
                "notes": dlg.result["notes"],
            }
            log.info("capturing live files into profile %s", pid)
            capture_live_to_profile(pid)
            log.info("capture done; files in dir: %s",
                     [p.name for p in profile_dir(pid).glob('*')])
            self.store["profiles"][pid] = info
            save_store(self.store)
            log.info("store saved; total profiles: %d", len(self.store["profiles"]))
            self._status(f"Добавлен аккаунт: {info['name']}")
            self.refresh()
        except Exception:
            log.error("add_current failed:\n%s", traceback.format_exc())
            messagebox.showerror("Ошибка", traceback.format_exc())

    def save_details(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("Детали", "Выберите профиль в списке.")
            return
        pid = sel[0]
        info = self.store["profiles"].setdefault(pid, {})
        new_name = self.e_name.get().strip()
        if not new_name:
            messagebox.showwarning("Имя", "Название не может быть пустым.")
            return
        info["name"] = new_name
        info["expires"] = self.e_expires.get().strip()

        new_limit = self.limit_status.get()
        # если статус лимита изменился — обновляем метку времени (сброс "устарел")
        if new_limit != info.get("limit_status"):
            info["limit_updated"] = now().isoformat(timespec="seconds")
        info["limit_status"] = new_limit

        info["notes"] = self.t_notes.get("1.0", "end").strip()
        save_store(self.store)
        self._status("Детали сохранены.")
        self.refresh()

    def delete_selected(self):
        sel = self.tree.selection()
        if not sel:
            return
        pid = sel[0]
        info = self.store["profiles"].get(pid, {})
        if not messagebox.askyesno(
                "Удаление",
                f"Удалить профиль «{info.get('name','?')}»?\n"
                "Сам логин в ZCode это не затронет — удалится только сохранённая копия."):
            return
        d = profile_dir(pid)
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
        self.store["profiles"].pop(pid, None)
        if self.store.get("active") == pid:
            self.store["active"] = None
        save_store(self.store)
        self._status("Профиль удалён.")
        self.refresh()

    def switch_selected(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("Переключение", "Выберите профиль в списке.")
            return
        target_pid = sel[0]
        target_info = self.store["profiles"].get(target_pid, {})
        target_uid = target_info.get("user_id")

        live_uid = get_live_user_id()
        current_pid = find_profile_by_user_id(self.store, live_uid)

        if live_uid and live_uid == target_uid:
            self._status("Этот аккаунт уже активен. Перезапускаю ZCode…")
            kill_zcode()
            launch_zcode()
            return

        if live_uid and current_pid is None:
            if not messagebox.askyesno(
                    "Текущий аккаунт не сохранён",
                    "Аккаунт, активный сейчас в ZCode, НЕ сохранён в менеджере.\n"
                    "После переключения его логин будет потерян.\n\n"
                    "Продолжить переключение?"):
                return
        else:
            if current_pid and current_pid != target_pid:
                capture_live_to_profile(current_pid)

        if not messagebox.askyesno(
                "Переключение",
                f"Переключиться на «{target_info.get('name','?')}»?\n"
                "ZCode будет закрыт и запущен заново."):
            return

        try:
            apply_profile_to_live(target_pid)
        except Exception as e:
            messagebox.showerror("Ошибка переключения", str(e))
            return

        self.store["active"] = target_pid
        save_store(self.store)
        self._status("Переключение… закрываю ZCode и запускаю заново.")
        kill_zcode()
        launch_zcode()
        self.after(1500, self.refresh)


if __name__ == "__main__":
    log.info("=== main entry ===")
    try:
        App().mainloop()
    except Exception as e:
        log.error("mainloop crashed:\n%s", traceback.format_exc())
        try:
            messagebox.showerror("Критическая ошибка", traceback.format_exc())
        except Exception:
            pass
        raise
    log.info("=== main exit ===")
