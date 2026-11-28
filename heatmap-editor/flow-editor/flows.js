import {statuses} from "../parameter-editor/parameter-model.js";
import {
  $, esc, icon, btn, statusBadge, input, labeled, block, opt, moveControls, jsonPanel, colorJson, download, downloadCsv,
  renderVersionList, renderVersionWorkflow,
} from "../parameter-editor/workbench-ui.js";
import {parameterLibrary, parameterStorageKey, saveVersion, versionKey} from "../parameter-editor/workbench-storage.js";
import {modes, nodeLibrary, nodeStorageKey} from "../node-editor/node-model.js";
import {nodeResultsPreview, prepareNodeTrials, nodeTrialForms} from "../node-editor/node-preview.js";
import {
  flowLibrary, newFlow, newSection, addEntry, pinNode, resolveNode, confirmedVersions,
  definition, recordForSave, definitionIssues,
} from "./flow-model.js";

const selectionKey = "skyao-flow-selection";
const state = {
  flows: [], nodes: [], parameters: [], flow: null, saved: null, baseline: "", tab: "directory", entry: null,
  chartSelections: new Map(), picker: null, busy: false, nodeReadError: false,
};
const dirty = () => state.flow && JSON.stringify(state.flow) !== state.baseline;
const locked = () => state.saved?.status === "confirmed";
const entries = () => state.flow.sections.flatMap(section => section.nodes);
const resolve = entry => resolveNode(state.flow, entry, state.nodes);
const issues = () => definitionIssues(state.flow, state.nodes);
let toastTimer;

function notify(message, error = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = error ? "toast error" : "toast";
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 6000 : 3000);
}

function filteredFlows() {
  const query = $("search").value.trim().toLowerCase();
  const status = $("status-filter").value;
  return state.flows.filter(item => (!status || item.status === status) && `${item.name} ${item.id}`.toLowerCase().includes(query));
}

function renderLibrary() {
  renderVersionList({items: filteredFlows(), total: state.flows.length, current: state.flow, noun: "流程"});
}

function header() {
  const flow = state.flow;
  $("selected-name").textContent = flow.name.trim() || "未命名流程";
  $("selected-meta").innerHTML = `<code>${esc(flow.id)}</code><span class="meta-divider"></span><span>v${flow.version}</span>`;
  $("selected-status").innerHTML = statusBadge(flow.status);
  if (!$("head-actions").childElementCount) $("head-actions").innerHTML = btn("markdown", "Markdown", "", "download");
}

function entryEditor(entry, index, list) {
  const node = resolve(entry);
  return `<li class="flow-entry node-entry-head" data-entry="${esc(entry.id)}">
    <span class="node-entry-title"><strong>${esc(node?.name || "节点版本无法解析")}</strong><code>${esc(entry.node_id)}</code> v${entry.node_version} · ${esc(entry.id)}</span>
    <div class="node-entry-actions">
      <button type="button" class="btn version-btn" data-action="change-version" aria-label="更换${esc(entry.id)}的节点版本">更换版本</button>
      ${moveControls("entry", index, list.length, entry.id)}
    </div>
  </li>`;
}

function sectionEditor(section, index, list) {
  return `<article class="node-entry" data-section="${esc(section.id)}">
    <div class="node-entry-head">
      <span class="node-entry-title"><code>${esc(section.id)}</code>一级标题</span>
      <div class="node-entry-actions">${moveControls("section", index, list.length, section.id)}</div>
    </div>
    ${labeled("标题名称", input(`sections.${index}.title`, section.title, {label: `${section.id} 标题名称`, placeholder: "例如 数据质控"}), true)}
    ${section.nodes.length ? `<ol class="flow-entries">${section.nodes.map(entryEditor).join("")}</ol>` : '<p class="hint">此标题下还没有节点。</p>'}
    <div class="node-add-actions">${btn("pick-node", "添加节点", "add", "plus")}</div>
  </article>`;
}

function renderEditor() {
  const flow = state.flow;
  const basics = `<div class="flow-basic">
    ${labeled("云流程名称", input("name", flow.name, {placeholder: "例如 蛋白组基础分析"}), true)}
    ${labeled("说明介绍", `<textarea data-bind="description" rows="2" placeholder="填写流程适用场景">${esc(flow.description)}</textarea>`)}</div>`;
  const sections = `<div class="flow-sections">${flow.sections.map(sectionEditor).join("")}
    ${btn("add-section", "添加一级标题", "add", "plus")}</div>`;
  $("definition").innerHTML = `<fieldset class="editor-fields" ${locked() ? "disabled" : ""}>
    ${block("基本信息", basics)}${block("两级目录", sections)}</fieldset>`;
}

function directoryPreview() {
  const groups = state.flow.sections.map(section => `<section class="flow-dir-section" data-dir-section="${esc(section.id)}">
    <h3 class="flow-heading">${esc(section.title.trim() || "未命名一级标题")}</h3>
    ${section.nodes.length ? `<ol>${section.nodes.map(entry => `<li>
      <button type="button" class="flow-dir-node" data-preview-entry="${esc(entry.id)}" aria-current="${entry.id === state.entry}">
        ${icon("chevron", 12)}<span>${esc(resolve(entry)?.name || "节点版本无法解析")}</span><code>v${entry.node_version}</code>
      </button></li>`).join("")}</ol>` : '<p class="hint">此标题下还没有节点。</p>'}</section>`).join("");
  return groups ? `<div class="directory-tree">${groups}</div>` : '<p class="hint">添加一级标题后可预览目录。</p>';
}

function selectEntry(id) {
  if (state.entry !== id) {
    state.entry = id;
    state.chartSelections.clear();
  }
}

function nodePreview() {
  const available = entries();
  const entry = available.find(item => item.id === state.entry) || available[0];
  selectEntry(entry?.id ?? null);
  if (!entry) return '<p class="hint">加入节点后可预览该版本的内容。</p>';
  const node = resolve(entry);
  const positions = state.flow.sections.flatMap(section => section.nodes.map(item =>
    [item.id, `${section.title.trim() || section.id} / ${resolve(item)?.name || item.node_id} · v${item.node_version} · ${item.id}`]));
  const picker = labeled("目录节点", `<select id="preview-entry">${opt(positions, entry.id)}</select>`);
  if (!node) return `${picker}<p class="validation has-issues">无法解析 ${esc(entry.node_id)} v${entry.node_version}。</p>`;
  const mode = node.reanalysis.mode;
  const forms = mode === "none" ? "" : nodeTrialForms(node, state.parameters, prepareNodeTrials(node, state.parameters));
  return `${picker}
    <div class="mock-form flow-node-head">
      <div class="mock-label"><strong>${esc(node.name)}</strong><span>v${node.version}</span></div>
      <code class="ref-code">${esc(node.id)} · ${esc(entry.id)}</code>
      ${node.description.trim() ? `<p class="mock-help">${esc(node.description)}</p>` : ""}
    </div>
    <h3 class="flow-heading">结果展示 · 示例</h3>
    ${nodeResultsPreview(node, state.chartSelections)}
    <h3 class="flow-heading">重分析参数</h3>
    <p class="hint">${esc(modes[mode])}${mode === "none" ? "" : ` · ${esc(node.reanalysis.handler_ref)} · ${node.reanalysis.integration_status === "not_connected" ? "未接入" : "配置预览"}`}</p>
    ${mode !== "none" ? (forms ? `<fieldset class="preview-params" aria-label="参数默认值预览" disabled>${forms}</fieldset>` :
      '<p class="hint">该节点版本未登记重分析参数。</p>') : ""}`;
}

function jsonText() {
  return JSON.stringify(definition(state.flow), null, 2);
}

function renderPreview() {
  document.querySelectorAll("[data-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tab === state.tab)));
  const content = $("preview-content");
  if (state.tab === "definition") {
    content.innerHTML = jsonPanel("流程定义 JSON");
    $("json-preview").innerHTML = colorJson(jsonText());
  } else {
    content.innerHTML = state.tab === "node" ? nodePreview() : directoryPreview();
  }
  const warnings = issues();
  const box = $("validation");
  box.className = `validation ${warnings.length ? "has-issues" : "good"}`;
  box.innerHTML = `<div>${icon(warnings.length ? "info" : "check", 17)} <strong>${warnings.length ? "请核对流程配置" : "当前流程定义通过校验"}</strong></div>` +
    (warnings.length ? `<ul>${warnings.map(issue => `<li>${esc(issue)}</li>`).join("")}</ul>` : "");
}

function renderWorkflow() {
  renderVersionWorkflow({records: state.flows, current: state.flow, saved: state.saved, dirty: dirty(),
    busy: state.busy, confirmedHelp: "该版本可供项目选用。"});
}

function renderAll() {
  header();
  renderLibrary();
  renderEditor();
  renderPreview();
  renderWorkflow();
}

function choose(flow, {preserve = false} = {}) {
  state.saved = flow.revision ? flow : null;
  state.baseline = JSON.stringify(flow);
  state.flow = structuredClone(flow);
  if (!preserve) {
    state.tab = "directory";
    selectEntry(null);
  }
  if (state.saved) sessionStorage.setItem(selectionKey, versionKey(flow));
  $("detail").hidden = false;
  renderAll();
}

async function refreshNodes() {
  try {
    state.nodes = await nodeLibrary.read();
    state.nodeReadError = false;
  } catch {
    state.nodes = [];
    state.nodeReadError = true;
  }
}

async function refreshParameters() {
  try {
    state.parameters = await parameterLibrary.read();
  } catch {
    state.parameters = [];
  }
}

async function load() {
  try {
    [state.flows] = await Promise.all([flowLibrary.read(), refreshNodes(), refreshParameters()]);
    const first = state.flows.find(item => versionKey(item) === sessionStorage.getItem(selectionKey)) || state.flows[0] || newFlow();
    $("load-error").hidden = true;
    $("new-card").disabled = false;
    $("export-library").disabled = false;
    choose(first);
  } catch {
    $("load-error").hidden = false;
    $("load-error").innerHTML = `<p>无法载入流程库，请检查浏览器存储设置。</p>${btn("reload", "重新载入", "primary")}`;
  }
}

function canLeave() {
  return !state.busy && (!dirty() || window.confirm("当前修改尚未保存。要离开这张流程卡吗？"));
}

async function save(action) {
  if (state.busy) return;
  if (action === "confirmed" && dirty()) return notify("请先保存本次修改。", true);
  if (["pending", "confirmed"].includes(action) && issues().length) return notify("请先修正预览区列出的配置问题。", true);
  state.busy = true;
  $("definition").inert = true;
  renderWorkflow();
  try {
    const {record, records} = await saveVersion(flowLibrary, state.flow, action, recordForSave);
    state.flows = records;
    if (!filteredFlows().includes(record)) {
      $("search").value = "";
      $("status-filter").value = "";
    }
    choose(record, {preserve: action !== "new_version"});
    notify({draft: "草稿已保存。", pending: "已保存，等待人工确认。", confirmed: "流程已确认入库。", new_version: `已创建 v${record.version} 草稿。`}[action]);
  } catch (error) {
    notify(error.message || "无法保存流程。", true);
  } finally {
    state.busy = false;
    $("definition").inert = false;
    renderWorkflow();
  }
}

function review() {
  if (dirty() || issues().length) {
    notify(dirty() ? "请先保存本次修改。" : "请修正预览区列出的配置问题。", true);
    return;
  }
  $("review-form").reset();
  $("review-target").textContent = `${state.flow.name} · ${state.flow.id} · v${state.flow.version}`;
  $("review-dialog").showModal();
}

function pickerSelection() {
  if (!$("pick-node").value) return null;
  return confirmedVersions(state.nodes, $("pick-node").value)
    .find(node => String(node.version) === $("pick-version").value);
}

function updatePickerSummary() {
  const node = pickerSelection();
  $("picker-summary").textContent = node ? `${node.id} · v${node.version}\n${node.description || "暂无简介。"}` :
    (state.nodeReadError ? "无法读取节点库，请检查浏览器存储。" : "暂无可选版本。请先在节点编辑器确认节点。");
  $("apply-picker").disabled = !node;
}

function updatePickerVersions(preferred) {
  const id = $("pick-node").value;
  const versions = id ? confirmedVersions(state.nodes, id) : [];
  const use = versions.find(node => node.version === preferred) || versions[0];
  $("pick-version").innerHTML = opt(versions.map((node, index) =>
    [node.version, `v${node.version}${index === 0 ? " · 最新已确认" : ""}`]), use?.version);
  updatePickerSummary();
}

async function openPicker(section, entry) {
  await refreshNodes();
  state.picker = {section, entry};
  const available = confirmedVersions(state.nodes, entry?.node_id);
  const newest = new Map();
  for (const node of available) {
    if (!newest.has(node.id)) newest.set(node.id, node);
  }
  $("picker-title").textContent = entry ? "更换节点版本" : "添加节点";
  $("picker-context").textContent = `${section.title.trim() || section.id}${entry ? ` · ${entry.id} · 当前 v${entry.node_version}` : ""}`;
  $("pick-node").disabled = Boolean(entry);
  $("pick-node").innerHTML = opt(Array.from(newest.values(), node => [node.id, `${node.name} · ${node.id}`]),
    entry?.node_id ?? newest.keys().next().value);
  $("apply-picker").textContent = entry ? "应用版本" : "加入目录";
  updatePickerVersions(entry?.node_version);
  if (!$("node-picker").open) $("node-picker").showModal();
}

function changeDirectory(button) {
  const {action, index, delta} = button.dataset;
  const section = state.flow.sections.find(item => item.id === button.closest("[data-section]")?.dataset.section);
  const entry = section?.nodes.find(item => item.id === button.closest("[data-entry]")?.dataset.entry);
  if (action === "pick-node" || action === "change-version") {
    openPicker(section, entry);
    return;
  }
  if (action === "add-section") {
    const added = newSection(state.flow);
    renderAll();
    $("definition").querySelector(`[data-section="${added.id}"] input`).focus();
    return;
  }

  const list = action.endsWith("-section") ? state.flow.sections : section.nodes;
  const position = Number(index);
  if (action.startsWith("move-")) {
    const target = position + Number(delta);
    if (target < 0 || target >= list.length) return;
    const [item] = list.splice(position, 1);
    list.splice(target, 0, item);
  } else {
    list.splice(position, 1);
  }
  if (!entries().some(item => item.id === state.entry)) selectEntry(null);
  renderAll();
}

function markdown() {
  const flow = definition(state.flow);
  const line = value => value.replace(/[\r\n]+/g, " ");
  const lines = [
    `# ${line(flow.name) || "未命名流程"}`, "", `- 流程 ID \`${flow.id}\``,
    `- 版本 v${flow.version}`, `- 状态 ${statuses[flow.status]}`, `- 修改时间 ${flow.updated_at || "未保存"}`,
    "", "## 说明介绍", "", flow.description || "暂无介绍。", "", "## 目录", "",
  ];
  for (const section of flow.sections) {
    lines.push(`### ${line(section.title) || "未命名一级标题"} · \`${section.id}\``, "");
    section.nodes.forEach((entry, index) => lines.push(
      `${index + 1}. ${line(resolve(entry)?.name || "节点版本无法解析")} · \`${entry.node_id}\` · v${entry.node_version} · 条目 \`${entry.id}\``));
    if (!section.nodes.length) lines.push("暂无节点。");
    lines.push("");
  }
  if (!flow.sections.length) lines.push("暂无一级标题。", "");
  download(`${flow.id}-v${flow.version}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
}

function exportTable() {
  const flows = filteredFlows();
  if (!flows.length) return notify("当前筛选范围内没有可导出的已保存流程。", true);
  const rows = [["流程名称", "流程 ID", "版本", "状态", "一级标题数", "节点条目数", "修改时间", "说明介绍"],
    ...flows.map(flow => [flow.name, flow.id, flow.version, statuses[flow.status], flow.sections.length,
      flow.sections.reduce((count, section) => count + section.nodes.length, 0), flow.updated_at, flow.description])];
  downloadCsv("SkyAO-云流程总表.csv", rows);
}

$("definition").addEventListener("input", event => {
  const bind = event.target.dataset.bind;
  if (!bind) return;
  if (bind === "name" || bind === "description") state.flow[bind] = event.target.value;
  else state.flow.sections[Number(bind.split(".")[1])].title = event.target.value;
  header();
  renderPreview();
  renderWorkflow();
});
$("search").addEventListener("input", renderLibrary);
$("status-filter").addEventListener("change", renderLibrary);
$("new-card").addEventListener("click", () => {
  if (!canLeave()) return;
  choose(newFlow());
  $("definition").querySelector('[data-bind="name"]').focus();
});
$("card-list").addEventListener("click", event => {
  const card = event.target.closest("[data-card]");
  if (!card || versionKey(state.flow) === card.dataset.card || !canLeave()) return;
  choose(state.flows.find(flow => versionKey(flow) === card.dataset.card));
});
$("export-library").addEventListener("click", exportTable);

$("pick-node").addEventListener("change", () => updatePickerVersions());
$("pick-version").addEventListener("change", updatePickerSummary);
$("cancel-picker").addEventListener("click", () => $("node-picker").close());
$("picker-form").addEventListener("submit", event => {
  event.preventDefault();
  const node = pickerSelection();
  if (!node || !state.picker) return;
  const {section, entry} = state.picker;
  if (entry) {
    pinNode(state.flow, entry, node);
    if (state.entry === entry.id) state.chartSelections.clear();
  } else {
    const added = addEntry(state.flow, section, node);
    if (!state.entry) selectEntry(added.id);
  }
  $("node-picker").close();
  renderAll();
  const row = $("definition").querySelector(`[data-section="${section.id}"]`);
  const button = entry ? row.querySelector(`[data-entry="${entry.id}"] [data-action="change-version"]`) :
    row.querySelector('[data-action="pick-node"]');
  button?.focus();
});
$("node-picker").addEventListener("close", () => { state.picker = null; });
$("cancel-review").addEventListener("click", () => $("review-dialog").close());
$("review-form").addEventListener("submit", event => {
  event.preventDefault();
  $("review-dialog").close();
  save("confirmed");
});
$("preview-content").addEventListener("change", event => {
  const target = event.target;
  if (target.id === "preview-entry") {
    selectEntry(target.value);
    renderPreview();
    $("preview-entry")?.focus();
  } else if (target.dataset.chart) {
    state.chartSelections.set(target.dataset.chart, target.value);
    renderPreview();
    $("preview-content").querySelector(`[data-chart="${target.dataset.chart}"]`)?.focus();
  }
});

async function copyJSON() {
  try {
    await navigator.clipboard.writeText(jsonText());
    notify("已复制 JSON。");
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("json-preview"));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    notify("已选中 JSON，可手动复制。");
  }
}

document.addEventListener("click", event => {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    state.tab = tab.dataset.tab;
    renderPreview();
  }
  const node = event.target.closest("[data-preview-entry]");
  if (node) {
    selectEntry(node.dataset.previewEntry);
    state.tab = "node";
    renderPreview();
    $("preview-entry")?.focus();
  }
  if (event.target.closest("#copy-json")) copyJSON();
  const button = event.target.closest("[data-action]");
  if (!button) return;
  switch (button.dataset.action) {
    case "add-section": case "pick-node": case "change-version":
    case "move-section": case "remove-section": case "move-entry": case "remove-entry": changeDirectory(button); break;
    case "save": save(state.flow.status); break;
    case "pending": save("pending"); break;
    case "review": review(); break;
    case "version": save("new_version"); break;
    case "latest": choose(state.flows.filter(item => item.id === state.flow.id).sort((a, b) => b.version - a.version)[0]); break;
    case "markdown": markdown(); break;
    case "reload": load(); break;
  }
});
window.addEventListener("storage", async event => {
  const tasks = [];
  if (event.key === nodeStorageKey || event.key === null) tasks.push(refreshNodes());
  if (event.key === parameterStorageKey || event.key === null) tasks.push(refreshParameters());
  if (tasks.length) {
    await Promise.all(tasks);
    if (state.flow) renderPreview();
  }
});
window.addEventListener("beforeunload", event => {
  if (dirty()) {
    event.preventDefault();
    event.returnValue = true;
  }
});

document.querySelectorAll("[data-icon]").forEach(element => { element.innerHTML = icon(element.dataset.icon); });
$("new-card").disabled = true;
$("export-library").disabled = true;
load();
