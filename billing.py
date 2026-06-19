# -*- coding: utf-8 -*-
"""
billing.py — опрос лимитов плана ZCode (GLM-5.2 / GLM-5-Turbo).

Работает с теми же профилями, что и account_manager.py: читает JWT из
data/profiles/<id>/config.json (поле provider["builtin:zai-start-plan"].apiKey)
и дёргает официальный billing API zcode.z.ai.

Billing API (в отличие от /v1/messages) НЕ требует captcha — достаточно
Authorization: Bearer <JWT>. Проверено эмпирически.

API endpoints (служебные, из логов ZCode):
  GET /api/v1/zcode-plan/billing/balance?app_version=3.0.1  — остатки токенов
  GET /api/v1/zcode-plan/billing/current?app_version=3.0.1  — план/даты

Можно использовать как библиотеку, так и как CLI: python billing.py
"""

import json
import base64
import logging
import datetime
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None  # сообщим при вызове

log = logging.getLogger("zam.billing")

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
PROFILES_DIR = DATA_DIR / "profiles"
PROFILES_JSON = DATA_DIR / "profiles.json"

# "Живой" аккаунт — то, что сейчас активно в ZCode
HOME = Path.home()
LIVE_CONFIG = HOME / ".zcode" / "v2" / "config.json"

START_PLAN_KEY = "builtin:zai-start-plan"
BILLING_BASE = "https://zcode.z.ai/api/v1/zcode-plan"
APP_VERSION = "3.0.1"

# порог «почти исчерпан» в %: если осталось меньше этого — помечаем 🔴
EXHAUST_THRESHOLD_PCT = 5


# =========================================================================
# = Чтение JWT из разных источников                                       =
# =========================================================================

def _b64url_decode(s):
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode("ascii"))


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def jwt_user_id(jwt_str):
    try:
        payload = jwt_str.split(".")[1]
        return json.loads(_b64url_decode(payload)).get("user_id")
    except Exception:
        return None


def jwt_from_config(cfg_path):
    """Достаёт apiKey (JWT) провайдера start-plan из config.json."""
    cfg = _read_json(cfg_path)
    if not cfg:
        return None
    try:
        return cfg["provider"][START_PLAN_KEY]["options"]["apiKey"]
    except Exception:
        return None


# =========================================================================
# = Запросы к billing API                                                  =
# =========================================================================

def _get(url, jwt, timeout=20):
    if requests is None:
        raise RuntimeError("библиотека 'requests' не установлена: pip install requests")
    r = requests.get(url, headers={"Authorization": f"Bearer {jwt}"}, timeout=timeout)
    return r.status_code, r.json() if r.headers.get("content-type", "").startswith("application/json") else {}


def fetch_balance(jwt):
    """Остатки токенов по моделям. Возвращает список dict или [] при ошибке."""
    code, body = _get(f"{BILLING_BASE}/billing/balance?app_version={APP_VERSION}", jwt)
    if code != 200 or body.get("code") != 0:
        log.warning("balance failed: http=%s body=%s", code, body)
        return []
    return body.get("data", {}).get("balances", [])


def fetch_current(jwt):
    """Текущий план: статус, даты, гранты. Возвращает dict или None."""
    code, body = _get(f"{BILLING_BASE}/billing/current?app_version={APP_VERSION}", jwt)
    if code != 200 or body.get("code") != 0:
        log.warning("current failed: http=%s body=%s", code, body)
        return None
    plans = body.get("data", {}).get("plans", [])
    return plans[0] if plans else None


# =========================================================================
# = Нормализация в единый вид                                              =
# =========================================================================

def _ts_to_date(ts):
    """epoch -> 'YYYY-MM-DD' (локальное время)."""
    try:
        return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    except Exception:
        return None


def summarize(jwt):
    """Полная сводка по одному аккаунту.

    Возвращает:
      {
        "ok": True/False,
        "user_id": str,
        "plan": {status, name, ends_at(date)},
        "models": [
          {name, total, used, remaining, available, reset_at(datetime), pct_left},
          ...
        ]
      }
    """
    uid = jwt_user_id(jwt)
    balances = fetch_balance(jwt)
    plan = fetch_current(jwt)
    if not balances and not plan:
        return {"ok": False, "error": "api_error", "user_id": uid}

    models = []
    for b in balances:
        total = b.get("total_units", 0) or 0
        remaining = b.get("remaining_units", 0) or 0
        used = b.get("used_units", 0) or 0
        pct_left = round(remaining / total * 100, 1) if total else 0.0
        reset_at = None
        if b.get("period_end"):
            try:
                reset_at = datetime.datetime.fromtimestamp(b["period_end"])
            except Exception:
                reset_at = None
        models.append({
            "name": b.get("show_name", "?"),
            "total": total,
            "used": used,
            "remaining": remaining,
            "available": b.get("available_units", remaining),
            "reset_at": reset_at,
            "pct_left": pct_left,
            "exhausted": pct_left < EXHAUST_THRESHOLD_PCT,
        })

    plan_info = None
    if plan:
        plan_info = {
            "status": plan.get("status"),
            "name": plan.get("name"),
            "ends_at": _ts_to_date(plan.get("ends_at")) if plan.get("ends_at") else None,
        }

    return {"ok": True, "user_id": uid, "plan": plan_info, "models": models}


def is_exhausted(summary, model="GLM-5.2"):
    """Удобный предикат: исчерпан ли конкретный лимит модели."""
    if not summary.get("ok"):
        return False
    for m in summary.get("models", []):
        if m["name"] == model:
            return m["exhausted"]
    return False


# =========================================================================
# = Опрос всех сохранённых профилей менеджера аккаунтов                   =
# =========================================================================

def _load_profiles_meta():
    """Возвращает [(profile_id, name, config_path), ...] из менеджера."""
    store = _read_json(PROFILES_JSON) or {"profiles": {}}
    out = []
    for pid, info in store.get("profiles", {}).items():
        name = info.get("name", pid)
        cfg_path = PROFILES_DIR / pid / "config.json"
        out.append((pid, name, cfg_path))
    return out


def summarize_all(include_live=True):
    """Опрашивает ВСЕ профили менеджера + (опц.) живой аккаунт.

    Возвращает список:
      [{source, id, name, summary, jwt_ok}, ...]
    """
    results = []

    # сохранённые профили
    for pid, name, cfg_path in _load_profiles_meta():
        jwt = jwt_from_config(cfg_path) if cfg_path.exists() else None
        if not jwt:
            results.append({"source": "profile", "id": pid, "name": name,
                            "summary": {"ok": False, "error": "no_jwt"},
                            "jwt_ok": False})
            continue
        results.append({"source": "profile", "id": pid, "name": name,
                        "summary": summarize(jwt), "jwt_ok": True})

    # живой аккаунт
    if include_live:
        jwt = jwt_from_config(LIVE_CONFIG)
        if jwt:
            live_uid = jwt_user_id(jwt)
            # проверим, не дублирует ли он уже сохранённый профиль
            already = any(r["summary"].get("user_id") == live_uid and r["summary"].get("ok")
                          for r in results)
            if not already:
                results.append({"source": "live", "id": "live", "name": "(текущий в ZCode)",
                                "summary": summarize(jwt), "jwt_ok": True})
    return results


# =========================================================================
# = CLI                                                                    =
# =========================================================================

def _fmt_models(models):
    lines = []
    for m in models:
        bar_filled = int(m["pct_left"] / 10)
        bar = "█" * bar_filled + "░" * (10 - bar_filled)
        reset = m["reset_at"].strftime("%H:%M") if m["reset_at"] else "?"
        flag = " 🔴" if m["exhausted"] else ""
        lines.append(
            f"    {m['name']:14} {bar} {m['pct_left']:5.1f}%  "
            f"осталось {m['remaining']:>10,} / {m['total']:,}  "
            f"сброс {reset}{flag}"
        )
    return "\n".join(lines)


def main():
    print("=" * 64)
    print("ZCode Plan Billing — опрос лимитов всех аккаунтов")
    print("=" * 64)
    results = summarize_all(include_live=True)
    if not results:
        print("\nНет ни одного аккаунта. Сначала добавьте их в менеджере.")
        return

    for r in results:
        s = r["summary"]
        print()
        print(f"─ {r['name']}  [{r['source']}]")
        if not s.get("ok"):
            print(f"    ⚠ не удалось получить: {s.get('error', '?')} "
                  f"(JWT мог протухнуть — перезапусти ZCode под этим аккаунтом)")
            continue
        plan = s.get("plan") or {}
        ends = plan.get("ends_at") or "?"
        print(f"    user_id: {s.get('user_id','?')}")
        print(f"    план:    {plan.get('name','?')} — {plan.get('status','?')} (до {ends})")
        print(_fmt_models(s.get("models", [])))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log.exception("billing CLI crashed")
        print(f"Ошибка: {e}")
        sys.exit(1)
