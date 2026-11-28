"""Acceptance tests with separate sender and receiver processes and real HTTP."""

import copy
import hashlib
import json
import os
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

import requests

ROOT = Path(__file__).resolve().parent.parent
RUN = "RUN-TEST-001"
API = f"/api/v1/runs/{RUN}"
DELIVERIES = "/api/v1/deliveries"


def load_case(number):
    directory, = (ROOT / "fixtures").glob(f"{number:02d}_*")
    doc = json.loads((directory / "manifest.json").read_text())
    files = [(item["file_name"], (directory / "files" / item["file_name"]).read_bytes()) for item in doc["artifacts"]]
    return doc, files


def free_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


class Receiver:
    def __init__(self, root, *, seed=None, data_dir=None):
        port = free_port()
        self.base = f"http://127.0.0.1:{port}"
        self.data_dir = data_dir or root / "server"
        self.spool = root / "spool"
        self.env = {
            **os.environ, "SKYAO_TOKEN": secrets.token_urlsafe(),
            "SKYAO_BASE_URL": self.base, "SKYAO_SPOOL_DIR": str(self.spool),
            "SKYAO_MAX_ATTEMPTS": "1", "SKYAO_MAX_FILE_BYTES": "4096",
            "SKYAO_MAX_TOTAL_BYTES": "10000", "SKYAO_MAX_MANIFEST_BYTES": "4096", "SKYAO_MAX_FILES": "4",
        }
        self.headers = {"Authorization": "Bearer " + self.env["SKYAO_TOKEN"]}
        self.command = [sys.executable, "-m", "skyao.server", "--port", str(port), "--data-dir", str(self.data_dir)]
        if seed:
            self.command += ["--seed", str(seed)]
        self.log_path = root / "receiver.log"
        self.process = None

    def start(self):
        with self.log_path.open("ab") as log:
            self.process = subprocess.Popen(self.command, cwd=ROOT, env=self.env, stdout=log, stderr=log)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and self.process.poll() is None:
            try:
                if requests.get(self.base + "/health", timeout=.2).ok:
                    return
            except requests.RequestException:
                time.sleep(.025)
        self.stop()
        raise RuntimeError(self.log_path.read_text())

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)

    def cli(self, *args, url=None):
        env = self.env if url is None else {**self.env, "SKYAO_BASE_URL": url}
        return subprocess.run([sys.executable, "-m", "skyao.client", *args], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=15)

    def cli_send(self, case, *, url=None):
        directory, = (ROOT / "fixtures").glob(f"{case:02d}_*")
        return self.cli("send", "--manifest", directory / "manifest.json", "--files-dir", directory / "files", url=url)

    def cli_state(self, command, delivery):
        return self.cli(command, "--run-id", RUN, "--delivery-id", delivery)

    def post(self, doc, files, *, headers=None, manifest_first=True, extra=()):
        body = json.dumps(doc, ensure_ascii=False).encode() if isinstance(doc, dict) else doc
        manifest = [("manifest", (None, body))]
        file_parts = [("files", (name, data, "text/csv")) for name, data in files]
        parts = manifest + file_parts if manifest_first else file_parts + manifest
        return requests.post(self.base + DELIVERIES, files=[*parts, *extra],
                             headers=self.headers if headers is None else headers, timeout=10)

    def get(self, path, *, headers=None):
        return requests.get(self.base + path, headers=self.headers if headers is None else headers, timeout=5)

    def connect(self):
        return sqlite3.connect(self.data_dir / "receiver.sqlite3")


class HTTPAcceptance(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.receiver = Receiver(self.root)
        self.addCleanup(self.receiver.stop)
        self.receiver.start()

    def assert_problem(self, reply, status, code):
        self.assertEqual(reply.status_code, status, reply.text)
        self.assertEqual(reply.json()["error"]["code"], code)

    def assert_cli_ok(self, process):
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        return json.loads(process.stdout)

    def current(self, node, *, history=False):
        data = self.receiver.get(API + "/results" + ("?history=1" if history else "")).json()
        return next(entry for section in data["sections"] for entry in section["nodes"] if entry["node_key"] == node)

    def counts(self):
        with self.receiver.connect() as db:
            return tuple(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                         for table in ("runs", "nodes", "units", "versions", "deliveries", "artifacts"))

    def objects(self):
        return {entry.name: entry.read_bytes() for entry in (self.receiver.data_dir / "objects").iterdir()}

    def test_fixture_sequence_and_old_artifact_history(self):
        submission = self.receiver.cli_send(1)
        first = self.assert_cli_ok(submission)
        print("CLI LOG " + submission.stderr.strip(), flush=True)
        print("HTTP 201 " + submission.stdout.strip(), flush=True)
        self.assertFalse(first["replayed"])
        status = self.assert_cli_ok(self.receiver.cli_state("status", first["delivery_id"]))
        self.assertEqual(status["http_status"], 201)
        before = self.current("expression_distribution")
        old = before["result_units"][1]["render_groups"][0]["sources"]["data"]
        self.assertTrue(self.assert_cli_ok(self.receiver.cli_send(1))["replayed"])
        for case in (2, 3, 4):
            self.assertFalse(self.assert_cli_ok(self.receiver.cli_send(case))["replayed"])
        fourth = self.current("expression_distribution", history=True)
        self.assertEqual([unit["revision"] for unit in fourth["result_units"]], [1, 2])
        self.assertEqual(fourth["result_units"][0]["render_groups"], before["result_units"][0]["render_groups"])
        self.assertTrue(self.assert_cli_ok(self.receiver.cli_send(1))["replayed"])
        self.assertEqual(self.current("expression_distribution", history=True), fourth)
        versions = fourth["result_units"][1]["history"]
        self.assertEqual([item["revision"] for item in versions], [2, 1])
        new = versions[0]["render_groups"][0]["sources"]["data"]
        self.assertEqual(new["file_name"], old["file_name"])
        self.assertNotEqual(new["artifact_id"], old["artifact_id"])
        for source, case, index in ((old, 1, 1), (new, 4, 0)):
            reply = self.receiver.get(API + "/artifacts/" + source["artifact_id"])
            self.assertTrue(reply.ok, reply.text)
            self.assertIn("attachment", reply.headers["Content-Disposition"])
            self.assertEqual(reply.content, load_case(case)[1][index][1])
            self.assertEqual(hashlib.sha256(reply.content).hexdigest(), source["sha256"])

        self.assert_cli_ok(self.receiver.cli_send(5))
        data = self.receiver.get(API + "/results").json()
        self.assertEqual(len(data["sections"]), 2)
        self.assertEqual(self.counts(), (1, 4, 8, 9, 5, 11))
        self.assertEqual(len(self.objects()), 11)
        print("FIXTURES 01–05 · 2 sections, 4 nodes, 8 current units, 9 versions, 5 accepted deliveries", flush=True)

    def test_all_supplied_faults_against_http_and_local_checksum(self):
        self.assert_cli_ok(self.receiver.cli_send(1))
        stored = self.objects()
        cli = self.receiver.cli_send(91)
        self.assertEqual(cli.returncode, 1)
        self.assertEqual(json.loads(cli.stderr)["error"]["code"], "CHECKSUM_MISMATCH")
        for case, status, code in (
            (90, 409, "DELIVERY_CONFLICT"), (91, 422, "CHECKSUM_MISMATCH"),
            (92, 422, "UNKNOWN_SOURCE"), (93, 422, "UNKNOWN_SELECTOR"), (94, 422, "UNKNOWN_RENDERER"),
        ):
            with self.subTest(case=case):
                self.assert_problem(self.receiver.post(*load_case(case)), status, code)
                print(f"FIXTURE {case} · HTTP {status} {code}", flush=True)
        self.assertEqual(self.counts(), (1, 1, 2, 2, 1, 2))
        self.assertEqual(self.objects(), stored)
        self.assertEqual(list((self.receiver.data_dir / "staging").iterdir()), [])

    def test_concurrent_replay_and_normalized_object_keys(self):
        doc, files = load_case(5)
        ordered = copy.deepcopy(doc)
        ordered["result_units"][0]["selectors"] = dict(reversed(list(doc["result_units"][0]["selectors"].items())))
        with ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda i: self.receiver.post(
                ordered if i % 2 else doc, list(reversed(files)), manifest_first=False), range(6)))
        self.assertEqual(sorted(response.status_code for response in responses), [200] * 5 + [201])
        self.assertTrue(all(receipt.json()["accepted_units"] == responses[0].json()["accepted_units"] for receipt in responses))
        self.assertEqual(self.counts(), (1, 1, 3, 3, 1, 3))
        print("CONCURRENT · 1 accepted (201), 5 replays (200)", flush=True)
        damaged = [files[0], (files[1][0], b"x" + files[1][1][1:]), files[2]]
        self.assert_problem(self.receiver.post(doc, damaged), 422, "CHECKSUM_MISMATCH")
        doc["result_units"].reverse()
        self.assert_problem(self.receiver.post(doc, files), 409, "DELIVERY_CONFLICT")

    def test_strict_manifest_and_node_identity(self):
        base, uploads = load_case(1)
        cases = [
            (lambda doc: doc["result_units"].append(copy.deepcopy(doc["result_units"][0])), "DUPLICATE_SELECTORS"),
            (lambda doc: doc["artifacts"].append(copy.deepcopy(doc["artifacts"][0])), "DUPLICATE_FILE"),
            (lambda doc: doc["result_units"][0]["render_groups"].append({"render_types": ["boxplot"], "editable": False,
                                                                         "sources": {"data": "S01.csv"}}), "DUPLICATE_RENDERER"),
            (lambda doc: doc.update(section_key="missing"), "UNKNOWN_SECTION"),
            (lambda doc: doc["result_units"][0]["render_groups"][0]["sources"].update(extra="S01.csv"), "INVALID_SOURCE_ROLES"),
            (lambda doc: doc.update(sort_order=True), "INVALID_TYPE"),
            (lambda doc: doc.update(compute_job_id="JOB-1"), "JOB_NOT_SUPPORTED"),
            (lambda doc: doc.update(schema_version="0.3"), "UNSUPPORTED_SCHEMA"),
            (lambda doc: doc.update(result_id="DEPRECATED"), "INVALID_FIELDS"),
            (lambda doc: doc["result_units"][0].update(selectors={}), "SELECTOR_DIMENSIONS"),
        ]
        for mutate, code in cases:
            with self.subTest(code=code):
                doc = copy.deepcopy(base)
                mutate(doc)
                self.assert_problem(self.receiver.post(doc, uploads), 422, code)
        self.assert_problem(self.receiver.post(b'{"analysis_run_id":"RUN-TEST-001","x":1,"x":2}', uploads), 400, "INVALID_JSON")
        self.assert_problem(self.receiver.post(b'{"x":NaN}', uploads), 400, "INVALID_JSON")
        self.assert_problem(self.receiver.post(b'{"x":"\xff"}', uploads), 400, "INVALID_JSON")
        self.assertEqual(self.counts(), (1, 0, 0, 0, 0, 0))
        self.assertEqual(self.receiver.post(base, uploads).status_code, 201)
        base.update(delivery_id="NEW", node_title="改名")
        self.assert_problem(self.receiver.post(base, uploads), 409, "NODE_CONFLICT")
        base.update(node_title="样本表达量分布")
        for index, unit in enumerate(base["result_units"]):
            unit["selectors"] = {"group": ["A", "B"][index]}
        self.assert_problem(self.receiver.post(base, uploads), 409, "NODE_CONFLICT")
        self.assertEqual(self.counts(), (1, 1, 2, 2, 1, 2))

    def test_multipart_file_safety_and_limits(self):
        doc, files = load_case(1)
        for bad_files, status, code in [
            (files[:1], 422, "FILE_SET_MISMATCH"), (files + [("extra.csv", b"x")], 422, "FILE_SET_MISMATCH"),
            (files + files[:1], 400, "INVALID_MULTIPART"), ([("../S01.csv", b"x"), files[1]], 422, "UNSAFE_FILENAME"),
            ([(r"C:\\tmp\\S01.csv", b"x"), files[1]], 422, "UNSAFE_FILENAME"),
            ([("S01.csv", b"x" * 4097), files[1]], 413, "UPLOAD_LIMIT"),
            ([(name, b"x" * 4000) for name in ("a.csv", "b.csv", "c.csv")], 413, "UPLOAD_LIMIT"),
            ([(f"{i}.csv", b"x") for i in range(5)], 413, "UPLOAD_LIMIT"),
        ]:
            with self.subTest(status=status, code=code, names=[name for name, _ in bad_files]):
                self.assert_problem(self.receiver.post(doc, bad_files), status, code)
        for extra in (("manifest", (None, "{}")), ("unexpected", (None, "x"))):
            self.assert_problem(self.receiver.post(doc, files, extra=[extra]), 400, "INVALID_MULTIPART")
        self.assert_problem(self.receiver.post(b"x" * 4097, files), 413, "UPLOAD_LIMIT")
        wrong_size = copy.deepcopy(doc)
        wrong_size["artifacts"][0]["size_bytes"] += 1
        self.assert_problem(self.receiver.post(wrong_size, files), 422, "SIZE_MISMATCH")
        doc["artifacts"][0]["file_name"] = "../S01.csv"
        self.assert_problem(self.receiver.post(doc, files), 422, "UNSAFE_FILENAME")
        malformed = requests.post(self.receiver.base + DELIVERIES,
                                  headers={**self.receiver.headers, "Content-Type": "multipart/form-data; boundary=short"},
                                  data=b"--short\r\nContent-Disposition: form-data; name=manifest\r\n\r\n{}", timeout=5)
        self.assert_problem(malformed, 400, "INVALID_MULTIPART")
        self.assertEqual(self.counts(), (1, 0, 0, 0, 0, 0))
        self.assertEqual(self.objects(), {})

    def test_invalid_csv_rejects_the_whole_delivery(self):
        def replace(doc, files, index, data):
            files[index] = (files[index][0], data)
            doc["artifacts"][index].update(size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest())

        self.assert_cli_ok(self.receiver.cli_send(1))
        previous = self.objects()
        expressions = (
            b"feature_id,log2_expression\nX,NaN\n", b"feature_id,log2_expression\nX,1e999\n",
            b"feature_id,log2_expression\nX,1\nX,2\n", b"other,log2_expression\nX,3\n",
            b"feature_id,log2_expression\nX,\n", b"feature_id,log2_expression\nX\n",
        )
        for data in expressions:
            doc, files = load_case(1)
            doc["delivery_id"] = "BAD-INPUT"
            replace(doc, files, 1, data)
            self.assert_problem(self.receiver.post(doc, files), 422, "INVALID_CSV")
        doc, files = load_case(2)
        replace(doc, files, 0, b"feature_id,mean_log2_expression,log2_fc,p_adjusted\nX,1,2,0\n")
        self.assert_problem(self.receiver.post(doc, files), 422, "INVALID_CSV")
        doc, files = load_case(3)
        index = next(index for index, (name, _) in enumerate(files) if name == "annotation.csv")
        replace(doc, files, index, files[index][1].replace(b"S01,A", b"OTHER,A"))
        self.assert_problem(self.receiver.post(doc, files), 422, "HEATMAP_SAMPLE_MISMATCH")
        self.assertEqual(self.counts(), (1, 1, 2, 2, 1, 2))
        self.assertEqual(self.objects(), previous)

    def test_transaction_rolls_back_after_second_version_fails(self):
        self.assert_cli_ok(self.receiver.cli_send(1))
        previous_counts = self.counts()
        previous = self.current("expression_distribution", history=True)
        with self.receiver.connect() as db:
            db.execute("""CREATE TRIGGER reject_second_version BEFORE INSERT ON versions
                WHEN NEW.delivery_id = 'INJECTED-FAILURE' AND EXISTS (
                    SELECT 1 FROM units WHERE id = NEW.unit_id AND selectors = '{"sample":"S02"}'
                ) BEGIN SELECT RAISE(ABORT, 'integration failure'); END""")
        doc, files = load_case(1)
        doc["delivery_id"] = "INJECTED-FAILURE"
        self.assert_problem(self.receiver.post(doc, files), 500, "HTTP_500")
        self.assertEqual(self.counts(), previous_counts)
        self.assertEqual(self.current("expression_distribution", history=True), previous)
        self.assert_problem(self.receiver.get(API + "/deliveries/INJECTED-FAILURE"), 404, "DELIVERY_NOT_FOUND")
        with self.receiver.connect() as db:
            registered = {row[0] for row in db.execute("SELECT id FROM artifacts")}
            db.execute("DROP TRIGGER reject_second_version")
        orphans = self.objects().keys() - registered
        self.assertEqual(len(orphans), 2)
        for orphan in orphans:
            self.assert_problem(self.receiver.get(API + "/artifacts/" + orphan), 404, "ARTIFACT_NOT_FOUND")
        self.assertEqual(self.receiver.post(doc, files).status_code, 201)

    def test_authentication_and_foreign_artifact(self):
        self.assert_problem(self.receiver.get(API + "/results", headers={}), 401, "UNAUTHORIZED")
        self.assert_problem(self.receiver.get(API + "/results", headers={"Authorization": "Bearer wrong"}), 401, "UNAUTHORIZED")
        self.assert_problem(self.receiver.post(*load_case(1), headers={}), 401, "UNAUTHORIZED")
        doc, files = load_case(1)
        doc["analysis_run_id"] = "OTHER-RUN"
        self.assert_problem(self.receiver.post(doc, files), 403, "RUN_FORBIDDEN")
        alternate = self.root / "alternate"
        alternate.mkdir()
        seed = json.loads((ROOT / "fixtures" / "seed.json").read_text())
        seed["analysis_run_id"] = "OTHER-RUN"
        seed_file = alternate / "seed.json"
        seed_file.write_text(json.dumps(seed))
        foreign = Receiver(alternate, seed=seed_file, data_dir=self.receiver.data_dir)
        self.addCleanup(foreign.stop)
        foreign.start()
        self.assertEqual(foreign.post(doc, files).status_code, 201)
        other_api = "/api/v1/runs/OTHER-RUN"
        unit = foreign.get(other_api + "/results").json()["sections"][0]["nodes"][0]["result_units"][0]
        artifact = unit["render_groups"][0]["sources"]["data"]["artifact_id"]
        self.assert_problem(self.receiver.get(other_api + "/artifacts/" + artifact), 403, "RUN_FORBIDDEN")
        self.assert_problem(self.receiver.get(API + "/artifacts/" + artifact), 404, "ARTIFACT_NOT_FOUND")
        self.assert_problem(foreign.get(other_api + "/artifacts/" + artifact, headers={}), 401, "UNAUTHORIZED")

    def test_restart_and_spool_uses_immutable_original_snapshot(self):
        accepted = self.assert_cli_ok(self.receiver.cli_send(1))
        self.receiver.stop()
        doc, files = load_case(4)
        doc.pop("delivery_id")
        for artifact in doc["artifacts"]:
            artifact.pop("size_bytes")
            artifact.pop("sha256")
        draft = self.root / "draft.json"
        draft.write_text(json.dumps(doc))
        source = self.root / "source"
        source.mkdir()
        path = source / files[0][0]
        path.write_bytes(files[0][1])
        failed = self.receiver.cli("send", "--manifest", draft, "--files-dir", source)
        self.assertEqual(failed.returncode, 1, failed.stdout + failed.stderr)
        event = json.loads(failed.stderr)
        self.assertEqual(event["status"], "failed_retryable")
        delivery = event["delivery_id"]
        self.assertNotEqual(delivery, "DEL-TEST-004")
        self.assertEqual(self.assert_cli_ok(self.receiver.cli_state("status", delivery))["attempts"], 1)
        path.unlink()
        path.write_bytes(b"changed since original send")
        self.receiver.start()
        self.assertEqual(self.receiver.get(API + "/deliveries/" + accepted["delivery_id"]).json(), accepted)
        self.assertEqual(self.current("expression_distribution")["result_units"][1]["revision"], 1)
        retried = self.assert_cli_ok(self.receiver.cli_state("retry", delivery))
        self.assertEqual(retried["accepted_units"][0]["revision"], 2)
        self.assertEqual(retried["delivery_id"], delivery)
        current = self.current("expression_distribution")["result_units"][1]["render_groups"][0]["sources"]["data"]
        self.assertEqual(self.receiver.get(API + "/artifacts/" + current["artifact_id"]).content, files[0][1])

    def test_response_lost_after_server_commit(self):
        receiver = self.receiver
        forwarded = []

        class LoseResponse(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                forwarded.append(requests.post(receiver.base + self.path, data=raw, headers={
                    name: self.headers[name] for name in ("Authorization", "Content-Type")
                }, timeout=5).status_code)
                self.close_connection = True

        with HTTPServer(("127.0.0.1", 0), LoseResponse) as proxy:
            worker = Thread(target=proxy.serve_forever, daemon=True)
            worker.start()
            try:
                failed = receiver.cli_send(1, url=f"http://127.0.0.1:{proxy.server_port}")
                self.assertEqual(failed.returncode, 1)
                self.assertEqual(json.loads(failed.stderr)["status"], "failed_retryable")
            finally:
                proxy.shutdown()
                worker.join()
        self.assertEqual(forwarded, [201])
        self.assertEqual(receiver.get(API + "/deliveries/DEL-TEST-001").status_code, 200)
        replay = self.assert_cli_ok(receiver.cli_state("retry", "DEL-TEST-001"))
        self.assertTrue(replay["replayed"])
        self.assertEqual(self.counts(), (1, 1, 2, 2, 1, 2))
        print("RESPONSE LOST · committed 201, CLI recovered original receipt with 200", flush=True)

    def test_cli_retries_429_and_503_with_the_same_manifest(self):
        receiver = self.receiver
        receiver.env["SKYAO_MAX_ATTEMPTS"] = "3"
        payloads = []

        class TemporaryFailures(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                payloads.append(raw)
                if len(payloads) <= 2:
                    self.send_response(429 if len(payloads) == 1 else 503)
                    self.send_header("Retry-After", "0")
                    self.end_headers()
                    return
                reply = requests.post(receiver.base + self.path, data=raw, headers={
                    name: self.headers[name] for name in ("Authorization", "Content-Type")
                }, timeout=5)
                self.send_response(reply.status_code)
                self.end_headers()
                self.wfile.write(reply.content)

        with HTTPServer(("127.0.0.1", 0), TemporaryFailures) as proxy:
            thread = Thread(target=proxy.serve_forever, daemon=True)
            thread.start()
            try:
                result = receiver.cli_send(1, url=f"http://127.0.0.1:{proxy.server_port}")
                self.assertFalse(self.assert_cli_ok(result)["replayed"])
            finally:
                proxy.shutdown()
                thread.join()
        self.assertEqual(len(payloads), 3)
        doc, _ = load_case(1)
        from skyao.protocol import canonical
        self.assertTrue(all(canonical(doc).encode() in body for body in payloads))
        status = self.assert_cli_ok(receiver.cli_state("status", "DEL-TEST-001"))
        self.assertEqual(status["attempts"], 3)
        self.assertEqual(self.counts(), (1, 1, 2, 2, 1, 2))

    def test_cli_rejects_symlink_and_local_snapshot_conflict(self):
        self.assert_cli_ok(self.receiver.cli_send(1))
        conflict = self.receiver.cli_send(90)
        self.assertEqual(conflict.returncode, 1)
        self.assertEqual(json.loads(conflict.stderr)["error"]["code"], "LOCAL_DELIVERY_CONFLICT")
        doc, files = load_case(4)
        draft = self.root / "draft.json"
        draft.write_text(json.dumps(doc))
        source = self.root / "source"
        source.mkdir()
        outside = self.root / "outside.csv"
        outside.write_bytes(files[0][1])
        (source / files[0][0]).symlink_to(outside)
        result = self.receiver.cli("send", "--manifest", draft, "--files-dir", source)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "LOCAL_FILE_UNAVAILABLE")
        self.assertEqual(self.counts(), (1, 1, 2, 2, 1, 2))

    def test_prune_keeps_receipts_and_snapshots_still_waiting_to_send(self):
        receiver = self.receiver
        self.assert_cli_ok(receiver.cli_send(1))
        receiver.stop()
        self.assertEqual(receiver.cli_send(4).returncode, 1)
        prune = self.assert_cli_ok(receiver.cli("prune", "--older-than-days", "0"))
        self.assertEqual(prune["pruned"], 1)
        accepted = self.assert_cli_ok(receiver.cli_state("status", "DEL-TEST-001"))
        self.assertEqual(accepted["receipt"]["status"], "accepted")
        self.assertTrue(accepted["files_pruned"])
        waiting = self.assert_cli_ok(receiver.cli_state("status", "DEL-TEST-004"))
        self.assertFalse(waiting["files_pruned"])
        receiver.start()
        self.assertTrue(self.assert_cli_ok(receiver.cli_send(1))["replayed"])
        self.assert_cli_ok(receiver.cli_state("retry", "DEL-TEST-004"))
        self.assertEqual(self.counts(), (1, 1, 2, 3, 2, 3))


if __name__ == "__main__":
    unittest.main(verbosity=2)
