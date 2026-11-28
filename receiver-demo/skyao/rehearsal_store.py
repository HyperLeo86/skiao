"""Project-scoped SQLite records for the V0.3 rehearsal and its drawing worker."""

import fcntl
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock, Thread
from uuid import uuid4

from .protocol import Problem, canonical, fingerprint_file
from .rehearsal_materials import plot_image, scopes
from .rehearsal_protocol import selector_key
from .storage import fsync_dir

DDL = """
CREATE TABLE IF NOT EXISTS rehearsal_projects (
    id TEXT PRIMARY KEY,
    analysis_run_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    flow_name TEXT NOT NULL,
    flow_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rehearsal_access (
    project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects,
    browser_digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rehearsal_access_browser ON rehearsal_access(browser_digest);
CREATE TABLE IF NOT EXISTS rehearsal_nodes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES rehearsal_projects,
    section_id TEXT NOT NULL,
    section_title TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_version INTEGER NOT NULL,
    node_title TEXT NOT NULL,
    position INTEGER NOT NULL,
    definition TEXT NOT NULL,
    UNIQUE(project_id, position)
);
CREATE TABLE IF NOT EXISTS rehearsal_deliveries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES rehearsal_projects,
    project_node_id TEXT NOT NULL REFERENCES rehearsal_nodes,
    fingerprint TEXT NOT NULL,
    manifest TEXT NOT NULL,
    status TEXT NOT NULL,
    accepted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rehearsal_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES rehearsal_projects,
    delivery_id TEXT NOT NULL REFERENCES rehearsal_deliveries,
    file_name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    media_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rehearsal_slots (
    id TEXT PRIMARY KEY,
    project_node_id TEXT NOT NULL REFERENCES rehearsal_nodes,
    result_item_id TEXT NOT NULL,
    result_name TEXT NOT NULL,
    type TEXT NOT NULL,
    selectors TEXT NOT NULL,
    status TEXT NOT NULL,
    current_version_id TEXT REFERENCES rehearsal_versions,
    plot_id TEXT REFERENCES rehearsal_plots,
    updated_delivery_id TEXT REFERENCES rehearsal_deliveries,
    UNIQUE(project_node_id, selectors, result_item_id)
);
CREATE TABLE IF NOT EXISTS rehearsal_versions (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL REFERENCES rehearsal_slots,
    revision INTEGER NOT NULL,
    file_id TEXT NOT NULL REFERENCES rehearsal_files,
    delivery_id TEXT NOT NULL REFERENCES rehearsal_deliveries,
    created_at TEXT NOT NULL,
    UNIQUE(slot_id, revision)
);
CREATE TABLE IF NOT EXISTS rehearsal_plots (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL REFERENCES rehearsal_slots,
    delivery_id TEXT NOT NULL REFERENCES rehearsal_deliveries,
    script TEXT NOT NULL,
    inputs TEXT NOT NULL,
    parameters TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    output_file_id TEXT REFERENCES rehearsal_files,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS rehearsal_slot_node ON rehearsal_slots(project_node_id);
CREATE INDEX IF NOT EXISTS rehearsal_versions_delivery ON rehearsal_versions(delivery_id);
CREATE INDEX IF NOT EXISTS rehearsal_files_project ON rehearsal_files(project_id);
CREATE INDEX IF NOT EXISTS rehearsal_plots_status ON rehearsal_plots(status);
"""

TABLES = {
    "rehearsal_projects": "项目", "rehearsal_nodes": "项目节点", "rehearsal_deliveries": "投送记录",
    "rehearsal_slots": "结果位置", "rehearsal_versions": "结果版本", "rehearsal_files": "文件记录",
    "rehearsal_plots": "绘图操作",
}
JSON_COLUMNS = {"definition", "manifest", "selectors", "inputs", "parameters"}


def new_id(prefix):
    return prefix + "-" + uuid4().hex


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def unpack(row):
    return {key: json.loads(value) if key in JSON_COLUMNS and value is not None else value for key, value in dict(row).items()}


class RehearsalStore:
    def __init__(self, store):
        self.store = store
        self.objects = store.root / "rehearsal_objects"
        self.objects.mkdir(exist_ok=True, mode=0o700)
        fsync_dir(store.root)
        self.worker_guard = Lock()
        self.worker = None
        with store.connect() as db:
            db.executescript(DDL)
        self.kick()

    def projects(self, owner=None):
        with self.store.connect() as db:
            if owner is None:
                rows = db.execute("SELECT * FROM rehearsal_projects ORDER BY created_at DESC, id")
            else:
                rows = db.execute("""SELECT p.* FROM rehearsal_projects p JOIN rehearsal_access a ON p.id=a.project_id
                                   WHERE a.browser_digest=? ORDER BY p.created_at DESC,p.id""", (owner,))
            return [dict(row) for row in rows]

    def authorize_project(self, project, owner):
        if owner is None:
            return
        with self.store.connect() as db:
            row = db.execute("SELECT 1 FROM rehearsal_access WHERE project_id=? AND browser_digest=?", (project, owner)).fetchone()
        if not row:
            raise Problem(404, "NOT_FOUND", "找不到该浏览器创建的演练项目。")

    def create(self, name, flow, nodes, owner=None):
        timestamp = now()
        project = dict(id=new_id("P"), analysis_run_id=new_id("RUN"), name=name, flow_id=flow["id"],
                       flow_name=flow["name"], flow_version=flow["version"], created_at=timestamp)
        with self.store.connect() as db:
            db.execute("INSERT INTO rehearsal_projects VALUES (:id,:analysis_run_id,:name,:flow_id,:flow_name,:flow_version,:created_at)", project)
            if owner is not None:
                db.execute("INSERT INTO rehearsal_access VALUES (?,?)", (project["id"], owner))
            for position, template in enumerate(nodes, 1):
                node = new_id("PN")
                db.execute("INSERT INTO rehearsal_nodes VALUES (?,?,?,?,?,?,?,?,?,?)",
                           (node, project["id"], template["section_id"], template["section_title"], template["entry_id"],
                            template["node_id"], template["node_version"], template["node_title"], position, canonical(template)))
                rows = [(new_id("S"), node, spec["id"], spec["name"], spec["type"], selector_key(selector), "empty")
                        for selector in scopes(template["selectors"]) for spec in template["results"]]
                db.executemany("""INSERT INTO rehearsal_slots
                    (id,project_node_id,result_item_id,result_name,type,selectors,status) VALUES (?,?,?,?,?,?,?)""", rows)
        return project

    @staticmethod
    def must(row, message):
        if row is None:
            raise Problem(404, "NOT_FOUND", message)
        return unpack(row)

    def target(self, run, node):
        with self.store.connect() as db:
            return self.must(db.execute("""SELECT n.* FROM rehearsal_nodes n JOIN rehearsal_projects p ON p.id=n.project_id
                                        WHERE n.id=? AND p.analysis_run_id=?""", (node, run)).fetchone(),
                             "投递目标与项目运行编号不匹配。")

    def project(self, project, node=None):
        with self.store.connect() as db:
            db.execute("BEGIN")
            record = self.must(db.execute("SELECT * FROM rehearsal_projects WHERE id=?", (project,)).fetchone(), "找不到演练项目。")
            nodes = [unpack(row) for row in db.execute("SELECT * FROM rehearsal_nodes WHERE project_id=? ORDER BY position", (project,))]
        if node:
            nodes = [item for item in nodes if item["id"] == node]
            if not nodes:
                raise Problem(404, "NOT_FOUND", "找不到该项目中的节点。")
        return record, nodes

    def file(self, project, file_id):
        with self.store.connect() as db:
            return self.must(db.execute("SELECT * FROM rehearsal_files WHERE project_id=? AND id=?", (project, file_id)).fetchone(),
                             "找不到该项目中的文件。")

    def database(self, project):
        with self.store.connect() as db:
            db.execute("BEGIN")
            self.must(db.execute("SELECT * FROM rehearsal_projects WHERE id=?", (project,)).fetchone(), "找不到演练项目。")
            queries = {
                "rehearsal_projects": "SELECT * FROM rehearsal_projects WHERE id=?",
                "rehearsal_nodes": "SELECT * FROM rehearsal_nodes WHERE project_id=? ORDER BY position",
                "rehearsal_deliveries": "SELECT * FROM rehearsal_deliveries WHERE project_id=? ORDER BY rowid DESC",
                "rehearsal_slots": """SELECT s.* FROM rehearsal_slots s JOIN rehearsal_nodes n ON n.id=s.project_node_id
                                     WHERE n.project_id=? ORDER BY n.position,s.rowid""",
                "rehearsal_versions": """SELECT v.* FROM rehearsal_versions v JOIN rehearsal_slots s ON s.id=v.slot_id
                                        JOIN rehearsal_nodes n ON n.id=s.project_node_id WHERE n.project_id=? ORDER BY v.rowid DESC""",
                "rehearsal_files": "SELECT * FROM rehearsal_files WHERE project_id=? ORDER BY rowid DESC",
                "rehearsal_plots": """SELECT j.* FROM rehearsal_plots j JOIN rehearsal_slots s ON s.id=j.slot_id
                                     JOIN rehearsal_nodes n ON n.id=s.project_node_id WHERE n.project_id=? ORDER BY j.rowid DESC""",
            }
            result = {table: [unpack(row) for row in db.execute(query, (project,))] for table, query in queries.items()}
        if any(job["status"] in {"queued", "running"} for job in result["rehearsal_plots"]):
            self.kick()
        return result

    def commit(self, node, doc, uploads):
        delivery = doc["delivery_id"]
        fingerprint = hashlib.sha256(canonical(doc).encode()).hexdigest()
        timestamp, project = now(), node["project_id"]
        specs = {item["id"]: item for item in node["definition"]["results"]}
        created = []
        replayed = False
        try:
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT fingerprint,project_id FROM rehearsal_deliveries WHERE id=?", (delivery,)).fetchone()
                if existing:
                    if existing["fingerprint"] != fingerprint or existing["project_id"] != project:
                        raise Problem(409, "DELIVERY_CONFLICT", "投送编号已用于不同内容，请生成新的投送编号。")
                    replayed = True
                else:
                    db.execute("INSERT INTO rehearsal_deliveries VALUES (?,?,?,?,?,?,?)",
                               (delivery, project, node["id"], fingerprint, canonical(doc), "accepted", timestamp))
                    for unit in doc["result_units"]:
                        scope = selector_key(unit["selectors"])
                        slots = {row["result_item_id"]: dict(row) for row in db.execute(
                            "SELECT * FROM rehearsal_slots WHERE project_node_id=? AND selectors=?", (node["id"], scope))}
                        changed = set()
                        for item in unit["result_items"]:
                            result = item["result_item_id"]
                            slot = slots[result]
                            name = item["sources"]["data"]
                            upload = uploads[name]
                            media = "text/csv" if specs[result]["type"] == "table" else "image/png"
                            file_id = self._add_file(db, created, project, delivery, name, upload.path,
                                                     upload.size, upload.sha256, media, "upload", timestamp)
                            version = self._append(db, slot["id"], file_id, delivery, timestamp)
                            db.execute("""UPDATE rehearsal_slots SET status='received',current_version_id=?,
                                          updated_delivery_id=? WHERE id=?""", (version, delivery, slot["id"]))
                            slot.update(file_id=file_id, current_version_id=version)
                            changed.add(result)
                        for spec in specs.values():
                            if spec["type"] == "render" and changed.intersection(spec["inputs"].values()):
                                self._schedule(db, slots, spec, delivery, timestamp)
                    fsync_dir(self.objects)
        except BaseException:
            for path in created:
                path.unlink(missing_ok=True)
            raise
        self.kick()
        return self.receipt(project, delivery, replayed), 200 if replayed else 201

    def _add_file(self, db, created, project, delivery, name, path, size, digest, media, kind, timestamp):
        id_ = new_id("FILE")
        destination = self.objects / id_
        os.link(path, destination)
        created.append(destination)
        db.execute("INSERT INTO rehearsal_files VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (id_, project, delivery, name, size, digest, media, kind, f"rehearsal_objects/{id_}", timestamp))
        return id_

    @staticmethod
    def _append(db, slot, file_id, delivery, timestamp):
        revision = db.execute("SELECT COALESCE(MAX(revision),0)+1 FROM rehearsal_versions WHERE slot_id=?", (slot,)).fetchone()[0]
        version = new_id("RV")
        db.execute("INSERT INTO rehearsal_versions VALUES (?,?,?,?,?,?)", (version, slot, revision, file_id, delivery, timestamp))
        return version

    @staticmethod
    def _schedule(db, slots, spec, delivery, timestamp):
        inputs, missing = {}, []
        for role, item in spec["inputs"].items():
            source = slots[item]
            version = source["current_version_id"]
            if not version:
                missing.append(item)
                continue
            file_id = source.get("file_id") or db.execute("SELECT file_id FROM rehearsal_versions WHERE id=?", (version,)).fetchone()[0]
            inputs[role] = {"result_item_id": item, "version_id": version, "file_id": file_id}
        job = new_id("DRAW")
        status = "waiting" if missing else "queued"
        message = "等待结果项 " + "、".join(missing) if missing else None
        params = {"format": "png", "mode": "supplied_coordinates" if spec["script"] == "pca" else "supplied_matrix"}
        db.execute("INSERT INTO rehearsal_plots VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   (job, slots[spec["id"]]["id"], delivery, spec["script"], canonical(inputs), canonical(params),
                    status, message, None, timestamp, None, None))
        db.execute("""UPDATE rehearsal_slots SET status=?,current_version_id=NULL,plot_id=?,updated_delivery_id=?
                      WHERE id=?""", (status, job, delivery, slots[spec["id"]]["id"]))

    def receipt(self, project, delivery, replayed=False):
        with self.store.connect() as db:
            db.execute("BEGIN")
            record = self.must(db.execute("SELECT * FROM rehearsal_deliveries WHERE project_id=? AND id=?", (project, delivery)).fetchone(),
                               "找不到该项目中的投送回执。")
            results = db.execute("""SELECT v.id version_id,v.revision,f.id file_id,f.file_name,s.id slot_id,
                    s.result_item_id,s.result_name,s.selectors,f.size_bytes,f.sha256
                FROM rehearsal_versions v JOIN rehearsal_files f ON f.id=v.file_id
                JOIN rehearsal_slots s ON s.id=v.slot_id WHERE v.delivery_id=? AND f.kind='upload' ORDER BY v.rowid""", (delivery,))
            jobs = db.execute("""SELECT j.*,s.result_item_id,s.result_name,s.selectors
                FROM rehearsal_plots j JOIN rehearsal_slots s ON s.id=j.slot_id WHERE j.delivery_id=? ORDER BY j.rowid""", (delivery,))
            return {**record, "replayed": replayed, "results": [unpack(row) for row in results],
                    "plots": [unpack(row) for row in jobs]}

    def kick(self):
        with self.worker_guard:
            if self.worker is None:
                self.worker = Thread(target=self._work, daemon=True, name="skyao-rehearsal-drawing")
                self.worker.start()

    def _claim(self):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("""SELECT j.*,n.project_id,s.result_item_id FROM rehearsal_plots j
                    JOIN rehearsal_slots s ON s.id=j.slot_id JOIN rehearsal_nodes n ON n.id=s.project_node_id
                    WHERE j.status='queued' ORDER BY j.rowid LIMIT 1""").fetchone()
            if row:
                db.execute("UPDATE rehearsal_plots SET status='running',started_at=? WHERE id=?", (now(), row["id"]))
                db.execute("UPDATE rehearsal_slots SET status='running' WHERE id=? AND plot_id=?", (row["slot_id"], row["id"]))
                return unpack(row)
            return None

    def _work(self):
        import logging

        with (self.store.root / "rehearsal-worker.lock").open("ab") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                with self.worker_guard:
                    self.worker = None
                return
            try:
                # Exclusive ownership makes interrupted running jobs safe to retry.
                with self.store.connect() as db:
                    db.execute("UPDATE rehearsal_plots SET status='queued' WHERE status='running'")
                    db.execute("UPDATE rehearsal_slots SET status='queued' WHERE status='running'")
                while True:
                    with self.worker_guard:
                        job = self._claim()
                        if not job:
                            fcntl.flock(lock, fcntl.LOCK_UN)
                            self.worker = None
                            return
                    with TemporaryDirectory(dir=self.store.staging) as directory:
                        output = Path(directory) / "plot.png"
                        error = None
                        try:
                            inputs = {role: self.objects / source["file_id"] for role, source in job["inputs"].items()}
                            plot_image(job["script"], inputs, output)
                        except ValueError as exc:
                            error = str(exc)
                        except Exception:
                            logging.getLogger(__name__).exception("Drawing failed for %s", job["id"])
                            error = "绘图程序未能生成图片，请检查源文件内容。"
                        self._finish(job, output, error)
            except Exception:
                logging.getLogger(__name__).exception("Rehearsal drawing worker stopped")
                with self.worker_guard:
                    fcntl.flock(lock, fcntl.LOCK_UN)
                    self.worker = None

    def _finish(self, job, output, error):
        timestamp = now()
        files = []
        try:
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                version = file_id = None
                if not error:
                    with output.open("rb") as stream:
                        os.fsync(stream.fileno())
                        size, digest = fingerprint_file(stream)
                    file_id = self._add_file(db, files, job["project_id"], job["delivery_id"],
                                             f"{job['result_item_id']}_{job['script']}.png", output,
                                             size, digest, "image/png", "generated", timestamp)
                    version = self._append(db, job["slot_id"], file_id, job["delivery_id"], timestamp)
                    fsync_dir(self.objects)
                db.execute("UPDATE rehearsal_plots SET status=?,message=?,output_file_id=?,finished_at=? WHERE id=?",
                           ("failed" if error else "succeeded", error, file_id, timestamp, job["id"]))
                db.execute("UPDATE rehearsal_slots SET status=?,current_version_id=? WHERE id=? AND plot_id=?",
                           ("failed" if error else "ready", version, job["slot_id"], job["id"]))
        except BaseException:
            for path in files:
                path.unlink(missing_ok=True)
            raise
