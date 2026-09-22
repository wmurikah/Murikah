#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "wrangler.toml"
APP_NAME = "murikah-tutor-container-staging-TutorContainer"
VERIFY_BASES = ("https://murikah-tutor-container-staging.hasspe.workers.dev","https://tutor.murikah.com")
APPLICATION_NOT_FOUND = "APPLICATION_NOT_FOUND"
CREATE_TEMPORARILY_UNAVAILABLE = "can't create application at this time"
TRANSIENT_DEPLOY_ERRORS = (
    APPLICATION_NOT_FOUND.casefold(),
    CREATE_TEMPORARILY_UNAVAILABLE.casefold(),
    "application is being deleted",
    "application is currently being deleted",
    "try again later",
)

def wrangler_path() -> str:
    local = ROOT / "node_modules" / ".bin" / "wrangler"
    if local.exists():
        return str(local)
    found = shutil.which("wrangler")
    if found:
        return found
    raise RuntimeError("wrangler executable was not found")

def expected_image_revision() -> str:
    text = CONFIG.read_text(encoding="utf-8")
    match = re.search(r'MURIKAH_CLOUDFLARE_IMAGE_REV\s*=\s*"([^"]+)"', text)
    if not match:
        raise RuntimeError("MURIKAH_CLOUDFLARE_IMAGE_REV is missing from wrangler.toml")
    return match.group(1)

def run_wrangler(*args: str, capture: bool=False, check: bool=True) -> subprocess.CompletedProcess[str]:
    command = [wrangler_path(), *args, "--config", str(CONFIG)]
    environment = os.environ.copy()
    environment["CI"] = "true"
    return subprocess.run(command, cwd=ROOT, env=environment, check=check, text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None)

def emit_completed_process(result: subprocess.CompletedProcess[str]) -> None:
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)

def apply_persistence_migrations() -> None:
    print("[Murikah Tutor] Applying version-controlled D1 persistence migrations.")
    result = run_wrangler(
        "d1", "migrations", "apply", "murikah-tutor-prod", "--remote",
        capture=True, check=False,
    )
    emit_completed_process(result)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode, result.args, output=result.stdout, stderr=result.stderr
        )

def is_transient_deploy_error(output: str) -> bool:
    folded = output.casefold()
    return any(marker in folded for marker in TRANSIENT_DEPLOY_ERRORS)

def deploy(*, attempts: int=8) -> str:
    delays = (5,8,13,20,30,45,60)
    last_output = ""
    for attempt in range(1, attempts+1):
        result = run_wrangler("deploy","--containers-rollout=immediate",capture=True,check=False)
        emit_completed_process(result)
        last_output = f"{result.stdout or ''}\n{result.stderr or ''}"
        if result.returncode == 0:
            return last_output
        if attempt >= attempts or not is_transient_deploy_error(last_output):
            raise subprocess.CalledProcessError(result.returncode,result.args,output=result.stdout,stderr=result.stderr)
        delay = delays[min(attempt-1,len(delays)-1)]
        print(f"[Murikah Tutor] Cloudflare container control plane is still converging; retrying deploy in {delay}s ({attempt}/{attempts}).")
        time.sleep(delay)
    raise RuntimeError("Tutor deploy retry loop exhausted unexpectedly")

def parse_json_output(raw: str) -> Any:
    text = raw.strip()
    try: return json.loads(text)
    except json.JSONDecodeError:
        starts=[p for p in (text.find("["),text.find("{")) if p>=0]
        if not starts: raise
        start=min(starts)
        for end_char in ("]","}"):
            end=text.rfind(end_char)
            if end>=start:
                try: return json.loads(text[start:end+1])
                except json.JSONDecodeError: continue
        raise

def list_tutor_applications() -> list[dict[str,Any]]:
    result = run_wrangler("containers","list","--json",capture=True)
    applications = parse_json_output(result.stdout)
    if not isinstance(applications,list):
        raise RuntimeError("wrangler containers list did not return a JSON list")
    return [app for app in applications if isinstance(app,dict) and str(app.get("name","")).casefold()==APP_NAME.casefold() and app.get("id")]

def wait_for_application_absent(*, timeout_seconds: int=120) -> None:
    deadline=time.monotonic()+timeout_seconds
    while time.monotonic()<deadline:
        if not list_tutor_applications():
            time.sleep(8)
            return
        time.sleep(4)
    raise RuntimeError(f"container application {APP_NAME!r} still exists after {timeout_seconds}s")

def recycle_tutor_application() -> None:
    matches=list_tutor_applications()
    if not matches:
        print("[Murikah Tutor] Stale container application is already absent; continuing with recreation.")
        return
    for app in matches:
        app_id=str(app["id"])
        print(f"[Murikah Tutor] Recycling stale Cloudflare container application {APP_NAME}.")
        run_wrangler("containers","delete",app_id)
    wait_for_application_absent()

def fetch_json(base: str, path: str, *, timeout: float) -> dict[str,Any]:
    separator="&" if "?" in path else "?"
    url=f"{base.rstrip('/')}{path}{separator}deploy_check={time.time_ns()}"
    request=Request(url,headers={"accept":"application/json","cache-control":"no-cache","user-agent":"Murikah-Tutor-Deploy-Verification/1.0"})
    with urlopen(request,timeout=timeout) as response:
        payload=json.loads(response.read().decode("utf-8"))
    if not isinstance(payload,dict): raise RuntimeError(f"unexpected JSON payload from {base}{path}")
    return payload

def image_revision(report: dict[str,Any]) -> str:
    image=report.get("image")
    if not isinstance(image,dict): return ""
    output=str(image.get("output",""))
    match=re.search(r"(?m)^image-revision=([^\r\n]+)$",output)
    return match.group(1).strip() if match else ""

def startup_log(report: dict[str,Any]) -> str:
    value=report.get("startupLog")
    return str(value.get("output","")) if isinstance(value,dict) else ""

def diagnostic_report(expected_revision: str, *, timeout_seconds: int=120) -> tuple[dict[str,Any],str]:
    deadline=time.monotonic()+timeout_seconds
    last_error=""
    last_report=None
    last_base=""
    while time.monotonic()<deadline:
        for base in VERIFY_BASES:
            try:
                report=fetch_json(base,"/__muri/container-diagnostics",timeout=30)
                revision=image_revision(report)
                print(f"[Murikah Tutor] Runtime image check: {revision or 'unknown'} (expected {expected_revision}).")
                last_report=report; last_base=base
                if revision==expected_revision: return report,base
            except (HTTPError,URLError,TimeoutError,OSError,ValueError,RuntimeError) as exc:
                last_error=f"{type(exc).__name__}: {exc}"
        time.sleep(4)
    if last_report is not None: return last_report,last_base
    raise RuntimeError(f"could not obtain Tutor container diagnostics: {last_error}")

def wait_until_ready(base: str, *, timeout_seconds: int=180) -> dict[str,Any]:
    deadline=time.monotonic()+timeout_seconds
    last={}
    while time.monotonic()<deadline:
        try:
            last=fetch_json(base,"/__muri/runtime-status",timeout=15)
            if last.get("ready") is True and last.get("httpStatus")==200: return last
        except (HTTPError,URLError,TimeoutError,OSError,ValueError,RuntimeError): pass
        time.sleep(4)
    return last

def safe_failure_detail(log: str) -> str:
    blocked=("password","secret","token","api_key","client_secret","private_key")
    lines=[]
    for line in log.splitlines():
        low=line.lower()
        lines.append("<redacted diagnostic line>" if any(x in low for x in blocked) else line)
    return "\n".join(lines[-24:])

def verify_fresh_runtime(expected_revision: str, *, timeout_seconds: int=120) -> tuple[bool,dict[str,Any],str]:
    report,base=diagnostic_report(expected_revision,timeout_seconds=timeout_seconds)
    return image_revision(report)==expected_revision,report,base

def validate_runtime_report(report: dict[str,Any]) -> None:
    log=startup_log(report)
    runtime=report.get("runtime") if isinstance(report.get("runtime"),dict) else {}
    port_probe=str(runtime.get("port3782","")) if isinstance(runtime,dict) else ""
    if "ModuleNotFoundError: No module named 'deeptutor'" in log:
        raise RuntimeError("fresh Tutor image still cannot import the bundled deeptutor package")
    if "Traceback (most recent call last):" in log and port_probe!="http-200":
        raise RuntimeError(f"fresh Tutor image failed during startup:\n{safe_failure_detail(log)}")

def refreshed_failure_detail(expected_revision: str) -> str:
    """Capture diagnostics after a readiness failure, not from an earlier image probe."""
    try:
        report,_=diagnostic_report(expected_revision,timeout_seconds=75)
        log=safe_failure_detail(startup_log(report))
        runtime=report.get("runtime") if isinstance(report.get("runtime"),dict) else {}
        port_probe=str(runtime.get("port3782","")) if isinstance(runtime,dict) else ""
        parts=[]
        if port_probe:
            parts.append(f"diagnostic port3782={port_probe}")
        if log:
            parts.append(log)
        return "\n".join(parts)
    except Exception as exc:
        return f"diagnostics refresh failed: {type(exc).__name__}: {exc}"

def recover_unready_application(expected_revision: str) -> tuple[dict[str,Any],str]:
    """Recover a serving instance that stayed wedged after a successful image deploy.

    The isolated diagnostic container proves the new image can boot. A separate
    APP_INSTANCE can still be left running/stuck across a container application
    rollout, so recycle the application once and redeploy instead of failing the
    release with a permanently unready serving instance.
    """
    detail=refreshed_failure_detail(expected_revision)
    print(
        "[Murikah Tutor] Fresh image passed isolated startup, but the serving "
        "instance did not become ready; recycling the container application once."
    )
    if detail:
        print(f"[Murikah Tutor] Pre-recycle diagnostics:\n{detail}")

    recycle_tutor_application()
    deploy()

    fresh,report,base=verify_fresh_runtime(expected_revision,timeout_seconds=180)
    if not fresh:
        detail=refreshed_failure_detail(expected_revision)
        raise RuntimeError(
            "Tutor application was recycled, but the expected image did not "
            "become observable"
            +(f"\n{detail}" if detail else "")
        )

    validate_runtime_report(report)
    status=wait_until_ready(base,timeout_seconds=240)
    if status.get("ready") is not True or status.get("httpStatus")!=200:
        detail=refreshed_failure_detail(expected_revision)
        raise RuntimeError(
            "Tutor application was recycled, but the serving instance still "
            "did not become ready on port 3782"
            +(f"\n{detail}" if detail else "")
        )
    return report,base


def main() -> int:
    expected_revision=expected_image_revision()
    apply_persistence_migrations()
    application_existed_before=bool(list_tutor_applications())
    deploy()
    fresh,report,base=verify_fresh_runtime(expected_revision,timeout_seconds=120)
    observed_revision=image_revision(report)

    if not fresh and not application_existed_before:
        print("[Murikah Tutor] A fresh container application was created in this deployment. Diagnostics have not confirmed the image revision yet; preserving the new application and extending readiness observation.")
        status=wait_until_ready(base,timeout_seconds=240)
        if status.get("ready") is True and status.get("httpStatus")==200:
            validate_runtime_report(report)
            print(f"[Murikah Tutor] Deployment verified: freshly-created application for image {expected_revision}, port 3782 healthy.")
            return 0
        fresh,report,base=verify_fresh_runtime(expected_revision,timeout_seconds=180)
        if not fresh:
            detail=refreshed_failure_detail(expected_revision)
            raise RuntimeError("freshly-created Tutor application did not become healthy or expose image "+expected_revision+"; application was preserved for inspection"+(f"\n{detail}" if detail else ""))

    elif not fresh:
        if not observed_revision:
            status=wait_until_ready(base,timeout_seconds=180)
            if status.get("ready") is True and status.get("httpStatus")==200:
                raise RuntimeError("Tutor is healthy but runtime image revision is still unknown; preserving the existing application rather than deleting it.")
            raise RuntimeError("Tutor runtime image revision is still unknown after deployment; preserving the existing application rather than deleting it.")
        print(f"[Murikah Tutor] Confirmed stale runtime image {observed_revision}; expected {expected_revision}.")
        recycle_tutor_application()
        deploy()
        fresh,report,base=verify_fresh_runtime(expected_revision,timeout_seconds=180)
        if not fresh:
            status=wait_until_ready(base,timeout_seconds=240)
            if status.get("ready") is True and status.get("httpStatus")==200:
                validate_runtime_report(report)
                print(f"[Murikah Tutor] Deployment verified after application recreation: image {expected_revision}, port 3782 healthy.")
                return 0
            detail=safe_failure_detail(startup_log(report))
            raise RuntimeError("Tutor application was recreated but the expected image did not become observable/healthy; the recreated application was preserved"+(f"\n{detail}" if detail else ""))

    validate_runtime_report(report)
    status=wait_until_ready(base,timeout_seconds=180)
    if status.get("ready") is not True or status.get("httpStatus")!=200:
        report,base=recover_unready_application(expected_revision)

    print(f"[Murikah Tutor] Deployment verified: image {expected_revision}, port 3782 healthy.")
    return 0

if __name__=="__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"Murikah Tutor deployment command failed with exit code {exc.returncode}.",file=sys.stderr)
        raise
