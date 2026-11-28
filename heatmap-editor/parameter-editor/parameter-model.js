export const types = {number: "数值", choice: "固定选项", project: "项目对象", text: "文本"};
export const statuses = {draft: "草稿", pending: "待确认", confirmed: "已确认"};
export const objects = {group: "分组", grouping_scheme: "分组方案", comparison: "比较对", gene_set: "基因集", task: "任务"};
export const sources = {project: "当前项目", scheme: "所选分组方案", task: "所选任务"};
export const strategies = {none: "不预选", all: "全部选中", project_default: "使用项目默认方案"};
export const dependencyTypes = {scheme: "grouping_scheme", task: "task"};
const codePattern = /^[a-z][a-z0-9_]*$/;

export const field = (name = "", code = "", minimum = null) => ({
  name, code, number_type: "integer", minimum, maximum: null, default: null,
});
export const option = () => ({name: "", code: ""});
export const preset = config => config.mode === "single" ? "single" : config.check === "min_lte_max" ? "range" : "multiple";
export const availableSources = object => ["project", ...({
  group: ["scheme"], comparison: ["scheme", "task"], gene_set: ["task"],
}[object] || [])];
export const availableStrategies = config => [
  "none",
  ...(config.mode === "multiple" ? ["all"] : []),
  ...(config.object === "grouping_scheme" && config.source === "project" ? ["project_default"] : []),
];

export function numberConfig(kind) {
  const fields = kind === "single" ? [field()] :
    kind === "range" ? [field("下界", "min"), field("上界", "max")] : [field()];
  return {mode: kind === "single" ? "single" : "multiple", fields,
    check: kind === "range" ? "min_lte_max" : null, percent_scale: null, tolerance: null};
}

export function newConfig(type) {
  switch (type) {
    case "number": return numberConfig("single");
    case "choice": return {mode: "single", options: [option()], default: null};
    case "project": return {mode: "single", object: "grouping_scheme", source: "project", dependency: "", default: "none"};
    case "text": return {mode: "single", allow_blank: true, max_length: null, default: null};
  }
}

export function dependencies(card, cards) {
  const expected = dependencyTypes[card.config.source];
  const matches = cards.filter(other => other.id !== card.id && codePattern.test(other.code) &&
    other.type === "project" && other.config.mode === "single" && other.config.object === expected);
  return Array.from(new Map(matches.map(item => [item.code, item])).values());
}

export function textIssue(value, config) {
  if (value === null) return null;
  if (!config.allow_blank && !value.trim()) return "请填写非空白文字。";
  if (config.mode === "single" && /[\r\n]/.test(value)) return "单行文本不能包含换行。";
  if (config.max_length !== null && Array.from(value).length > config.max_length) return `文字最多 ${config.max_length} 个字符。`;
  return null;
}

function numberIssue(value, field) {
  if (value === null) return null;
  if (!Number.isFinite(value)) return "请输入有效数值";
  if (field.number_type === "integer" && !Number.isInteger(value)) return "请输入整数";
  if (field.minimum !== null && value < field.minimum) return `不得小于 ${field.minimum}`;
  if (field.maximum !== null && value > field.maximum) return `不得大于 ${field.maximum}`;
  return null;
}

function valuesIssues(config, values, label) {
  const issues = [];
  const scale = config.percent_scale ? Number(config.percent_scale) : null;
  config.fields.forEach((item, index) => {
    const issue = numberIssue(values[index], item);
    const prefix = `${item.name || `数值 ${index + 1}`}${label}`;
    if (issue) issues.push(`${prefix}${issue}。`);
    else if (scale !== null && values[index] !== null && (values[index] < 0 || values[index] > scale)) {
      issues.push(`${prefix}需在 0–${scale} 之间。`);
    }
  });
  if (values.length >= 2 && values.every(Number.isFinite)) {
    if (config.check === "min_lte_max" && values[0] > values[1]) issues.push(`${label}下界必须小于或等于上界。`);
    if (config.check === "sum_to_percent" && config.percent_scale && Number.isFinite(config.tolerance)) {
      const target = Number(config.percent_scale);
      const total = values.reduce((sum, value) => sum + value, 0);
      if (Math.abs(total - target) > config.tolerance + Number.EPSILON * Math.max(target, Math.abs(total)) * values.length) {
        issues.push(`${label}合计应为 ${target}，允许误差 ±${config.tolerance}。`);
      }
    }
  }
  return issues;
}

export function definitionIssues(card, cards) {
  const issues = [];
  const config = card.config;
  if (!card.name.trim()) issues.push("请填写参数名称。");
  if (!codePattern.test(card.code.trim())) issues.push("参数代码须以小写字母开头，并仅使用小写字母、数字和下划线。");
  else if (cards.some(other => card.id !== other.id && card.code.trim() === other.code)) issues.push("参数代码已被另一张卡使用。");

  function checkRows(rows, label) {
    const codes = new Set();
    rows.forEach((row, index) => {
      const prefix = `${label} ${index + 1}`;
      if (!row.name.trim()) issues.push(`${prefix}缺少名称。`);
      if (!codePattern.test(row.code)) issues.push(`${prefix}需要有效代码。`);
      else if (codes.has(row.code)) issues.push(`${label}代码 ${row.code} 重复。`);
      codes.add(row.code);
    });
  }

  if (card.type === "number") {
    if (config.mode === "multiple") {
      if (config.fields.length < 2) issues.push("多值参数至少需要两个数值子项。");
      checkRows(config.fields, "数值子项");
    }
    config.fields.forEach((item, index) => {
      const name = item.name || (config.mode === "single" ? "数值" : `数值 ${index + 1}`);
      if (item.minimum !== null && item.maximum !== null && item.minimum > item.maximum) issues.push(`${name}的最小允许值不能大于最大允许值。`);
      if (item.number_type === "integer" && [item.minimum, item.maximum].some(value => value !== null && !Number.isInteger(value))) {
        issues.push(`${name}的允许边界须为整数。`);
      }
    });
    if (config.check === "min_lte_max" && config.fields[0].minimum !== null && config.fields[1].maximum !== null
        && config.fields[0].minimum > config.fields[1].maximum) issues.push("当前边界无法产生下界小于或等于上界的范围。");
    if (config.check === "sum_to_percent" && !config.percent_scale) issues.push("请设置百分比的传值尺度。");
    if (config.check === "sum_to_percent" && (!Number.isFinite(config.tolerance) || config.tolerance < 0)) {
      issues.push("请填写大于或等于 0 的合计误差。");
    }
    issues.push(...valuesIssues(config, config.fields.map(item => item.default), "默认值"));
  }
  if (card.type === "choice" && config.mode !== "boolean") {
    if (config.options.length === 0) issues.push("请至少添加一个固定选项。");
    checkRows(config.options, "选项");
    const defaults = Array.isArray(config.default) ? config.default : [config.default];
    if (defaults.some(value => value !== null && !config.options.some(item => item.code && item.code === value))) {
      issues.push("默认选项须使用有效的选项代码。");
    }
  }
  if (card.type === "project" && config.source !== "project" && !dependencies(card, cards).some(item => item.code === config.dependency)) {
    issues.push(`请关联一个单选「${objects[dependencyTypes[config.source]]}」参数。`);
  }
  if (card.type === "text") {
    if (config.max_length !== null && (!Number.isInteger(config.max_length) || config.max_length < 1)) issues.push("最大长度须为正整数。");
    const issue = textIssue(config.default, config);
    if (issue) issues.push(`默认文字 · ${issue}`);
  }
  return issues;
}

const demoChoices = {
  project: {
    grouping_scheme: [["GS001", "处理组与对照组"], ["GS002", "时间点分组"]],
    group: [["G001", "对照组"], ["G002", "处理组"], ["G003", "恢复组"]],
    comparison: [["C001", "处理组 vs 对照组"], ["C002", "恢复组 vs 处理组"]],
    gene_set: [["SET001", "差异基因集"], ["SET002", "显著上调基因集"]],
    task: [["T001", "差异表达分析"], ["T002", "功能富集分析"]],
  },
  GS001: {group: [["G001", "对照组"], ["G002", "处理组"]], comparison: [["C001", "处理组 vs 对照组"]]},
  GS002: {group: [["G004", "第 0 天"], ["G005", "第 7 天"]], comparison: [["C003", "第 7 天 vs 第 0 天"]]},
  T001: {comparison: [["C001", "处理组 vs 对照组"]], gene_set: [["SET001", "差异基因集"]]},
  T002: {comparison: [["C002", "恢复组 vs 处理组"]], gene_set: [["SET002", "显著上调基因集"]]},
};
export const parentOptions = config => demoChoices.project[dependencyTypes[config.source]] || [];
export const projectOptions = (config, parent) =>
  demoChoices[config.source === "project" ? "project" : parent]?.[config.object] || [];
export function projectDefault(config, parent) {
  const options = projectOptions(config, parent);
  if (config.default === "all") return options.map(([code]) => code);
  if (config.default === "project_default") return options[0]?.[0] ?? null;
  return config.mode === "multiple" ? [] : null;
}

export function initialPreview(card, example = false) {
  const config = card.config;
  if (card.type === "number") {
    const demoRange = card.id === "sample-gene_count_range" && config.check === "min_lte_max";
    const fields = config.fields;
    const values = fields.map((item, index) => {
      if (item.default !== null) return item.default;
      if (!example && !demoRange) return null;
      const candidate = demoRange ? [10, 100][index] : 0;
      return Math.min(item.maximum ?? Infinity, Math.max(item.minimum ?? -Infinity, candidate));
    });
    if (example && config.check === "min_lte_max" && values[0] > values[1]) {
      if (fields[0].default === null && (fields[0].minimum ?? -Infinity) <= values[1]) values[0] = values[1];
      else if (fields[1].default === null && (fields[1].maximum ?? Infinity) >= values[0]) values[1] = values[0];
    }
    if (example && config.check === "sum_to_percent" && config.percent_scale) {
      let remaining = Number(config.percent_scale) - values.reduce((sum, value) => sum + value, 0);
      fields.forEach((item, index) => {
        if (item.default !== null) return;
        const lower = Math.max(0, item.minimum ?? 0);
        const upper = Math.min(Number(config.percent_scale), item.maximum ?? Infinity);
        const allowed = Math.min(upper, Math.max(lower, values[index] + remaining));
        const next = item.number_type === "integer" ? Math.floor(allowed) : allowed;
        remaining -= next - values[index];
        values[index] = next;
      });
    }
    return {value: values};
  }
  if (card.type === "project") {
    const parent = parentOptions(config)[0]?.[0] ?? "";
    const options = projectOptions(config, parent);
    const value = projectDefault(config, parent);
    return {parent, value: example && (value === null || value.length === 0) ?
      config.mode === "multiple" ? options.slice(0, 2).map(([id]) => id) : options[0]?.[0] ?? null : value};
  }
  if (card.type === "choice") {
    const codes = config.options.map(item => item.code).filter(Boolean);
    const value = config.default ?? (config.mode === "multiple" ? [] : null);
    if (!example || !(value === null || value.length === 0)) return {value: structuredClone(value)};
    return {value: config.mode === "boolean" ? true : config.mode === "multiple" ? codes.slice(0, 2) : codes[0] ?? null};
  }
  return {value: config.default ?? (example ? Array.from("分析说明").slice(0, config.max_length ?? 4).join("") : null)};
}

export function submission(card, preview) {
  const code = card.code.trim();
  if (!codePattern.test(code)) return {};
  const {type, config} = card;
  let {value} = preview;
  if (type === "number") {
    value = config.mode === "single" ? value[0] : Object.fromEntries(
      config.fields.flatMap((item, index) => codePattern.test(item.code) ? [[item.code, value[index]]] : []));
  }
  return {[code]: value};
}

export function previewIssues(card, preview) {
  if (card.type === "number") return valuesIssues(card.config, preview.value, "试填值");
  if (card.type !== "text") return [];
  return [textIssue(preview.value ?? "", card.config)].filter(Boolean);
}

export function definition(card) {
  const {revision, ...publicDefinition} = card;
  return {...publicDefinition, name: card.name.trim(), code: card.code.trim()};
}
