"""An editable synthetic source and evidence for its most recent receipt."""

import base64
import hashlib
from pathlib import Path
from uuid import uuid4

from .protocol import Problem, read_json

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "delivery-demo" / "reading.csv"
TEMPLATE = SOURCE.with_name("manifest.json")
NODE_KEY = "editable-transfer"
MAX_SOURCE_BYTES = 64 * 1024
CLOUD_RECEIPT = "cloud-transfer.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def last_version(results):
    for section in results["sections"]:
        for node in section["nodes"]:
            if node["node_key"] == NODE_KEY and section["section_key"] == "expression":
                return next((unit for unit in node["result_units"] if not unit["selectors"]), None)
    return None


def version_artifact(version):
    if version:
        for group in version["render_groups"]:
            item = group["sources"].get("data")
            if item and item["file_name"] == SOURCE.name:
                return item
    return None


def state(store, context):
    source = read_source(context["analysis_run_id"])
    run = context["analysis_run_id"]
    latest = last_version(store.results(context, include_history=False))
    receiver = None
    artifact = version_artifact(latest)
    if artifact:
        artifact_id = artifact["artifact_id"]
        stored = store.objects / artifact_id
        with stored.open("rb") as stream:
            data = stream.read(MAX_SOURCE_BYTES + 1)
        actual = digest(data) if len(data) <= MAX_SOURCE_BYTES else None
        receiver = {
            **artifact, "delivery_id": latest["delivery_id"], "revision": latest["revision"],
            "path": str(stored), "download": f"/api/v1/runs/{run}/artifacts/{artifact_id}",
            "preview": data[:4096].decode("utf-8", errors="replace"),
            "verified": actual == artifact["sha256"],
        }
    cloud_record = store.root / CLOUD_RECEIPT
    cloud = read_json(cloud_record.read_bytes()) if cloud_record.is_file() else None
    return {"source": source, "receiver": receiver, "cloud": cloud}


def read_source(run):
    try:
        with SOURCE.open("rb") as stream:
            data = stream.read(MAX_SOURCE_BYTES + 1)
    except OSError:
        raise Problem(404, "SOURCE_UNAVAILABLE", "Cannot read delivery-demo/reading.csv.") from None
    if len(data) > MAX_SOURCE_BYTES:
        raise Problem(413, "SOURCE_TOO_LARGE", "The editable sample is limited to 64 KiB.")
    try:
        preview = data.decode("utf-8")
    except UnicodeError:
        raise Problem(422, "SOURCE_ENCODING", "Save the CSV as UTF-8.") from None
    document = read_json(TEMPLATE.read_bytes())
    sha256 = digest(data)
    document.update(analysis_run_id=run, delivery_id=f"EDIT-{uuid4()}")
    document["artifacts"][0].update(size_bytes=len(data), sha256=sha256)
    return {
        "path": str(SOURCE), "name": SOURCE.name, "size_bytes": len(data), "sha256": sha256,
        "base64": base64.b64encode(data).decode("ascii"), "preview": preview, "manifest": document,
    }
