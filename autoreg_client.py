# -*- coding: utf-8 -*-
"""
autoreg_client.py — управление TS-сервером авторега + HTTP-клиент API.

Связующее звено между Tkinter-менеджером (account_manager.py) и
Express-сервером (src/index.ts, порт 3847):

  AutoregServer — поднимает/останавливает TS-сервер как фоновый subprocess,
                  проверяет health, даёт HTTP-методы.
  AutoregClient — высокоуровневые операции: создать job, запустить pipeline,
                  опросить статус, получить готовый бандл.

Сценарий «без прокси»: proxy="direct://" (патч из Фазы 1) — все запросы
идут напрямую с локального IP.
"""

import os
import sys
import time
import shutil
import logging
import subprocess
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None

log = logging.getLogger("zam.autoreg")

APP_DIR = Path(__file__).resolve().parent
TS_ENTRY = APP_DIR / "src" / "index.ts"
DEFAULT_PORT = 3847
HEALTH_TIMEOUT = 60  # секунд на запуск сервера (npx tsx первый раз качает пакет)


# =========================================================================
# = Менеджер TS-сервера                                                   =
# =========================================================================

class AutoregServer:
    """Поднимает Express-сервер (npx tsx src/index.ts) как фоновый процесс."""

    _instance = None

    def __init__(self, port=DEFAULT_PORT):
        self.port = port
        self.process = None
        self.base_url = f"http://127.0.0.1:{port}"

    @classmethod
    def get(cls, port=DEFAULT_PORT):
        if cls._instance is None:
            cls._instance = cls(port)
        return cls._instance

    # --- жизненный цикл --------------------------------------------------

    def is_alive(self):
        """Быстрая проверка: отвечает ли /api/health."""
        try:
            r = requests.get(f"{self.base_url}/api/health", timeout=3)
            return r.status_code == 200 and r.json().get("ok") is True
        except Exception:
            return False

    def ensure_started(self):
        """Запускает сервер, если он ещё не работает. True при успехе."""
        if self.is_alive():
            log.info("autoreg server already alive")
            return True

        if not TS_ENTRY.exists():
            raise RuntimeError(f"TS-точка входа не найдена: {TS_ENTRY}")
        if requests is None:
            raise RuntimeError("нужна библиотека 'requests': pip install requests")

        # npx на Windows = npx.cmd — нужен shell=True
        env = os.environ.copy()
        env["PORT"] = str(self.port)

        log.info("starting TS autoreg server (npx tsx)...")
        self.process = subprocess.Popen(
            "npx tsx src/index.ts",
            cwd=str(APP_DIR),
            shell=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            creationflags=(subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0),
        )

        # ждём health
        deadline = time.time() + HEALTH_TIMEOUT
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"TS-сервер упал при запуске (exit code {self.process.returncode}). "
                    f"Проверь: npm install + npx playwright install chromium."
                )
            if self.is_alive():
                log.info("autoreg server ready on port %d", self.port)
                return True
            time.sleep(1)

        raise RuntimeError(
            f"TS-сервер не стал healthy за {HEALTH_TIMEOUT}с. "
            f"Возможно npm install ещё не завершён."
        )

    def stop(self):
        """Корректно убивает сервер (весь process tree — cmd + node)."""
        if self.process is None:
            return
        pid = self.process.pid
        try:
            # /T = убить всё дерево (cmd.exe + node.exe)
            subprocess.run(
                f"taskkill /F /T /PID {pid}",
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            log.info("autoreg server stopped (pid %d)", pid)
        except Exception:
            try:
                self.process.kill()
            except Exception:
                pass
        self.process = None

    # --- HTTP-хелперы ----------------------------------------------------

    def _get(self, path, timeout=15):
        r = requests.get(f"{self.base_url}{path}", timeout=timeout)
        r.raise_for_status()
        return r.json()

    def _post(self, path, data=None, timeout=600):
        r = requests.post(f"{self.base_url}{path}", json=data or {}, timeout=timeout)
        r.raise_for_status()
        return r.json()

    def _delete(self, path, timeout=15):
        r = requests.delete(f"{self.base_url}{path}", timeout=timeout)
        r.raise_for_status()
        return r.json()


# =========================================================================
# = Высокоуровневый клиент автoрега                                      =
# =========================================================================

# Человекочитаемые названия шагов pipeline для GUI
STEP_LABELS = {
    "created": "создан",
    "captcha": "решаем капчу (Playwright)...",
    "signup": "регистрация на Z.AI...",
    "email_wait": "ждём письмо подтверждения (IMAP)...",
    "finish_signup": "завершаем регистрацию...",
    "platform_login": "логин на платформе Z.AI...",
    "api_key": "создаём API key...",
    "zcode_oauth": "ZCode OAuth (Playwright)...",
    "zcode_captcha": "ZCode капча...",
    "done": "готово",
    "cancelled": "отменён",
    "error": "ошибка",
}


def step_label(step):
    return STEP_LABELS.get(step, step)


class AutoregClient:
    """Высокоуровневые операции с API сервера авторега."""

    def __init__(self, server=None):
        self.server = server or AutoregServer.get()

    def ensure_started(self):
        return self.server.ensure_started()

    def is_alive(self):
        return self.server.is_alive()

    # --- операции с job --------------------------------------------------

    def create_job(self, email, mail_password=None, proxy="direct://", username=None):
        """Создаёт задачу авторегистрации. Возвращает объект job."""
        data = {
            "email": email.strip(),
            "username": (username or email.split("@")[0]).strip(),
            "proxy": proxy or "direct://",
        }
        if mail_password:
            data["mail_password"] = mail_password
        return self.server._post("/api/autoreg/jobs", data, timeout=15)

    def run_full(self, job_id):
        """POST /auto-run — блокирует на несколько минут (капча + signup + email)."""
        return self.server._post(f"/api/autoreg/jobs/{job_id}/auto-run", timeout=600)

    def get_job(self, job_id):
        """Текущий статус задачи."""
        return self.server._get(f"/api/autoreg/jobs/{job_id}")

    def get_bundle(self, job_id):
        """Готовый бандл (zcode_jwt, oauth, user_id и т.д.) — когда step=done."""
        return self.server._get(f"/api/autoreg/jobs/{job_id}/zcode-bundle")

    def cancel_job(self, job_id):
        return self.server._post(f"/api/autoreg/jobs/{job_id}/cancel", timeout=15)

    def delete_job(self, job_id):
        return self.server._delete(f"/api/autoreg/jobs/{job_id}")


# =========================================================================
# = CLI self-test                                                         =
# =========================================================================

if __name__ == "__main__":
    print("=== autoreg_client self-test ===")
    srv = AutoregServer.get()
    try:
        ok = srv.ensure_started()
        print(f"server alive: {ok}")
        print(f"health: {srv._get('/api/health')}")
    except Exception as e:
        print(f"ERROR: {e}")
    finally:
        srv.stop()
