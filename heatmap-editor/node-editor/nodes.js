import {types, statuses, dependencies, initialPreview, projectDefault} from "../parameter-editor/parameter-model.js";
import {$, icon, esc, btn, statusBadge, input, select, opt, checked, labeled, block, colorJson, download, downloadCsv} from "../parameter-editor/workbench-ui.js";
import {parameterForm, updateParameterTrial} from "../parameter-editor/parameter-form.js";
import {parameterLibrary, parameterStorageKey} from "../parameter-editor/workbench-storage.js";
import {
  resultTypes, modes, scripts, nodeLibrary, identity, newNode, addResult, makeReference,
  resolve, definition, definitionIssues, trialSubmission, trialIssues,
} from "./node-model.js";

const selectionKey = "skyao-node-selection";
const state = {
  saved: null, node: null, nodes: [], cards: [], tab: "results", busy: false,
  trials: new Map(), chartSelections: new Map(), libraryError: "",
};
const dirty = () => state.node && JSON.stringify(state.node) !== state.baseline;
const locked = () => state.saved?.status === "confirmed";
const issues = () => definitionIssues(state.node, state.cards);
const nodeRefRows = () => state.node.reanalysis.parameters;
const glyphs = {table: "form", image: "eye", render: "edit"};
let toastTimer;

function notify(message, error = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = error ? "toast error" : "toast";
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 6000 : 3000);
}

function filteredNodes() {
  const query = $("search").value.trim().toLowerCase();
  const status = $("status-filter").value;
  return state.nodes.filter(item => (!status || item.status === status) && `${item.name} ${item.id}`.toLowerCase().includes(query));
}

function renderLibrary() {
  const nodes = filteredNodes();
  $("library-count").textContent = state.nodes.length;
  $("match-count").textContent = `${nodes.length} 项`;
  $("card-list").innerHTML = nodes.length ? nodes.map(item =>
    `<button type="button" class="library-item" data-card="${esc(identity(item))}" ${identity(item) === identity(state.node) ? 'aria-current="true"' : ""}>
      <span class="item-icon number">${icon("layers", 15)}</span>
      <span class="item-label"><strong>${esc(item.name || "未命名节点")}</strong><code>${esc(item.id)} · v${item.version}</code></span>
      <span class="item-dot ${item.status}" title="${statuses[item.status]}" aria-label="${statuses[item.status]}"></span>
    </button>`).join("") : '<p class="empty">没有符合条件的已保存节点。</p>';
}

function header() {
  const {node} = state;
  $("selected-name").textContent = node.name.trim() || "未命名节点";
  $("selected-status").innerHTML = statusBadge(node.status);
  $("selected-meta").innerHTML = `<code>${esc(node.id)}</code><span class="meta-divider"></span><span>v${node.version}</span>`;
  if (!$("head-actions").childElementCount) $("head-actions").innerHTML = btn("markdown", "Markdown", "", "download");
}

function moveControls(kind, index, length, label) {
  return `<button type="button" class="icon-button" data-action="move-${kind}" data-index="${index}" data-delta="-1" aria-label="上移${esc(label)}" ${index ? "" : "disabled"}>↑</button>
    <button type="button" class="icon-button" data-action="move-${kind}" data-index="${index}" data-delta="1" aria-label="下移${esc(label)}" ${index + 1 < length ? "" : "disabled"}>↓</button>
    <button type="button" class="icon-button" data-action="remove-${kind}" data-index="${index}" aria-label="删除${esc(label)}">${icon("trash", 15)}</button>`;
}

const scriptLabel = ref => Object.hasOwn(scripts, ref) ? `${scripts[ref]}（${ref}）` : ref;
const scriptStatus = ref => Object.hasOwn(scripts, ref) ? "示例预览可用" : "未接入";
function resultEditor(result, index) {
  const path = `results.${index}`;
  const name = labeled("结果名称", input(path + ".name", result.name, {label: `${result.id} 结果名称`, placeholder: "输入显示名称"}), true);
  let details = "";
  if (result.type === "table") {
    details = `<label class="checkbox"><input type="checkbox" data-bind="${path}.visible"${checked(result.visible)}> 在页面展示</label>
      ${result.visible ? "" : '<p class="hint">该表作为绘图来源。</p>'}`;
  }
  if (result.type === "render") {
    const tableOptions = state.node.results.filter(item => item.type === "table")
      .map(item => [item.id, `${item.id} · ${item.name || "未命名表格"}`]);
    const candidates = result.script_refs.map((ref, position) => `<span class="choice-chip"><code>${esc(scriptLabel(ref))}</code>
      <span class="integration ${Object.hasOwn(scripts, ref) ? "ready" : ""}">${scriptStatus(ref)}</span>
      <button type="button" class="icon-button" data-action="remove-script" data-index="${index}" data-script="${position}" aria-label="删除候选脚本 ${esc(ref)}">${icon("trash", 13)}</button></span>`).join("");
    details = `
      ${labeled("来源表格", select(path + ".source_table_id", result.source_table_id, [["", "选择当前节点的表格"], ...tableOptions], `${result.id} 来源表格`), true)}
      <div class="node-editor-line">${labeled("候选脚本 ID／代码", `<input data-script-input="${index}" list="script-library" aria-label="${result.id} 候选脚本 ID／代码" placeholder="选择热图或输入其他脚本代码" autocomplete="off">`)}
      <button type="button" class="btn" data-action="add-script" data-index="${index}">添加脚本</button></div>
      ${candidates ? `<div class="script-options">${candidates}</div>` : ""}
      ${labeled("默认脚本", select(path + ".default_script_ref", result.default_script_ref,
        [["", "选择候选脚本"], ...result.script_refs.map(ref => [ref, scriptLabel(ref)])], `${result.id} 默认脚本`), true)}`;
  }
  return `<article class="node-entry" data-result-id="${esc(result.id)}">
    <div class="node-entry-head"><span class="node-entry-title"><code>${esc(result.id)}</code>${resultTypes[result.type]}</span>
    <div class="node-entry-actions">${moveControls("result", index, state.node.results.length, result.id)}</div></div>
    ${name}${details}</article>`;
}

function resultSection() {
  return `<div class="node-list">${state.node.results.map(resultEditor).join("")}
    <div class="node-add-actions">${Object.entries(resultTypes).map(([type, label]) =>
      `<button type="button" class="btn add" data-action="add-result" data-type="${type}">${icon("plus", 15)}添加${label}</button>`).join("")}</div>
    <datalist id="script-library">${Object.entries(scripts).map(([ref, name]) => `<option value="${esc(ref)}">${esc(name)} · 示例预览可用</option>`).join("")}</datalist></div>`;
}

function referenceRows() {
  return nodeRefRows().map((ref, index, list) => {
    const card = resolve(ref, state.cards);
    return `<article class="node-entry">
      <div class="node-entry-head"><span class="node-entry-title"><strong>${esc(card?.name || ref.parameter_code)}</strong>
        ${card ? esc(types[card.type]) : "无法解析"} · v${ref.parameter_version}</span>
        <div class="node-entry-actions">${moveControls("param", index, list.length, ref.parameter_code)}</div></div>
      <code class="ref-code">${esc(ref.parameter_code)}</code>
      <label class="checkbox"><input type="checkbox" data-bind="reanalysis.parameters.${index}.required"${checked(ref.required)}>必填</label></article>`;
  }).join("");
}

function parameterOptions() {
  const codes = new Set(nodeRefRows().map(ref => ref.parameter_code));
  const text = card => `${card.name || "未命名参数"} · ${card.code || "无代码"} · ${types[card.type]} · v${card.version} · ${statuses[card.status]}`;
  return '<option value="">选择参数版本</option>' + state.cards.map(card => {
    const usable = card.status === "confirmed" && !codes.has(card.code);
    const suffix = codes.has(card.code) ? " · 已选同代码" : "";
    return `<option value="${esc(identity(card))}" ${usable ? "" : "disabled"}>${esc(text(card) + suffix)}</option>`;
  }).join("");
}

function analysisSection() {
  const analysis = state.node.reanalysis;
  const radios = Object.entries(modes).map(([mode, label]) => `<label class="checkbox">
    <input type="radio" name="analysis-mode" data-bind="reanalysis.mode" value="${mode}"${checked(mode === analysis.mode)}>${label}</label>`).join("");
  return `<div class="checklist" role="group" aria-label="重分析执行方式">${radios}</div>
    ${analysis.mode === "none" ? "" : `<div id="analyze-fields">
      ${labeled("执行入口 ID／代码", input("reanalysis.handler_ref", analysis.handler_ref, {placeholder: analysis.mode === "cloud" ? "云端脚本代码" : "本地任务入口代码", code: true}), true)}
      <p class="hint"><span class="integration">未接入</span> 试填只生成提交示例。</p>
      <div class="node-list">${referenceRows()}</div>
      <div class="node-editor-line">${labeled("参数清单", `<select id="parameter-picker" title="仅能选用已确认的参数版本">${parameterOptions()}</select>`)}
        ${btn("add-param", "添加参数")}</div>
      <p class="hint">${esc(state.libraryError || "可查看所有版本，仅已确认且代码未被选用的参数可添加。")}</p>
      </div>`}`;
}

function renderEditor() {
  $("definition").innerHTML = `<fieldset class="editor-fields" ${locked() ? "disabled" : ""}>
    ${block("基本信息", `
      ${labeled("节点名称", input("name", state.node.name, {placeholder: "例如 蛋白表达量分布"}), true)}
      <div style="margin-top:8px">${labeled("节点介绍", `<textarea data-bind="description" rows="2" placeholder="填写节点用途">${esc(state.node.description)}</textarea>`)}</div>`)}
    ${block("结果列表", resultSection())}${block("重分析配置", analysisSection())}</fieldset>`;
}

function linkTrials() {
  const pinned = nodeRefRows().map(ref => resolve(ref, state.cards)).filter(Boolean);
  const previous = state.trials;
  state.trials = new Map(pinned.map(card => [identity(card), previous.get(identity(card)) ??
    initialPreview(card, false, {showRangeExample: false})]));
  for (const card of pinned) {
    if (card.type !== "project" || card.config.source === "project") continue;
    const parent = dependencies(card, pinned).find(item => item.code === card.config.dependency);
    const trial = state.trials.get(identity(card));
    const value = parent ? state.trials.get(identity(parent))?.value ?? "" : "";
    if (trial.parent !== value) {
      trial.parent = value;
      trial.value = projectDefault(card.config, value);
    }
  }
}

function linkedTrialCards(force = false) {
  if (force) linkTrials();
  const assignments = nodeRefRows().map(ref => ({ref, card: resolve(ref, state.cards)}));
  return assignments.map(({ref, card}, index) => card ? `<div class="mock-form" data-trial-index="${index}">
    ${parameterForm(card, state.trials.get(identity(card)), {required: ref.required, linked: true, showCode: true})}</div>` :
    `<div class="validation has-issues">无法解析 ${esc(ref.parameter_code)} v${ref.parameter_version}。</div>`).join("");
}

function jsonPanel(title) {
  return `<div class="code-card"><div class="code-head"><span class="code-title">${title}</span>
    <button id="copy-json" type="button" class="code-copy" aria-label="复制 JSON" title="复制 JSON">${icon("copy", 15)}</button></div><pre><code id="json-preview"></code></pre></div>`;
}

function resultPreview(result) {
  const {node} = state;
  const placeholder = text => `<div class="result-placeholder">${icon(glyphs[result.type], 22)}${esc(text)}</div>`;
  let content;
  if (result.type === "table") {
    content = '<div class="table-scroller"><table class="config-table"><thead><tr><th>Protein</th><th>Control_01</th><th>Control_02</th><th>TreatA_01</th></tr></thead><tbody><tr><td>ALB</td><td>4.1</td><td>4.0</td><td>2.8</td></tr><tr><td>APOA1</td><td>3.4</td><td>3.6</td><td>2.5</td></tr><tr><td>ACTB</td><td>2.2</td><td>2.1</td><td>2.2</td></tr></tbody></table></div>';
  } else if (result.type === "image") {
    content = placeholder("成品图片占位");
  } else {
    const source = node.results.find(item => item.type === "table" && item.id === result.source_table_id);
    const requested = state.chartSelections.get(result.id);
    const selected = result.script_refs.includes(requested) ? requested : result.default_script_ref;
    const choices = result.script_refs.map(ref => [ref, scriptLabel(ref)]);
    content = `<p class="mock-help">来源 ${source ? esc(`${source.id} · ${source.name || "未命名表格"}`) : "待配置"}
      <br>默认脚本 ${result.default_script_ref ? esc(scriptLabel(result.default_script_ref)) : "待配置"}</p>
      ${choices.length > 1 ? labeled("切换预览脚本", `<select data-chart="${esc(result.id)}">${opt([["", "选择脚本"], ...choices], selected)}</select>`) : ""}
      ${source && selected === "heatmap" ? '<iframe class="node-preview-frame" src="../index.html?node-preview=example" loading="lazy" title="现有热图编辑器的示例渲染"></iframe>' :
        placeholder(source && selected ? `${scriptLabel(selected)} · 绘图入口未接入` : "待配置来源表格及脚本")}`;
  }
  return `<article class="mock-form preview-result" data-preview-result="${esc(result.id)}">
    <div class="mock-label"><strong>${esc(result.name || "未命名结果")}</strong><span>${resultTypes[result.type]}</span></div>
    <code class="ref-code">${esc(result.id)} · 示例</code>${content}</article>`;
}

function jsonText() {
  const record = state.tab === "trial" ? trialSubmission(state.node, state.cards, state.trials) : definition(state.node);
  return JSON.stringify(record, null, 2);
}

function renderValidation() {
  const warnings = [...issues(), ...(state.tab === "trial" && state.node.reanalysis.mode !== "none" ?
    trialIssues(state.node, state.cards, state.trials) : [])];
  const box = $("validation");
  box.className = `validation ${warnings.length ? "has-issues" : "good"}`;
  const title = warnings.length ? "请核对节点配置或试填值" : "当前节点定义通过校验";
  box.innerHTML = `<div>${icon(warnings.length ? "info" : "check", 17)} <strong>${title}</strong></div>` +
    (warnings.length ? `<ul>${warnings.map(item => `<li>${esc(item)}</li>`).join("")}</ul>` : "");
  if ($("json-preview")) $("json-preview").innerHTML = colorJson(jsonText());
}

function renderPreview() {
  document.querySelectorAll("[data-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tab === state.tab)));
  const content = $("preview-content");
  if (state.tab === "definition") {
    content.innerHTML = jsonPanel("节点定义 JSON");
  } else if (state.tab === "trial") {
    const enabled = state.node.reanalysis.mode !== "none";
    content.innerHTML = enabled ? `<div id="node-trial">${linkedTrialCards(true) || '<p class="hint">当前节点未登记重分析参数。</p>'}</div>
      <p class="hint">试填只生成提交示例，默认值继承自参数库。</p>${jsonPanel("提交示例")}` :
      '<p class="hint">此节点的重分析方式为「不支持」。</p>';
  } else {
    const visible = state.node.results.filter(result => result.type !== "table" || result.visible);
    const hidden = state.node.results.filter(result => result.type === "table" && !result.visible);
    content.innerHTML = visible.map(resultPreview).join("") +
      (hidden.length ? `<p class="hint">仅作为绘图来源：${hidden.map(result => esc(`${result.id} ${result.name}`)).join("、")}</p>` : "") +
      (!visible.length && !hidden.length ? '<p class="hint">添加结果项后可查看示例。</p>' : "");
  }
  renderValidation();
}

function renderWorkflow() {
  const hasNext = state.nodes.some(item => item.id === state.node.id && item.version > state.node.version);
  let actions;
  let help;
  if (locked()) {
    actions = hasNext ? btn("latest", "查看最新版本", "primary") : btn("version", "另存新版本", "primary", "plus");
    help = "该版本可供云流程选用。";
  } else if (state.node.status === "pending") {
    actions = btn("save", "保存修改") + btn("review", "确认入库", "primary", "check");
    help = dirty() ? "请先保存修改，再确认入库。" : "等待人工核对。";
  } else {
    actions = btn("save", state.saved ? "保存修改" : "保存草稿") + btn("pending", "提交待确认", "primary");
    help = "可以先保存未完成的定义。";
  }
  $("workflow").hidden = false;
  $("workflow-status").innerHTML = `<span class="workflow-icon">${icon(locked() ? "check" : "clock")}</span>
    <span><strong>${dirty() ? "有未保存的修改" : statuses[state.node.status]}</strong><small>${help}</small></span>`;
  $("workflow-actions").innerHTML = actions;
  if (state.busy) $("workflow-actions").querySelectorAll("button").forEach(button => { button.disabled = true; });
}

function choose(node, {preserve = false} = {}) {
  state.saved = node.revision ? node : null;
  state.baseline = JSON.stringify(node);
  state.node = structuredClone(node);
  if (!preserve) {
    state.trials.clear();
    state.chartSelections.clear();
    state.tab = "results";
  }
  if (state.saved) sessionStorage.setItem(selectionKey, identity(node));
  $("detail").hidden = false;
  header();
  renderLibrary();
  renderEditor();
  renderPreview();
  renderWorkflow();
}

function canLeave() {
  return !state.busy && (!dirty() || window.confirm("当前修改尚未保存。要离开这张节点卡吗？"));
}

async function refreshParameters() {
  try {
    state.cards = await parameterLibrary.read();
    state.libraryError = "";
  } catch {
    state.libraryError = "无法载入参数库。已保存节点仍可通过版本快照预览。";
  }
  if (state.node && !state.busy) {
    const picker = $("parameter-picker");
    if (picker) {
      const value = picker.value;
      picker.innerHTML = parameterOptions();
      if ([...picker.options].some(option => option.value === value && !option.disabled)) picker.value = value;
    }
    renderValidation();
  }
}

async function load() {
  try {
    [state.nodes] = await Promise.all([nodeLibrary.read(), refreshParameters()]);
    const initial = state.nodes.find(item => identity(item) === sessionStorage.getItem(selectionKey)) || state.nodes[0] || newNode();
    $("load-error").hidden = true;
    $("new-card").disabled = false;
    $("export-library").disabled = false;
    choose(initial);
  } catch {
    $("load-error").hidden = false;
    $("load-error").innerHTML = `<p>无法载入节点库，请检查浏览器存储设置。</p>${btn("reload", "重新载入", "primary")}`;
  }
}

async function save(action) {
  if (state.busy) return;
  const node = state.node;
  if (action === "confirmed" && dirty()) return notify("请先保存本次修改。", true);
  if (["confirmed", "pending"].includes(action) && issues().length) return notify("请先修正预览区列出的配置问题。", true);
  state.busy = true;
  $("definition").inert = true;
  renderWorkflow();
  try {
    const {record, nodes} = await nodeLibrary.update(nodes => {
      const index = nodes.findIndex(item => identity(item) === identity(node));
      const stored = nodes[index];
      if (node.revision && (!stored || stored.revision !== node.revision)) {
        throw new Error("这张卡已在其他页面更新，请刷新后重试。");
      }
      if (!node.revision && stored) throw new Error("节点 ID 已存在，请重新新增。");
      const creating = action === "new_version";
      if (creating && (stored?.status !== "confirmed" || nodes.some(item => item.id === node.id && item.version > node.version))) {
        throw new Error("请从最新的已确认版本创建新版本。");
      }
      if (!creating && stored?.status === "confirmed") throw new Error("请另存新版本后编辑。");
      if (action === "confirmed" && stored?.status !== "pending") throw new Error("请先提交待确认。");
      const next = definition(creating ? stored : node);
      const record = {
        ...next, version: creating ? node.version + 1 : node.version,
        status: creating ? "draft" : action,
        revision: creating ? 1 : node.revision + 1,
        updated_at: new Date().toISOString(),
      };
      if (creating || index < 0) nodes.unshift(record);
      else nodes[index] = record;
      return {record, nodes};
    });
    state.nodes = nodes;
    if (!filteredNodes().includes(record)) {
      $("search").value = "";
      $("status-filter").value = "";
    }
    choose(record, {preserve: action !== "new_version"});
    notify({draft: "草稿已保存。", pending: "已保存，等待人工确认。", confirmed: "节点已确认入库。", new_version: `已创建 v${record.version} 草稿。`}[action]);
  } catch (error) {
    notify(error.message || "无法保存节点。", true);
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
  $("review-target").textContent = `${state.node.name} · ${state.node.id} · v${state.node.version}`;
  $("review-dialog").showModal();
}

function edit(target) {
  const path = target.dataset.bind.split(".");
  const property = path.pop();
  const record = path.reduce((value, field) => value[field], state.node);
  record[property] = target.type === "checkbox" ? target.checked : target.value;
  header();
  if (target.dataset.bind === "reanalysis.mode" || property === "visible") {
    const id = target.dataset.bind;
    renderEditor();
    const value = target.type === "radio" ? `[value="${target.value}"]` : "";
    $("definition").querySelector(`[data-bind="${id}"]${value}`)?.focus();
  }
  if (target.dataset.bind.startsWith("results.") && property === "name") {
    // Keep the in-use text input mounted while source labels track the new name.
    const tableOptions = state.node.results.filter(item => item.type === "table")
      .map(item => [item.id, `${item.id} · ${item.name || "未命名表格"}`]);
    $("definition").querySelectorAll('[data-bind$=".source_table_id"]').forEach(control => {
      control.innerHTML = opt([["", "选择当前节点的表格"], ...tableOptions], control.value);
    });
  }
  if (state.tab === "results" || target.dataset.bind === "reanalysis.mode" || property === "required") renderPreview();
  else renderValidation();
  renderWorkflow();
}

function changeRows(button) {
  const {action, type, delta} = button.dataset;
  const index = Number(button.dataset.index);
  const {results} = state.node;
  let focus = null;
  if (action === "add-result") {
    const result = addResult(state.node, type);
    focus = `[data-result-id="${result.id}"] input`;
  } else if (action === "add-script") {
    const control = $("definition").querySelector(`[data-script-input="${index}"]`);
    const ref = control.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(ref)) return notify("请填写有效的候选脚本 ID／代码。", true);
    const result = results[index];
    if (result.script_refs.includes(ref)) return notify("这个脚本已在候选列表中。", true);
    result.script_refs.push(ref);
    focus = `[data-script-input="${index}"]`;
  } else if (action === "remove-script") {
    const result = results[index];
    const position = Number(button.dataset.script);
    const removed = result.script_refs[position];
    if (result.default_script_ref === removed && result.script_refs.length > 1) {
      return notify("请先指定另一个默认脚本，再移除此脚本。", true);
    }
    result.script_refs.splice(position, 1);
    if (result.default_script_ref === removed) result.default_script_ref = "";
  } else if (action === "add-param") {
    const value = $("parameter-picker").value;
    const card = state.cards.find(item => identity(item) === value && item.status === "confirmed");
    if (!card || nodeRefRows().some(ref => ref.parameter_code === card.code)) return notify("请选择一个尚未选用的已确认参数。", true);
    nodeRefRows().push(makeReference(card));
    focus = "#parameter-picker";
  } else {
    const isResult = action.endsWith("-result");
    const list = isResult ? results : nodeRefRows();
    if (action.startsWith("move-")) {
      const destination = index + Number(delta);
      if (destination < 0 || destination >= list.length) return;
      const [item] = list.splice(index, 1);
      list.splice(destination, 0, item);
      focus = `[data-action="${action}"][data-index="${destination}"][data-delta="${delta}"]:not(:disabled)`;
    } else {
      if (isResult) {
        const id = list[index].id;
        const users = results.filter(result => result.type === "render" && result.source_table_id === id);
        if (users.length) return notify(`${id} 仍被 ${users.map(item => item.id).join("、")} 引用，请先解除或调整引用。`, true);
      }
      list.splice(index, 1);
    }
  }
  renderEditor();
  renderPreview();
  renderWorkflow();
  if (focus) $("definition").querySelector(focus)?.focus();
}

function editTrial(target) {
  const container = target.closest("[data-trial-index]");
  if (!container) return;
  const ref = nodeRefRows()[Number(container.dataset.trialIndex)];
  const card = resolve(ref, state.cards);
  if (!card) return;
  const trial = state.trials.get(identity(card));
  updateParameterTrial(target, card, trial);
  if (card.type === "project" && nodeRefRows().some(item => {
    const dependent = resolve(item, state.cards);
    return dependent?.type === "project" && dependent.config.dependency === card.code;
  })) {
    $("node-trial").innerHTML = linkedTrialCards(true);
    $("node-trial").querySelector(`[data-trial-index="${container.dataset.trialIndex}"] [data-preview="single"]`)?.focus();
  }
  renderValidation();
}

function markdown() {
  const item = definition(state.node);
  const lines = [
    `# ${item.name.replace(/[\r\n]+/g, " ") || "未命名节点"}`, "",
    `- 节点 ID \`${item.id}\``, `- 版本 v${item.version}`, `- 状态 ${statuses[item.status]}`,
    `- 修改时间 ${item.updated_at || "未保存"}`, "", "## 节点介绍", "", item.description || "暂无介绍。",
    "", "## 结果清单", "",
  ];
  item.results.forEach(result => {
    lines.push(`- \`${result.id}\` ${result.name || "未命名结果"}（${resultTypes[result.type]}）`);
    if (result.type === "table") lines.push(`  - ${result.visible ? "展示表格" : "仅作为绘图来源"}`);
    if (result.type === "render") lines.push(
      `  - 来源表格 \`${result.source_table_id || "待配置"}\``,
      `  - 候选脚本 ${result.script_refs.map(ref => `\`${ref}\`（${scriptStatus(ref)}）`).join("、") || "待配置"}`,
      `  - 默认脚本 \`${result.default_script_ref || "待配置"}\``,
    );
  });
  if (!item.results.length) lines.push("暂无结果项。");
  const analysis = item.reanalysis;
  lines.push("", "## 重分析配置", "", `- 执行方式 ${modes[analysis.mode]}`);
  if (analysis.mode !== "none") {
    lines.push(`- 执行入口 \`${analysis.handler_ref || "待配置"}\`（未接入）`, "", "### 参数清单", "");
    analysis.parameters.forEach(ref => {
      const card = resolve(ref, state.cards);
      lines.push(`${ref.order}. ${card?.name || ref.parameter_code} \`${ref.parameter_code}\` v${ref.parameter_version} · ${ref.required ? "必填" : "选填"} · ID \`${ref.parameter_id}\``);
    });
    if (!analysis.parameters.length) lines.push("暂无选用参数。");
  }
  const issues = definitionIssues(state.node, state.cards);
  if (issues.length) lines.push("", "## 待补配置", "", ...issues.map(issue => `- ${issue}`));
  download(`${item.id}-v${item.version}.md`, lines.join("\n") + "\n", "text/markdown;charset=utf-8");
}

function exportTable() {
  const items = filteredNodes();
  if (!items.length) return notify("当前筛选范围内没有可导出的已保存节点。", true);
  const rows = [["节点名称", "节点 ID", "版本", "状态", "结果项数", "重分析方式", "执行入口", "修改时间", "节点介绍"],
    ...items.map(item => [item.name, item.id, item.version, statuses[item.status], item.results.length,
      modes[item.reanalysis.mode], item.reanalysis.handler_ref, item.updated_at, item.description])];
  downloadCsv("SkyAO-节点总表.csv", rows);
}

$("definition").addEventListener("input", event => {
  const target = event.target;
  if (target.dataset.bind && target.tagName !== "SELECT" && !["checkbox", "radio"].includes(target.type)) edit(target);
});
$("definition").addEventListener("change", event => {
  const target = event.target;
  if (target.dataset.bind && (target.tagName === "SELECT" || ["checkbox", "radio"].includes(target.type))) edit(target);
});
$("definition").addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target.dataset.scriptInput !== undefined) {
    event.preventDefault();
    $("definition").querySelector(`[data-action="add-script"][data-index="${event.target.dataset.scriptInput}"]`).click();
  }
});
$("preview-content").addEventListener("input", event => {
  if (event.target.tagName !== "SELECT" && event.target.type !== "checkbox") editTrial(event.target);
});
$("preview-content").addEventListener("change", event => {
  const target = event.target;
  if (target.dataset.chart) {
    state.chartSelections.set(target.dataset.chart, target.value);
    renderPreview();
    $("preview-content").querySelector(`[data-chart="${target.dataset.chart}"]`)?.focus();
  } else if (target.tagName === "SELECT" || target.type === "checkbox") editTrial(target);
});
$("new-card").addEventListener("click", () => {
  if (!canLeave()) return;
  choose(newNode());
  $("definition").querySelector('[data-bind="name"]').focus();
});
$("search").addEventListener("input", renderLibrary);
$("status-filter").addEventListener("change", renderLibrary);
$("export-library").addEventListener("click", exportTable);
$("card-list").addEventListener("click", event => {
  const item = event.target.closest("[data-card]");
  if (!item || item.dataset.card === identity(state.node) || !canLeave()) return;
  choose(state.nodes.find(node => identity(node) === item.dataset.card));
});
$("cancel-review").addEventListener("click", () => $("review-dialog").close());
$("review-form").addEventListener("submit", event => {
  event.preventDefault();
  $("review-dialog").close();
  save("confirmed");
});

document.addEventListener("click", async event => {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    state.tab = tab.dataset.tab;
    renderPreview();
  }
  if (event.target.closest("#copy-json")) {
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
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const {action} = button.dataset;
  switch (action) {
    case "add-result": case "move-result": case "remove-result": case "add-script": case "remove-script":
    case "add-param": case "move-param": case "remove-param": changeRows(button); break;
    case "save": save(state.node.status); break;
    case "pending": save("pending"); break;
    case "review": review(); break;
    case "version": save("new_version"); break;
    case "latest": choose(state.nodes.filter(node => node.id === state.node.id).sort((a, b) => b.version - a.version)[0]); break;
    case "markdown": markdown(); break;
    case "reload": load(); break;
  }
});
window.addEventListener("storage", event => {
  if (event.key === parameterStorageKey || event.key === null) refreshParameters();
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
