# -*- coding: utf-8 -*-
"""AT -> backend-api probe from the EXTENSION page context (has host_permissions).
Checks whether Bearer AT / x-openai-access-token work on chatgpt.com backend,
whether checkout create returns oaics_, and whether oaics_ can be exchanged for
a hosted/cs_ session directly via API. Token never printed/persisted."""
import json, os, re, time, shutil, tempfile, base64
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
TOKEN = os.environ.get("OPX_LIVE_TOKEN", "").strip()
if not TOKEN:
    raise SystemExit("OPX_LIVE_TOKEN 未设置")

import importlib.util
spec = importlib.util.spec_from_file_location("live_elig", ROOT / "scripts" / "live-eligibility-mullvad.py")
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)

from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service as FFService

VERSION = live.VERSION
XPI = live.XPI
BINARY = live.BINARY
SOURCE_PROFILE = live.SOURCE_PROFILE
EVIDENCE = ROOT / ".context-snapshots" / f"live-at-backend-probe-{VERSION}"
EVIDENCE.mkdir(parents=True, exist_ok=True)


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

EXT_PROBE_JS = r"""
const done = arguments[arguments.length - 1];
const token = arguments[0];
const mask = s => {
  const text = String(s || '');
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
             .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
};
const summarize = async (label, url, opts = {}) => {
  const rec = {label, url, status: null, ok: false, contentType: '', keys: [], bodyPreview: '', redirected: '', error: ''};
  const started = performance.now();
  try {
    const response = await fetch(url, {credentials: 'omit', cache: 'no-store', ...(opts.fetch || {})});
    rec.status = response.status;
    rec.ok = response.ok;
    rec.contentType = response.headers.get('content-type') || '';
    rec.redirected = response.redirected ? response.url : '';
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      rec.keys = Object.keys(body).sort().slice(0, 40);
      if (body.user && typeof body.user === 'object') {
        rec.userKeys = Object.keys(body.user).sort().slice(0, 30);
        rec.userEmail = mask(body.user.email || '');
        rec.hasUser = true;
      }
      if (typeof body.accessToken === 'string') rec.hasAccessToken = Boolean(body.accessToken);
      if (typeof body.sessionToken === 'string') rec.hasSessionToken = Boolean(body.sessionToken);
      if (body.plan_type) rec.planType = mask(body.plan_type);
      if (body.email) rec.email = mask(body.email);
    }
    rec.bodyPreview = mask(text).slice(0, 600);
    rec.ms = Math.round(performance.now() - started);
  } catch (error) {
    rec.error = String(error && error.message || error).slice(0, 300);
    rec.ms = Math.round(performance.now() - started);
  }
  return rec;
};

(async () => {
  const out = {origin: location.origin, ua: navigator.userAgent.slice(0, 80)};
  out.meNoAuth = await summarize('me-noauth', 'https://chatgpt.com/backend-api/me');
  out.meBearer = await summarize('me-bearer', 'https://chatgpt.com/backend-api/me', {fetch: {headers: {Accept: 'application/json', Authorization: 'Bearer ' + token}}});
  out.meHeader = await summarize('me-x-openai-access-token', 'https://chatgpt.com/backend-api/me', {fetch: {headers: {Accept: 'application/json', 'x-openai-access-token': token}}});
  out.sessionNoAuth = await summarize('session-noauth', 'https://chatgpt.com/api/auth/session');
  out.sessionBearer = await summarize('session-bearer', 'https://chatgpt.com/api/auth/session', {fetch: {headers: {Accept: 'application/json', Authorization: 'Bearer ' + token}}});

  const createBody = {
    entry_point: 'all_plans_pricing_modal',
    plan_name: 'chatgptplusplan',
    billing_details: {country: 'PH', currency: 'PHP'},
    cancel_url: 'https://chatgpt.com/#pricing',
    checkout_ui_mode: 'hosted',
    promo_campaign: {promo_campaign_id: 'plus-1-month-free', is_coupon_from_query_param: false},
  };
  const createHeaders = {
    Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
    'x-openai-target-path': '/backend-api/payments/checkout', 'x-openai-target-route': '/backend-api/payments/checkout',
  };
  out.checkoutCreate = await summarize('checkout-create-hosted-ph', 'https://chatgpt.com/backend-api/payments/checkout', {
    fetch: {method: 'POST', headers: createHeaders, body: JSON.stringify(createBody)},
  });
  const m = (out.checkoutCreate.bodyPreview || '').match(/(oaics_[A-Za-z0-9_-]+)/);
  const oaics = m ? m[1] : '';
  out.oaicsId = oaics || '';
  if (oaics) {
    out.checkoutGetBearer = await summarize('checkout-get-oaics-bearer', 'https://chatgpt.com/backend-api/payments/checkout/' + oaics, {fetch: {headers: {Accept: 'application/json', Authorization: 'Bearer ' + token}}});
    out.checkoutGetNoAuth = await summarize('checkout-get-oaics-noauth', 'https://chatgpt.com/backend-api/payments/checkout/' + oaics);
    out.checkoutV1Bearer = await summarize('checkout-v1-bearer', 'https://chatgpt.com/backend-api/checkout/v1/checkout/' + oaics, {fetch: {headers: {Accept: 'application/json', Authorization: 'Bearer ' + token}}});
    out.checkoutUpdateBearer = await summarize('checkout-update-bearer', 'https://chatgpt.com/backend-api/payments/checkout/update', {
      fetch: {method: 'POST', headers: {...createHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({
        checkout_session_id: oaics, processor_entity: 'openai_ie', plan_name: 'chatgptplusplan',
        price_interval: 'month', seat_quantity: 1,
        promo_campaign: {promo_campaign_id: 'plus-1-month-free', is_coupon_from_query_param: false},
      })},
    });
    out.checkoutTaxesBearer = await summarize('checkout-taxes-bearer', 'https://chatgpt.com/backend-api/payments/checkout/taxes', {
      fetch: {method: 'POST', headers: {...createHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({
        checkout_session_id: oaics, checkout_email: 'redacted@example.invalid', billing_country: 'PH',
        billing_name: 'Checkout User', currency: 'PHP', tax_id: null, processor_entity: 'openai_ie',
        billing_address: {line1: '1 Example Street', city: 'Example City', country: 'PH', postal_code: '00000', state: ''},
      })},
    });
  }
  done(out);
})().catch(error => done({error: String(error && error.message || error)}));
"""

result = {
    "version": VERSION,
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "claims": {
        "email": mask_email(profile_claims.get("email") or ""),
        "chatgptUserPresent": bool(auth_claims.get("chatgpt_account_user_id")),
        "planType": auth_claims.get("chatgpt_plan_type") or "unknown",
        "expiresInDays": round((int(claims.get("exp", 0)) - int(time.time())) / 86400, 1) if claims.get("exp") else None,
    },
    "extProbe": None,
    "shortLinkNav": None,
    "errors": [],
    "ok": False,
}

driver = None
temp_root = None
try:
    temp_root = Path(tempfile.mkdtemp(prefix="opx-at-backend-probe-"))
    profile_path = temp_root / "profile"
    if SOURCE_PROFILE and SOURCE_PROFILE.is_dir():
        shutil.copytree(SOURCE_PROFILE, profile_path, ignore=shutil.ignore_patterns("parent.lock", "lock", ".parentlock"))
    else:
        profile_path.mkdir()
    options = Options()
    options.binary_location = str(BINARY)
    options.page_load_strategy = "eager"
    options.add_argument("-profile")
    options.add_argument(str(profile_path))
    options.set_preference("xpinstall.signatures.required", False)
    options.set_preference("extensions.autoDisableScopes", 0)
    options.set_preference("extensions.enabledScopes", 15)
    options.set_preference("extensions.allowPrivateBrowsingByDefault", True)
    live.configure_firefox_proxy(options)
    options.set_preference("browser.shell.checkDefaultBrowser", False)
    options.set_preference("browser.startup.homepage_override.mstone", "ignore")

    driver = live.webdriver.Firefox(options=options, service=FFService(service_args=["--allow-system-access"]))
    driver.set_page_load_timeout(45)
    install = live.install_temporary_addon(driver, str(XPI))
    result["addonInstall"] = install
    if not install.get("ok"):
        raise RuntimeError(f"扩展安装失败: {install.get('error')}")
    addon_id = install["addonId"]
    result["addonRuntime"] = live.inspect_addon_runtime(driver, addon_id)
    result["lastStage"] = "addon-installed"

    settings_url = result["addonRuntime"].get("settingsUrl")
    if not settings_url:
        uuid = live.extension_uuid(profile_path)
        settings_url = f"moz-extension://{uuid}/automation-settings.html"
    driver.get(settings_url)
    time.sleep(2)
    result["extProbe"] = driver.execute_async_script(EXT_PROBE_JS, TOKEN)
    result["lastStage"] = "ext-probe-complete"

    oaics = (result.get("extProbe") or {}).get("oaicsId") or ""
    if oaics:
        short_url = f"https://chatgpt.com/checkout/openai_llc/{oaics}"
        nav = {"shortUrl": redact(short_url), "finalUrl": "", "status": "", "bodyPreview": "", "hasStripe": False, "hasCs": False, "hasPk": False}
        try:
            driver.get(short_url)
            time.sleep(8)
            nav["finalUrl"] = redact(driver.current_url)
            body = driver.execute_script("return (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 2000)") or ""
            src = driver.page_source or ""
            nav["bodyPreview"] = redact(body)[:500]
            nav["hasStripe"] = "stripe.com" in src.lower()
            nav["hasCs"] = bool(re.search(r"(cs_(?:live|test)_[A-Za-z0-9_-]+)", src))
            nav["hasPk"] = bool(re.search(r"pk_(?:live|test)_[A-Za-z0-9]+", src))
            nav["status"] = "auth_required" if urlsplit(driver.current_url).path.startswith("/auth/login") else "loaded"
            try:
                shot = driver.get_screenshot_as_png()
                (EVIDENCE / "shortlink-page.png").write_bytes(shot)
                nav["screenshot"] = "shortlink-page.png"
            except Exception:
                pass
        except Exception as error:
            nav["error"] = str(error)[:300]
        result["shortLinkNav"] = nav

    result["ok"] = bool(result.get("extProbe") and not result["errors"])
    result["lastStage"] = "complete"
except Exception as error:
    result["errors"].append(f"{result.get('lastStage', 'init')} · {type(error).__name__}：{str(error)[:300]}")
    result["ok"] = False
finally:
    if driver:
        driver.quit()
    if temp_root:
        shutil.rmtree(temp_root, ignore_errors=True)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    (EVIDENCE / "result.json").write_text(payload, encoding="utf-8")
    print(payload)
