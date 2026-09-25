#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
CONFIG = ROOT / "wrangler.toml"
GENERATED_CONFIG = ROOT / "wrangler.deploy.generated.toml"
PREBUILT_IMAGE_REPOSITORY = "murikah-tutor"
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
REGISTRY_PROPAGATION_MARKERS = (
    "no such manifest:",
    "manifest unknown",
)
DEPLOY_SUCCESS_MARKERS = (
    "deployed murikah-tutor-container-staging triggers",
    "success  modified application",
    "applied changes",
)

def wrangler_path() -> str:
    local = ROOT / "node_modules" / ".bin" / "wrangler"
    if local.exists():
        return str(local)
    found = shutil.which("wrangler")
    if found:
        return found
    raise RuntimeError("wrangler executable was not found")

def source_revision() -> str:
    def git_object(spec: str) -> str:
        result = subprocess.run(
            ["git", "rev-parse", spec],
            cwd=REPO_ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        value = result.stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            raise RuntimeError(f"unexpected git object id for {spec}: {value!r}")
        return value

    tutor_tree = git_object("HEAD:tutor")
    logo_blob = git_object("HEAD:docs/images/murikah_6.png")
    return f"{tutor_tree}-{logo_blob}"

def prebuilt_image_tag(revision: str) -> str:
    return f"{PREBUILT_IMAGE_REPOSITORY}:source-{revision}"

def prepare_deploy_config(image_tag: str, revision: str) -> Path:
    text = CONFIG.read_text(encoding="utf-8")
    image_marker = 'image = "murikah-tutor:main"'
    if text.count(image_marker) != 1:
        raise RuntimeError("wrangler.toml must contain exactly one managed Tutor image fallback")
    text = text.replace(image_marker, f'image = "{image_tag}"', 1)
    text, replacements = re.subn(
        r'(?m)^MURIKAH_CLOUDFLARE_IMAGE_REV = "[^"]+"$',
        f'MURIKAH_CLOUDFLARE_IMAGE_REV = "{revision}"',
        text,
    )
    if replacements != 1:
        raise RuntimeError(
            "wrangler.toml must contain exactly one MURIKAH_CLOUDFLARE_IMAGE_REV runtime variable"
        )
    GENERATED_CONFIG.write_text(text, encoding="utf-8")
    print(
        "[Murikah Tutor] Deployment pinned to prebuilt Cloudflare Registry image "
        f"{image_tag}."
    )
    return GENERATED_CONFIG

def run_wrangler(
    *args: str,
    capture: bool=False,
    check: bool=True,
    config_path: Path=CONFIG,
) -> subprocess.CompletedProcess[str]:
    command = [wrangler_path(), *args, "--config", str(config_path)]
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

def deploy(*, attempts: int=12, config_path: Path=CONFIG) -> str:
    delays = (5,10,15,20,30,45,60,60,60,60,60)
    last_output = ""
    for attempt in range(1, attempts+1):
        result = run_wrangler(
            "deploy",
            "--containers-rollout=immediate",
            capture=True,
            check=False,
            config_path=config_path,
        )
        emit_completed_process(result)
        last_output = f"{result.stdout or ''}\n{result.stderr or ''}"
        folded = last_output.casefold()
        registry_pending = any(marker in folded for marker in REGISTRY_PROPAGATION_MARKERS)
        deploy_succeeded = any(marker in folded for marker in DEPLOY_SUCCESS_MARKERS)
        if registry_pending:
            if attempt >= attempts:
                raise RuntimeError(
                    "The exact prebuilt Tutor image was still unavailable in the "
                    "Cloudflare managed registry after all bounded retries."
                )
            delay = delays[min(attempt-1,len(delays)-1)]
            print(
                "[Murikah Tutor] Exact prebuilt image is not readable from the "
                f"Cloudflare registry yet; retrying deploy after {delay}s "
                f"({attempt}/{attempts})."
            )
            time.sleep(delay)
            continue
        if result.returncode == 0 and deploy_succeeded:
            return last_output
        if result.returncode == 0:
            return last_output
        if attempt >= attempts or not is_transient_deploy_error(last_output):
            raise subprocess.CalledProcessError(
                result.returncode,
                result.args,
                output=result.stdout,
                stderr=result.stderr,
            )
        delay = delays[min(attempt-1,len(delays)-1)]
        print(
            "[Murikah Tutor] Cloudflare container control plane is still converging; "
            f"retrying deploy in {delay}s ({attempt}/{attempts})."
        )
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

def runtime_revision_payload(base: str, *, timeout: float=20.0) -> dict[str,Any]:
    return fetch_json(base, "/__muri/runtime-revision", timeout=timeout)

def wait_for_runtime_revision(
    expected_revision: str,
    *,
    timeout_seconds: int=120,
) -> tuple[bool,dict[str,Any],str]:
    """Verify the image running in the real Tutor application instance.

    This deliberately avoids the isolated diagnostics container for the primary
    rollout decision. The diagnostics instance is useful for failure detail but
    can briefly report an unknown revision while Cloudflare's registry/control
    plane converges, even when the real application has already been updated.
    """
    deadline=time.monotonic()+timeout_seconds
    last_payload: dict[str,Any]={}
    last_base=""
    last_error=""
    last_revision=""
    stale_observations=0
    while time.monotonic()<deadline:
        for base in VERIFY_BASES:
            try:
                payload=runtime_revision_payload(base,timeout=20)
                revision=str(payload.get("imageRevision") or "").strip()
                ready=payload.get("ready") is True and payload.get("httpStatus")==200
                running=payload.get("running") is True
                print(
                    f"[Murikah Tutor] Main runtime image check: "
                    f"{revision or 'unknown'} (expected {expected_revision}); "
                    f"running={running} ready={ready}."
                )
                last_payload=payload
                last_base=base
                last_revision=revision
                if revision==expected_revision:
                    return True,payload,base
                if revision:
                    stale_observations += 1
                    # A concrete wrong revision is authoritative evidence that
                    # the warm application did not roll to the deployed image.
                    # Two observations avoid a one-off read during transition
                    # without wasting the full timeout before deterministic
                    # recreation.
                    if stale_observations >= 2:
                        return False,payload,base
            except (HTTPError,URLError,TimeoutError,OSError,ValueError,RuntimeError) as exc:
                last_error=f"{type(exc).__name__}: {exc}"
        time.sleep(4)
    if last_payload:
        return last_revision==expected_revision,last_payload,last_base
    raise RuntimeError(f"could not obtain Tutor main runtime revision: {last_error}")

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


def recover_fresh_but_unready_runtime(
    expected_revision: str,
    *,
    config_path: Path=CONFIG,
) -> tuple[dict[str,Any],str]:
    """Retry one clean application creation after an image/registry readiness race.

    Cloudflare can report a successful Worker deploy while the freshly-pushed
    container manifest is still propagating. In that state the expected image
    revision may already be observable through diagnostics even though the
    long-lived application never opens port 3782. Recreate the application once
    after propagation has settled instead of failing the whole deployment on
    that transient first-start race.
    """
    before = refreshed_failure_detail(expected_revision)
    print(
        "[Murikah Tutor] Expected image is present but port 3782 is still not "
        "ready; recycling the container application once after registry propagation."
    )
    if before:
        print("[Murikah Tutor] Pre-recycle readiness diagnostics:\n" + before)
    recycle_tutor_application()
    time.sleep(20)
    deploy(config_path=config_path)
    fresh, report, base = verify_fresh_runtime(expected_revision, timeout_seconds=180)
    if not fresh:
        detail = refreshed_failure_detail(expected_revision)
        raise RuntimeError(
            "Tutor readiness recovery recreated the application but the expected "
            f"image {expected_revision} did not become observable"
            + (f"\n{detail}" if detail else "")
        )
    status = wait_until_ready(base, timeout_seconds=300)
    validate_runtime_report(report)
    if status.get("ready") is not True or status.get("httpStatus") != 200:
        detail = refreshed_failure_detail(expected_revision)
        raise RuntimeError(
            "Tutor readiness recovery deployed the expected image but port 3782 "
            "still did not become healthy"
            + (f"\n{detail}" if detail else "")
        )
    return report, base

def main() -> int:
    expected_revision=source_revision()
    image_tag=prebuilt_image_tag(expected_revision)
    apply_persistence_migrations()
    deploy_config=prepare_deploy_config(image_tag,expected_revision)
    try:
        application_existed_before=bool(list_tutor_applications())

        deploy(config_path=deploy_config)

        # First verify the real application instance, not the isolated diagnostics
        # instance. Give Cloudflare a short window to switch a warm container to the
        # new image. If it stays stale or unknown, do one deterministic recreation.
        fresh,status,base=wait_for_runtime_revision(expected_revision,timeout_seconds=90)
        if not fresh:
            observed=str(status.get("imageRevision") or "").strip()
            print(
                "[Murikah Tutor] Main runtime did not switch to the deployed image "
                f"(observed {observed or 'unknown'}, expected {expected_revision})."
            )
            if application_existed_before:
                print(
                    "[Murikah Tutor] Recycling the stale/indeterminate container application once "
                    "so Cloudflare starts the deployed image cleanly."
                )
            else:
                print(
                    "[Murikah Tutor] Newly-created application did not expose the "
                    "deployed image; recreating it once after registry propagation."
                )
            recycle_tutor_application()
            time.sleep(15)
            deploy(config_path=deploy_config)
            fresh,status,base=wait_for_runtime_revision(expected_revision,timeout_seconds=180)
            if not fresh:
                observed=str(status.get("imageRevision") or "").strip()
                detail=refreshed_failure_detail(expected_revision)
                raise RuntimeError(
                    "Tutor application was recreated but the real runtime still did "
                    f"not expose image {expected_revision} (observed {observed or 'unknown'})"
                    +(f"\n{detail}" if detail else "")
                )

        # Image identity is now authoritative. Only then wait for application health.
        ready=wait_until_ready(base,timeout_seconds=300)
        if ready.get("ready") is not True or ready.get("httpStatus")!=200:
            # Refresh isolated diagnostics only for troubleshooting detail. Do not use
            # its temporarily-unknown image revision as the rollout authority.
            detail=refreshed_failure_detail(expected_revision)
            raise RuntimeError(
                f"Tutor runtime is on image {expected_revision} but did not become "
                "healthy on port 3782 within the readiness window"
                +(f"\n{detail}" if detail else "")
            )

        print(
            f"[Murikah Tutor] Deployment verified: main runtime image "
            f"{expected_revision}, port 3782 healthy."
        )
        return 0
    finally:
        GENERATED_CONFIG.unlink(missing_ok=True)

if __name__=="__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"Murikah Tutor deployment command failed with exit code {exc.returncode}.",file=sys.stderr)
        raise
