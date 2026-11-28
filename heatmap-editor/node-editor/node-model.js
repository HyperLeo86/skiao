import {dependencies, definition as parameterDefinition, previewIssues, submission} from "../parameter-editor/parameter-model.js";
import {localCollection, versionKey} from "../parameter-editor/workbench-storage.js";

export const resultTypes = {table: "表格", image: "原生图片", render: "渲染图片"};
export const modes = {none: "不支持", cloud: "云端执行", local: "本地参数下发"};
export const cloudScriptLibraries = [
  {name: "图形渲染脚本库", scripts: [["render.heatmap", "热图渲染"], ["render.distribution", "分布图渲染"], ["render.pca", "PCA 图渲染"]]},
  {name: "重新计算脚本库", scripts: [["recompute.expression_matrix", "表达矩阵重算"], ["recompute.differential_results", "差异结果重算"]]},
];

const cloudScriptNames = new Map(cloudScriptLibraries.flatMap(library => library.scripts));
export const cloudScriptName = ref => cloudScriptNames.get(ref);
export const scripts = Object.freeze({heatmap: "热图"});
const prefixes = {table: "T", image: "P", render: "G"};
const refPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
export const nodeStorageKey = "skyao-static-node-library-v1";
export const nodeLibrary = localCollection(nodeStorageKey);
export const identity = versionKey;

export function newNode() {
  return {
    id: "N-" + crypto.randomUUID().slice(0, 13).toUpperCase(), name: "", description: "",
    version: 1, revision: 0, status: "draft", updated_at: null,
    results: [], result_id_counters: {T: 0, P: 0, G: 0},
    reanalysis: {mode: "none", handler_ref: "", integration_status: "not_applicable", parameters: []},
  };
}

export function addResult(node, type) {
  const prefix = prefixes[type];
  const id = prefix + ++node.result_id_counters[prefix];
  const result = {id, name: "", type};
  if (type === "table") result.visible = true;
  if (type === "render") Object.assign(result, {source_table_id: "", script_refs: [], default_script_ref: ""});
  node.results.push(result);
  return result;
}

export function makeReference(card) {
  return {
    parameter_id: card.id, parameter_code: card.code, parameter_version: card.version,
    required: false, definition_snapshot: structuredClone(parameterDefinition(card)),
  };
}

export function resolve(ref, cards) {
  const card = ref.definition_snapshot ?? cards.find(item => item.id === ref.parameter_id && item.version === ref.parameter_version);
  if (!card || card.id !== ref.parameter_id || card.version !== ref.parameter_version ||
      card.code !== ref.parameter_code || card.status !== "confirmed" || !card.config) return null;
  return card;
}

export function definition(node) {
  const {revision, ...visible} = structuredClone(node);
  visible.name = visible.name.trim();
  visible.results.forEach(result => {
    result.name = result.name.trim();
    if (result.type === "render") result.script_integration = Object.fromEntries(
      result.script_refs.map(ref => [ref, Object.hasOwn(scripts, ref) ? "preview_only" : "not_connected"]));
  });
  const reanalysis = visible.reanalysis;
  if (reanalysis.mode === "none") {
    reanalysis.handler_ref = "";
    reanalysis.parameters = [];
  }
  reanalysis.handler_ref = reanalysis.handler_ref.trim();
  reanalysis.integration_status = reanalysis.mode === "none" ? "not_applicable" : "not_connected";
  reanalysis.parameters.forEach((ref, index) => { ref.order = index + 1; });
  return visible;
}

export function definitionIssues(node, cards) {
  const issues = [];
  if (!node.name.trim()) issues.push("请填写节点名称。");
  if (!node.results.length) issues.push("请至少添加一项结果。");
  const ids = new Set();
  const tables = new Set(node.results.filter(result => result.type === "table").map(result => result.id));
  node.results.forEach(result => {
    if (ids.has(result.id)) issues.push(`结果编号 ${result.id} 重复。`);
    if (!Object.hasOwn(resultTypes, result.type) || !new RegExp(`^${prefixes[result.type]}[1-9]\\d*$`).test(result.id)) issues.push(`结果编号 ${result.id} 无效。`);
    ids.add(result.id);
    if (!result.name.trim()) issues.push(`${result.id} 缺少结果名称。`);
    if (result.type !== "render") return;
    if (!tables.has(result.source_table_id)) issues.push(`${result.id} 请选择当前节点中的来源表格。`);
    if (!result.script_refs.length) issues.push(`${result.id} 请登记至少一个候选绘图脚本。`);
    if (new Set(result.script_refs).size !== result.script_refs.length ||
        result.script_refs.some(ref => !refPattern.test(ref))) issues.push(`${result.id} 候选脚本代码无效或重复。`);
    if (!result.default_script_ref || !result.script_refs.includes(result.default_script_ref)) {
      issues.push(`${result.id} 请从候选脚本中指定有效的默认脚本。`);
    }
  });

  const {reanalysis} = node;
  if (reanalysis.mode === "none") return issues;
  if (reanalysis.mode === "cloud" && !refPattern.test(reanalysis.handler_ref.trim())) issues.push("请从预设脚本库选择云端脚本。");
  const codes = new Set();
  const pinned = reanalysis.parameters.map(ref => resolve(ref, cards)).filter(Boolean);
  reanalysis.parameters.forEach(ref => {
    const code = ref.parameter_code;
    if (codes.has(code)) issues.push(`重分析参数 ${code} 重复。`);
    codes.add(code);
    const card = resolve(ref, cards);
    if (!card) {
      issues.push(`找不到已确认的参数 ${code} v${ref.parameter_version}。`);
      return;
    }
    if (card.type === "project" && card.config.source !== "project" &&
        !dependencies(card, pinned).some(candidate => candidate.code === card.config.dependency)) {
      issues.push(`${code} 需要关联参数 ${card.config.dependency || "（未设置）"}，请选择相应的单选项目对象参数。`);
    }
  });
  return issues;
}

export function trialSubmission(node, cards, trials) {
  return {
    node_id: node.id, node_version: node.version,
    parameters: Object.fromEntries(node.reanalysis.parameters.flatMap(ref => {
      const card = resolve(ref, cards);
      const trial = card && trials.get(identity(card));
      return card && trial ? Object.entries(submission(card, trial)) : [];
    })),
  };
}

export function trialIssues(node, cards, trials) {
  return node.reanalysis.parameters.flatMap(ref => {
    const card = resolve(ref, cards);
    const trial = card && trials.get(identity(card));
    if (!trial) return [];
    const values = Array.isArray(trial.value) ? trial.value : [trial.value];
    const empty = value => value === null || typeof value === "string" && !value.trim();
    const present = values.some(value => !empty(value));
    const required = ref.required && (!present || card.type === "number" && values.some(empty));
    return [
      ...(required ? [`${card.name}为必填，请完整试填。`] : []),
      ...(present ? previewIssues(card, trial).map(issue => `${card.name} · ${issue}`) : []),
    ];
  });
}
