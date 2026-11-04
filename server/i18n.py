"""14 语字典与本地化工具。

locale 代码沿用 DLsite 的写法（ja-jp / en-us / zh-cn …），
URL 前缀、hreflang、html lang 三者都从这里派生，避免三处各写一套。
"""

import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_STRINGS_PATH = os.path.join(_HERE, "i18n", "strings.json")

LOCALES = [
    {"code": "ja-jp", "hreflang": "ja-JP", "label": "日本語", "html_lang": "ja"},
    {"code": "en-us", "hreflang": "en-US", "label": "English", "html_lang": "en"},
    {"code": "zh-cn", "hreflang": "zh-CN", "label": "简体中文", "html_lang": "zh-Hans"},
    {"code": "zh-tw", "hreflang": "zh-TW", "label": "繁體中文", "html_lang": "zh-Hant"},
    {"code": "ko-kr", "hreflang": "ko-KR", "label": "한국어", "html_lang": "ko"},
    {"code": "es-es", "hreflang": "es-ES", "label": "Español", "html_lang": "es"},
    {"code": "de-de", "hreflang": "de-DE", "label": "Deutsch", "html_lang": "de"},
    {"code": "fr-fr", "hreflang": "fr-FR", "label": "Français", "html_lang": "fr"},
    {"code": "id-id", "hreflang": "id-ID", "label": "Bahasa Indonesia", "html_lang": "id"},
    {"code": "it-it", "hreflang": "it-IT", "label": "Italiano", "html_lang": "it"},
    {"code": "pt-br", "hreflang": "pt-BR", "label": "Português", "html_lang": "pt-BR"},
    {"code": "sv-se", "hreflang": "sv-SE", "label": "Svenska", "html_lang": "sv"},
    {"code": "th-th", "hreflang": "th-TH", "label": "ภาษาไทย", "html_lang": "th"},
    {"code": "vi-vn", "hreflang": "vi-VN", "label": "Tiếng Việt", "html_lang": "vi"},
]

CODES = [loc["code"] for loc in LOCALES]
BY_CODE = {loc["code"]: loc for loc in LOCALES}
DEFAULT_LOCALE = "ja-jp"

with open(_STRINGS_PATH, encoding="utf-8") as _fh:
    STRINGS = json.load(_fh)

_missing = [c for c in CODES if c not in STRINGS]
if _missing:
    raise RuntimeError("strings.json 缺少语言：%s" % _missing)


def t(locale, key, **kwargs):
    """取一条文案；缺键时回落到默认语言，再缺则返回键名。"""
    table = STRINGS.get(locale) or STRINGS[DEFAULT_LOCALE]
    text = table.get(key) or STRINGS[DEFAULT_LOCALE].get(key) or key
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, IndexError, ValueError):
            return text
    return text


def pick(request, path_locale=None):
    """URL 前缀优先，其次 Accept-Language，最后默认。"""
    if path_locale in BY_CODE:
        return path_locale
    best, best_q = DEFAULT_LOCALE, 0.0
    for lang, q in request.accept_languages:
        code = lang.replace("_", "-").lower()
        if code in BY_CODE:
            if q > best_q:
                best, best_q = code, q
        else:
            base = code.split("-")[0]
            for cand in CODES:
                if cand.split("-")[0] == base and q > best_q:
                    best, best_q = cand, q
                    break
    return best
