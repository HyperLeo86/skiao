"""Synthetic project definitions, downloadable materials and image rendering."""

import csv
import hashlib
from io import BytesIO, StringIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILTIN_FLOW = {"id": "F-REHEARSAL", "name": "结果投送演练模板 · 合成数据", "version": 1}
SAMPLES = {"S01": "样本 1", "S02": "样本 2"}
COMPARISONS = {"C_AB": "A vs B", "C_BC": "B vs C"}


def table(id_, name, stem, schema="table", versions="A"):
    return dict(id=id_, name=name, type="table", visible=True, stem=stem, schema=schema, versions=list(versions))


def image(id_, name, stem):
    return dict(id=id_, name=name, type="image", stem=stem, versions=["A"])


def render(id_, name, script, inputs):
    return dict(id=id_, name=name, type="render", script=script, inputs=inputs)


TEMPLATE_NODES = [
    ("数据质控", "质控汇总", {}, [table("T1", "质控汇总表", "qc")]),
    ("样本信息", "样本概览", {"sample": SAMPLES}, [table("T1", "样本信息表", "sample")]),
    ("定量结果", "定量结果展示", {}, [table("T1", "定量主表", "quant", versions="AB"), table("T2", "定量摘要", "quant_summary")]),
    ("表达分布", "分布图展示", {}, [image("P1", "表达分布图", "distribution")]),
    ("样本相关", "相关性展示", {}, [image("P1", "样本相关性图", "correlation")]),
    ("主成分分析", "PCA 展示", {}, [table("T1", "PCA 坐标表", "pca", "pca", "AB"), render("G1", "PCA 图", "pca", {"data": "T1"})]),
    ("聚类展示", "热图展示", {}, [
        table("T1", "数值矩阵", "matrix", "matrix"), table("T2", "样本注释", "annotation", "annotation"),
        render("G1", "表达热图", "heatmap", {"matrix": "T1", "annotation": "T2"}),
    ]),
    ("差异结果", "比较对结果", {"comparison": COMPARISONS}, [
        table("T1", "差异结果表", "difference", "difference"), image("P1", "差异结果图", "difference"),
    ]),
    ("功能注释", "注释结果", {}, [table("T1", "功能注释表", "functional_annotation")]),
    ("富集结果", "富集结果展示", {}, [table("T1", "富集结果表", "enrichment"), image("P1", "富集结果图", "enrichment")]),
]


def builtin_nodes():
    return [
        dict(section_id=f"S{i}", section_title=section, entry_id=f"E{i}", node_id=f"N-REHEARSAL-{i:02d}",
             node_version=1, node_title=title, selectors=selectors, results=results)
        for i, (section, title, selectors, results) in enumerate(TEMPLATE_NODES, 1)
    ]


def csv_bytes(rows):
    stream = StringIO(newline="")
    csv.writer(stream, lineterminator="\n").writerows(rows)
    return stream.getvalue().encode("utf-8")


def demo_csv(spec, version, selectors):
    schema, stem = spec["schema"], spec["stem"]
    fixtures = ROOT / "fixtures"
    if schema in {"matrix", "annotation"}:
        return (fixtures / "03_overview" / "files" / (schema + ".csv")).read_bytes()
    if schema == "difference":
        filename = selectors.get("comparison", "C_AB") + ".csv"
        return (fixtures / "02_comparisons" / "files" / filename).read_bytes()
    if schema == "pca":
        with (fixtures / "03_overview" / "files" / "pca.csv").open(newline="") as stream:
            rows = list(csv.reader(stream))
        for index, row in enumerate(rows[1:]):
            if version == "B":
                row[2:4] = [str(round(float(row[2]) * -2 + 5, 2)),
                            str(round(float(row[3]) * 3 - 4 + index / 3, 2))]
            row.append(version)
        return csv_bytes([rows[0] + ["material_version"], *rows[1:]])
    if stem == "quant":
        abundance = [22, 39, 54] if version == "A" else [120, 215, 179]
        return csv_bytes([["feature_id", "abundance", "material_version"],
                          *[(f"G{i:03d}", value, version) for i, value in enumerate(abundance, 1)]])
    if stem == "sample":
        sample = selectors["sample"]
        return csv_bytes([["sample_id", "sequence_reads", "material_version"], [sample, 3160000 + 10000 * int(sample[1:]), version]])
    examples = {
        "qc": [["sample_id", "mapped_pct"], ["S01", "94.8"], ["S02", "96.1"]],
        "quant_summary": [["metric", "count"], ["features", "3"], ["samples", "2"]],
        "functional_annotation": [["feature_id", "annotation"], ["G001", "Example enzyme"], ["G002", "Example binding"]],
        "enrichment": [["term_id", "feature_count", "p_adjusted"], ["TERM01", "7", "0.02"], ["TERM02", "5", "0.04"]],
    }
    rows = examples.get(stem, [["feature_id", "value"], ["G001", "3.1"], ["G002", "4.8"]])
    return csv_bytes([row + ["material_version" if not index else version] for index, row in enumerate(rows)])


def sample_png(stem, scope):
    image_ = Image.new("RGB", (720, 400), "#f7f5fd")
    draw = ImageDraw.Draw(image_)
    draw.text((42, 30), f"SkyAO synthetic | {stem} | {scope or 'overall'}", fill="#272245", font_size=20)
    draw.line([(48, 340), (663, 340)], fill="#8b80a5", width=2)
    draw.line([(48, 340), (48, 78)], fill="#8b80a5", width=2)
    digest = hashlib.sha256(f"{stem}:{scope}".encode()).digest()
    for i in range(10):
        height = 35 + digest[i] % 200
        x = 72 + 57 * i
        draw.rounded_rectangle((x, 340 - height, x + 29, 339), radius=5, fill="#6e55c7" if i % 2 else "#a78ce5")
    output = BytesIO()
    image_.save(output, format="PNG")
    return output.getvalue()


def scopes(dimensions):
    from itertools import product

    keys = list(dimensions)
    return [dict(zip(keys, values)) for values in product(*(dimensions[key] for key in keys))]


def material_archive(project, nodes):
    output = BytesIO()
    with ZipFile(output, mode="w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("使用说明.txt", f"{project['name']} · {project['id']}\n解压后选择 CSV 或 PNG 原件。按每个目录的说明选择目标。\nA 与 B 是同一位置的不同材料。推荐每次只绑定其中一版。\n")
        for index, node in enumerate(nodes, 1):
            template = node["definition"]
            directory = f"{index:02d}_{node['id']}"
            lines = [f"推荐路径：{project['name']} → {node['section_title']} → {node['node_title']}",
                     f"项目节点 ID：{node['id']}，来源节点：{node['node_id']} v{node['node_version']}"]
            for selector in scopes(template["selectors"]):
                scope = "_".join(selector.values())
                for spec in template["results"]:
                    if spec["type"] == "render":
                        continue
                    for version in spec["versions"]:
                        extension = "csv" if spec["type"] == "table" else "png"
                        suffix = "_" + scope if scope else ""
                        name = f"{spec['stem']}{suffix}_{version}.{extension}"
                        data = demo_csv(spec, version, selector) if extension == "csv" else sample_png(spec["stem"], scope)
                        archive.writestr(f"{directory}/{name}", data)
                        ranges = "、".join(
                            f"{dimensions_title(key)}：{template['selectors'][key][value]}（{value}）" for key, value in selector.items()
                        )
                        lines.append(f"{name} → {spec['name']}（{spec['id']}）" + (f" · {ranges}" if ranges else " · 整体"))
            for spec in template["results"]:
                if spec["type"] == "render":
                    lines.append(f"{spec['name']}（{spec['id']}）由平台按固定输入生成。")
            archive.writestr(f"{directory}/投递说明.txt", "\n".join(lines) + "\n")
    output.seek(0)
    return output


def dimensions_title(key):
    return {"sample": "样本", "comparison": "比较对"}.get(key, key)


def plot_image(script, files, output):
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure
    from matplotlib.ticker import MaxNLocator

    def read(role):
        with files[role].open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            return reader.fieldnames, list(reader)

    figure = Figure(figsize=(7.2, 4.5), dpi=120, layout="constrained")
    FigureCanvasAgg(figure)
    axes = figure.subplots()
    if script == "pca":
        _, rows = read("data")
        groups = {}
        for row in rows:
            groups.setdefault(row["group"], []).append(row)
        for label, points in groups.items():
            axes.scatter([float(point["PC1"]) for point in points], [float(point["PC2"]) for point in points], label=label, s=48)
        axes.set(xlabel="PC1", ylabel="PC2", title="PCA · supplied coordinates")
        axes.grid(alpha=.2)
        axes.xaxis.set_major_locator(MaxNLocator(6))
        axes.yaxis.set_major_locator(MaxNLocator(6))
        if len(groups) <= 12:
            axes.legend(loc="best")
    elif script == "heatmap":
        if not {"matrix", "annotation"} <= files.keys():
            raise ValueError("该模板未配置热图的矩阵和样本注释两个输入。")
        columns, rows = read("matrix")
        _, annotation = read("annotation")
        groups = {row["sample_id"]: row["group"] for row in annotation}
        samples = columns[1:]
        if set(samples) != groups.keys():
            raise ValueError("样本注释与数值矩阵的样本编号不一致。")
        image_ = axes.imshow([[float(row[sample]) for sample in samples] for row in rows], aspect="auto", cmap="Purples")
        axes.set_xticks(range(len(samples)), [f"{sample} / {groups[sample]}" for sample in samples], rotation=40, ha="right")
        if len(rows) <= 30:
            axes.set_yticks(range(len(rows)), [row["feature_id"] for row in rows])
        axes.set(title="Expression matrix · supplied values", xlabel="Sample / group", ylabel="Feature")
        figure.colorbar(image_, ax=axes, label="Value")
    else:
        raise ValueError("该模板的绘图脚本尚未接入。")
    figure.savefig(output, format="png")
