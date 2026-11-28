// Parse UTF-8 CSV returned by the artifact API. The receiver validates the
// headers and row widths before exposing file references.
export function csv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"' && (quoted || field === "")) {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(field);
      field = "";
    } else if (!quoted && (char === "\r" || char === "\n")) {
      rows.push([...row, field]);
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (row.length || field !== "" || text.endsWith('""') || text.endsWith(",")) rows.push([...row, field]);
  return {columns: rows.shift(), rows};
}

function escapeText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function column({columns, rows}, name, transform = Number) {
  const index = columns.indexOf(name);
  return rows.map(row => transform(row[index]));
}

function gaussianDensity(values) {
  const scale = Math.max(1, ...values.reduce((extrema, value) => [
    Math.min(extrema[0], value), Math.max(extrema[1], value),
  ], [0, 0]).map(Math.abs));
  const normalized = values.map(value => value / scale);
  const mean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const variance = normalized.reduce((sum, value) => sum + (value - mean) ** 2, 0) / normalized.length;
  const bandwidth = 1.06 * Math.sqrt(variance) * normalized.length ** -0.2 || Math.max(Math.abs(mean) * .02, .05 / scale);
  const extent = normalized.reduce((range, value) => [
    Math.min(range[0], value), Math.max(range[1], value),
  ], [Infinity, -Infinity]);
  const low = Math.max(-Number.MAX_VALUE / scale, extent[0] - 3 * bandwidth);
  const high = Math.min(Number.MAX_VALUE / scale, extent[1] + 3 * bandwidth);
  const x = [], y = [];
  for (let i = 0; i < 120; i += 1) {
    const point = low + (high - low) * i / 119;
    x.push(point * scale);
    y.push(normalized.reduce((sum, value) => sum + Math.exp(-0.5 * ((point - value) / bandwidth) ** 2), 0)
      / normalized.length / (bandwidth * scale) / Math.sqrt(2 * Math.PI));
  }
  return {x, y};
}

export function plotSpec(type, inputs, style) {
  const {color, fontSize} = style;
  const data = inputs.data;
  const marker = {color, size: 7};
  let traces, xLabel, yLabel;
  if (type === "boxplot" || type === "violin") {
    traces = [{
      type: type === "boxplot" ? "box" : "violin",
      y: column(data, "log2_expression"),
      text: column(data, "feature_id", escapeText),
      name: "表达量",
      marker,
      points: "all",
      boxpoints: "all",
      line: {color},
      jitter: .32,
    }];
    yLabel = "log₂ 表达量";
  } else if (type === "density") {
    traces = [{type: "scatter", mode: "lines", ...gaussianDensity(column(data, "log2_expression")), line: {color}}];
    xLabel = "log₂ 表达量";
    yLabel = "概率密度";
  } else if (type === "volcano" || type === "ma_plot") {
    const volcano = type === "volcano";
    traces = [{
      type: "scatter", mode: "markers", marker,
      x: column(data, volcano ? "log2_fc" : "mean_log2_expression"),
      y: volcano ? column(data, "p_adjusted", value => -Math.log10(Number(value))) : column(data, "log2_fc"),
      text: column(data, "feature_id", escapeText),
    }];
    xLabel = volcano ? "log₂ 倍数变化" : "平均 log₂ 表达量";
    yLabel = volcano ? "−log₁₀ 调整后 p 值" : "log₂ 倍数变化";
  } else if (type === "pca") {
    traces = [{
      type: "scatter", mode: "markers", marker,
      x: column(data, "PC1"), y: column(data, "PC2"),
      text: data.rows.map((_, index) => {
        const row = data.rows[index];
        return escapeText(row[data.columns.indexOf("sample_id")] + " · " + row[data.columns.indexOf("group")]);
      }),
    }];
    xLabel = "PC1";
    yLabel = "PC2";
  } else if (type === "heatmap") {
    const matrix = inputs.matrix;
    const annotation = inputs.annotation;
    const group = new Map(annotation.rows.map(row => [
      row[annotation.columns.indexOf("sample_id")], row[annotation.columns.indexOf("group")],
    ]));
    const samples = matrix.columns.slice(1);
    const labels = samples.map(sample => escapeText(sample + " · " + group.get(sample)));
    traces = [{
      type: "heatmap", x: labels,
      y: column(matrix, "feature_id", escapeText),
      z: matrix.rows.map(row => row.slice(1).map(Number)),
      colorscale: [[0, "#f4f8f5"], [1, color]],
      hovertemplate: "%{y} · %{x}<br>表达量 %{z}<extra></extra>",
    }];
    xLabel = "样本 · 分组";
    yLabel = "特征";
  } else {
    throw new Error("未知图表类型");
  }
  const axis = title => ({title: {text: title}, automargin: true, gridcolor: "#e8eeea", zerolinecolor: "#cdd9d2"});
  return {
    traces,
    layout: {
      height: type === "heatmap" ? 390 : 330,
      margin: {t: 18, r: 24, b: 56, l: 65},
      font: {family: "Inter, PingFang SC, sans-serif", size: fontSize, color: "#202b28"},
      xaxis: axis(xLabel),
      yaxis: {...axis(yLabel), autorange: type === "heatmap" ? "reversed" : true},
      showlegend: false,
    },
  };
}
