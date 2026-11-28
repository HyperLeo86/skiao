"""Archive the last accepted editable-demo file in a private GitHub repository."""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import quote, urlsplit

import requests
from .editable import CLOUD_RECEIPT, digest
from .storage import fsync_dir


def github(method, route, body=None, *, allow_missing=False):
    command = ["gh", "api", "--hostname", "github.com", "--method", method, route]
    if body is not None:
        command.extend(["--input", "-"])
    result = subprocess.run(
        command, input=json.dumps(body) if body is not None else None,
        text=True, capture_output=True, timeout=45,
    )
    if result.returncode:
        if re.search(r"\(HTTP 401\)", result.stderr):
            raise ValueError("GitHub CLI returned HTTP 401. Authenticate with GitHub before archiving.")
        if allow_missing and re.search(r"\(HTTP 404\)", result.stderr):
            return None
        message = re.search(r"\(HTTP [0-9]{3}\)", result.stderr)
        suffix = " " + message.group() if message else ""
        raise ValueError("GitHub request failed" + suffix + ". Check the repository and write access.")
    return json.loads(result.stdout)


def receive_copy(base_url):
    base = urlsplit(base_url)
    if (base.scheme != "http" or base.hostname not in {"127.0.0.1", "localhost", "::1"}
            or base.username or base.password or base.path or base.query or base.fragment):
        raise ValueError("Use the local demo URL, such as http://127.0.0.1:18765.")
    with requests.Session() as client:
        client.trust_env = False
        session = client.get(base_url + "/demo/session", headers={"X-SkyAO-Demo": "test-console"},
                             timeout=10, allow_redirects=False)
        session.raise_for_status()
        headers = {"Authorization": "Bearer " + session.json()["token"]}
        response = client.get(base_url + "/demo/transfer/state", headers=headers, timeout=10, allow_redirects=False)
        response.raise_for_status()
        state = response.json()
        item = state["receiver"]
        if not item or not item["verified"] or item["sha256"] != state["source"]["sha256"]:
            raise ValueError("Send the current CSV to the receiver before archiving it.")
        stored = client.get(base_url + item["download"], headers=headers, timeout=10, allow_redirects=False)
        stored.raise_for_status()
        if digest(stored.content) != item["sha256"]:
            raise ValueError("The downloaded receiver file does not match its SHA-256.")
        return item, stored.content


def archive(repo, item, data):
    details = github("GET", f"repos/{repo}")
    if not details["private"]:
        raise ValueError("Choose a private GitHub repository for this demo.")
    branch = details["default_branch"]
    file_path = f"deliveries/{item['delivery_id']}/{item['file_name']}"
    route = f"repos/{repo}/contents/{file_path}"
    existing = github("GET", route, allow_missing=True)
    if existing:
        commit = github("GET", f"repos/{repo}/git/ref/heads/{quote(branch, safe='/')}")["object"]["sha"]
    else:
        result = github("PUT", route, {
            "message": f"Archive accepted SkyAO delivery {item['delivery_id']}",
            "content": base64.b64encode(data).decode("ascii"),
            "branch": branch,
        })
        commit = result["commit"]["sha"]
    saved = github("GET", f"{route}?ref={commit}")
    if base64.b64decode(saved["content"]) != data:
        raise ValueError("GitHub read-back did not match the receiver's file.")
    return {
        "repo": repo, "delivery_id": item["delivery_id"], "file_path": file_path,
        "sha256": item["sha256"], "commit": commit,
        "file_url": f"https://github.com/{repo}/blob/{commit}/{file_path}",
    }


def write_receipt(directory, record):
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as output:
        path = Path(output.name)
        try:
            json.dump(record, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            output.close()
            path.replace(directory / CLOUD_RECEIPT)
            fsync_dir(directory)
        finally:
            path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="private GitHub repository in owner/name form")
    parser.add_argument("--base-url", default="http://127.0.0.1:18765")
    parser.add_argument("--data-dir", type=Path, default=Path(".sky-demo"))
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+", args.repo):
        parser.error("Expected --repo owner/name.")
    try:
        item, data = receive_copy(args.base_url)
        if Path(item["path"]).parent.parent != args.data_dir.resolve():
            raise ValueError("Use the same --data-dir as the running test receiver.")
        record = archive(args.repo, item, data)
        write_receipt(args.data_dir, record)
    except (ValueError, OSError, requests.RequestException, subprocess.SubprocessError) as error:
        print(error, file=sys.stderr)
        return 1
    print(record["file_url"])
    print("SHA-256 " + record["sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
