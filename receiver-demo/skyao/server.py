"""Local HTTP receiver for one pre-authorized analysis run."""

import argparse
import hmac
import os
import secrets
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic
from urllib.parse import urlsplit

from flask import Flask, current_app, jsonify, redirect, request, send_from_directory, url_for
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from .editable import state as editable_state
from .multipart import Limits, stage_request, too_large
from .parameters import ParameterLibrary
from .protocol import Problem, check_file, identifier, read_json, validate_data, validate_manifest
from .storage import Store
from .rehearsal import register_rehearsal

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SEED = ROOT / "fixtures" / "seed.json"
DEMO_CASES = {
    "01": ("01_samples", "首次投送 · 两个样本", "S01 和 S02 各产生版本 1。再次发送同一包会重放回执。", 201, None),
    "02": ("02_comparisons", "两个有向比对组", "查看 A vs B 和 B vs C 的火山图、MA 图和数据表。", 201, None),
    "03": ("03_overview", "整体结果 · 多源热图", "矩阵与注释一起生成热图，PCA 使用独立坐标。", 201, None),
    "04": ("04_update_s02", "局部更新 · 仅 S02", "先发送 01。这一包只把 S02 更新到版本 2，S01 保持版本 1。", 201, None),
    "05": ("05_multi_dimensions", "多维选择 · 比对组 × 层级", "三种实际组合，B vs C 只有基因层级。", 201, None),
    "90": ("90_id_conflict", "投送编号冲突", "先发送 01。此包复用它的编号，但更改了文件内容与摘要。", 409, "DELIVERY_CONFLICT"),
    "91": ("91_bad_checksum", "文件摘要错误", "S02.csv 的字节已改动。使用网页或 curl 可直接验证接收端拒绝。", 422, "CHECKSUM_MISMATCH"),
    "92": ("92_bad_source", "引用不存在的文件", "渲染组引用了清单中不存在的文件。", 422, "UNKNOWN_SOURCE"),
    "93": ("93_bad_selector", "未知样本编号", "样本值不在当前任务的字典中。", 422, "UNKNOWN_SELECTOR"),
    "94": ("94_bad_renderer", "未知渲染器", "渲染类型不在接收器的注册表中。", 422, "UNKNOWN_RENDERER"),
}


def limit(name, default):
    value = int(os.environ.get(f"SKYAO_MAX_{name}", default))
    if value < 1:
        raise ValueError(f"SKYAO_MAX_{name} must be positive.")
    return value


def create_app(directory, seed_path, token, *, demo=False, share_origin=None):
    share_host = None
    if share_origin:
        origin = urlsplit(share_origin)
        if not demo or origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
            raise ValueError("--share-origin requires --demo and a bare HTTPS origin.")
        share_host = origin.hostname
    if not token or not token.isascii() or any(character.isspace() for character in token):
        raise ValueError("Set SKYAO_TOKEN to a nonempty ASCII bearer token.")
    context = read_json(Path(seed_path).read_bytes())
    allowed_run = identifier(context["analysis_run_id"], "seed.analysis_run_id")
    defaults = Limits(
        limit("FILE_BYTES", 20 * 1024**2),
        limit("TOTAL_BYTES", 100 * 1024**2),
        limit("MANIFEST_BYTES", 1024**2),
        limit("FILES", 100),
    )
    store = Store(directory)
    store.seed(context)
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = defaults.request
    if demo:
        app.config["TRUSTED_HOSTS"] = ["127.0.0.1", "localhost", "::1"] + ([share_host] if share_host else [])

    if demo:
        parameters = ParameterLibrary(store, ROOT / "fixtures" / "parameters.json")

    def authenticate():
        scheme, _, supplied = request.headers.get("Authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(supplied.encode(), token.encode()):
            raise Problem(401, "UNAUTHORIZED", "A valid bearer token is required.")

    def authorize(run):
        if run != allowed_run:
            raise Problem(403, "RUN_FORBIDDEN", "This identity has no access to the requested run.")
        registered = store.context(run)
        if registered is None:
            raise Problem(404, "RUN_NOT_FOUND", "The analysis run was not found.")
        return registered

    @app.errorhandler(Problem)
    def protocol_error(error):
        response = jsonify(error.body())
        response.status_code = error.status
        if error.status == 401:
            response.headers["WWW-Authenticate"] = "Bearer"
        return response

    @app.errorhandler(RequestEntityTooLarge)
    def oversized(_):
        return protocol_error(too_large("Request body exceeds the upload limit."))

    @app.errorhandler(HTTPException)
    def http_error(error):
        status = error.code or 500
        return protocol_error(Problem(status, f"HTTP_{status}", error.name))

    @app.errorhandler(sqlite3.OperationalError)
    def database_error(error):
        current_app.logger.error("database operation failed (%s)", getattr(error, "sqlite_errorname", "unknown"))
        return protocol_error(Problem(503, "STORAGE_UNAVAILABLE", "Receiver storage is temporarily unavailable."))

    @app.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.path.startswith(("/api/", "/demo/")):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/")
    def home():
        if share_origin:
            return redirect(url_for("rehearsal_page"))
        if demo:
            return redirect(url_for("console"))
        return redirect(url_for("run_page", run=allowed_run))

    def page(filename):
        response = send_from_directory(ROOT / "web", filename)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
        return response

    def demo_only():
        if not demo or request.remote_addr not in {"127.0.0.1", "::1"}:
            raise Problem(404, "HTTP_404", "Not Found")

    if demo:
        register_rehearsal(app, store, defaults, demo_only, page, share_origin=share_origin)

    @app.get("/demo")
    def console():
        demo_only()
        return page("console.html")

    @app.get("/demo/session")
    def demo_session():
        demo_only()
        if (request.headers.get("X-SkyAO-Demo") != "test-console"
                or request.headers.get("Sec-Fetch-Site") not in {None, "same-origin"}
                or request.headers.get("Origin") not in {None, request.host_url.rstrip("/")}):
            raise Problem(403, "DEMO_SESSION_FORBIDDEN", "Open the test console from the receiver origin.")
        return {"token": token, "run_id": allowed_run}

    @app.get("/demo/parameters")
    def parameter_page():
        demo_only()
        return page("parameters.html")

    @app.get("/demo/parameters/data")
    def parameter_list():
        demo_only()
        return {"cards": parameters.list()}

    @app.post("/demo/parameters/data")
    def parameter_save():
        demo_only()
        if (request.headers.get("Sec-Fetch-Site") not in {None, "same-origin"}
                or request.headers.get("Origin") not in {None, request.host_url.rstrip("/")}):
            raise Problem(403, "PARAMETER_ORIGIN", "请从 SkyAO 工作区保存参数。")
        if request.content_length is None or request.content_length > 256 * 1024:
            raise Problem(413, "PARAMETER_SIZE", "参数定义大小超过上限。")
        return parameters.save(request.get_json())

    @app.get("/demo/transfer")
    def transfer_page():
        demo_only()
        return page("transfer.html")

    @app.get("/demo/transfer/state")
    def transfer_state():
        demo_only()
        authenticate()
        return editable_state(store, authorize(allowed_run))

    @app.get("/demo/cases")
    def demo_cases():
        demo_only()
        return {"cases": [
            {"id": case, "folder": folder, "title": title, "description": description,
             "expected_status": status, "expected_code": code}
            for case, (folder, title, description, status, code) in DEMO_CASES.items()
        ]}

    @app.get("/demo/cases/<case>/<filename>")
    def demo_fixture(case, filename):
        demo_only()
        if case not in DEMO_CASES:
            raise Problem(404, "HTTP_404", "Not Found")
        folder = ROOT / "fixtures" / DEMO_CASES[case][0]
        if filename == "manifest.json":
            return send_from_directory(folder, filename)
        manifest = read_json((folder / "manifest.json").read_bytes())
        if filename not in {artifact["file_name"] for artifact in manifest["artifacts"]}:
            raise Problem(404, "HTTP_404", "Not Found")
        return send_from_directory(folder / "files", filename)

    @app.get("/runs/<run>")
    def run_page(run):
        if run != allowed_run:
            raise Problem(404, "RUN_NOT_FOUND", "The analysis run was not found.")
        return page("index.html")

    @app.get("/web/<name>")
    def web_asset(name):
        if name not in {"app.js", "charts.js", "style.css", "console.js", "console.css", "session.js", "transfer.js", "transfer.css",
                        "parameters.js", "parameter-model.js", "parameters.css",
                        "rehearsal.js", "rehearsal.css"}:
            raise Problem(404, "HTTP_404", "Not Found")
        return send_from_directory(ROOT / "web", name)

    @app.get("/web/plotly.min.js")
    def plotly():
        return send_from_directory(ROOT / "node_modules" / "plotly.js-dist-min", "plotly.min.js")

    @app.post("/api/v1/deliveries")
    def receive():
        started = monotonic()
        info = {}
        try:
            authenticate()
            with TemporaryDirectory(dir=store.staging) as directory:
                raw, uploads = stage_request(request, Path(directory), defaults)
                doc = read_json(raw)
                run = identifier(doc.get("analysis_run_id"), "analysis_run_id") if isinstance(doc, dict) else None
                if run is None:
                    raise Problem(422, "INVALID_FIELDS", "Manifest must be an object.")
                registered = authorize(run)
                keys = validate_manifest(doc, context=registered)
                info = {"run": run, "delivery": doc["delivery_id"], "node": doc["node_key"]}
                if {item["file_name"] for item in doc["artifacts"]} != uploads.keys():
                    raise Problem(422, "FILE_SET_MISMATCH", "Multipart files must exactly match artifacts.")
                for item in doc["artifacts"]:
                    upload = uploads[item["file_name"]]
                    check_file(item, upload.size, upload.sha256)
                validate_data(doc, uploads)
                receipt, status = store.commit(doc, keys, uploads)
            current_app.logger.info(
                "accepted run=%s delivery=%s node=%s replayed=%s elapsed_ms=%d",
                run, doc["delivery_id"], doc["node_key"], receipt["replayed"], (monotonic() - started) * 1000,
            )
            return jsonify(receipt), status
        except Problem as error:
            current_app.logger.info("rejected code=%s %s elapsed_ms=%d", error.code, info, (monotonic() - started) * 1000)
            raise

    @app.get("/api/v1/runs/<run>/deliveries/<delivery>")
    def receipt(run, delivery):
        authenticate()
        authorize(run)
        saved = store.receipt(run, delivery)
        if saved is None:
            raise Problem(404, "DELIVERY_NOT_FOUND", "No accepted delivery with this ID.")
        return saved

    @app.get("/api/v1/runs/<run>/results")
    def results(run):
        authenticate()
        return store.results(authorize(run), request.args.get("history") == "1")

    @app.get("/api/v1/runs/<run>/artifacts/<artifact_id>")
    def artifact(run, artifact_id):
        authenticate()
        authorize(run)
        item = store.artifact(run, artifact_id)
        if item is None:
            raise Problem(404, "ARTIFACT_NOT_FOUND", "No artifact with this ID in the analysis run.")
        return send_from_directory(
            store.objects, item["id"], download_name=item["file_name"],
            mimetype="application/octet-stream", as_attachment=True,
        )

    return app


def main():
    import logging

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--demo", action="store_true", help="enable the loopback test console with its own data directory")
    parser.add_argument("--share-origin", help="public HTTPS origin; exposes only the browser-isolated rehearsal")
    args = parser.parse_args()
    if args.share_origin and (not args.demo or not args.data_dir):
        parser.error("--share-origin requires --demo and its own explicit --data-dir")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    default_directory = ".sky-demo" if args.demo else os.environ.get("SKYAO_DATA_DIR", ".sky-server")
    directory = args.data_dir or Path(default_directory)
    token = secrets.token_urlsafe(32) if args.demo else os.environ.get("SKYAO_TOKEN")
    app = create_app(directory, args.seed, token, demo=args.demo, share_origin=args.share_origin)
    app.run(host="127.0.0.1", port=args.port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
