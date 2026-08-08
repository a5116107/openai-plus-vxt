import json
import os
import shutil
import tempfile
import time
import re
import subprocess
import math
from pathlib import Path
from urllib.parse import unquote, urlsplit

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
XPI = Path(os.environ.get("OPX_LIVE_XPI", str(ROOT / "dist" / f"openai-plus-vxt-{VERSION}-mullvad.xpi")))
SESSIONS = Path(os.environ.get(
    "OPX_LIVE_SESSIONS_DIR",
    str(ROOT / ".context-snapshots" / "live-accounts"),
))
BINARY = Path(os.environ.get("OPX_FIREFOX_BINARY", r"C:\Users\Administrator\AppData\Local\Mullvad\MullvadBrowser\Release\mullvadbrowser.exe"))
SOURCE_PROFILE = Path(os.environ.get("OPX_LIVE_BROWSER_PROFILE", "").strip()) if os.environ.get("OPX_LIVE_BROWSER_PROFILE", "").strip() else None
USE_BROWSER_SESSION = os.environ.get("OPX_LIVE_USE_BROWSER_SESSION", "0").strip().lower() in {"1", "true", "on", "yes"}
AT_SESSION_DIAGNOSTIC = os.environ.get("OPX_LIVE_AT_SESSION_DIAGNOSTIC", "0").strip().lower() in {"1", "true", "on", "yes"}
EVIDENCE = ROOT / ".context-snapshots" / f"live-eligibility-{VERSION}"
SAMPLE_COUNT = max(1, min(20, int(os.environ.get("OPX_LIVE_SAMPLE_COUNT", "8"))))
ACCOUNT_OFFSET = max(0, int(os.environ.get("OPX_LIVE_ACCOUNT_OFFSET", "0")))
RUN_LABEL = re.sub(r"[^a-zA-Z0-9_.-]+", "-", os.environ.get("OPX_LIVE_RUN_LABEL", "latest")).strip("-") or "latest"
VALID_FILE = os.environ.get("OPX_LIVE_VALID_FILE", "").strip()
COUNTRIES = tuple(dict.fromkeys(
    item.strip().upper() for item in os.environ.get("OPX_LIVE_COUNTRIES", "HK").split(",") if item.strip()
))
PAYMENT_METHODS = tuple(dict.fromkeys(
    item.strip().lower() for item in os.environ.get("OPX_LIVE_PAYMENT_METHODS", "momo").split(",") if item.strip()
))
CHECKOUT_UI_MODE = os.environ.get("OPX_LIVE_CHECKOUT_UI_MODE", "hosted").strip().lower()
if CHECKOUT_UI_MODE not in {"hosted", "custom", "both"}:
    raise ValueError("OPX_LIVE_CHECKOUT_UI_MODE 必须是 hosted、custom 或 both")
REQUIRE_ZERO = os.environ.get("OPX_LIVE_REQUIRE_ZERO", "1").strip().lower() not in {"0", "false", "off", "no"}
ROUND_COUNT = max(1, min(10, int(os.environ.get("OPX_LIVE_ROUNDS", "1"))))
STRICT_QUALITY = os.environ.get("OPX_LIVE_STRICT_QUALITY", "1").strip().lower() not in {"0", "false", "off", "no"}
EXPECTED_FRONT_COUNTRY = os.environ.get("OPX_LIVE_EXPECT_FRONT_COUNTRY", "").strip().upper()
FRONT_TRACE_URL = os.environ.get("OPX_LIVE_FRONT_TRACE_URL", "https://www.cloudflare.com/cdn-cgi/trace").strip()
TARGET_PROBE_URL = os.environ.get("OPX_LIVE_TARGET_PROBE_URL", "https://chatgpt.com/cdn-cgi/trace").strip()
FRONT_PROXY_URL = os.environ.get("OPX_LIVE_FRONT_PROXY", "socks5h://127.0.0.1:10808").strip()


def parse_front_proxy(raw):
    value = str(raw or "").strip()
    if "://" not in value:
        value = f"http://{value}"
    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https", "socks4", "socks4a", "socks5", "socks5h"}:
        raise ValueError(f"不支持的前置代理协议: {scheme or 'empty'}")
    if not parsed.hostname or not parsed.port:
        raise ValueError("前置代理必须包含主机和端口")
    return {
        "url": value,
        "scheme": scheme,
        "host": parsed.hostname,
        "port": parsed.port,
        "username": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
    }


FRONT_PROXY = parse_front_proxy(FRONT_PROXY_URL)


def configure_firefox_proxy(options):
    options.set_preference("network.proxy.type", 1)
    scheme = FRONT_PROXY["scheme"]
    if scheme.startswith("socks"):
        options.set_preference("network.proxy.socks", FRONT_PROXY["host"])
        options.set_preference("network.proxy.socks_port", FRONT_PROXY["port"])
        options.set_preference("network.proxy.socks_version", 4 if scheme.startswith("socks4") else 5)
        options.set_preference("network.proxy.socks_remote_dns", scheme in {"socks4a", "socks5h"})
        return
    options.set_preference("network.proxy.http", FRONT_PROXY["host"])
    options.set_preference("network.proxy.http_port", FRONT_PROXY["port"])
    options.set_preference("network.proxy.ssl", FRONT_PROXY["host"])
    options.set_preference("network.proxy.ssl_port", FRONT_PROXY["port"])
    options.set_preference("network.proxy.share_proxy_settings", True)


def public_front_proxy():
    return {
        "scheme": FRONT_PROXY["scheme"],
        "host": FRONT_PROXY["host"],
        "port": FRONT_PROXY["port"],
        "hasCredentials": bool(FRONT_PROXY["username"] or FRONT_PROXY["password"]),
    }


def extension_proxy_endpoint(label):
    scheme = FRONT_PROXY["scheme"]
    if scheme == "socks5h":
        scheme = "socks5"
    elif scheme in {"socks4a", "socks4"}:
        scheme = "socks4"
    return {
        "enabled": True,
        "scheme": scheme,
        "host": FRONT_PROXY["host"],
        "port": FRONT_PROXY["port"],
        "username": FRONT_PROXY["username"],
        "password": FRONT_PROXY["password"],
        "label": label,
    }


def load_accounts():
    explicit_token = os.environ.get("OPX_LIVE_TOKEN", "").strip()
    if USE_BROWSER_SESSION or (AT_SESSION_DIAGNOSTIC and not explicit_token):
        return []
    if explicit_token:
        parts = explicit_token.split(".")
        if len(parts) != 3:
            raise RuntimeError("OPX_LIVE_TOKEN 不是有效 JWT")
        try:
            import base64
            payload_raw = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
            payload = json.loads(base64.urlsafe_b64decode(payload_raw.encode("ascii")))
            if payload.get("exp") and int(payload["exp"]) <= int(time.time()):
                raise RuntimeError("OPX_LIVE_TOKEN 已过期")
            profile = payload.get("https://api.openai.com/profile") or {}
            email = str(profile.get("email") or os.environ.get("OPX_LIVE_EMAIL", "")).strip()
            if not email:
                raise RuntimeError("OPX_LIVE_TOKEN 中没有邮箱，请设置 OPX_LIVE_EMAIL")
            return [(email, explicit_token)]
        except RuntimeError:
            raise
        except Exception as error:
            raise RuntimeError(f"OPX_LIVE_TOKEN 解析失败：{error}") from error

    accounts = []
    seen_emails = set()
    eligible_seen = 0
    now = int(time.time())
    selected_files = None
    if VALID_FILE:
        valid_data = json.loads(Path(VALID_FILE).read_text(encoding="utf-8"))
        selected_files = {
            str(item.get("file") or "")
            for item in valid_data.get("valid", [])
            if isinstance(item, dict) and item.get("file")
        }
    for path in sorted(SESSIONS.glob("*.json")):
        if selected_files is not None and path.name not in selected_files:
            continue
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            email = str(item.get("email") or "").strip()
            token = str(item.get("access_token") or "").strip()
            if not email or not token:
                continue
            email_key = email.lower()
            if email_key in seen_emails:
                continue
            parts = token.split(".")
            if len(parts) > 1:
                import base64
                payload_raw = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
                payload = json.loads(base64.urlsafe_b64decode(payload_raw.encode("ascii")))
                if payload.get("exp") and int(payload["exp"]) <= now:
                    continue
            if eligible_seen < ACCOUNT_OFFSET:
                eligible_seen += 1
                seen_emails.add(email_key)
                continue
            accounts.append((email, token))
            seen_emails.add(email_key)
            if len(accounts) >= SAMPLE_COUNT:
                break
        except Exception:
            continue
    if not accounts:
        raise RuntimeError("未找到当前有效 session")
    return accounts


def send(driver, message, timeout=120):
    driver.set_script_timeout(timeout)
    return driver.execute_async_script(
        """
        const message = arguments[0];
        const done = arguments[arguments.length - 1];
        const api = globalThis.browser || globalThis.chrome;
        Promise.race([
          api.runtime.sendMessage(message),
          new Promise((_, reject) => setTimeout(() => reject(new Error('extension-message-timeout')), 20000)),
        ]).then(value => done({ok: true, value}), error => done({ok: false, error: String(error && error.message || error)}));
        """,
        message,
    )


def extension_uuid(profile):
    prefs = profile / "prefs.js"
    deadline = time.time() + 15
    while time.time() < deadline:
        if prefs.exists():
            text = prefs.read_text(encoding="utf-8", errors="ignore")
            match = re.search(r'user_pref\("extensions\.webextensions\.uuids",\s*"((?:\\.|[^"\\])*)"\);', text)
            if match:
                raw = json.loads(f'"{match.group(1)}"')
                uuid = json.loads(raw).get("openai-plus-vxt@local.opx")
                if uuid:
                    return uuid
        time.sleep(0.5)
    raise RuntimeError("未找到扩展 UUID")


def resolve_generated_links(driver, hits):
    resolved = []
    method_patterns = {
        "paypal": r"\bpaypal\b",
        "momo": r"\bmomo\b",
        "kakao": r"kakao\s*pay|kakaopay",
        "upi": r"\bupi\b",
        "ideal": r"\bi\s*deal\b|\bideal\b",
        "card": r"credit\s*card|debit\s*card|card\s*number|银行卡|信用卡",
    }
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        source_url = str(hit.get("shortUrl") or hit.get("link") or hit.get("longUrl") or "").strip()
        if not source_url:
            continue
        item = {"sourceUrl": source_url, "ok": False, "finalUrl": "", "methods": [], "stripeResources": []}
        try:
            driver.get(source_url)
            time.sleep(6)
            final_url = driver.current_url
            body_text = driver.execute_script(
                "return (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 30000)"
            ) or ""
            page_source = driver.page_source or ""
            login_required = urlsplit(final_url).path.startswith("/auth/login") or "log in or sign up" in body_text.lower()
            resources = driver.execute_script(
                "return performance.getEntriesByType('resource').map(e => e.name).filter(Boolean)"
            ) or []
            stripe_resources = [
                str(url) for url in resources
                if "stripe.com" in str(url).lower() or "pay.openai.com" in str(url).lower()
            ][:30]
            session_match = re.search(r"((?:oaics|cs_(?:live|test))_[A-Za-z0-9_-]+)", f"{final_url}\n{page_source}")
            pk_match = re.search(r"(pk_(?:live|test)_[A-Za-z0-9]+)", page_source)
            item.update({
                "ok": True,
                "finalUrl": final_url,
                "resolutionStatus": "auth_required" if login_required else "checkout_loaded",
                "methods": [] if login_required else [
                    name for name, pattern in method_patterns.items() if re.search(pattern, body_text, re.I)
                ],
                "stripeResources": stripe_resources,
                "checkoutSessionId": session_match.group(1) if session_match else "",
                "stripePublishableKey": pk_match.group(1) if pk_match else "",
                "bodyPreview": body_text[:500],
            })
        except Exception as error:
            item["error"] = f"{type(error).__name__}: {error}"
        resolved.append(item)
    return resolved


def inspect_addon_runtime(driver, addon_id):
    driver.set_context(driver.CONTEXT_CHROME)
    try:
        driver.set_script_timeout(30)
        return driver.execute_async_script(
            """
            const addonId = arguments[0];
            const done = arguments[arguments.length - 1];
            const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
            AddonManager.getAddonByID(addonId).then(addon => {
              const policy = WebExtensionPolicy.getByID(addonId);
              done({
                addonFound: Boolean(addon),
                addonId: addon?.id || addonId,
                isActive: Boolean(addon?.isActive),
                appDisabled: Boolean(addon?.appDisabled),
                userDisabled: Boolean(addon?.userDisabled),
                signedState: addon?.signedState ?? null,
                privateBrowsingAllowed: Boolean(addon?.isAllowedInPrivateBrowsing),
                policyActive: Boolean(policy?.active),
                policyPrivateBrowsingAllowed: Boolean(policy?.privateBrowsingAllowed),
                policyHostname: policy?.mozExtensionHostname || null,
                settingsUrl: policy?.getURL('automation-settings.html') || null,
              });
            }, error => done({error: String(error?.message || error)}));
            """,
            addon_id,
        )
    finally:
        driver.set_context(driver.CONTEXT_CONTENT)


def install_temporary_addon(driver, xpi_path):
    driver.set_context(driver.CONTEXT_CHROME)
    try:
        driver.set_script_timeout(30)
        return driver.execute_async_script(
            """
            const xpiPath = arguments[0];
            const done = arguments[arguments.length - 1];
            const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
            const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
            file.initWithPath(xpiPath);
            AddonManager.installTemporaryAddon(file)
              .then(addon => done({ok: true, addonId: addon.id}))
              .catch(error => done({ok: false, error: String(error?.message || error)}));
            """,
            str(xpi_path),
        )
    finally:
        driver.set_context(driver.CONTEXT_CONTENT)


def grant_private_browsing(driver, addon_id):
    driver.set_context(driver.CONTEXT_CHROME)
    try:
        driver.set_script_timeout(30)
        return driver.execute_async_script(
            """
            const addonId = arguments[0];
            const done = arguments[arguments.length - 1];
            const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
            const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
            ExtensionPermissions.add(addonId, {
              permissions: ['internal:privateBrowsingAllowed'],
              origins: [],
            }).then(() => AddonManager.getAddonByID(addonId))
              .then(addon => addon?.reload())
              .then(() => done({ok: true, reloaded: true}), error => done({ok: false, error: String(error?.message || error)}));
            """,
            addon_id,
        )
    finally:
        driver.set_context(driver.CONTEXT_CONTENT)


def storage_set(driver, values):
    driver.set_script_timeout(30)
    return driver.execute_async_script(
        """
        const values = arguments[0];
        const done = arguments[arguments.length - 1];
        const api = globalThis.browser || globalThis.chrome;
        api.storage.local.set(values).then(() => done(true), error => done(String(error.message || error)));
        """,
        values,
    )


def storage_get(driver, key):
    driver.set_script_timeout(30)
    return driver.execute_async_script(
        """
        const key = arguments[0];
        const done = arguments[arguments.length - 1];
        const api = globalThis.browser || globalThis.chrome;
        api.storage.local.get(key).then(value => done(value[key] || null), error => done({__error: String(error.message || error)}));
        """,
        key,
    )


def run_at_session_diagnostic(driver):
    driver.set_script_timeout(90)
    return driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        const api = globalThis.browser || globalThis.chrome;
        const tokenFromRaw = raw => {
          const text = String(raw || '').trim();
          try {
            const parsed = JSON.parse(text);
            for (const key of ['accessToken', 'access_token', 'token']) {
              if (typeof parsed?.[key] === 'string' && parsed[key]) return parsed[key];
            }
          } catch {}
          return text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] || '';
        };
        const cookieSummary = async () => {
          let cookies = [];
          let query = 'none';
          let lastError = '';
          for (const details of [
            {domain: 'chatgpt.com', firstPartyDomain: 'chatgpt.com'},
            {domain: 'chatgpt.com', firstPartyDomain: ''},
            {domain: 'chatgpt.com'},
          ]) {
            try {
              cookies = await api.cookies.getAll(details);
              query = Object.prototype.hasOwnProperty.call(details, 'firstPartyDomain')
                ? `firstPartyDomain:${details.firstPartyDomain || '(empty)'}`
                : 'domain-only';
              break;
            } catch (error) {
              lastError = String(error && error.message || error);
            }
          }
          const names = [...new Set(cookies.map(item => String(item.name || '')).filter(Boolean))].sort();
          return {
            count: cookies.length,
            names,
            sessionCookieCount: names.filter(name => /session|auth|token/i.test(name)).length,
            query,
            error: query === 'none' ? lastError : '',
          };
        };
        const request = async (name, token, headers, credentials) => {
          try {
            const response = await fetch('https://chatgpt.com/api/auth/session', {
              method: 'GET', headers: {Accept: 'application/json', ...headers}, credentials, cache: 'no-store',
            });
            const text = await response.text();
            let body = {};
            try { body = JSON.parse(text); } catch {}
            const record = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
            return {
              name,
              status: response.status,
              ok: response.ok,
              redirected: response.redirected,
              responseType: Array.isArray(body) ? 'array' : typeof body,
              keys: Object.keys(record).sort().slice(0, 40),
              hasAccessToken: typeof record.accessToken === 'string' && Boolean(record.accessToken),
              hasSessionToken: typeof record.sessionToken === 'string' && Boolean(record.sessionToken),
              hasUser: Boolean(record.user && typeof record.user === 'object'),
              bodyLength: text.length,
              tokenEchoed: token ? text.includes(token) : false,
            };
          } catch (error) {
            return {name, status: 0, ok: false, error: String(error && error.message || error)};
          }
        };
        (async () => {
          const stateResponse = await api.runtime.sendMessage({type: 'opx:probe-get-state'});
          const accounts = Array.isArray(stateResponse?.state?.accounts) ? stateResponse.state.accounts : [];
          const account = accounts.find(item => item?.enabled) || accounts[0];
          const token = tokenFromRaw(account?.tokenRaw);
          const before = await cookieSummary();
          if (!token) {
            done({ok: false, accountCount: accounts.length, tokenPresent: false, before, after: before, attempts: []});
            return;
          }
          const attempts = [];
          attempts.push(await request('authorization-omit', token, {Authorization: `Bearer ${token}`}, 'omit'));
          attempts.push(await request('authorization-include', token, {Authorization: `Bearer ${token}`}, 'include'));
          attempts.push(await request('x-openai-access-token', token, {'x-openai-access-token': token}, 'include'));
          for (const cookieName of [
            '__Secure-next-auth.session-token',
            'next-auth.session-token',
            '__Secure-authjs.session-token',
            'authjs.session-token',
          ]) {
            let cookieSet = false;
            let cookieError = '';
            try {
              await api.cookies.set({
                url: 'https://chatgpt.com/',
                name: cookieName,
                value: token,
                path: '/',
                secure: true,
                httpOnly: true,
                sameSite: 'lax',
                firstPartyDomain: 'chatgpt.com',
              });
              cookieSet = true;
            } catch (error) {
              cookieError = String(error && error.message || error);
            }
            const cookieAttempt = await request(`cookie:${cookieName}`, token, {}, 'include');
            cookieAttempt.cookieSet = cookieSet;
            cookieAttempt.cookieError = cookieError;
            attempts.push(cookieAttempt);
            try {
              await api.cookies.remove({
                url: 'https://chatgpt.com/',
                name: cookieName,
                firstPartyDomain: 'chatgpt.com',
              });
            } catch {}
          }
          const after = await cookieSummary();
          done({
            ok: true,
            accountCount: accounts.length,
            tokenPresent: true,
            before,
            after,
            attempts,
          });
        })().catch(error => done({ok: false, error: String(error && error.message || error)}));
        """
    )


def check_front_proxy():
    failures = []
    for attempt in range(1, 6):
        completed = subprocess.run(
            ["curl.exe", "-sS", "--max-time", "20", "--proxy", FRONT_PROXY["url"], FRONT_TRACE_URL],
            capture_output=True,
            text=True,
            timeout=25,
            check=False,
        )
        trace_text = completed.stdout or ""
        country = re.search(r"^loc=([A-Z]{2})$", trace_text, re.MULTILINE)
        ip = re.search(r"^ip=([^\r\n]+)$", trace_text, re.MULTILINE)
        if completed.returncode == 0 and country and ip:
            return {"country": country.group(1), "ip": ip.group(1), "attempts": attempt}
        failures.append(f"{attempt}:curl={completed.returncode}")
        if attempt < 5:
            time.sleep(2)
    endpoint = f"{FRONT_PROXY['scheme']}://{FRONT_PROXY['host']}:{FRONT_PROXY['port']}"
    raise RuntimeError(f"前置出口 {endpoint} 检查失败（{', '.join(failures)}）")


def check_target_reachability():
    completed = subprocess.run(
        ["curl.exe", "-sS", "--max-time", "20", "--proxy", FRONT_PROXY["url"], TARGET_PROBE_URL],
        capture_output=True,
        text=True,
        timeout=25,
        check=False,
    )
    return {
        "ok": completed.returncode == 0,
        "url": TARGET_PROBE_URL,
        "curlExit": completed.returncode,
        "error": (completed.stderr or "").strip()[-500:],
    }


def capture_browser_evidence(driver, result):
    try:
        result["browserEvidence"] = driver.execute_script(
            """
            return {
              url: location.href,
              title: document.title,
              readyState: document.readyState,
              bodyText: (document.body?.innerText || '')
                .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
                .slice(0, 2000),
              bodyChildCount: document.body?.children.length || 0,
              hasProbeRoot: Boolean(document.querySelector('#probe-raw-accounts')),
              hasBrowserApi: Boolean(globalThis.browser),
              hasChromeApi: Boolean(globalThis.chrome),
            };
            """
        )
        redacted_source = re.sub(
            r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            "[redacted-token]",
            driver.page_source,
        )
        redacted_source = re.sub(
            r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}",
            "[redacted-email]",
            redacted_source,
            flags=re.I,
        )
        (EVIDENCE / f"failure-page-{RUN_LABEL}.html").write_text(redacted_source, encoding="utf-8")
        driver.save_screenshot(str(EVIDENCE / f"failure-page-{RUN_LABEL}.png"))
    except Exception as evidence_error:
        result["browserEvidenceError"] = str(evidence_error)


def summarize_factor(observations, key_fn):
    groups = {}
    for item in observations:
        key = str(key_fn(item) or "unknown")
        row = groups.setdefault(key, {"attempts": 0, "resolved": 0, "hits": 0, "misses": 0, "errors": 0})
        row["attempts"] += 1
        outcome = item.get("outcome")
        if outcome == "hit":
            row["hits"] += 1
            row["resolved"] += 1
        elif outcome == "miss":
            row["misses"] += 1
            row["resolved"] += 1
        else:
            row["errors"] += 1
    for row in groups.values():
        n, hits = row["resolved"], row["hits"]
        if not n:
            row.update({"rate": None, "wilsonLow": 0, "wilsonHigh": 100})
            continue
        z = 1.96
        p = hits / n
        denominator = 1 + z * z / n
        center = (p + z * z / (2 * n)) / denominator
        margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
        row.update({
            "rate": round(p * 100, 1),
            "wilsonLow": round(max(0, center - margin) * 100, 1),
            "wilsonHigh": round(min(1, center + margin) * 100, 1),
        })
    return groups


def main():
    accounts = load_accounts()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    temp_root = Path(tempfile.mkdtemp(prefix="opx-live-mullvad-"))
    profile = temp_root / "profile"
    if SOURCE_PROFILE and SOURCE_PROFILE.is_dir():
        shutil.copytree(
            SOURCE_PROFILE,
            profile,
            ignore=shutil.ignore_patterns("parent.lock", "lock", ".parentlock"),
        )
    else:
        profile.mkdir()
    options = Options()
    options.binary_location = str(BINARY)
    options.page_load_strategy = "eager"
    options.add_argument("-profile")
    options.add_argument(str(profile))
    options.set_preference("xpinstall.signatures.required", False)
    options.set_preference("extensions.autoDisableScopes", 0)
    options.set_preference("extensions.enabledScopes", 15)
    options.set_preference("extensions.allowPrivateBrowsingByDefault", True)
    configure_firefox_proxy(options)
    options.set_preference("browser.shell.checkDefaultBrowser", False)
    options.set_preference("browser.startup.homepage_override.mstone", "ignore")
    driver = None
    result = {
        "version": VERSION,
        "requestedAccounts": len(accounts),
        "accountsImported": 0,
        "health": {},
        "runtime": {},
        "observations": 0,
        "outcomes": {},
        "hitDatabaseCount": 0,
        "verifiedLinkCount": 0,
        "readiness": {},
        "experimentConfig": {
            "countries": list(COUNTRIES),
            "paymentMethods": list(PAYMENT_METHODS),
            "checkoutUiMode": CHECKOUT_UI_MODE,
            "requireZero": REQUIRE_ZERO,
            "rounds": ROUND_COUNT,
            "strictQuality": STRICT_QUALITY,
            "frontProxy": public_front_proxy(),
        },
        "roundEvidence": [],
        "qualityGate": {},
        "factorSummary": {},
        "logEvents": [],
        "lastStage": "init",
        "errors": [],
    }
    try:
        driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
        driver.set_page_load_timeout(30)
        install_result = install_temporary_addon(driver, XPI)
        result["addonInstall"] = install_result
        if not install_result.get("ok"):
            raise RuntimeError(f"扩展安装失败: {install_result.get('error')}")
        addon_id = install_result["addonId"]
        result["privateBrowsingGrant"] = grant_private_browsing(driver, addon_id)
        result["addonRuntime"] = inspect_addon_runtime(driver, addon_id)
        result["lastStage"] = "addon-installed"
        settings_url = result["addonRuntime"].get("settingsUrl")
        if not settings_url:
            uuid = extension_uuid(profile)
            settings_url = f"moz-extension://{uuid}/automation-settings.html"
        result["lastStage"] = "settings-opening"
        try:
            driver.get(settings_url)
        except TimeoutException:
            driver.execute_script("window.stop()")
        time.sleep(2)
        result["version"] = VERSION
        WebDriverWait(driver, 30).until(lambda d: d.find_element(By.ID, "probe-raw-accounts"))
        result["lastStage"] = "settings-open"
        if AT_SESSION_DIAGNOSTIC:
            if accounts:
                raw_accounts = "\n".join(f"{email}----{token}" for email, token in accounts)
                imported = send(driver, {"type": "opx:probe-save-accounts", "rawAccounts": raw_accounts}, timeout=30)
                imported_value = imported.get("value") if isinstance(imported, dict) else None
                if not isinstance(imported_value, dict) or not imported_value.get("ok"):
                    raise RuntimeError("AT 诊断账号导入失败")
            result["atSessionDiagnostic"] = run_at_session_diagnostic(driver)
            result["lastStage"] = "at-session-diagnostic-complete"
            result["ok"] = bool(result["atSessionDiagnostic"].get("ok"))
            return
        if USE_BROWSER_SESSION:
            sync_response = send(driver, {"type": "opx:probe-sync-current-session"}, timeout=45)
            sync_value = sync_response.get("value") if isinstance(sync_response, dict) else None
            result["runtime"]["sessionSync"] = {
                "messageOk": bool(sync_response.get("ok")) if isinstance(sync_response, dict) else False,
                "synced": bool(sync_value.get("ok")) if isinstance(sync_value, dict) else False,
                "message": sync_value.get("message", "") if isinstance(sync_value, dict) else "",
            }
            if not isinstance(sync_value, dict) or not sync_value.get("ok") or not sync_value.get("accountId"):
                raise RuntimeError(result["runtime"]["sessionSync"]["message"] or "当前浏览器登录会话同步失败")
            synced_account_id = str(sync_value["accountId"])
            synced_state = sync_value.get("state") if isinstance(sync_value.get("state"), dict) else {}
            stale_ids = [
                str(item.get("id")) for item in synced_state.get("accounts", [])
                if isinstance(item, dict) and item.get("id") and str(item.get("id")) != synced_account_id
            ]
            if stale_ids:
                send(driver, {"type": "opx:probe-account-action", "action": "delete", "accountIds": stale_ids}, timeout=30)
            latest = send(driver, {"type": "opx:probe-get-state"}, timeout=30)
            latest_value = latest.get("value") if isinstance(latest, dict) else None
            latest_state = latest_value.get("state") if isinstance(latest_value, dict) else None
            accounts = [
                (str(item.get("email") or ""), "") for item in latest_state.get("accounts", [])
                if isinstance(item, dict) and str(item.get("id")) == synced_account_id
            ] if isinstance(latest_state, dict) else []
            if len(accounts) != 1:
                raise RuntimeError("同步后未形成唯一探测账号")
            result["requestedAccounts"] = 1
        actual_exit = check_front_proxy()
        target_reachability = check_target_reachability()
        front_country_matched = not EXPECTED_FRONT_COUNTRY or actual_exit["country"] == EXPECTED_FRONT_COUNTRY
        result["health"] = {
            "status": "ok" if target_reachability["ok"] and front_country_matched else "fail",
            "expectedCountry": EXPECTED_FRONT_COUNTRY, "actualCountry": actual_exit["country"],
            "actualIp": actual_exit["ip"], "hasIp": bool(actual_exit["ip"]), "hasAsn": False, "latencyMs": 0,
            "traceUrl": FRONT_TRACE_URL, "targetReachability": target_reachability,
        }
        if STRICT_QUALITY and not target_reachability["ok"]:
            raise RuntimeError("目标域预检失败，严格模式停止执行")
        if STRICT_QUALITY and not front_country_matched:
            raise RuntimeError("前置出口实际国家与显式期望不一致")

        proxy_settings = {
            "enabled": True,
            "chainMode": "direct-exit",
            "front": extension_proxy_endpoint("真实执行器前置"),
            "exit1": extension_proxy_endpoint("真实执行器出口1"),
            "exit2": extension_proxy_endpoint("真实执行器出口2"),
            "countryExits": [
                {"country": country, "endpoint": extension_proxy_endpoint(f"真实执行器/{country}")}
                for country in COUNTRIES
            ],
        }
        proxy_setup_response = send(driver, {"type": "opx:proxy-save", "settings": proxy_settings}, timeout=30)
        proxy_setup_value = proxy_setup_response.get("value") if isinstance(proxy_setup_response, dict) else None
        result["runtime"]["proxySetup"] = {
            "messageOk": bool(proxy_setup_response.get("ok")) if isinstance(proxy_setup_response, dict) else False,
            "saved": bool(proxy_setup_value.get("ok")) if isinstance(proxy_setup_value, dict) else False,
            "message": proxy_setup_value.get("message", "") if isinstance(proxy_setup_value, dict) else "",
            "countries": list(COUNTRIES),
            "frontProxy": public_front_proxy(),
        }
        if not result["runtime"]["proxySetup"]["messageOk"] or not result["runtime"]["proxySetup"]["saved"]:
            raise RuntimeError("扩展代理配置保存失败")

        if not USE_BROWSER_SESSION:
            raw_accounts = "\n".join(f"{email}----{token}" for email, token in accounts)
            driver.execute_script("""
              const raw = document.querySelector('#probe-raw-accounts');
              raw.value = arguments[0]; raw.dispatchEvent(new Event('input', {bubbles:true}));
              document.querySelector('#btn-probe-save-accounts').click();
            """, raw_accounts)
        WebDriverWait(driver, 30).until(lambda d: f"账号 {len(accounts)}" in d.find_element(By.ID, "probe-account-summary").text)
        result["accountsImported"] = len(accounts)
        result["lastStage"] = "accounts-imported"

        task_name = f"{VERSION} Mullvad real matrix {RUN_LABEL}"
        driver.execute_script("""
          const setValue = (id, value) => { const el=document.querySelector('#'+id); el.value=value; el.dispatchEvent(new Event('change',{bubbles:true})); };
          const setCheck = (id, value) => { const el=document.querySelector('#'+id); el.checked=value; el.dispatchEvent(new Event('change',{bubbles:true})); };
          const taskName = arguments[0], countries = arguments[1], paymentMethods = arguments[2];
          const checkoutUiMode = arguments[3], requireZero = arguments[4];
          setValue('probe-task-name', taskName);
          setValue('probe-interval', '3600'); setValue('probe-retry', '1');
          setValue('probe-entry-proxy', 'front'); setValue('probe-exit-proxy', 'follow-country');
          setValue('probe-notify-mode', 'silent'); setValue('probe-experiment-mode', 'attribution');
          setValue('probe-promotion-country', countries[0] || 'HK'); setValue('probe-research-target-cell', '1');
          setValue('probe-payment-variants', paymentMethods.join(','));
          setValue('probe-checkout-ui-mode', checkoutUiMode);
          setValue('probe-research-repeat-minutes', '0'); setValue('probe-research-min-total', '20');
          setValue('probe-seed-replicates', '1'); setValue('probe-factor-min-samples', '2'); setValue('probe-drift-min-samples', '4');
          document.querySelectorAll('input[data-probe-country]').forEach(el => { el.checked=countries.includes(el.dataset.probeCountry); el.dispatchEvent(new Event('change',{bubbles:true})); });
          setCheck('probe-pin-success', false); setCheck('probe-skip-after-hit', false); setCheck('probe-auto-switch-exit', true);
          setCheck('probe-auto-open-hit', false); setCheck('probe-sniff-hit', true); setCheck('probe-save-hitdb', true);
          setCheck('probe-exclude-unhealthy', false); setCheck('probe-high-rate-only', false); setCheck('probe-exploration-enabled', true);
          setCheck('probe-factor-tracking', true); setCheck('probe-drift-detection', true); setCheck('probe-balanced-order', true);
          setCheck('probe-staged-pipeline', true); setCheck('probe-use-selected-bootstrap', true); setCheck('probe-enable-promotion-update', true);
          setCheck('probe-enable-provider-taxes', false); setCheck('probe-require-zero', requireZero); setCheck('probe-extract-final-url', true);
          setCheck('probe-enable-stripe-confirm', false); setCheck('probe-detect-methods', true); setCheck('probe-auto-apply-detected-methods', true);
          setCheck('probe-sound-enabled', false);
          document.querySelector('#btn-probe-create-task').click();
        """, task_name, list(COUNTRIES), list(PAYMENT_METHODS), CHECKOUT_UI_MODE, REQUIRE_ZERO)
        WebDriverWait(driver, 30).until(
            lambda d: "保存任务..." not in d.find_element(By.ID, "btn-probe-create-task").text
            and bool(d.find_element(By.ID, "probe-task-status").text.strip())
        )
        task_status_el = driver.find_element(By.ID, "probe-task-status")
        task_save_status = task_status_el.text
        task_save_class = task_status_el.get_attribute("class") or ""
        task_save_type = task_status_el.get_attribute("data-type") or ""
        task_state_response = send(driver, {"type": "opx:probe-get-state"}, timeout=30)
        task_state_value = task_state_response.get("value") if isinstance(task_state_response, dict) else None
        task_state = task_state_value.get("state") if isinstance(task_state_value, dict) else None
        saved_tasks = task_state.get("tasks", []) if isinstance(task_state, dict) else []
        matching_task = next(
            (
                task for task in saved_tasks
                if isinstance(task, dict)
                and isinstance(task.get("config"), dict)
                and task["config"].get("name") == task_name
            ),
            None,
        )
        result["runtime"]["taskSaveStatus"] = task_save_status
        result["runtime"]["taskSaveClass"] = task_save_class
        result["runtime"]["taskSaveType"] = task_save_type
        result["runtime"]["taskSaveButtonText"] = driver.find_element(By.ID, "btn-probe-create-task").text
        result["runtime"]["taskStateCheck"] = {
            "messageOk": bool(task_state_response.get("ok")) if isinstance(task_state_response, dict) else False,
            "taskCount": len(saved_tasks),
            "matched": bool(matching_task),
            "activeTaskId": task_state.get("activeTaskId") if isinstance(task_state, dict) else None,
        }
        if "error" in task_save_class.split() or task_save_type == "error":
            result["errors"].append(f"任务保存失败：{task_save_status}")
            raise RuntimeError(task_save_status)
        if not matching_task:
            result["errors"].append("任务保存后后台状态未找到目标任务")
            raise RuntimeError("probe task persistence check failed")
        result["lastStage"] = "task-saved"
        health_response = send(driver, {
            "type": "opx:probe-control", "action": "health-check", "taskId": matching_task.get("id"),
        }, timeout=90)
        health_value = health_response.get("value") if isinstance(health_response, dict) else None
        health_state = health_value.get("state") if isinstance(health_value, dict) else None
        health_rows = health_state.get("proxyHealth", []) if isinstance(health_state, dict) else []
        result["runtime"]["proxyHealth"] = [
            {
                key: row.get(key)
                for key in ("country", "status", "actualCountry", "actualIp", "asn", "latencyMs", "message")
                if key in row
            }
            for row in health_rows if isinstance(row, dict)
        ]
        matching_health = {
            str(row.get("country") or "").upper()
            for row in health_rows
            if isinstance(row, dict)
            and row.get("status") == "ok"
            and str(row.get("actualCountry") or "").upper() == str(row.get("country") or "").upper()
        }
        if STRICT_QUALITY and any(country not in matching_health for country in COUNTRIES):
            raise RuntimeError("扩展出口健康检查未达到计划国家与实际国家一致")
        result["lastStage"] = "proxy-health-checked"
        for round_index in range(1, ROUND_COUNT + 1):
            round_exit = check_front_proxy()
            round_item = {"round": round_index, "startedAt": int(time.time() * 1000), "frontExit": round_exit}
            result["roundEvidence"].append(round_item)
            driver.find_element(By.ID, "btn-probe-run-once").click()
            result["lastStage"] = f"task-running-round-{round_index}"
            deadline = time.time() + max(60, int(os.environ.get("OPX_LIVE_TIMEOUT_SEC", "600")))
            while time.time() < deadline:
                time.sleep(3)
                button_text = driver.find_element(By.ID, "btn-probe-run-once").text
                status_text = driver.find_element(By.ID, "probe-task-status").text
                if "探测中" not in button_text and ("完成" in status_text or "凭证预检" in status_text or "没有可用账号" in status_text):
                    round_item["statusText"] = status_text
                    round_item["finishedAt"] = int(time.time() * 1000)
                    break
            else:
                result["errors"].append(f"真实实验第 {round_index} 轮等待超时，已保留页面结果")
                break

        driver.find_element(By.ID, "btn-probe-refresh").click()
        time.sleep(2)
        task_status = driver.find_element(By.ID, "probe-task-status").text
        run_summary = driver.find_element(By.ID, "probe-run-summary").text
        factor_summary = driver.find_element(By.ID, "probe-factor-summary").text
        readiness_summary = driver.find_element(By.ID, "probe-readiness-summary").text
        hitdb_summary = driver.find_element(By.ID, "probe-hitdb-summary").text
        account_summary = driver.find_element(By.ID, "probe-account-report-summary").text
        runlog_text = driver.find_element(By.ID, "runlog-stream").text
        result["runtime"].update({"statusText": task_status, "runSummary": run_summary, "accountSummary": account_summary})
        observation_match = re.search(r"(?:当前纪元观测|观测)\s+(\d+)", factor_summary)
        total_match = re.search(r"总计\s+(\d+)", hitdb_summary)
        verified_match = re.search(r"有效链接\s+(\d+)", hitdb_summary)
        result["observations"] = int(observation_match.group(1)) if observation_match else 0
        result["hitDatabaseCount"] = int(total_match.group(1)) if total_match else 0
        result["verifiedLinkCount"] = int(verified_match.group(1)) if verified_match else 0
        result["readiness"] = {"summary": readiness_summary, "factorSummary": factor_summary}
        result["logEvents"] = [line[:180] for line in runlog_text.splitlines()[-30:] if line.strip()]
        final_state_response = send(driver, {"type": "opx:probe-get-state"}, timeout=30)
        final_state_value = final_state_response.get("value") if isinstance(final_state_response, dict) else None
        final_state = final_state_value.get("state") if isinstance(final_state_value, dict) else None
        final_observations = final_state.get("observations", []) if isinstance(final_state, dict) else []
        final_hits = final_state.get("hits", []) if isinstance(final_state, dict) else []
        result["resolvedLinks"] = resolve_generated_links(driver, final_hits)
        result["generatedLinks"] = [
            {
                key: hit.get(key)
                for key in (
                    "country", "currency", "checkoutUiMode", "qualificationVerified",
                    "amountHint", "promoHint", "link", "longUrl", "shortUrl",
                    "channels", "detectedMethods", "paymentMethodLinks", "checkoutVariants",
                    "hostedResolutionStatus", "hostedResolutionMessage", "identitySnapshotReady",
                    "resolvedCheckoutSessionType", "hostedResolutionMethods", "stripeResourceCount",
                    "stripePublishableKeyFound",
                )
                if key in hit
            }
            for hit in final_hits if isinstance(hit, dict)
        ]
        if final_observations:
            result["observations"] = len(final_observations)
            for observation in final_observations:
                outcome = str(observation.get("outcome") or "unknown")
                result["outcomes"][outcome] = result["outcomes"].get(outcome, 0) + 1
            keep_fields = (
                "observedAt", "experimentMode", "experimentArm", "designCellKey", "accountBatchId",
                "accountId", "runId", "cycleId", "round", "sequence", "routeVariantId",
                "probeCountry", "plannedAuthCountry", "plannedCheckoutCountry", "plannedBillingCountry",
                "plannedPaymentMethod", "submittedPaymentMethod", "outcome", "hitKind", "qualificationVerified",
                "finalLinkVerified", "linkVerificationLevel", "linkUsable", "credentialStatus", "errorClass",
                "checkoutCreated", "amountHint", "currency", "paymentMethod", "retryOrdinal", "durationMs",
                "actualAuthCountry", "actualCheckoutCountry", "actualBillingCountry", "countryTreatmentApplied",
                "routeTreatmentApplied", "paymentMethodTreatmentApplied", "experimentValidityStatus",
                "experimentValidForAttribution", "experimentValidityReasons",
                "auth", "checkout", "billing", "extensionVersion", "browserFamily", "locale", "timeZone",
                "checkoutSubnet", "checkoutNetworkType", "ruleEpochId",
            )
            result["observationDetails"] = [
                {key: observation.get(key) for key in keep_fields if key in observation}
                for observation in final_observations[-100:]
            ]
        result["factorSummary"] = {
            "byAccount": summarize_factor(final_observations, lambda item: item.get("accountId")),
            "byPlannedCheckoutCountry": summarize_factor(final_observations, lambda item: item.get("plannedCheckoutCountry")),
            "byActualCheckoutCountry": summarize_factor(final_observations, lambda item: item.get("actualCheckoutCountry") or item.get("checkout", {}).get("country")),
            "byCheckoutIp": summarize_factor(final_observations, lambda item: item.get("checkout", {}).get("ip")),
            "byPlannedPaymentMethod": summarize_factor(final_observations, lambda item: item.get("plannedPaymentMethod")),
            "bySubmittedPaymentMethod": summarize_factor(final_observations, lambda item: item.get("submittedPaymentMethod") or "not-submitted"),
        }
        resolved = [item for item in final_observations if item.get("outcome") in {"hit", "miss"}]
        attribution = [item for item in final_observations if item.get("experimentValidForAttribution") is True]
        country_applied = [item for item in final_observations if item.get("countryTreatmentApplied") is True]
        route_applied = [item for item in final_observations if item.get("routeTreatmentApplied") is True]
        submitted = [item for item in final_observations if item.get("submittedPaymentMethod")]
        qualified = [item for item in final_observations if item.get("qualificationVerified") is True]
        final_links = [item for item in final_observations if item.get("finalLinkVerified") is True and item.get("linkUsable") is True]
        result["qualityGate"] = {
            "flowCompleted": bool(final_observations),
            "resolvedOutcomes": len(resolved),
            "attributionEligible": len(attribution),
            "countryTreatmentApplied": len(country_applied),
            "routeTreatmentApplied": len(route_applied),
            "paymentMethodSubmitted": len(submitted),
            "qualificationVerified": len(qualified),
            "verifiedFinalLinks": len(final_links),
            "frontCountryMatched": not EXPECTED_FRONT_COUNTRY or all(
                item.get("frontExit", {}).get("country") == EXPECTED_FRONT_COUNTRY for item in result["roundEvidence"]
            ),
        }
        terminal_evidence = "\n".join(result["logEvents"])
        flow_ok = result["accountsImported"] == len(accounts) and not result["errors"] and (
            result["observations"] > 0 or "凭证预检" in terminal_evidence or "没有可用账号" in terminal_evidence
        )
        quality_ok = bool(result["qualityGate"].get("attributionEligible")) and bool(result["qualityGate"].get("frontCountryMatched"))
        result["ok"] = flow_ok and (quality_ok if STRICT_QUALITY else True)
        if flow_ok and STRICT_QUALITY and not quality_ok:
            result["errors"].append("实验质量门未通过：没有处理生效的可归因观测，或前置出口与显式期望不一致")
        result["lastStage"] = "complete"
    except Exception as error:
        error_text = str(error).strip()
        result["errors"].append(
            f"{result.get('lastStage', 'unknown')} · {type(error).__name__}"
            + (f"：{error_text}" if error_text else "")
        )
        result["ok"] = False
    finally:
        if driver:
            if not result.get("ok"):
                capture_browser_evidence(driver, result)
            driver.quit()
        shutil.rmtree(temp_root, ignore_errors=True)
        result_text = json.dumps(result, ensure_ascii=False, indent=2)
        (EVIDENCE / f"result-{RUN_LABEL}.json").write_text(result_text, encoding="utf-8")
        (EVIDENCE / "result.json").write_text(result_text, encoding="utf-8")
        print(result_text)


if __name__ == "__main__":
    main()
