"""Turn untrusted client JSON into values the game logic can trust.

This is the sanitization boundary: everything a phone sends arrives as arbitrary
JSON, and the rest of the backend assumes it has already been through here.
Nothing in this module raises - each helper returns a safe fallback (an empty
list, an empty string, a default name) so a hostile or buggy client can only ever
get its own message ignored.

The equivalents in the frontend (``public/identify.js``) and in the legacy Node
server are kept deliberately in step with these rules, in particular the
"finite numbers only" filtering below.
"""

import math

#: ``(field, max_len, required)`` for each vector in one gallery sample.
#: Required fields are stored even when empty so the client can rely on their
#: presence; optional ones are dropped when they carry nothing.
GALLERY_FIELDS = (
    ("hist", 64, True),
    ("grid", 256, True),
    ("lower", 64, False),
    ("shape", 8, False),
    ("embed", 512, False),
    ("reid", 512, False),  # person re-identification embedding (public/reid.js)
)

#: An enrolment scan is one sample per angle; more than this is junk or abuse.
MAX_GALLERY_SAMPLES = 24

MAX_MOTION_SAMPLES = 32  # per relayed message (~3 s at 10 Hz)


def clean_room_code(code):
    """Lowercase, alphanumeric-and-dash, max 16 chars, never empty."""
    cleaned = "".join(ch for ch in str(code or "demo").lower() if ch.isalnum() or ch == "-")[:16]
    return cleaned or "demo"


def clean_name(name):
    return str(name or "").strip()[:20] or "Player"


def clean_player_id(player_id):
    """Accept a client-supplied id only if it looks like one we issued.

    Ids are UUIDs, optionally with the ``:debug-clone`` suffix, so the character
    set is deliberately narrow. Returns ``""`` for anything else, which callers
    read as "no id was supplied".
    """
    value = str(player_id or "").strip()
    if 8 <= len(value) <= 80 and all(char.isalnum() or char in ":-" for char in value):
        return value
    return ""


def clean_vector(vector, max_len):
    """Coerce one feature vector to a capped list of finite floats.

    Non-finite values have to be rejected explicitly: ``float()`` happily
    returns NaN/Infinity (both for the JSON literals ``NaN``/``Infinity``, which
    Python's json module accepts, and for strings like ``"nan"``), and such a
    value would then poison the cosine-similarity matching on every phone - and
    be re-emitted in the roster as bare ``NaN``, which is not valid JSON for the
    clients to parse. This mirrors the ``Number.isFinite`` filter the JS side
    applies to the same payload.
    """
    if not isinstance(vector, list):
        return []
    clean = []
    for value in vector[:max_len]:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            clean.append(number)
    return clean


def clean_gallery(gallery):
    """Sanitize a whole enrolment scan: a capped list of vector samples."""
    if not isinstance(gallery, list):
        return []
    clean = []
    for sample in gallery[:MAX_GALLERY_SAMPLES]:
        if not isinstance(sample, dict):
            continue
        item = {}
        for name, max_len, required in GALLERY_FIELDS:
            vector = clean_vector(sample.get(name), max_len)
            if required or vector:
                item[name] = vector
        clean.append(item)
    return clean


def clean_motion_samples(samples):
    """``[[t_ms, activity], ...]`` from a phone's motion sensor: finite numbers, capped length."""
    if not isinstance(samples, list):
        return []
    clean = []
    for item in samples[:MAX_MOTION_SAMPLES]:
        if not isinstance(item, list) or len(item) < 2:
            continue
        try:
            t, v = float(item[0]), float(item[1])
        except (TypeError, ValueError):
            continue
        if math.isfinite(t) and math.isfinite(v) and v >= 0:
            clean.append([int(t), round(v, 2)])
    return clean
