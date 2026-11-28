"""Loopback-only rehearsal routes alongside the existing V0.2 API."""

import hashlib
import os
import re
from secrets import token_urlsafe
from pathlib import Path
from tempfile import TemporaryDirectory

from flask import g, jsonify, redirect, request, send_file, send_from_directory

from .multipart import stage_request
from .protocol import Problem, fields, identifier, read_json
from .rehearsal_materials import BUILTIN_FLOW, material_archive
from .rehearsal_protocol import multipart_filename, printable_name, project_blueprint, validate_manifest
from .rehearsal_store import TABLES, RehearsalStore

ROOT = Path(__file__).resolve().parent.parent
WORKBENCH_ASSETS = {
    "parameter-editor": {"parameters.css", "parameters.json", "parameters.js", "parameter-model.js", "parameter-form.js", "workbench-storage.js", "workbench-ui.js"},
    "node-editor": {"nodes.css", "nodes.js", "node-model.js", "node-preview.js"},
    "flow-editor": {"flows.css", "flows.js", "flow-model.js"},
}


def register_rehearsal(app, store, limits, demo_only, page, *, share_origin=None):
    rehearsal = RehearsalStore(store)
    workspace = ROOT.parent
    default = workspace if (workspace / "heatmap-editor").is_dir() else workspace / "SkyAO-workbench"
    checkout = Path(os.environ.get("SKYAO_WORKBENCH_DIR", default)) / "heatmap-editor"

    if share_origin:
        @app.before_request
        def create_browser_session():
            endpoint = request.endpoint or ""
            allowed = endpoint.startswith("rehearsal_") or endpoint in {"home", "health"} or (
                endpoint == "web_asset" and request.view_args.get("name") in
                {"rehearsal.js", "rehearsal.css", "parameters.css", "charts.js"}
            )
            if not allowed:
                raise Problem(404, "NOT_FOUND", "找不到演练资源。")
            token = request.cookies.get("__Host-skyao-rehearsal", "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                if request.method != "GET":
                    raise Problem(403, "REHEARSAL_SESSION", "请先打开演练台页面再重试。")
                token = token_urlsafe(32)
                g.rehearsal_cookie = token
            g.rehearsal_owner = hashlib.sha256(token.encode()).hexdigest()

        @app.after_request
        def set_browser_session(response):
            token = g.get("rehearsal_cookie")
            if token:
                response.set_cookie("__Host-skyao-rehearsal", token, secure=True, httponly=True,
                                    samesite="Strict", path="/", max_age=60 * 60 * 24 * 30)
                response.headers["Cache-Control"] = "no-store"
            return response

    def authorize(project):
        rehearsal.authorize_project(project, g.get("rehearsal_owner"))

    def mutation():
        demo_only()
        if (request.headers.get("Sec-Fetch-Site") not in {None, "same-origin"}
                or request.headers.get("Origin") not in {None, share_origin or request.host_url.rstrip("/")}):
            raise Problem(403, "REHEARSAL_ORIGIN", "请从演练台同源页面发起操作。")

    @app.get("/demo/rehearsal")
    def rehearsal_page():
        demo_only()
        return page("rehearsal.html")

    @app.get("/demo/rehearsal/api/projects")
    def rehearsal_projects():
        demo_only()
        return {"projects": rehearsal.projects(g.get("rehearsal_owner")), "builtin_flow": BUILTIN_FLOW,
                "workbench": (checkout / "flow-editor" / "flow-model.js").is_file(),
                "limits": {"file_bytes": limits.file, "total_bytes": limits.total, "files": limits.files}}

    @app.post("/demo/rehearsal/api/projects")
    def rehearsal_create():
        mutation()
        if request.content_length is None or request.content_length > 1024 * 1024:
            raise Problem(413, "TEMPLATE_SIZE", "项目配置超过 1 MB。")
        payload = read_json(request.get_data())
        fields(payload, (), "project", ("name", "template"))
        flow, nodes = project_blueprint(payload.get("template"))
        name = printable_name(payload["name"]) if payload.get("name") else ("投送演练项目" if payload.get("template") is None else flow["name"] + " · 演练")
        return jsonify(rehearsal.create(name, flow, nodes, g.get("rehearsal_owner"))), 201

    @app.get("/demo/rehearsal/api/projects/<project>/database")
    def rehearsal_database(project):
        demo_only()
        authorize(project)
        return {"tables": rehearsal.database(project), "labels": TABLES}

    @app.get("/demo/rehearsal/api/projects/<project>/materials")
    @app.get("/demo/rehearsal/api/projects/<project>/materials/<node>")
    def rehearsal_materials(project, node=None):
        demo_only()
        authorize(project)
        record, nodes = rehearsal.project(project, node)
        return send_file(material_archive(record, nodes), mimetype="application/zip", as_attachment=True,
                         download_name=f"{node or project}_materials.zip")

    @app.post("/demo/rehearsal/api/v3/deliveries")
    def rehearsal_upload():
        mutation()
        with TemporaryDirectory(dir=store.staging) as directory:
            raw, uploads = stage_request(request, Path(directory), limits, filename=multipart_filename)
            doc = read_json(raw)
            if not isinstance(doc, dict):
                raise Problem(422, "INVALID_FIELDS", "Manifest 须为一个 JSON 对象。")
            run = identifier(doc.get("analysis_run_id"), "analysis_run_id")
            node = identifier(doc.get("project_node_id"), "project_node_id")
            registered = rehearsal.target(run, node)
            authorize(registered["project_id"])
            validate_manifest(doc, registered, uploads)
            receipt, status = rehearsal.commit(registered, doc, uploads)
        return jsonify(receipt), status

    @app.get("/demo/rehearsal/api/projects/<project>/receipts/<delivery>")
    def rehearsal_receipt(project, delivery):
        demo_only()
        authorize(project)
        return rehearsal.receipt(project, delivery)

    @app.get("/demo/rehearsal/api/projects/<project>/files/<file_id>")
    def rehearsal_file(project, file_id):
        demo_only()
        authorize(project)
        record = rehearsal.file(project, file_id)
        return send_from_directory(rehearsal.objects, record["id"], mimetype=record["media_type"],
                                   download_name=record["file_name"], as_attachment=request.args.get("download") == "1")

    @app.get("/workbench/")
    def rehearsal_workbench():
        demo_only()
        return redirect("/workbench/parameter-editor/")

    @app.get("/workbench/<editor>/")
    @app.get("/workbench/<editor>/<asset>")
    def rehearsal_editor(editor, asset=None):
        demo_only()
        if editor not in WORKBENCH_ASSETS or asset is not None and asset not in WORKBENCH_ASSETS[editor]:
            raise Problem(404, "NOT_FOUND", "找不到工作台资源。")
        if asset:
            return send_from_directory(checkout / editor, asset)
        path = checkout / editor / "index.html"
        if not path.is_file():
            raise Problem(404, "NOT_FOUND", "本地工作台源码目录不可用。")
        return path.read_text().replace("</nav>", '<a href="/demo/rehearsal">结果投送演练台</a></nav>', 1)

    @app.get("/workbench/index.html")
    def rehearsal_heatmap_editor():
        demo_only()
        return send_from_directory(checkout, "index.html")
