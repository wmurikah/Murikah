"""Murikah Tutor visible-text policy helpers."""
from __future__ import annotations

import re

_ENTITY_RE = re.compile(r"(?i)&mdash;|&#8212;|&#x0*2014;")
_CODE_RE = re.compile(r"\x60\x60\x60[\s\S]*?\x60\x60\x60|\x60[^\x60\n]*\x60")
_URL_RE = re.compile(r"https?://[^\s<>()]+", re.IGNORECASE)


def _sanitize_code(value: str) -> str:
    value = value.replace("\u2014", "\\u2014")
    return _ENTITY_RE.sub(r"\\u2014", value)


def _sanitize_url(value: str) -> str:
    value = value.replace("\u2014", "%E2%80%94")
    value = re.sub(r"(?i)&mdash;", "%26mdash%3B", value)
    value = re.sub(r"(?i)&#8212;", "%26%238212%3B", value)
    value = re.sub(r"(?i)&#x0*2014;", "%26%23x2014%3B", value)
    return value


def _sanitize_plain(value: str) -> str:
    value = value.replace(" \u2014 ", "; ")
    value = value.replace("\u2014", ", ")
    value = _ENTITY_RE.sub("; ", value)
    return value


def sanitize_murikah_visible_text(value: object) -> str:
    """Remove em-dash output without changing ordinary hyphens or en dashes."""
    text = str(value or "")
    if not text:
        return ""

    output: list[str] = []
    cursor = 0
    for code_match in _CODE_RE.finditer(text):
        plain = text[cursor : code_match.start()]
        plain_cursor = 0
        for url_match in _URL_RE.finditer(plain):
            output.append(_sanitize_plain(plain[plain_cursor : url_match.start()]))
            output.append(_sanitize_url(url_match.group(0)))
            plain_cursor = url_match.end()
        output.append(_sanitize_plain(plain[plain_cursor:]))
        output.append(_sanitize_code(code_match.group(0)))
        cursor = code_match.end()

    tail = text[cursor:]
    tail_cursor = 0
    for url_match in _URL_RE.finditer(tail):
        output.append(_sanitize_plain(tail[tail_cursor : url_match.start()]))
        output.append(_sanitize_url(url_match.group(0)))
        tail_cursor = url_match.end()
    output.append(_sanitize_plain(tail[tail_cursor:]))
    return "".join(output)


MURIKAH_VISIBLE_STYLE_RULE = (
    "Do not use em dashes. Use commas, periods, colons or semicolons instead."
)


__all__ = ["MURIKAH_VISIBLE_STYLE_RULE", "sanitize_murikah_visible_text"]
