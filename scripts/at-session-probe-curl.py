# -*- coding: utf-8 -*-
"""AT -> ChatGPT session/checkout probe using curl_cffi (Chrome TLS fingerprint)
through the front socks5 proxy. Mirrors gen_pp_link.py's successful path."""
import json, os, re, time, base64
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN = os.environ.get("OPX_LIVE_TOKEN", "").strip()
if not TOKEN:
    raise SystemExit("OPX_LIVE_TOKEN 未设置")
PROXY = os.environ.get("OPX_FRONT_PROXY", "socks5h://127.0.0.1:10808").strip()
EVIDENCE = ROOT / ".context-snapshots" / "at-session-probe"
EVIDENCE.mkdir(parents=True, exist_ok=True)

from curl_cffi import requests as curl_requests

def mask_email(value):
    text = str(value or "")
    if "@" not in text:
        return "***"
    local, domain = text.split("@", 1)
    return local[:2] + "***@" + domain

def redact(text):
    text = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[redacted-jwt]", str(text))
    text = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[redacted-email]", text, flags=re.I)
    return text

def jwt_claims(token):
    part = token.split(".")[1]
    part += "=" * ((4 - len(part) % 4) % 4)
    return json.loads(base64.urlsafe_b64decode(part.encode("ascii")))

claims = jwt_claims(TOKEN)
profile_claims = claims.get("https://api.openai.com/profile") or {}
auth_claims = claims.get("https://api.openai.com/auth") or {}

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
BASE_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": "https://chatgpt.com/",
}

def req(label, url, method="GET", headers=None, cookies=None, json_body=None, impersonate="chrome"):
    start = time.time()
    result = {"label": label, "method": method, "url": url, "status": None, "location": "", "contentType": "", "bodyPreview": "", "keys": [], "error": ""}
    try:
        h = dict(BASE_HEADERS)
        if headers:
            h.update(headers)
        response = curl_requests.request(
            method, url, headers=h, cookies=cookies, json=json_body,
            proxies={"http": PROXY, "https": PROXY}, impersonate=impersonate,
            timeout=30, allow_redirects=False,
        )
        result["status"] = response.status_code
        result["location"] = response.headers.get("Location") or ""
        result["contentType"] = response.headers.get("Content-Type") or ""
        text = response.text
        result["bodyPreview"] = redact(text)[:700]
        try:
            parsed = response.json()
            if isinstance(parsed, dict):
                result["keys"] = list(parsed.keys())[:30]
                if "user" in parsed and isinstance(parsed["user"], dict):
                    result["sessionUser"] = {k: (mask_email(v) if k == "email" else "present") for k, v in parsed["user"].items()}
                    result["userEmail"] = mask_email(parsed["user"].get("email") or "")
                if "accessToken" in parsed:
                    result["hasAccessToken"] = bool(parsed["accessToken"])
                if "sessionToken" in parsed:
                    result["hasSessionToken"] = bool(parsed["sessionToken"])
                if parsed.get("email"):
                    result["email"] = mask_email(parsed["email"])
                if parsed.get("plan_type"):
                    result["planType"] = str(parsed["plan_type"])
        except Exception:
            pass
    except Exception as error:
        result["error"] = str(error)[:250]
    result["ms"] = int((time.time() - start) * 1000)
    return result

results = []
results.append(req("session-baseline", "https://chatgpt.com/api/auth/session"))
results.append(req("session-bearer", "https://chatgpt.com/api/auth/session", headers={"Authorization": "Bearer " + TOKEN}))
results.append(req("me-noauth", "https://chatgpt.com/backend-api/me"))
results.append(req("me-bearer", "https://chatgpt.com/backend-api/me", headers={"Authorization": "Bearer " + TOKEN}))
results.append(req("me-x-header", "https://chatgpt.com/backend-api/me", headers={"x-openai-access-token": TOKEN}))
results.append(req("me-cookie-token", "https://chatgpt.com/backend-api/me", cookies={"__Secure-next-auth.session-token": TOKEN}))

create_body = {
    "entry_point": "all_plans_pricing_modal",
    "plan_name": "chatgptplusplan",
    "billing_details": {"country": "PH", "currency": "PHP"},
    "cancel_url": "https://chatgpt.com/#pricing",
    "checkout_ui_mode": "hosted",
    "promo_campaign": {"promo_campaign_id": "plus-1-month-free", "is_coupon_from_query_param": False},
}
create_result = req(
    "checkout-create-hosted-ph",
    "https://chatgpt.com/backend-api/payments/checkout",
    method="POST",
    headers={"Authorization": "Bearer " + TOKEN,
             "x-openai-target-path": "/backend-api/payments/checkout",
             "x-openai-target-route": "/backend-api/payments/checkout"},
    json_body=create_body,
)
results.append(create_result)
oaics = ""
m = re.search(r"(oaics_[A-Za-z0-9_-]+)", create_result.get("bodyPreview") or "")
if m:
    oaics = m.group(1)
create_result["oaicsId"] = oaics

if oaics:
    results.append(req("shortlink-noauth", f"https://chatgpt.com/checkout/openai_llc/{oaics}"))
    results.append(req("shortlink-bearer", f"https://chatgpt.com/checkout/openai_llc/{oaics}", headers={"Authorization": "Bearer " + TOKEN}))
    results.append(req("checkout-get-bearer", f"https://chatgpt.com/backend-api/payments/checkout/{oaics}", headers={"Authorization": "Bearer " + TOKEN}))
    results.append(req("checkout-v1-bearer", f"https://chatgpt.com/backend-api/checkout/v1/checkout/{oaics}", headers={"Authorization": "Bearer " + TOKEN}))
    results.append(req("checkout-snapshot-bearer", f"https://chatgpt.com/backend-api/payments/checkout/snapshot", method="POST",
                       headers={"Authorization": "Bearer " + TOKEN, "x-openai-target-path": "/backend-api/payments/checkout/snapshot",
                                "x-openai-target-route": "/backend-api/payments/checkout/snapshot"},
                       json_body={"checkout_session_id": oaics, "processor_entity": "openai_ie"}))

report = {
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "probe": "at-session-probe-curl-cffi",
    "frontProxy": PROXY,
    "claims": {
        "email": mask_email(profile_claims.get("email") or ""),
        "chatgptUserPresent": bool(auth_claims.get("chatgpt_account_user_id")),
        "planType": auth_claims.get("chatgpt_plan_type") or "unknown",
        "expiresInDays": round((int(claims.get("exp", 0)) - int(time.time())) / 86400, 1) if claims.get("exp") else None,
    },
    "results": results,
}
(Path(EVIDENCE) / "result-curl-cffi.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
