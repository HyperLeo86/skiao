"""V0.3 delta manifest. Target and renderer metadata are server-owned."""

import csv
import re

from PIL import Image

from .protocol import (
    CSV_SCHEMAS, Problem, SHA_PATTERN, array, canonical, check_file, csv_rows, fields,
    identifier, invalid, matches, nonnegative,
)
from .rehearsal_materials import builtin_nodes, BUILTIN_FLOW, table, image, render


def filename(value, path="文件名"):
    return matches(value, r"[\w .()+-]{1,160}", path, "UNSAFE_FILENAME")


def multipart_filename(raw):
    try:
        return filename(raw.decode("utf-8"))
    except UnicodeError:
        invalid("UNSAFE_FILENAME", "文件名须使用 UTF-8。")


def selector_key(value):
    return canonical(value)


def validate_manifest(doc, node, uploads):
    fields(doc, ("schema_version", "delivery_id", "analysis_run_id", "project_node_id", "result_units", "artifacts"), "Manifest")
    if doc["schema_version"] != "0.3":
        invalid("UNSUPPORTED_SCHEMA", "演练台要求结果项增量协议 V0.3。")
    for key in ("delivery_id", "analysis_run_id", "project_node_id"):
        identifier(doc[key], key)
    artifacts = {}
    for item in array(doc["artifacts"], "artifacts"):
        fields(item, ("file_name", "size_bytes", "sha256"), "artifacts[]")
        name = filename(item["file_name"])
        if name in artifacts:
            invalid("DUPLICATE_FILE", f"文件 {name} 重复。")
        nonnegative(item["size_bytes"], "size_bytes")
        matches(item["sha256"], SHA_PATTERN, "sha256")
        artifacts[name] = item
    if artifacts.keys() != uploads.keys():
        invalid("FILE_SET_MISMATCH", "实际投送文件与 Manifest 不一致。")
    for name, item in artifacts.items():
        check_file(item, uploads[name].size, uploads[name].sha256)

    template = node["definition"]
    specs = {item["id"]: item for item in template["results"]}
    used, scopes = set(), set()
    for unit in array(doc["result_units"], "result_units"):
        dimensions = template["selectors"]
        fields(unit, ("selectors", "result_items"), "result_units[]")
        fields(unit["selectors"], dimensions, "result_units[].selectors")
        for key, value in unit["selectors"].items():
            if not isinstance(value, str) or value not in dimensions[key]:
                invalid("UNKNOWN_SELECTOR", f"{key} 中没有登记该编号。")
        scope = selector_key(unit["selectors"])
        if scope in scopes:
            invalid("DUPLICATE_SCOPE", "同一范围只应登记一个结果单元。")
        scopes.add(scope)
        targets = set()
        for item in array(unit["result_items"], "result_items"):
            fields(item, ("result_item_id", "sources"), "result_items[]")
            target = identifier(item["result_item_id"], "result_item_id")
            spec = specs.get(target)
            if spec is None or spec["type"] == "render":
                invalid("UNKNOWN_TARGET", f"{target} 不是该项目节点的可上传位置。")
            if target in targets:
                invalid("DUPLICATE_TARGET", f"同一范围的 {target} 只允许一个文件。")
            targets.add(target)
            fields(item["sources"], ("data",), "sources")
            name = filename(item["sources"]["data"])
            if name not in uploads or name in used:
                invalid("INVALID_SOURCE", f"{name} 缺失或重复绑定。")
            used.add(name)
            validate_payload(spec, uploads[name].path, name)
    if used != uploads.keys():
        invalid("UNBOUND_FILE", "存在尚未绑定结果项的文件。")


def validate_payload(spec, path, name):
    title = spec["name"]
    if spec["type"] == "image":
        if not name.lower().endswith(".png"):
            invalid("INVALID_PNG", f"{title} 需要 PNG 文件。")
        try:
            with Image.open(path) as image_:
                if image_.format != "PNG" or image_.width * image_.height > 16_000_000 or getattr(image_, "n_frames", 1) != 1:
                    raise ValueError
                image_.verify()
            with Image.open(path) as image_:
                image_.load()
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
            invalid("INVALID_PNG", f"{title} 的 {name} 不是可读取的静态 PNG，或图片尺寸超限。")
        return
    if not name.lower().endswith(".csv"):
        invalid("INVALID_CSV", f"{title} 需要 CSV 文件。")
    required, identity, numeric = CSV_SCHEMAS[spec["schema"]]
    try:
        columns, ids = csv_rows(path, name, required, identity=identity, numeric=numeric,
                                adjusted=spec["schema"] == "difference")
    except Problem as exc:
        missing = re.search(r"missing columns (.+)\.$", str(exc))
        if missing:
            invalid("INVALID_CSV", f"{title}缺少 {missing[1]} 列。")
        invalid("INVALID_CSV", f"{title}的 CSV 格式错误 · {exc}")
    if spec["schema"] == "matrix" and (not 2 <= len(columns) <= 81 or len(ids) > 200):
        invalid("INVALID_CSV", f"{title}需要 1–80 个样本列及最多 200 行数据。")
    if spec["schema"] in {"pca", "annotation"} and len(ids) > 2500:
        invalid("INVALID_CSV", f"{title}最多接收 2500 行。")
    if not identity:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            entries = csv.reader(stream)
            next(entries)
            if next(entries, None) is None:
                invalid("INVALID_CSV", f"{title}需要至少一条数据行。")


def printable_name(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 160 or any(ord(char) < 32 for char in value):
        invalid("INVALID_NAME", "名称须为 1–160 个可显示字符。")
    return value.strip()


def template_version(value):
    if type(value) is not int or not 1 <= value <= 99999:
        invalid("INVALID_TEMPLATE", "模板或节点版本须为有效整数。")
    return value


def project_blueprint(bundle):
    if bundle is None:
        return BUILTIN_FLOW, builtin_nodes()
    fields(bundle, ("flow", "nodes"), "template")
    flow, raw_nodes = bundle["flow"], array(bundle["nodes"], "template.nodes")
    if not isinstance(flow, dict) or flow.get("status") != "confirmed":
        invalid("INVALID_TEMPLATE", "请选择已确认的流程版本。")
    sections = array(flow.get("sections"), "flow.sections")
    entries = []
    section_ids, entry_ids = set(), set()
    if len(sections) > 30 or len(raw_nodes) > 60:
        invalid("TEMPLATE_LIMIT", "演练最多接收 30 个一级目录和 60 个节点。")
    by_version = {}
    for node in raw_nodes:
        if not isinstance(node, dict) or node.get("status") != "confirmed":
            invalid("INVALID_TEMPLATE", "模板包含未确认的节点。")
        key = (identifier(node.get("id"), "node.id"), template_version(node.get("version")))
        by_version[key] = node
    for section in sections:
        fields(section, ("id", "title", "nodes"), "section")
        section_id = identifier(section["id"], "section.id")
        if section_id in section_ids:
            invalid("INVALID_TEMPLATE", "目录编号重复。")
        section_ids.add(section_id)
        for entry in array(section["nodes"], "section.nodes"):
            fields(entry, ("id", "node_id", "node_version"), "entry")
            entry_id = identifier(entry["id"], "entry.id")
            if entry_id in entry_ids or len(entries) >= 60:
                invalid("INVALID_TEMPLATE", "条目编号重复或超出节点数量上限。")
            entry_ids.add(entry_id)
            key = (identifier(entry["node_id"], "node_id"), template_version(entry["node_version"]))
            node = by_version.get(key)
            if node is None:
                invalid("INVALID_TEMPLATE", f"找不到节点 {key[0]} v{key[1]}。")
            entries.append(dict(section_id=section_id, section_title=printable_name(section["title"]), entry_id=entry_id,
                                node_id=key[0], node_version=key[1], node_title=printable_name(node.get("name")),
                                selectors={}, results=import_results(node), source_node=node))
    return dict(id=identifier(flow.get("id"), "flow.id"), name=printable_name(flow.get("name")),
                version=template_version(flow.get("version"))), entries


def import_results(node):
    raw = array(node.get("results"), "node.results")
    ids = set()
    definitions = []
    if len(raw) > 40:
        invalid("TEMPLATE_LIMIT", "每个节点最多接收 40 个结果位置。")
    for item in raw:
        if not isinstance(item, dict):
            invalid("INVALID_TEMPLATE", "结果项无效。")
        id_ = identifier(item.get("id"), "result.id")
        if id_ in ids:
            invalid("INVALID_TEMPLATE", "节点中有重复结果编号。")
        ids.add(id_)
        name, kind = printable_name(item.get("name")), item.get("type")
        if kind == "table":
            definitions.append({**table(id_, name, f"result_{id_}"), "visible": item.get("visible", True) is True})
        elif kind == "image":
            definitions.append(image(id_, name, f"result_{id_}"))
        elif kind == "render":
            source = identifier(item.get("source_table_id"), "source_table_id")
            script = identifier(item.get("default_script_ref"), "default_script_ref")
            definitions.append(render(id_, name, script, {"data": source}))
        else:
            invalid("INVALID_TEMPLATE", "仅接收表格、原生图片和渲染图片定义。")
    sources = {item["id"]: item for item in definitions if item["type"] == "table"}
    for item in definitions:
        if item["type"] != "render":
            continue
        source = sources.get(item["inputs"]["data"])
        if not source:
            invalid("INVALID_TEMPLATE", "渲染图片必须引用本节点的表格。")
        if item["script"] == "pca":
            source["schema"] = "pca"
    return definitions
