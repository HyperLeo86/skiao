"""skyctl: submit, retry or inspect a durable local SkyAO delivery."""

import argparse
import fcntl
import json
import os
import re
import stat
import sys
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from time import monotonic, sleep, time
from urllib.parse import urlsplit
from uuid import uuid4

import requests
from requests_toolbelt.multipart.encoder import MultipartEncoder

from .protocol import Problem, canonical, check_file, fingerprint_file, identifier, read_json, validate_manifest
from .storage import fsync_dir

RETRY_STATUS = {408, 429}


def state_write(directory, state):
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, prefix=".state-", delete=False) as stream:
        path = Path(stream.name)
        try:
            stream.write(canonical(state) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
            os.replace(path, directory / "state.json")
            fsync_dir(directory)
        finally:
            path.unlink(missing_ok=True)


def write_snapshot(path, data):
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


@contextmanager
def lock_delivery(run_dir, delivery):
    locks = run_dir / "locks"
    packages = run_dir / "packages"
    for directory in (locks, packages):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fsync_dir(run_dir)
    fsync_dir(run_dir.parent)
    with (locks / delivery).open("ab") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        yield packages / delivery


@contextmanager
def source_file(directory_fd, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    except OSError:
        raise Problem(422, "LOCAL_FILE_UNAVAILABLE", f"Cannot safely open {name}.") from None
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise Problem(422, "LOCAL_FILE_UNAVAILABLE", f"{name} must be a regular file.")
        yield stream


def snapshot(doc, files_dir, destination):
    with TemporaryDirectory(dir=destination.parent, prefix="package-") as temporary:
        draft = Path(temporary) / "snapshot"
        draft.mkdir()
        file_store = draft / "files"
        file_store.mkdir()
        try:
            directory_fd = os.open(files_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError:
            raise Problem(422, "LOCAL_FILES_DIR", "The requested files directory is unavailable or a symlink.") from None
        try:
            for artifact in doc["artifacts"]:
                name = artifact["file_name"]
                with source_file(directory_fd, name) as source, (file_store / name).open("xb") as target:
                    size, digest = fingerprint_file(source, target)
                    target.flush()
                    os.fsync(target.fileno())
                check_file(artifact, size, digest)
                artifact.update(size_bytes=size, sha256=digest)
        finally:
            os.close(directory_fd)
        validate_manifest(doc)
        if destination.exists():
            previous = read_json((destination / "manifest.json").read_bytes())
            if canonical(previous) != canonical(doc):
                raise Problem(409, "LOCAL_DELIVERY_CONFLICT", "This delivery ID already has a different local snapshot.")
            if not (destination / "files").exists():
                fsync_dir(file_store)
                os.rename(file_store, destination / "files")
                fsync_dir(destination)
            return
        write_snapshot(draft / "manifest.json", canonical(doc).encode())
        state_write(draft, {"status": "pending", "attempts": 0})
        fsync_dir(file_store)
        fsync_dir(draft)
        os.rename(draft, destination)
        fsync_dir(destination.parent)


def transport():
    url = os.environ.get("SKYAO_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
    parsed = urlsplit(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname or (
        parsed.scheme != "https" and (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"})
    ):
        raise Problem(400, "INVALID_BASE_URL", "Use HTTPS or local loopback HTTP for SKYAO_BASE_URL.")
    token = os.environ.get("SKYAO_TOKEN", "")
    if not token or not token.isascii() or any(character.isspace() for character in token):
        raise Problem(401, "TOKEN_REQUIRED", "Set a valid SKYAO_TOKEN in the environment.")
    return url + "/api/v1/deliveries", {"Authorization": f"Bearer {token}"}


def receipt_matches(body, doc):
    if not isinstance(body, dict) or body.get("status") != "accepted":
        return False
    if any(body.get(key) != doc[key] for key in ("analysis_run_id", "delivery_id", "section_key", "node_key")):
        return False
    units = body.get("accepted_units")
    if not isinstance(units, list) or len(units) != len(doc["result_units"]):
        return False
    return all(
        isinstance(item, dict) and item.get("selectors") == unit["selectors"]
        and type(item.get("revision")) is int and item["revision"] > 0
        for item, unit in zip(units, doc["result_units"])
    )


def retry_delay(response, attempt):
    if response is not None and (value := response.headers.get("Retry-After")):
        from email.utils import parsedate_to_datetime

        try:
            if value.isdecimal():
                return int(value)
            return max(0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            pass
    return 2**attempt


def log_event(doc, status, started, *, attempt, code=None):
    event = {
        "run_id": doc["analysis_run_id"], "delivery_id": doc["delivery_id"],
        "node_key": doc["node_key"], "status": status,
        "attempt": attempt, "elapsed_ms": int((monotonic() - started) * 1000),
    }
    if code:
        event["code"] = code
    print(canonical(event), file=sys.stderr)


def upload(directory, doc, max_attempts):
    started = monotonic()
    state = read_json((directory / "state.json").read_bytes())
    previous = state["attempts"]
    remembered = {"receipt": state["receipt"]} if "receipt" in state else {}
    try:
        url, headers = transport()
        with ExitStack() as opened:
            uploads = []
            directory_fd = os.open(directory / "files", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            opened.callback(os.close, directory_fd)
            for artifact in doc["artifacts"]:
                name = artifact["file_name"]
                stream = opened.enter_context(source_file(directory_fd, name))
                check_file(artifact, *fingerprint_file(stream))
                uploads.append(("files", (name, stream, "application/octet-stream")))
            session = opened.enter_context(requests.Session())
            session.trust_env = False
            for attempt in range(max_attempts):
                for _, (_, stream, _) in uploads:
                    stream.seek(0)
                payload = MultipartEncoder(fields=[("manifest", canonical(doc)), *uploads])
                count = previous + attempt + 1
                state_write(directory, {**remembered, "status": "uploading", "attempts": count})
                response = None
                code = "NETWORK_ERROR"
                transient = True
                try:
                    response = session.post(
                        url, headers={**headers, "Content-Type": payload.content_type},
                        data=payload, timeout=(3, 30), allow_redirects=False,
                    )
                    status = response.status_code
                    try:
                        body = response.json()
                    except ValueError:
                        body = {}
                    if status in {200, 201} and receipt_matches(body, doc):
                        state_write(directory, {
                            "status": "accepted", "attempts": count,
                            "http_status": status, "receipt": body,
                        })
                        log_event(doc, "accepted", started, attempt=count)
                        print(json.dumps(body, ensure_ascii=False))
                        return 0
                    transient = status in RETRY_STATUS or status >= 500 or status in {200, 201}
                    error = body.get("error", {}) if isinstance(body, dict) else {}
                    candidate = error.get("code") if isinstance(error, dict) else None
                    code = candidate if isinstance(candidate, str) and re.fullmatch(r"[A-Z_]{1,64}", candidate) else f"HTTP_{status}"
                    if status in {200, 201}:
                        code = "INVALID_RECEIPT"
                except requests.RequestException:
                    pass
                phase = "failed_retryable" if transient else "failed_permanent"
                if transient and attempt + 1 < max_attempts:
                    delay = retry_delay(response, attempt)
                    # Preserve a manual retry for servers that ask for a long pause.
                    if delay <= 30:
                        log_event(doc, "retrying", started, attempt=count, code=code)
                        sleep(delay)
                        continue
                result = {**remembered, "status": phase, "attempts": count, "code": code}
                if response is not None:
                    result["http_status"] = response.status_code
                state_write(directory, result)
                log_event(doc, phase, started, attempt=count, code=code)
                return 1
    except Problem as error:
        state_write(directory, {**remembered, "status": "failed_permanent", "attempts": previous, "code": error.code})
        log_event(doc, "failed_permanent", started, attempt=previous, code=error.code)
        return 1


def prune(root, days):
    if days < 0:
        raise Problem(400, "INVALID_RETENTION", "Retention in days must be nonnegative.")
    deadline = time() - days * 86400
    pruned = 0
    for run_dir in root.iterdir():
        locks = run_dir / "locks"
        if not locks.is_dir():
            continue
        for lock in locks.iterdir():
            with lock_delivery(run_dir, lock.name) as directory:
                status = directory / "state.json"
                files = directory / "files"
                if not status.is_file() or not files.is_dir() or status.stat().st_mtime > deadline:
                    continue
                if read_json(status.read_bytes())["status"] != "accepted":
                    continue
                with TemporaryDirectory(dir=directory.parent, prefix="pruned-") as trash:
                    os.rename(files, Path(trash) / "files")
                    fsync_dir(directory)
                pruned += 1
    print(canonical({"pruned": pruned, "older_than_days": days}))
    return 0


def main():
    parser = argparse.ArgumentParser(prog="skyctl", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    send = commands.add_parser("send")
    send.add_argument("--manifest", type=Path, required=True)
    send.add_argument("--files-dir", type=Path, required=True)
    for command in ("retry", "status"):
        sub = commands.add_parser(command)
        sub.add_argument("--run-id", required=True)
        sub.add_argument("--delivery-id", required=True)
    cleanup = commands.add_parser("prune", help="remove files from accepted snapshots, retaining receipts")
    cleanup.add_argument("--older-than-days", type=int, required=True)
    args = parser.parse_args()
    doc = None
    try:
        root = Path(os.environ.get("SKYAO_SPOOL_DIR", ".sky-client")).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if args.command == "prune":
            return prune(root, args.older_than_days)
        if args.command == "send":
            doc = read_json(args.manifest.read_bytes())
            validate_manifest(doc, draft=True)
            run = doc["analysis_run_id"]
            delivery = doc.setdefault("delivery_id", str(uuid4()))
        else:
            run = identifier(args.run_id, "run_id")
            delivery = identifier(args.delivery_id, "delivery_id")
        with lock_delivery(root / run, delivery) as directory:
            if args.command == "send":
                snapshot(doc, args.files_dir, directory)
            if not directory.exists():
                raise Problem(404, "LOCAL_DELIVERY_NOT_FOUND", "No saved snapshot for this run and delivery ID.")
            doc = read_json((directory / "manifest.json").read_bytes())
            validate_manifest(doc)
            if args.command == "status":
                state = read_json((directory / "state.json").read_bytes())
                print(json.dumps({
                    "analysis_run_id": run, "delivery_id": delivery,
                    "files_pruned": not (directory / "files").is_dir(), **state,
                }, ensure_ascii=False))
                return 0
            if not (directory / "files").is_dir():
                raise Problem(409, "LOCAL_SNAPSHOT_PRUNED", "The accepted snapshot was pruned. The receipt remains available in status.")
            attempts = int(os.environ.get("SKYAO_MAX_ATTEMPTS", "4"))
            if attempts < 1:
                raise Problem(400, "INVALID_ATTEMPTS", "SKYAO_MAX_ATTEMPTS must be positive.")
            return upload(directory, doc, attempts)
    except (Problem, OSError, ValueError) as error:
        failure = error if isinstance(error, Problem) else Problem(400, "LOCAL_IO", "Could not read or write local data or configuration.")
        print(canonical(failure.body()), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
