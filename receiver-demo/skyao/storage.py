"""SQLite results and independently durable, server-addressed artifact files."""

import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .protocol import DIMENSIONS, RENDERERS, Problem, canonical

DDL = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    context TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs,
    section_key TEXT NOT NULL,
    node_key TEXT NOT NULL,
    title TEXT NOT NULL,
    sort_order TEXT NOT NULL,
    selector_keys TEXT NOT NULL,
    UNIQUE (run_id, section_key, node_key)
);
CREATE TABLE IF NOT EXISTS deliveries (
    run_id TEXT NOT NULL REFERENCES runs,
    delivery_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    manifest TEXT NOT NULL,
    receipt TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    PRIMARY KEY (run_id, delivery_id)
);
CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES nodes,
    selectors TEXT NOT NULL,
    current_version_id INTEGER REFERENCES versions,
    UNIQUE (node_id, selectors)
);
CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY,
    unit_id INTEGER NOT NULL REFERENCES units,
    revision INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    render_groups TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (unit_id, revision),
    FOREIGN KEY (run_id, delivery_id) REFERENCES deliveries
);
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    UNIQUE (run_id, delivery_id, file_name),
    FOREIGN KEY (run_id, delivery_id) REFERENCES deliveries
);
"""


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Store:
    def __init__(self, directory):
        self.root = Path(directory).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.objects = self.root / "objects"
        self.staging = self.root / "staging"
        for subdir in (self.objects, self.staging):
            subdir.mkdir(exist_ok=True, mode=0o700)
        fsync_dir(self.root)
        fsync_dir(self.root.parent)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(DDL)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.root / "receiver.sqlite3", timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA synchronous = FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def seed(self, context):
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO runs VALUES (?, ?)", (context["analysis_run_id"], canonical(context)))

    def context(self, run):
        with self.connect() as db:
            row = db.execute("SELECT context FROM runs WHERE run_id = ?", (run,)).fetchone()
            return json.loads(row["context"]) if row else None

    def receipt(self, run, delivery):
        with self.connect() as db:
            row = db.execute("SELECT receipt FROM deliveries WHERE run_id = ? AND delivery_id = ?", (run, delivery)).fetchone()
            return json.loads(row["receipt"]) if row else None

    def artifact(self, run, artifact_id):
        with self.connect() as db:
            return db.execute("SELECT * FROM artifacts WHERE run_id = ? AND id = ?", (run, artifact_id)).fetchone()

    def commit(self, doc, selector_keys, uploads):
        run, delivery, section, node = (
            doc["analysis_run_id"], doc["delivery_id"], doc["section_key"], doc["node_key"]
        )
        manifest = canonical(doc)
        digest = hashlib.sha256(manifest.encode()).hexdigest()
        timestamp = datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT fingerprint, receipt FROM deliveries WHERE run_id = ? AND delivery_id = ?",
                (run, delivery),
            ).fetchone()
            if existing:
                if digest != existing["fingerprint"]:
                    raise Problem(409, "DELIVERY_CONFLICT", "delivery_id already belongs to a different manifest.")
                return {**json.loads(existing["receipt"]), "replayed": True}, 200

            node_id = self.ensure_node(db, doc, selector_keys)
            receipt = {
                "status": "accepted", "analysis_run_id": run, "delivery_id": delivery,
                "section_key": section, "node_key": node, "replayed": False, "accepted_units": [],
            }
            db.execute("INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?)",
                       (run, delivery, digest, manifest, "{}", timestamp))
            artifacts = {}
            for name, upload in uploads.items():
                artifact_id = uuid4().hex
                # link fails if a destination exists and leaves the staged source
                # available for request cleanup. Staging and objects share a volume.
                os.link(upload.path, self.objects / artifact_id)
                db.execute("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)",
                           (artifact_id, run, delivery, name, upload.size, upload.sha256))
                artifacts[name] = {
                    "artifact_id": artifact_id, "file_name": name,
                    "size_bytes": upload.size, "sha256": upload.sha256,
                }
            fsync_dir(self.objects)
            for unit in doc["result_units"]:
                revision = self.append_version(db, node_id, unit, artifacts, run, delivery, timestamp)
                receipt["accepted_units"].append({"selectors": unit["selectors"], "revision": revision})
            db.execute("UPDATE deliveries SET receipt = ? WHERE run_id = ? AND delivery_id = ?",
                       (canonical(receipt), run, delivery))
            return receipt, 201

    @staticmethod
    def ensure_node(db, doc, keys):
        identity = (doc["analysis_run_id"], doc["section_key"], doc["node_key"])
        metadata = (doc["node_title"], str(doc["sort_order"]), canonical(keys))
        row = db.execute(
            "SELECT * FROM nodes WHERE run_id = ? AND section_key = ? AND node_key = ?", identity
        ).fetchone()
        if row:
            if (row["title"], row["sort_order"], row["selector_keys"]) != metadata:
                raise Problem(409, "NODE_CONFLICT", "Node title, order, or selector keys differ from the registered node.")
            return row["id"]
        return db.execute(
            "INSERT INTO nodes (run_id, section_key, node_key, title, sort_order, selector_keys) VALUES (?, ?, ?, ?, ?, ?)",
            (*identity, *metadata),
        ).lastrowid

    @staticmethod
    def append_version(db, node_id, unit, artifacts, run, delivery, timestamp):
        selectors = canonical(unit["selectors"])
        row = db.execute(
            """SELECT u.id, v.revision FROM units u
               JOIN versions v ON v.id = u.current_version_id
               WHERE u.node_id = ? AND u.selectors = ?""", (node_id, selectors)
        ).fetchone()
        if row:
            unit_id, revision = row["id"], row["revision"] + 1
        else:
            unit_id = db.execute(
                "INSERT INTO units (node_id, selectors) VALUES (?, ?)", (node_id, selectors)
            ).lastrowid
            revision = 1
        groups = [
            {
                "render_types": group["render_types"],
                "editable": group["editable"],
                "can_edit": {key: group["editable"] and RENDERERS[key][2] for key in group["render_types"]},
                "sources": {role: artifacts[name] for role, name in group["sources"].items()},
            }
            for group in unit["render_groups"]
        ]
        version_id = db.execute(
            """INSERT INTO versions (unit_id, revision, run_id, delivery_id, render_groups, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""", (unit_id, revision, run, delivery, canonical(groups), timestamp)
        ).lastrowid
        db.execute("UPDATE units SET current_version_id = ? WHERE id = ?", (version_id, unit_id))
        return revision

    def results(self, context, include_history):
        run = context["analysis_run_id"]
        sections = []
        with self.connect() as db:
            db.execute("BEGIN")
            for section, metadata in sorted(context["sections"].items(), key=lambda item: (item[1]["order"], item[0])):
                nodes = []
                for node in db.execute(
                    """SELECT * FROM nodes WHERE run_id = ? AND section_key = ?
                       ORDER BY length(sort_order), sort_order, node_key""", (run, section)
                ):
                    units = []
                    for row in db.execute(
                        """SELECT u.selectors, u.id as unit_id, v.* FROM units u
                           JOIN versions v ON v.id = u.current_version_id WHERE u.node_id = ?
                           ORDER BY u.selectors""", (node["id"],)
                    ):
                        unit = {"selectors": json.loads(row["selectors"]), **version_json(row)}
                        if include_history:
                            unit["history"] = [
                                version_json(version) for version in db.execute(
                                    "SELECT * FROM versions WHERE unit_id = ? ORDER BY revision DESC",
                                    (row["unit_id"],),
                                )
                            ]
                        units.append(unit)
                    nodes.append({
                        "node_key": node["node_key"], "node_title": node["title"],
                        "sort_order": int(node["sort_order"]), "selector_keys": json.loads(node["selector_keys"]),
                        "result_units": units,
                    })
                if nodes:
                    sections.append({"section_key": section, **metadata, "nodes": nodes})
        return {
            "analysis_run_id": run, "sections": sections,
            "dimensions": {
                key: {"title": title, "values": context[field]} for key, (title, field) in DIMENSIONS.items()
            },
            "renderers": {key: {"title": title} for key, (title, _, _) in RENDERERS.items()},
        }


def version_json(row):
    return {
        "revision": row["revision"], "delivery_id": row["delivery_id"],
        "created_at": row["created_at"], "render_groups": json.loads(row["render_groups"]),
    }
