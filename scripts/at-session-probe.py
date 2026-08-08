import json
import os
import re
import base64
import time
import urllib.request
import urllib.error
import http.cookiejar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN = os.environ.get("OPX_LIVE_TOKEN", "").strip()
if not TOKEN:
    raise SystemExit("OPX_LIVE_TOKEN 未设置")
import socks as _socks
import socket
_FRONT = os.environ.get("OPX_FRONT_PROXY", "socks5h://127.0.0.1:10808").strip()
if _FRONT:
    _m = re.match(r"^(socks5h?|http|https)://([^:/]+)(?::(\d+))?", _FRONT)
    if _m:
        _scheme, _host, _port = _m.group(1), _m.group(2), int(_m.group(3) or 10808)
        if _scheme.startswith("socks"):
            _socks.set_default_proxy(_socks.SOCKS5 if _scheme == "socks5h" else _socks.SOCKS5, _host, _port)
            socket.socket = _socks.socksocket
            print(f"[proxy] socks5h://{_host}:{_port}", flush=True)

OUT = ROOT / ".context-snapshots" / "at-session-probe"
OUT.mkdir(parents=True, exist_ok=True)

def mask_email(value):
    text = str(value or "")
    if "@" not in text:
        return text[:2] + "***" if len(text) > 2 else "***"
    local, domain = text.split("@", 1)
    return local[:2] + "***@" + domain

def redact(text):
    text = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[redacted-jwt]", str(text))
    text = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[redacted-email]", text, flags=re.I)
    return text

def jwt_payload(token):
    part = token.split(".")[1]
    part += "=" * ((4 - len(part) % 4) % 4)
    return json.loads(base64.urlsafe_b64decode(part.encode("ascii")))

claims = jwt_payload(TOKEN)
profile = claims.get("https://api.openai.com/profile") or {}
auth = claims.get("https://api.openai.com/auth") or {}

def req(label, url, method="GET", headers=None, cookies=None, follow=True):
    start = time.time()
    result = {"label": label, "method": method, "url": url, "status": None, "location": "", "contentType": "", "bodyPreview": "", "keys": []}
    try:
        cookie_jar = http.cookiejar.CookieJar()
        if cookies:
            for name, value in cookies.items():
                cookie = http.cookiejar.Cookie(0, name, value, None, False, ".chatgpt.com", False, True, "/", True, False, None, False, None, None, {})
                cookie_jar.set_cookie(cookie)
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
        h = {"Accept": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        if headers:
            h.update(headers)
        request = urllib.request.Request(url, method=method, headers=h)
        if method == "POST":
            request.add_header("Content-Type", "application/json")
            request.data = b"{}"
        with opener.open(request, timeout=25) as response:
            result["status"] = response.status
            result["location"] = response.headers.get("Location") or ""
            result["contentType"] = response.headers.get("Content-Type") or ""
            raw = response.read(4000).decode("utf-8", errors="replace")
            result["bodyPreview"] = redact(raw)[:600]
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    result["keys"] = list(parsed.keys())[:24]
                    if "user" in parsed and isinstance(parsed["user"], dict):
                        result["sessionUser"] = {k: (mask_email(v) if k == "email" else "present") for k, v in parsed["user"].items()}
                    if "accessToken" in parsed:
                        result["hasAccessToken"] = bool(parsed["accessToken"])
            except Exception:
                pass
    except urllib.error.HTTPError as error:
        result["status"] = error.code
        result["location"] = error.headers.get("Location") or ""
        result["contentType"] = error.headers.get("Content-Type") or ""
        result["bodyPreview"] = redact(error.read(800).decode("utf-8", errors="replace"))[:400]
    except Exception as error:
        result["error"] = str(error)[:200]
    result["ms"] = int((time.time() - start) * 1000)
    return result

results = []
results.append(req("session-baseline", "https://chatgpt.com/api/auth/session"))
results.append(req("session-bearer", "https://chatgpt.com/api/auth/session", headers={"Authorization": "Bearer " + TOKEN}))
results.append(req("session-cookie-as-token", "https://chatgpt.com/api/auth/session", cookies={"__Secure-next-auth.session-token": TOKEN}))
results.append(req("session-bearer-post", "https://chatgpt.com/api/auth/session", method="POST", headers={"Authorization": "Bearer " + TOKEN}))

create_body = {
    "entry_point": "all_plans_pricing_modal",
    "plan_name": "chatgptplusplan",
    "billing_details": {"country": "PH", "currency": "PHP"},
    "cancel_url": "https://chatgpt.com/#pricing",
    "checkout_ui_mode": "hosted",
    "promo_campaign": {"promo_campaign_id": "plus-1-month-free", "is_coupon_from_query_param": False},
}
create_headers = {
    "Authorization": "Bearer " + TOKEN,
    "Content-Type": "application/json",
    "Referer": "https://chatgpt.com/",
    "x-openai-target-path": "/backend-api/payments/checkout",
    "x-openai-target-route": "/backend-api/payments/checkout",
}
start = time.time()
create_result = {"label": "checkout-create-hosted-ph", "status": None, "keys": [], "urlValue": "", "providerUrl": "", "sessionId": "", "processorEntity": "", "bodyPreview": ""}
try:
    request = urllib.request.Request("https://chatgpt.com/backend-api/payments/checkout", method="POST", headers=create_headers, data=json.dumps(create_body).encode("utf-8"))
    with urllib.request.urlopen(request, timeout=30) as response:
        create_result["status"] = response.status
        raw = response.read().decode("utf-8", errors="replace")
        parsed = json.loads(raw)
        create_result["keys"] = list(parsed.keys())[:30]
        create_result["urlValue"] = redact(str(parsed.get("url") or ""))[:200]
        create_result["providerUrl"] = redact(str(parsed.get("stripe_hosted_url") or parsed.get("checkout_url") or ""))[:200]
        create_result["sessionId"] = str(parsed.get("checkout_session_id") or parsed.get("session_id") or "")
        create_result["processorEntity"] = str(parsed.get("processor_entity") or "")
        create_result["bodyPreview"] = redact(raw)[:700]
        oaics = re.search(r"(oaics_[A-Za-z0-9_\-]+)", raw)
        create_result["oaicsId"] = oaics.group(1) if oaics else ""
except urllib.error.HTTPError as error:
    create_result["status"] = error.code
    create_result["bodyPreview"] = redact(error.read(800).decode("utf-8", errors="replace"))[:400]
except Exception as error:
    create_result["error"] = str(error)[:200]
create_result["ms"] = int((time.time() - start) * 1000)
results.append(create_result)

short_url = ""
if create_result.get("oaicsId"):
    short_url = f"https://chatgpt.com/checkout/openai_llc/{create_result['oaicsId']}"
    results.append(req("shortlink-noauth", short_url))
    results.append(req("shortlink-bearer", short_url, headers={"Authorization": "Bearer " + TOKEN}))
    results.append(req("shortlink-session-cookie", short_url, cookies={"__Secure-next-auth.session-token": TOKEN}))
    results.append(req("shortlink-bearer-api", "https://chatgpt.com/backend-api/payments/checkout/" + create_result["oaicsId"], headers={"Authorization": "Bearer " + TOKEN}))
    results.append(req("shortlink-bearer-checkout-v1", "https://chatgpt.com/backend-api/checkout/v1/checkout/" + create_result["oaicsId"], headers={"Authorization": "Bearer " + TOKEN}))

report = {
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "probe": "at-session-probe",
    "claims": {
        "keys": [k for k in claims.keys()],
        "email": mask_email(profile.get("email") or ""),
        "chatgptUserPresent": bool(auth.get("chatgpt_account_user_id")),
        "planType": auth.get("chatgpt_plan_type") or claims.get("https://api.openai.com/profile", {}).get("planType") or "unknown",
        "exp": claims.get("exp"),
        "expiresInDays": round((int(claims.get("exp", 0)) - int(time.time())) / 86400, 1) if claims.get("exp") else None,
    },
    "results": results,
}
(OUT / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
