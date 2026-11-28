"""Manifest V0.2 and the receiver's CSV renderer contracts."""

import csv
import hashlib
import json
import math
import re
from pathlib import Path

ID_PATTERN = r"[A-Za-z0-9_.-]{1,128}"
FILE_PATTERN = r"[A-Za-z0-9_.-]{1,200}"
SHA_PATTERN = r"[a-f0-9]{64}"
CHUNK = 64 * 1024

DIMENSIONS = {
    "sample": ("样本", "samples"),
    "comparison": ("比对组", "comparisons"),
    "group": ("实验组", "groups"),
    "feature_level": ("分析层级", "feature_levels"),
}
RENDERERS = {
    "boxplot": ("箱线图", {"data"}, True),
    "violin": ("小提琴图", {"data"}, True),
    "density": ("密度分布图", {"data"}, True),
    "volcano": ("火山图", {"data"}, True),
    "ma_plot": ("MA 图", {"data"}, True),
    "table": ("数据表", {"data"}, False),
    "heatmap": ("热图", {"matrix", "annotation"}, True),
    "pca": ("PCA 图", {"data"}, True),
}


class Problem(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code

    def body(self):
        return {"error": {"code": self.code, "message": str(self)}}


def invalid(code, message):
    raise Problem(422, code, message)


def canonical(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":"))


def read_json(raw):
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                raise ValueError("duplicate JSON key")
            obj[key] = value
        return obj

    def reject_constant(value):
        raise ValueError("nonfinite JSON number")

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            reject_constant(value)
        return number

    try:
        return json.loads(
            raw.decode("utf-8"), object_pairs_hook=unique,
            parse_constant=reject_constant, parse_float=finite_float,
        )
    except (ValueError, RecursionError):
        raise Problem(400, "INVALID_JSON", "Expected UTF-8 JSON with unique object keys.") from None


def fields(value, required, path, optional=()):
    if type(value) is not dict or set(required) - value.keys() or value.keys() - set(required) - set(optional):
        invalid("INVALID_FIELDS", f"{path} has missing, extra, or invalid fields.")


def array(value, path):
    if type(value) is not list or not value:
        invalid("INVALID_TYPE", f"{path} must be a nonempty array.")
    return value


def matches(value, pattern, path, code="INVALID_TYPE"):
    if type(value) is not str or not re.fullmatch(pattern, value) or value in {".", ".."}:
        invalid(code, f"{path} has an invalid value.")
    return value


def identifier(value, path):
    return matches(value, ID_PATTERN, path)


def file_name(value, path):
    return matches(value, FILE_PATTERN, path, "UNSAFE_FILENAME")


def nonnegative(value, path):
    if type(value) is not int or value < 0:
        invalid("INVALID_TYPE", f"{path} must be a nonnegative integer.")


def validate_manifest(doc, *, draft=False, context=None):
    required = [
        "schema_version", "analysis_run_id", "section_key", "node_key",
        "node_title", "sort_order", "result_units", "artifacts",
    ]
    optional = ["compute_job_id"]
    (optional if draft else required).append("delivery_id")
    fields(doc, required, "manifest", optional)
    if doc["schema_version"] != "0.2":
        invalid("UNSUPPORTED_SCHEMA", "schema_version must be 0.2.")
    for key in ("analysis_run_id", "section_key", "node_key", "delivery_id", "compute_job_id"):
        if key in doc:
            identifier(doc[key], key)
    if "compute_job_id" in doc:
        invalid("JOB_NOT_SUPPORTED", "Registration of compute jobs is disabled for this receiver.")
    title = doc["node_title"]
    if type(title) is not str or not 1 <= len(title) <= 200 or not title.strip() or re.search(r"[\ud800-\udfff]", title):
        invalid("INVALID_TYPE", "node_title must be a nonblank Unicode string of 1–200 characters.")
    nonnegative(doc["sort_order"], "sort_order")
    if context is not None and doc["section_key"] not in context["sections"]:
        invalid("UNKNOWN_SECTION", "section_key is not registered for this run.")

    names = set()
    for artifact in array(doc["artifacts"], "artifacts"):
        metadata = ("size_bytes", "sha256")
        fields(artifact, ("file_name",) if draft else ("file_name", *metadata), "artifact", metadata if draft else ())
        name = file_name(artifact["file_name"], "artifact.file_name")
        if name in names:
            invalid("DUPLICATE_FILE", "Artifact names must be unique.")
        names.add(name)
        if "size_bytes" in artifact:
            nonnegative(artifact["size_bytes"], "artifact.size_bytes")
        if "sha256" in artifact:
            matches(artifact["sha256"], SHA_PATTERN, "artifact.sha256")

    identities = set()
    selector_keys = None
    referenced = set()
    for unit in array(doc["result_units"], "result_units"):
        fields(unit, ("selectors", "render_groups"), "result unit")
        selectors = unit["selectors"]
        if type(selectors) is not dict:
            invalid("INVALID_TYPE", "selectors must be an object.")
        for key, value in selectors.items():
            if key not in DIMENSIONS:
                invalid("UNKNOWN_DIMENSION", "A selector dimension is not registered.")
            identifier(value, "selector value")
            if context is not None and value not in context[DIMENSIONS[key][1]]:
                invalid("UNKNOWN_SELECTOR", f"{key}={value} is not registered for this run.")
        keys = sorted(selectors)
        if selector_keys is not None and selector_keys != keys:
            invalid("SELECTOR_DIMENSIONS", "All result units must use the same selector keys.")
        selector_keys = keys
        identity = canonical(selectors)
        if identity in identities:
            invalid("DUPLICATE_SELECTORS", "A delivery cannot contain duplicate selector combinations.")
        identities.add(identity)

        seen = set()
        for group in array(unit["render_groups"], "render_groups"):
            fields(group, ("render_types", "sources", "editable"), "render group")
            if type(group["editable"]) is not bool or type(group["sources"]) is not dict:
                invalid("INVALID_TYPE", "editable must be boolean and sources must be an object.")
            roles = set()
            for renderer in array(group["render_types"], "render_types"):
                if type(renderer) is not str or renderer not in RENDERERS:
                    invalid("UNKNOWN_RENDERER", "A render_type is not registered.")
                if renderer in seen:
                    invalid("DUPLICATE_RENDERER", f"{renderer} occurs multiple times in the result unit.")
                seen.add(renderer)
                roles.update(RENDERERS[renderer][1])
            if set(group["sources"]) != roles:
                invalid("INVALID_SOURCE_ROLES", f"Expected source roles: {', '.join(sorted(roles))}.")
            for name in group["sources"].values():
                file_name(name, "sources file name")
                if name not in names:
                    invalid("UNKNOWN_SOURCE", f"{name} is not declared in artifacts.")
                referenced.add(name)
    if names != referenced:
        invalid("UNREFERENCED_ARTIFACT", "Every artifact must be referenced by a render group.")
    return selector_keys


def fingerprint_file(source, target=None):
    size = 0
    sha = hashlib.sha256()
    for chunk in iter(lambda: source.read(CHUNK), b""):
        sha.update(chunk)
        size += len(chunk)
        if target is not None:
            target.write(chunk)
    return size, sha.hexdigest()


def check_file(artifact, size, digest):
    name = artifact["file_name"]
    if "size_bytes" in artifact and artifact["size_bytes"] != size:
        invalid("SIZE_MISMATCH", f"{name} size does not match the manifest.")
    if "sha256" in artifact and artifact["sha256"] != digest:
        invalid("CHECKSUM_MISMATCH", f"{name} SHA-256 does not match the manifest.")


def csv_rows(path: Path, name, required, *, identity=None, numeric=(), adjusted=False):
    def fail(reason):
        invalid("INVALID_CSV", f"{name}: {reason}.")

    try:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            rows = csv.reader(stream, strict=True)
            columns = next(rows, [])
            if not columns or any(not column.strip() for column in columns) or len(set(columns)) != len(columns):
                fail("expected a nonempty header with unique column names")
            missing = set(required) - set(columns)
            if missing:
                fail(f"missing columns {', '.join(sorted(missing))}")
            number_columns = [(column, columns.index(column)) for column in (columns[1:] if numeric == "*" else numeric)]
            identity_index = columns.index(identity) if identity else None
            seen = {}
            for row_number, row in enumerate(rows, start=2):
                if len(row) != len(columns):
                    fail(f"row {row_number} has the wrong column count")
                if identity_index is not None:
                    key = row[identity_index]
                    if not key.strip() or key in seen:
                        fail(f"row {row_number} has an empty or repeated {identity}")
                    seen[key] = row[columns.index("group")] if "group" in required else None
                    if "group" in required and not seen[key].strip():
                        fail(f"row {row_number} has an empty group")
                for column, index in number_columns:
                    value = row[index].strip()
                    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value):
                        fail(f"row {row_number} column {column} must be a finite number")
                    number = float(value)
                    if not math.isfinite(number):
                        fail(f"row {row_number} column {column} must be a finite number")
                    if adjusted and column == "p_adjusted" and not 0 < number <= 1:
                        fail(f"row {row_number} p_adjusted must be in (0, 1]")
            if identity and not seen:
                fail("expected at least one data row")
            return columns, seen
    except (UnicodeError, csv.Error):
        fail("expected well-formed UTF-8 CSV")


CSV_SCHEMAS = {
    "expression": (("feature_id", "log2_expression"), "feature_id", ("log2_expression",)),
    "difference": (
        ("feature_id", "mean_log2_expression", "log2_fc", "p_adjusted"),
        "feature_id", ("mean_log2_expression", "log2_fc", "p_adjusted"),
    ),
    "table": ((), None, ()),
    "matrix": (("feature_id",), "feature_id", "*"),
    "annotation": (("sample_id", "group"), "sample_id", ()),
    "pca": (("sample_id", "group", "PC1", "PC2"), "sample_id", ("PC1", "PC2")),
}
RENDERER_SCHEMAS = {
    "boxplot": {"data": "expression"}, "violin": {"data": "expression"},
    "density": {"data": "expression"}, "volcano": {"data": "difference"},
    "ma_plot": {"data": "difference"}, "table": {"data": "table"},
    "pca": {"data": "pca"}, "heatmap": {"matrix": "matrix", "annotation": "annotation"},
}


def validate_data(doc, uploaded):
    cache = {}
    for unit in doc["result_units"]:
        for group in unit["render_groups"]:
            for renderer in group["render_types"]:
                inputs = {}
                for role, schema in RENDERER_SCHEMAS[renderer].items():
                    name = group["sources"][role]
                    key = (name, schema)
                    if key not in cache:
                        if not name.lower().endswith(".csv"):
                            invalid("INVALID_CSV", f"{name} must be a CSV for {renderer}.")
                        required, identity, numeric = CSV_SCHEMAS[schema]
                        cache[key] = csv_rows(
                            uploaded[name].path, name, required,
                            identity=identity, numeric=numeric, adjusted=schema == "difference",
                        )
                    inputs[role] = cache[key]
                if renderer == "heatmap":
                    columns, _ = inputs["matrix"]
                    _, samples = inputs["annotation"]
                    if columns[0] != "feature_id" or set(columns[1:]) != samples.keys():
                        invalid("HEATMAP_SAMPLE_MISMATCH", "Heatmap matrix columns and annotation samples must match.")
