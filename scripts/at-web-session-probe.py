# -*- coding: utf-8 -*-
"""Probe whether an access token can bootstrap a ChatGPT web session.

The probe uses a real Mullvad Browser page to create the NextAuth transaction,
then tests the authorization server with the supplied bearer token. Evidence is
redacted before it is written under .context-snapshots/at-web-session-probe/.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit

from curl_cffi import requests as curl_requests
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".context-snapshots" / "at-web-session-probe"
TOKEN = os.environ.get("OPX_LIVE_TOKEN", "").strip()
PROXY = os.environ.get("OPX_LIVE_FRONT_PROXY", "socks5h://127.0.0.1:10808").strip()
BINARY = os.environ.get(
    "OPX_FIREFOX_BINARY",
    r"C:\Users\Administrator\AppData\Local\Mullvad\MullvadBrowser\Release\mullvadbrowser.exe",
)

if not TOKEN:
    raise SystemExit("OPX_LIVE_TOKEN 未设置")


def jwt_payload(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("AT 不是 JWT")
    raw = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
    return json.loads(base64.urlsafe_b64decode(raw.encode("ascii")))


def mask_email(value: str) -> str:
    text = str(value or "")
    if "@" not in text:
        return "***"
    local, domain = text.split("@", 1)
    return f"{local[:2]}***@{domain}"


def redact(value: str) -> str:
    text = str(value or "")
    text = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[redacted-jwt]", text)
    text = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[redacted-email]", text)
    text = re.sub(r"(?i)(code|state|token|nonce)=([^&\s]+)", r"\1=[redacted]", text)
    return text


def summarize_response(label: str, response) -> dict:
    text = response.text or ""
    payload = {}
    try:
        payload = response.json()
    except Exception:
        pass
    record = {
        "label": label,
        "status": response.status_code,
        "contentType": response.headers.get("content-type", ""),
        "location": redact(response.headers.get("location", ""))[:500],
        "setCookieNames": sorted(set(re.findall(r"(?:^|,\s*)([^=;,\s]+)=", response.headers.get("set-cookie", "")))),
        "keys": sorted(payload.keys())[:40] if isinstance(payload, dict) else [],
        "bodyPreview": redact(text)[:500],
    }
    if isinstance(payload, dict):
        record["error"] = redact(str(payload.get("error") or payload.get("detail") or ""))[:220]
        record["hasAccessToken"] = bool(payload.get("access_token") or payload.get("accessToken"))
        record["hasRefreshToken"] = bool(payload.get("refresh_token") or payload.get("refreshToken"))
    return record


def browser_options(profile: Path) -> Options:
    options = Options()
    options.binary_location = BINARY
    options.page_load_strategy = "eager"
    options.add_argument("-profile")
    options.add_argument(str(profile))
    parsed = urlsplit(PROXY if "://" in PROXY else f"http://{PROXY}")
    options.set_preference("network.proxy.type", 1)
    if parsed.scheme.startswith("socks"):
        options.set_preference("network.proxy.socks", parsed.hostname)
        options.set_preference("network.proxy.socks_port", parsed.port)
        options.set_preference("network.proxy.socks_version", 5 if "5" in parsed.scheme else 4)
        options.set_preference("network.proxy.socks_remote_dns", parsed.scheme.endswith("h") or parsed.scheme.endswith("a"))
    else:
        options.set_preference("network.proxy.http", parsed.hostname)
        options.set_preference("network.proxy.http_port", parsed.port)
        options.set_preference("network.proxy.ssl", parsed.hostname)
        options.set_preference("network.proxy.ssl_port", parsed.port)
        options.set_preference("network.proxy.share_proxy_settings", True)
    options.set_preference("browser.shell.checkDefaultBrowser", False)
    options.set_preference("browser.startup.homepage_override.mstone", "ignore")
    return options


    addon_id = driver.install_addon(str(build_header_probe_extension(temp_root)), temporary=True)
    bootstrap_url = extension_page_url(driver, addon_id, "bootstrap.html")
    if not bootstrap_url:
        return {"ok": False, "error": "header extension URL missing"}
    driver.get(bootstrap_url)
    time.sleep(1)
    if not driver.execute_script("return Boolean(document.querySelector('#token') && document.querySelector('#set'))"):
        return {
            "ok": False,
            "error": "header extension bootstrap page did not load",
            "pageUrl": redact(driver.current_url),
            "pagePreview": redact(driver.page_source)[:300],
        }
    driver.execute_script(
        """
        document.querySelector('#token').value = arguments[0];
        document.querySelector('#set').click();
        """,
        token,
    )
    for _ in range(30):
        configured = driver.execute_script("return document.querySelector('#status').textContent")
        if configured:
            break
        time.sleep(0.1)
    driver.get(authorize_url)
    time.sleep(7)
    final_url = driver.current_url
    split = urlsplit(final_url)
    body = driver.execute_script("return (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200)") or ""
    return {
        "ok": True,
        "configured": configured == "ready",
        "finalOrigin": f"{split.scheme}://{split.netloc}",
        "finalPath": split.path,
        "callbackReached": split.netloc == "chatgpt.com" and split.path.startswith("/api/auth/callback/"),
        "loginPageReached": split.netloc == "auth.openai.com" and ("login" in split.path or "authorize" in split.path),
        "bodyPreview": redact(body)[:500],
    }


def start_nextauth_transaction(driver) -> dict:
    return driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        (async () => {
          const csrfResponse = await fetch('/api/auth/csrf', {credentials: 'include', cache: 'no-store'});
          const csrf = await csrfResponse.json();
          const body = new URLSearchParams({
            csrfToken: csrf.csrfToken,
            callbackUrl: 'https://chatgpt.com/',
            json: 'true',
          });
          const response = await fetch('/api/auth/signin/openai', {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body,
            credentials: 'include',
          });
          const data = await response.json();
          done({status: response.status, authorizeUrl: data.url || '', hasCsrf: Boolean(csrf.csrfToken)});
        })().catch(error => done({status: 0, error: String(error && error.message || error)}));
        """
    )


def read_browser_session(driver) -> dict:
    return driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        fetch('https://chatgpt.com/api/auth/session', {credentials: 'include', cache: 'no-store'})
          .then(async response => {
            const text = await response.text();
            let body = {};
            try { body = JSON.parse(text); } catch {}
            done({
              status: response.status,
              keys: Object.keys(body).sort().slice(0, 40),
              hasUser: Boolean(body.user),
              hasAccessToken: Boolean(body.accessToken),
              hasSessionToken: Boolean(body.sessionToken),
              email: body.user && body.user.email || '',
            });
          }, error => done({status: 0, error: String(error && error.message || error)}));
        """
    )


def main() -> None:
    claims = jwt_payload(TOKEN)
    auth = claims.get("https://api.openai.com/auth") or {}
    profile_claims = claims.get("https://api.openai.com/profile") or {}
    OUT.mkdir(parents=True, exist_ok=True)
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "proxy": PROXY,
        "claims": {
            "email": mask_email(profile_claims.get("email") or ""),
            "clientId": claims.get("client_id") or "",
            "planType": auth.get("chatgpt_plan_type") or "unknown",
            "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(claims.get("exp") or 0))),
            "expired": int(claims.get("exp") or 0) <= int(time.time()),
        },
        "nextAuth": {},
        "authorizeAttempts": [],
        "tokenExchangeAttempts": [],
        "callback": {},
        "session": {},
        "result": "not_started",
    }
    temp_root = Path(tempfile.mkdtemp(prefix="opx-at-web-session-"))
    profile = temp_root / "profile"
    profile.mkdir()
    driver = None
    try:
        driver = webdriver.Firefox(options=browser_options(profile), service=Service(service_args=["--allow-system-access"]))
        driver.set_page_load_timeout(60)
        driver.set_script_timeout(60)
        driver.get("https://chatgpt.com/")
        time.sleep(6)
        transaction = start_nextauth_transaction(driver)
        authorize_url = str(transaction.pop("authorizeUrl", ""))
        parsed_authorize = urlsplit(authorize_url)
        params = parse_qs(parsed_authorize.query)
        report["nextAuth"] = {
            **transaction,
            "authorizeOrigin": f"{parsed_authorize.scheme}://{parsed_authorize.netloc}",
            "authorizePath": parsed_authorize.path,
            "clientIdMatches": (params.get("client_id") or [""])[0] == str(claims.get("client_id") or ""),
            "redirectUri": (params.get("redirect_uri") or [""])[0],
            "responseType": (params.get("response_type") or [""])[0],
        }
        if not authorize_url:
            report["result"] = "nextauth_transaction_failed"
            return


        session = curl_requests.Session(impersonate="chrome")
        session.proxies = {"http": PROXY, "https": PROXY}
        for cookie in driver.get_cookies():
            session.cookies.set(cookie["name"], cookie["value"], domain=cookie.get("domain") or ".chatgpt.com", path=cookie.get("path") or "/")

        current_url = authorize_url
        callback_url = ""
        for index in range(8):
            response = session.get(
                current_url,
                headers={"Accept": "text/html,application/json", "Authorization": f"Bearer {TOKEN}"},
                allow_redirects=False,
                timeout=30,
            )
            report["authorizeAttempts"].append(summarize_response(f"authorize-{index + 1}", response))
            location = response.headers.get("location", "")
            if not location:
                break
            current_url = urljoin(current_url, location)
            split = urlsplit(current_url)
            if split.netloc == "chatgpt.com" and split.path.startswith("/api/auth/callback/"):
                callback_url = current_url
                break

        report["authorizeNoBearer"] = summarize_response(
            "authorize-no-bearer",
            session.get(authorize_url, headers={"Accept": "application/json"}, allow_redirects=False, timeout=30),
        )
        continue_url = report["authorizeAttempts"][0].get("location") or ""
        if not continue_url:
            try:
                import json as _json
                body = _json.loads((report["authorizeAttempts"][0].get("bodyPreview") or "").replace("[redacted-jwt]", "").replace("[redacted-email]", ""))
                continue_url = str(body.get("continue_url") or "")
            except Exception:
                continue_url = ""
        follow_result = None
        if continue_url:
            follow = session.get(continue_url, headers={"Accept": "application/json"}, allow_redirects=False, timeout=30)
            follow_result = summarize_response("continue-login", follow)
            location = follow.headers.get("location", "")
            for hop in range(5):
                if not location:
                    break
                follow = session.get(urljoin(continue_url, location), headers={"Accept": "application/json"}, allow_redirects=False, timeout=30)
                follow_result = summarize_response(f"continue-hop-{hop + 1}", follow)
                location = follow.headers.get("location", "")
        report["authorizeFollow"] = follow_result

        token_url = "https://auth.openai.com/oauth/token"
        client_id = str(claims.get("client_id") or (params.get("client_id") or [""])[0])
        exchange_forms = [
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "subject_token": TOKEN,
                "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "client_id": client_id,
            },
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": TOKEN,
                "client_id": client_id,
            },
        ]
        for index, form in enumerate(exchange_forms, 1):
            response = session.post(token_url, data=form, allow_redirects=False, timeout=30)
            report["tokenExchangeAttempts"].append(summarize_response(f"token-exchange-{index}", response))
        supplemental_forms = [
            {
                "grant_type": "refresh_token",
                "refresh_token": "",
                "client_id": client_id,
                "audience": "https://api.openai.com/v1",
            },
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "subject_token": TOKEN,
                "subject_token_type": "urn:ietf:params:oauth:token-type:refresh_token",
                "requested_token_type": "urn:ietf:params:oauth:token-type:refresh_token",
                "client_id": client_id,
            },
        ]
        for index, form in enumerate(supplemental_forms, 3):
            response = session.post(token_url, data=form, allow_redirects=False, timeout=30)
            report["tokenExchangeAttempts"].append(summarize_response(f"token-exchange-{index}", response))

        if callback_url:
            driver.get(callback_url)
            time.sleep(5)
            report["callback"] = {"received": True, "finalUrl": redact(driver.current_url)}
            session_result = read_browser_session(driver)
            session_result["email"] = mask_email(session_result.get("email") or "")
            report["session"] = session_result
            report["result"] = "session_established" if session_result.get("hasAccessToken") else "callback_without_session"
        else:
            report["callback"] = {"received": False}
            report["session"] = read_browser_session(driver)
            report["session"]["email"] = mask_email(report["session"].get("email") or "")
            report["result"] = "bearer_authorize_not_exchanged"
    except Exception as error:
        report["result"] = "probe_error"
        report["error"] = redact(f"{type(error).__name__}: {error}")[:500]
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        shutil.rmtree(temp_root, ignore_errors=True)
        payload = json.dumps(report, ensure_ascii=False, indent=2)
        (OUT / "result.json").write_text(payload, encoding="utf-8")
        print(payload)


if __name__ == "__main__":
    main()
