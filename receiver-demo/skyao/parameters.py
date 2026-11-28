"""Versioned parameter definitions for the local SkyAO workspace."""

import json
import math
import re
from datetime import datetime, timezone
from uuid import uuid4

from .protocol import Problem

CODE = re.compile(r"[a-z][a-z0-9_]*")
TYPES = {"number", "choice", "project", "text"}


def valid_config(kind, config):
    def number(value):
        return value is None or type(value) is int and abs(value) <= 2**53 - 1 or type(value) is float and math.isfinite(value)

    def strings(row, *keys):
        return isinstance(row, dict) and all(isinstance(row.get(key), str) for key in keys)

    mode = config.get("mode")
    default = config.get("default")
    if kind == "number":
        fields = config.get("fields")
        check = config.get("check")
        return (
            isinstance(fields, list) and bool(fields)
            and (mode == "multiple" or mode == "single" and len(fields) == 1)
            and "check" in config and "percent_scale" in config
            and (check is None or check == "min_lte_max" and mode == "multiple" and len(fields) == 2
                 or check == "sum_to_percent" and mode == "multiple")
            and config.get("percent_scale") in (None, "1", "100")
            and "tolerance" in config and number(config["tolerance"])
            and all(
                strings(item, "name", "code") and item.get("number_type") in ("integer", "decimal")
                and all(key in item and number(item[key]) for key in ("minimum", "maximum", "default"))
                for item in fields
            )
        )
    if kind == "choice":
        options = config.get("options")
        return (
            "default" in config and isinstance(options, list) and all(strings(item, "name", "code") for item in options)
            and (mode == "single" and (default is None or isinstance(default, str))
                 or mode == "boolean" and (default is None or type(default) is bool)
                 or mode == "multiple" and (default is None or isinstance(default, list)
                                           and all(isinstance(item, str) for item in default)))
        )
    if kind == "project":
        sources = {
            "group": ("project", "scheme"),
            "grouping_scheme": ("project",),
            "comparison": ("project", "scheme", "task"),
            "gene_set": ("project", "task"),
            "task": ("project",),
        }
        return (
            strings(config, "object", "source", "dependency")
            and config["source"] in sources.get(config["object"], ())
            and mode in ("single", "multiple")
            and (default == "none" or default == "all" and mode == "multiple"
                 or default == "project_default" and config["object"] == "grouping_scheme")
        )
    return (
        mode in ("single", "multiple") and type(config.get("allow_blank")) is bool
        and "max_length" in config and number(config["max_length"])
        and "default" in config and (default is None or isinstance(default, str))
    )


def validate_review(card, existing):
    def require(condition, message):
        if not condition:
            raise Problem(422, "INVALID_PARAMETER", message)

    def row_codes(rows):
        codes = [row["code"] for row in rows]
        require(
            rows and all(row["name"].strip() and CODE.fullmatch(row["code"]) for row in rows)
            and len(codes) == len(set(codes)),
            "请为每个选项或子项填写名称及唯一的有效代码。",
        )
        return set(codes)

    config = card["config"]
    kind = card["type"]
    mode = config["mode"]
    if kind == "number":
        fields = config["fields"]
        scale = int(config["percent_scale"]) if config.get("percent_scale") else None
        if mode == "multiple":
            require(len(fields) >= 2, "多值参数至少需要两个数值子项。")
            row_codes(fields)
        if config["check"] == "sum_to_percent":
            tolerance = config["tolerance"]
            require(scale is not None and tolerance is not None and tolerance >= 0,
                    "请填写百分比传值尺度和允许误差。")
        defaults = [row["default"] for row in fields]
        for row in fields:
            minimum, maximum, value = (row[key] for key in ("minimum", "maximum", "default"))
            if row["number_type"] == "integer":
                require(all(item is None or item == int(item) for item in (minimum, maximum, value)),
                        "整数子项的边界与默认值须为整数。")
            require(minimum is None or maximum is None or minimum <= maximum, "最小允许值不能大于最大允许值。")
            require(value is None or (minimum is None or minimum <= value) and (maximum is None or value <= maximum),
                    "数值默认值超出允许边界。")
            require(scale is None or value is None or 0 <= value <= scale, "百分比默认值超出传值尺度。")
        if config["check"] == "min_lte_max":
            lower, upper = fields[0]["minimum"], fields[1]["maximum"]
            require(lower is None or upper is None or lower <= upper, "当前边界无法产生有效范围。")
            require(None in defaults or defaults[0] <= defaults[1], "默认值下界不能大于上界。")
        elif config["check"] == "sum_to_percent" and None not in defaults:
            total = math.fsum(defaults)
            require(abs(total - scale) <= tolerance + math.ulp(max(scale, total)) * len(fields),
                    "默认值的合计超出允许误差。")
    elif kind == "choice" and mode != "boolean":
        codes = row_codes(config["options"])
        default = config["default"]
        selected = default if isinstance(default, list) else [] if default is None else [default]
        require(set(selected) <= codes and len(selected) == len(set(selected)), "固定选项的默认值无效。")
    elif kind == "project" and config["source"] != "project":
        expected = {"scheme": "grouping_scheme", "task": "task"}[config["source"]]
        require(any(
            item["id"] != card.get("id") and item["code"] == config["dependency"]
            and CODE.fullmatch(item["code"]) and item["type"] == "project"
            and item["config"]["mode"] == "single" and item["config"]["object"] == expected
            for item in existing
        ), "请关联适合该选项来源的单选参数。")
    elif kind == "text":
        length, value = config["max_length"], config["default"]
        require(length is None or length == int(length) and length >= 1, "文本最大长度须为正整数。")
        require(value is None or (
            (config["allow_blank"] or value.strip()) and (length is None or len(value) <= length)
            and (mode == "multiple" or "\r" not in value and "\n" not in value)
        ), "默认文字不符合空白、换行或长度限制。")


class ParameterLibrary:
    def __init__(self, store, seed_path):
        self.store = store
        seed = json.loads(seed_path.read_text())
        with store.connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS parameter_definitions (
                    id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    revision INTEGER NOT NULL,
                    definition TEXT NOT NULL,
                    PRIMARY KEY (id, version)
                )
            """)
            db.executemany(
                "INSERT OR IGNORE INTO parameter_definitions VALUES (?, 1, 1, ?)",
                [(card["id"], json.dumps(card, ensure_ascii=False)) for card in seed],
            )

    def list(self):
        with self.store.connect() as db:
            rows = db.execute("SELECT definition FROM parameter_definitions ORDER BY rowid")
            return [json.loads(row["definition"]) for row in rows]

    def save(self, payload):
        if not isinstance(payload, dict) or not isinstance(payload.get("card"), dict):
            raise Problem(422, "INVALID_PARAMETER", "缺少参数定义。")
        source = payload["card"]
        action = payload.get("action")
        if action not in ("draft", "pending", "confirmed", "new_version"):
            raise Problem(422, "INVALID_PARAMETER", "未知的保存操作。")
        card_id, version, revision = (source.get(key) for key in ("id", "version", "revision"))
        if card_id is not None and (
            not isinstance(card_id, str) or type(version) is not int or type(revision) is not int
        ):
            raise Problem(422, "INVALID_PARAMETER", "参数版本标识无效。")
        card = {key: source.get(key) for key in ("name", "code", "type", "config", "description")}
        if (
            any(not isinstance(card[key], str) for key in ("name", "code", "type", "description"))
            or card["type"] not in TYPES or not isinstance(card["config"], dict)
            or not valid_config(card["type"], card["config"])
        ):
            raise Problem(422, "INVALID_PARAMETER", "参数定义格式无效。")
        card["name"] = card["name"].strip()
        card["code"] = card["code"].strip()
        target = "draft" if action == "new_version" else action
        if target != "draft" and (not card["name"] or not CODE.fullmatch(card["code"])):
            raise Problem(422, "INVALID_PARAMETER", "请填写名称和有效的参数代码。")

        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT definition FROM parameter_definitions")
            existing = [json.loads(row["definition"]) for row in rows]
            current = next((item for item in existing if item["id"] == card_id and item["version"] == version), None)
            if card_id is not None and (current is None or current["revision"] != revision):
                raise Problem(409, "PARAMETER_CONFLICT", "这张卡已在其他页面更新，请刷新后重试。")
            if action == "new_version":
                if current is None or current["status"] != "confirmed":
                    raise Problem(409, "PARAMETER_STATE", "请从已确认的版本创建新版本。")
                versions = [item for item in existing if item["id"] == card_id]
                latest = max(versions, key=lambda item: item["version"])
                if latest != current:
                    raise Problem(409, "PARAMETER_STATE", "请先处理同一参数的最新版本。")
                card = {key: current[key] for key in card}
                version, revision = current["version"] + 1, 0
            else:
                if current and current["status"] == "confirmed":
                    raise Problem(409, "PARAMETER_STATE", "已确认版本需通过新版本修改。")
                if action == "confirmed" and (not current or current["status"] != "pending"):
                    raise Problem(409, "PARAMETER_STATE", "请先提交待确认。")
                if action == "confirmed" and any(current[key] != value for key, value in card.items()):
                    raise Problem(409, "PARAMETER_STATE", "请先保存本次改动，再确认入库。")
                if card_id is None:
                    card_id, version, revision = str(uuid4()), 1, 0

            if card["code"] and any(
                item["code"] == card["code"] and item["id"] != card_id for item in existing
            ):
                raise Problem(409, "PARAMETER_CODE_TAKEN", "参数代码已被另一张卡使用。")
            if target != "draft":
                validate_review(dict(card, id=card_id), existing)
            card.update(
                id=card_id, version=version, revision=revision + 1, status=target,
                updated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
            db.execute("""
                INSERT INTO parameter_definitions VALUES (?, ?, ?, ?)
                ON CONFLICT(id, version) DO UPDATE
                SET revision = excluded.revision, definition = excluded.definition
            """, (card_id, version, card["revision"], json.dumps(card, ensure_ascii=False, allow_nan=False)))
        return card
