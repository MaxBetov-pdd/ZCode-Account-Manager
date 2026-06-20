# -*- coding: utf-8 -*-
"""
zcode_encrypt.py — мост между autoreg (открытые токены) и файлами ZCode.

ZCode хранит аккаунт start-plan в двух файлах:
  ~/.zcode/v2/credentials.json  — поля зашифрованы собственным форматом enc:v1:
  ~/.zcode/v2/config.json       — JWT лежит открыто в provider[builtin:zai-start-plan].apiKey

Этот модуль умеет:
  * encrypt()/decrypt()  — формат enc:v1: (AES-256-GCM, точная копия логики ZCode@electron)
  * build_config_json()  — собрать config.json из JWT
  * build_credentials_json() — собрать и зашифровать credentials.json из открытых полей

Ключ шифрования детерминированный:
  SHA256("zcode-credential-fallback:" + os.platform() + ":" + os.homedir() + ":" + username)
В Node os.platform() на Windows = "win32" (НЕ "Windows").

Проверено на реальных 16 профилях: дешифровка совпадает, перешифрование корректно.
"""

import os
import json
import base64
import hashlib
import platform
import getpass
import uuid
import datetime
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    AESGCM = None  # сообщим при вызове

# --- константы формата enc:v1: (точно как в zcode.cjs) -------------------

PREFIX = "enc:v1:"          # Dct
ALGO = "aes-256-gcm"        # T3r
IV_LEN = 12                 # E3r (nonce)
TAG_LEN = 16                # Mro (auth tag)
ENV_SECRET_VAR = "ZCODE_CREDENTIAL_SECRET"  # zro

START_PLAN_KEY = "builtin:zai-start-plan"


# =========================================================================
# = Ключ шифрования                                                        =
# =========================================================================

def resolve_secret():
    """Воспроизведение Nro() из zcode.cjs:
    приоритет — env ZCODE_CREDENTIAL_SECRET, иначе fallback по платформе/дому/юзеру."""
    explicit = os.environ.get(ENV_SECRET_VAR, "").strip()
    if explicit:
        return explicit
    # os.platform() в Node на Windows = "win32"
    plat = "win32" if platform.system() == "Windows" else platform.system().lower()
    home = str(Path.home())
    try:
        user = getpass.getuser()
    except Exception:
        user = "unknown"
    return f"zcode-credential-fallback:{plat}:{home}:{user}"


def derive_key(secret=None):
    """SHA256(secret) -> 32 байта (воспроизведение Oro())."""
    if secret is None:
        secret = resolve_secret()
    return hashlib.sha256(secret.encode("utf-8")).digest()


# =========================================================================
# = Шифрование / дешифрование enc:v1:                                     =
# =========================================================================

def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def encrypt(plain: str, secret=None) -> str:
    """Открытая строка -> enc:v1:<nonce>.<authtag>.<ciphertext> (base64url)."""
    if AESGCM is None:
        raise RuntimeError("нужна библиотека: pip install cryptography")
    key = derive_key(secret)
    nonce = os.urandom(IV_LEN)
    blob = AESGCM(key).encrypt(nonce, plain.encode("utf-8"), None)  # ct||tag
    ct, tag = blob[:-TAG_LEN], blob[-TAG_LEN:]
    return f"{PREFIX}{_b64url_encode(nonce)}.{_b64url_encode(tag)}.{_b64url_encode(ct)}"


def decrypt(enc: str, secret=None) -> str:
    """enc:v1:... -> открытая строка. Не-enc строки возвращает как есть."""
    if not isinstance(enc, str) or not enc.startswith(PREFIX):
        return enc
    key = derive_key(secret)
    parts = enc[len(PREFIX):].split(".")
    if len(parts) != 3:
        raise ValueError("Credential decrypt failed: invalid ciphertext format")
    nonce, tag, ct = (_b64url_decode(p) for p in parts)
    if len(nonce) != IV_LEN:
        raise ValueError("Credential decrypt failed: invalid IV length")
    if len(tag) != TAG_LEN:
        raise ValueError("Credential decrypt failed: invalid auth tag length")
    try:
        return AESGCM(key).decrypt(nonce, ct + tag, None).decode("utf-8")
    except Exception as e:
        raise ValueError(
            "Credential decrypt failed: key mismatch or corrupted ciphertext"
        ) from e


# =========================================================================
# = Сборка файлов аккаунта ZCode                                          =
# =========================================================================

def _parse_jwt_user_id(jwt_str):
    """user_id из payload JWT (без проверки подписи — только чтение)."""
    try:
        payload = jwt_str.split(".")[1]
        data = json.loads(_b64url_decode(payload))
        return data.get("user_id") or data.get("sub")
    except Exception:
        return None


def _new_feedback_id():
    """zcodefeedbackclientid имеет вид fb_<uuid>."""
    return f"fb_{uuid.uuid4()}"


def build_config_json(jwt, template_path=None):
    """Собирает config.json: берёт шаблон (если есть) и прописывает JWT в start-plan.

    jwt — токен провайдера builtin:zai-start-plan (eyJ...).
    template_path — путь к существующему config.json (возьмём структуру провайдеров оттуда).
                    Если None — используется минимальный рабочий шаблон.
    """
    if template_path and Path(template_path).exists():
        with open(template_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    else:
        cfg = _minimal_config_template()

    provider = cfg.setdefault("provider", {})
    sp = provider.setdefault(START_PLAN_KEY, {})
    sp.setdefault("name", "Z.ai - Coding Plan")
    sp.setdefault("kind", "anthropic")
    opts = sp.setdefault("options", {})
    opts["apiKey"] = jwt
    opts["baseURL"] = "https://zcode.z.ai/api/v1/zcode-plan/anthropic"
    opts["apiKeyRequired"] = True
    sp["enabled"] = True
    sp.setdefault("source", "custom")
    return cfg


def build_credentials_json(
    jwt,
    oauth_access_token=None,
    user_id=None,
    email=None,
    name=None,
    feedback_id=None,
):
    """Собирает credentials.json с зашифрованными полями (enc:v1:).

    Все поля, которые ZCode пишет при логине start-plan:
      zcodefeedbackclientid, oauth:zai:access_token, zcodejwttoken,
      oauth:zai:user_info, oauth:active_provider
    """
    uid = user_id or _parse_jwt_user_id(jwt)

    user_info = {
        "user_id": uid,
        "email": email or "",
        "name": name or (email.split("@")[0] if email else "user"),
    }
    # avatar — пустой data-uri (ZCode обновит сам при первом запросе)
    user_info.setdefault("avatar", "")

    record = {
        "zcodefeedbackclientid": feedback_id or _new_feedback_id(),
        "oauth:zai:access_token": oauth_access_token or jwt,
        "zcodejwttoken": jwt,
        "oauth:zai:user_info": json.dumps(user_info, ensure_ascii=False),
        "oauth:active_provider": "zai",
    }
    # каждое значение шифруем
    return {k: encrypt(str(v)) for k, v in record.items()}


def _minimal_config_template():
    """Минимальный config.json, достаточный для запуска ZCode под start-plan."""
    return {
        "$schema": "https://opencode.ai/config.json",
        "provider": {},
    }


# =========================================================================
# = Запись в профиль менеджера                                            =
# =========================================================================

def write_profile_files(
    dest_dir,
    jwt,
    oauth_access_token=None,
    user_id=None,
    email=None,
    name=None,
    config_template=None,
):
    """Записывает config.json + credentials.json в dest_dir (папка профиля).

    Возвращает user_id (для записи в profiles.json).
    """
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    uid = user_id or _parse_jwt_user_id(jwt)
    if not uid:
        raise ValueError("Не удалось извлечь user_id из JWT")

    cfg = build_config_json(jwt, config_template)
    cred = build_credentials_json(
        jwt,
        oauth_access_token=oauth_access_token,
        user_id=uid,
        email=email,
        name=name,
    )

    with open(dest / "config.json", "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    with open(dest / "credentials.json", "w", encoding="utf-8") as f:
        json.dump(cred, f, ensure_ascii=False, indent=2)

    return uid


# =========================================================================
# = Отладка / self-test при запуске напрямую                              =
# =========================================================================

if __name__ == "__main__":
    print("=== zcode_encrypt self-test ===")
    print(f"secret: {resolve_secret()!r}")
    print(f"key:    {derive_key().hex()}")

    # круглый путь
    test = "builtin:zai-start-plan"
    enc = encrypt(test)
    dec = decrypt(enc)
    print(f"\nround-trip: {test!r}")
    print(f"  enc: {enc[:60]}...")
    print(f"  dec: {dec!r}")
    print(f"  OK:  {dec == test}")

    # проверка на реальном профиле (если есть)
    cred_path = Path(__file__).parent / "data" / "profiles" / "b48c1772fdcf" / "credentials.json"
    if cred_path.exists():
        print(f"\n=== дешифровка реального профиля {cred_path.parent.name} ===")
        rec = json.loads(cred_path.read_text(encoding="utf-8"))
        for k, v in rec.items():
            try:
                plain = decrypt(v)
                shown = plain if len(plain) < 70 else plain[:67] + "..."
                print(f"  {k:35} {shown}")
            except Exception as e:
                print(f"  {k:35} FAIL: {e}")
    else:
        print("\n(профиль b48c1772fdcf не найден — пропуск дешифровки)")
