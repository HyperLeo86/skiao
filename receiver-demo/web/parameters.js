import {
  types, statuses, objects, sources, strategies, dependencyTypes, field, option, preset, numberConfig,
  newConfig, availableSources, availableStrategies, dependencies, definitionIssues, previewIssues,
  parentOptions, projectOptions, projectDefault, initialPreview, submission, definition,
} from "./parameter-model.js";

const icons = {
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  library: '<rect x="4" y="4" width="15" height="16" rx="2"/><path d="M8 4v16m3-11h5m-5 4h5"/>',
  search: '<circle cx="10.8" cy="10.8" r="5.8"/><path d="m15 15 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  number: '<path d="m10 4-3 16m10-16-3 16M4 9h16M3 15h16"/>',
  choice: '<path d="M10 6h10m-10 6h10m-10 6h10M4 6h1m-1 6h1m-1 6h1"/>',
  project: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9"/>',
  text: '<path d="M4 5h16m-8 0v14m-4 0h8M4 5v3m16-3v3"/>',
  edit: '<path d="M13 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7m-9 3 1-4 7-7 3 3-7 7-4 1Z"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  form: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10v4m3-2h5"/>',
  copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13m-7 4v5m4-5v5"/>',
};
const icon = (name, size = 17) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const $ = id => document.getElementById(id);
const endpoint = "/demo/parameters/data";
const state = {cards: [], saved: null, card: null, preview: null, tab: "payload", busy: false};
let toastTimer;
const key = card => `${card.id}@${card.version}`;
const dirty = () => state.card && JSON.stringify(state.card) !== JSON.stringify(state.saved);
const locked = () => state.saved?.status === "confirmed";
const btn = (action, title, extra = "", glyph = "") => `<button type="button" class="btn ${extra}" data-action="${action}">${glyph ? icon(glyph, 16) : ""}${title}</button>`;
const statusBadge = status => `<span class="status ${status}"><i></i>${statuses[status]}</span>`;
const selected = (value, expected) => value === expected ? " selected" : "";
const checked = value => value ? " checked" : "";
const pairs = entries => Object.entries(entries);
const opt = (items, value) => items.map(([code, label]) =>
  `<option value="${esc(code)}"${selected(String(value ?? ""), String(code))}>${esc(label)}</option>`).join("");

function input(path, value, {type = "text", label, placeholder = "", code = false} = {}) {
  return `<input data-bind="${path}" ${label ? `aria-label="${esc(label)}"` : ""} type="${type}" value="${esc(value)}"
    placeholder="${esc(placeholder)}" ${type === "number" ? 'step="any"' : 'autocomplete="off"'} ${code ? 'class="mono" spellcheck="false"' : ""}>`;
}
function select(path, value, options, label = "") {
  return `<select data-bind="${path}" ${label ? `aria-label="${esc(label)}"` : ""}>${opt(options, value)}</select>`;
}
function labeled(label, control, required = false) {
  return `<label class="field"><span>${label}${required ? ' <em>*</em>' : ''}</span>${control}</label>`;
}
function block(title, body, info = "") {
  return `<section class="definition-block"><div class="block-title"><h3>${title}</h3>${info ? `<span>${info}</span>` : ""}</div>${body}</section>`;
}
const modeOptions = [["single", "单选"], ["multiple", "多选"]];

function filteredCards() {
  const query = $("search").value.trim().toLowerCase();
  const type = $("type-filter").value;
  const status = $("status-filter").value;
  return state.cards.filter(card => (!query || `${card.name} ${card.code}`.toLowerCase().includes(query)) &&
    (!type || card.type === type) && (!status || card.status === status));
}

function library() {
  const cards = filteredCards();
  $("library-count").textContent = state.cards.length;
  $("match-count").textContent = `${cards.length} 项`;
  $("card-list").innerHTML = cards.length ? cards.map(card =>
    `<button type="button" class="library-item" data-card="${esc(key(card))}" ${state.card && key(state.card) === key(card) ? 'aria-current="true"' : ''}>
      <span class="item-icon ${card.type}">${icon(card.type, 15)}</span>
      <span class="item-label"><strong>${esc(card.name || "未命名参数")}</strong><code>${esc(card.code || "—")}</code></span>
      ${card.version > 1 ? `<small class="item-version">v${card.version}</small>` : ""}
      <span class="item-dot ${card.status}" title="${statuses[card.status]}" aria-label="${statuses[card.status]}"></span>
    </button>`).join("") : '<p class="empty">没有符合条件的参数。</p>';
}

function heading() {
  const card = state.card;
  if (!card) return;
  $("selected-name").textContent = card.name.trim() || "未命名参数";
  $("selected-icon").innerHTML = icon(card.type, 22);
  $("selected-status").innerHTML = statusBadge(card.status);
  $("selected-meta").innerHTML = `<code>${esc(card.code || "参数代码待填写")}</code><span class="meta-divider"></span><span>v${card.version}</span>`;
  $("head-actions").innerHTML = card.id ? btn("markdown", "Markdown", "", "download") : "";
}

function numberEditor(c) {
  const arrangement = preset(c);
  const multiple = c.mode === "multiple";
  const headers = `${multiple ? "<th>子项名称</th><th>子项代码</th>" : ""}<th>数值类型</th><th>最小允许值</th><th>最大允许值</th>${arrangement === "multiple" ? "<th></th>" : ""}`;
  const numbers = c.fields.map((item, index) => {
    const base = `config.fields.${index}`;
    const name = item.name || `数值 ${index + 1}`;
    return `<tr>${multiple ? `<td>${input(base + ".name", item.name, {label: `子项 ${index + 1} 名称`, placeholder: "子项名称"})}</td>
      <td>${input(base + ".code", item.code, {label: `子项 ${index + 1} 代码`, placeholder: "field_code", code: true})}</td>` : ""}
      <td>${select(base + ".number_type", item.number_type, [["integer", "整数"], ["decimal", "小数"]], `${name} 数值类型`)}</td>
      ${["minimum", "maximum"].map((bound, position) => `<td>${input(base + "." + bound, item[bound], {type: "number", label: `${name} ${position ? "最大" : "最小"}允许值`, placeholder: "不限制"})}</td>`).join("")}
      ${arrangement === "multiple" ? `<td><button type="button" class="icon-button" data-action="remove-field" data-index="${index}" aria-label="删除子项 ${index + 1}" ${c.fields.length === 1 ? "disabled" : ""}>${icon("trash", 15)}</button></td>` : ""}</tr>`;
  }).join("");
  const formats = [["single", "单个数值"], ["range", "范围"], ["multiple", "多个数值"]];
  const percent = arrangement === "multiple" ? `<div class="percent-settings">
    ${labeled("百分比传值尺度", select("config.percent_scale", c.percent_scale, [["","普通数值"],["100","0–100（25 表示 25%）"],["1","0–1（0.25 表示 25%）"]]))}
    ${c.percent_scale ? `<label class="checkbox"><input type="checkbox" data-bind="config.check"${checked(c.check === "sum_to_percent")}> 合计必须为 100%</label>
      ${c.check === "sum_to_percent" ? labeled("允许误差（传值单位）", input("config.tolerance", c.tolerance, {type: "number", placeholder: "例如 0.01"})) : ""}` : ""}
  </div>` : "";
  return {
    values: `<div class="segments" aria-label="数值配置方式">${formats.map(([kind, label]) =>
      `<button type="button" data-action="format" data-value="${kind}" aria-pressed="${kind === arrangement}">${label}</button>`).join("")}</div>
      <div class="table-scroller"><table class="config-table"><thead><tr>${headers}</tr></thead><tbody>${numbers}</tbody></table></div>
      ${arrangement === "multiple" ? btn("add-field", "添加子项", "add", "plus") : ""}
      ${arrangement === "range" ? `<div class="inline-rule">${icon("check", 15)}<span>组合检查</span><code>下界 ≤ 上界</code></div>` : ""}${percent}`,
    defaults: `<div class="field-row">${c.fields.map((item, index) => labeled(multiple ? esc(item.name || `子项 ${index + 1}`) : "默认值",
      input(`config.fields.${index}.default`, item.default, {type: "number", placeholder: "未设置"}))).join("")}</div>`,
  };
}

function choiceEditor(c) {
  const items = c.options.map((item, index) => `<tr>
    <td>${input(`config.options.${index}.name`, item.name, {label: `选项 ${index + 1} 名称`, placeholder: "选项名称"})}</td>
    <td>${input(`config.options.${index}.code`, item.code, {label: `选项 ${index + 1} 代码`, placeholder: "option_code", code: true})}</td>
    <td><button type="button" class="icon-button" data-action="remove-option" data-index="${index}" aria-label="删除选项 ${index + 1}">${icon("trash", 15)}</button></td>
  </tr>`).join("");
  const options = c.options.filter(item => item.code).map(item => [item.code, item.name || item.code]);
  const defaults = c.mode === "multiple" ? checklist(options, c.default, "default-choice", "暂无可设为默认值的选项。") :
    select("config.default", c.default, [["", "不设置默认值"], ...(c.mode === "boolean" ? [["true", "是"], ["false", "否"]] : options)], "默认选项");
  return {
    values: `${labeled("选择方式", select("config.mode", c.mode, [...modeOptions, ["boolean", "是／否（布尔值）"]]))}
      ${c.mode === "boolean" ? '<p class="hint">选择「是」提交 true，选择「否」提交 false。</p>' :
        `<div class="table-scroller"><table class="config-table"><thead><tr><th>选项名称</th><th>选项代码</th><th></th></tr></thead>
          <tbody>${items}</tbody></table></div>${btn("add-option", "添加选项", "add", "plus")}`}`,
    defaults,
  };
}

function projectEditor(card) {
  const c = card.config;
  const matches = dependencies(card, state.cards).map(item => [item.code, `${item.name} · ${item.code}`]);
  return {
    values: `<div class="field-row">
      ${labeled("选择对象", select("config.object", c.object, pairs(objects)))}
      ${labeled("选择方式", select("config.mode", c.mode, modeOptions))}
      ${labeled("选项来源", select("config.source", c.source, availableSources(c.object).map(source => [source, sources[source]])))}
      ${c.source === "project" ? "" : labeled("关联参数", select("config.dependency", c.dependency, [["", "选择关联参数"], ...matches]))}
      </div>`,
    defaults: labeled("默认策略", select("config.default", c.default, availableStrategies(c).map(strategy => [strategy, strategies[strategy]]))),
  };
}

function textEditor(c) {
  return {
    values: `<div class="field-row">
      ${labeled("输入形式", select("config.mode", c.mode, [["single", "单行"], ["multiple", "多行"]]))}
      ${labeled("最大长度", input("config.max_length", c.max_length, {type: "number", placeholder: "不限制"}))}
      </div><label class="checkbox"><input type="checkbox" data-bind="config.allow_blank"${checked(c.allow_blank)}> 允许空白</label>`,
    defaults: labeled("默认文字", c.mode === "multiple" ? `<textarea data-bind="config.default" rows="2" placeholder="未设置">${esc(c.default)}</textarea>` :
      input("config.default", c.default, {placeholder: "未设置"})),
  };
}

function renderEditor() {
  const {card} = state;
  const {values, defaults} = card.type === "number" ? numberEditor(card.config) :
    card.type === "choice" ? choiceEditor(card.config) : card.type === "project" ? projectEditor(card) : textEditor(card.config);
  $("definition").innerHTML = `<fieldset class="editor-fields" ${locked() ? "disabled" : ""}>
    ${block("基本信息", `<div class="field-row">${labeled("参数名称", input("name", card.name, {placeholder: "例如 基因数范围"}), true)}
      ${labeled("参数代码", input("code", card.code, {placeholder: "例如 gene_count_range", code: true}), true)}</div>
      ${labeled("填写类型", select("type", card.type, pairs(types)), true)}`)}
    ${block("取值配置", values)}
    ${block("默认设置", defaults, "选填")}
    ${block("参数说明", `<textarea data-bind="description" aria-label="参数说明" rows="2" placeholder="填写用途、单位或注意事项">${esc(card.description)}</textarea>`, "选填")}
  </fieldset>`;
}

function checklist(options, values, target, empty) {
  return options.length ? `<div class="checklist">${options.map(([code, name]) =>
    `<label class="checkbox"><input type="checkbox" data-${target} value="${esc(code)}"${checked(values?.includes(code))}> ${esc(name)}</label>`).join("")}</div>` :
    `<span class="hint">${empty}</span>`;
}

function mockForm() {
  const {card, preview} = state;
  const c = card.config;
  const title = `<div class="mock-label"><strong>${esc(card.name.trim() || "未命名参数")}</strong><span>${types[card.type]}</span></div>`;
  const mockInput = (name, value, index) => `<input type="number" step="any" data-preview="${index}" aria-label="试填 ${esc(name)}" value="${esc(value)}" placeholder="请输入">`;
  const mockSelect = (options, value, label) => `<select data-preview="single" aria-label="${esc(label)}">${opt([["", "请选择"], ...options], value)}</select>`;
  let control;
  if (card.type === "number") {
    control = `<div class="field-row">${c.fields.map((item, index) => {
      const name = item.name || `数值 ${index + 1}`;
      const entry = mockInput(name, preview.value[index], index);
      return c.mode === "single" ? entry : labeled(esc(name), entry);
    }).join("")}</div>`;
  } else if (card.type === "choice") {
    const options = c.mode === "boolean" ? [["true", "是"], ["false", "否"]] :
      c.options.filter(item => item.code).map(item => [item.code, item.name || item.code]);
    control = c.mode === "multiple" ? checklist(options, preview.value, "preview-choice", "添加选项后可试填。") :
      mockSelect(options, preview.value, "试填固定选项");
  } else if (card.type === "project") {
    const options = projectOptions(c, preview.parent);
    const parent = c.source === "project" ? "" : labeled(`${objects[dependencyTypes[c.source]]}（示例）`,
      `<select data-preview="parent">${opt([["", "请选择"], ...parentOptions(c)], preview.parent)}</select>`);
    control = `<span class="demo-source">${icon("info", 14)} 使用示例项目数据</span>${parent}${c.mode === "multiple" ?
      checklist(options, preview.value, "preview-choice", "当前来源无可选对象。") : mockSelect(options, preview.value, "试填项目对象")}`;
  } else {
    control = c.mode === "multiple" ? `<textarea rows="3" aria-label="试填文本" data-preview="text" placeholder="请输入文字">${esc(preview.value)}</textarea>` :
      `<input aria-label="试填文本" data-preview="text" value="${esc(preview.value)}" placeholder="请输入文字">`;
  }
  $("form-preview").innerHTML = title + control + (card.description.trim() ? `<p class="mock-help">${esc(card.description)}</p>` : "");
}

function jsonText() {
  return JSON.stringify(state.tab === "payload" ? submission(state.card, state.preview) : definition(state.card), null, 2);
}
function colorJson(value) {
  const tokens = value.split(/("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/gi);
  return tokens.map((part, index) => !part ? "" : index % 4 === 1 ? `<span class="${valueForKey(index) ? "json-key" : "json-string"}">${esc(part)}</span>` :
      index % 4 === 3 ? `<span class="json-literal">${esc(part)}</span>` : esc(part)).join("");

  function valueForKey(index) {
    return tokens[index + 1]?.includes(":");
  }
}

function renderResults() {
  $("json-preview").innerHTML = colorJson(jsonText());
  const issues = definitionIssues(state.card, state.cards);
  const preview = previewIssues(state.card, state.preview);
  $("validation").className = `validation ${issues.length || preview.length ? "has-issues" : "good"}`;
  $("validation").innerHTML = issues.length || preview.length ?
    `<div>${icon("info", 17)} <strong>${issues.length ? "请核对参数定义" : "请核对试填值"}</strong></div>
    <ul>${[...issues, ...preview].map(issue => `<li>${esc(issue)}</li>`).join("")}</ul>` :
    `<div>${icon("check", 17)} <strong>当前配置与试填值通过校验</strong></div>`;
}

function workflow() {
  const card = state.card;
  const isDirty = dirty();
  let help = "填写定义后可提交给生信工程师确认。";
  let actions = btn("save", "保存草稿") + btn("pending", "提交待确认", "primary");
  if (locked()) {
    const hasNext = state.cards.some(item => item.id === card.id && item.version > card.version);
    help = hasNext ? "此版本已确认，已有更新版本。" : "此版本已确认，可供流程节点选用。";
    actions = hasNext ? btn("latest", "查看最新版本", "primary") : btn("version", "另存新版本", "primary", "plus");
  } else if (card.status === "pending") {
    help = isDirty ? "保存修改后可继续确认。" : "等待生信工程师核对。";
    actions = btn("save", "保存修改") + btn("review", "确认入库", "primary", "check");
  }
  $("workflow-status").innerHTML = `<span class="workflow-icon">${icon(isDirty ? "edit" : locked() ? "check" : "clock", 17)}</span>
    <span><strong>${isDirty ? "有未保存的修改" : statuses[card.status]}</strong><small>${help}</small></span>`;
  $("workflow-actions").innerHTML = actions;
  $("workflow-actions").querySelectorAll("button").forEach(button => { button.disabled = state.busy; });
}

function renderCard() {
  $("detail").hidden = false;
  $("workflow").hidden = false;
  heading();
  renderEditor();
  mockForm();
  renderResults();
  workflow();
  library();
}
function choose(card) {
  state.saved = card.id ? card : null;
  state.card = structuredClone(card);
  state.preview = initialPreview(state.card);
  setTab("payload", false);
  renderCard();
}
function canLeave() {
  return !state.busy && (!dirty() || window.confirm("当前修改尚未保存。要离开这张参数卡吗？"));
}
function createCard() {
  if (!canLeave()) return;
  const type = "number";
  choose({id: null, name: "", code: "", type, config: newConfig(type), description: "", version: 1, status: "draft", updated_at: null});
  $("definition").querySelector('[data-bind="name"]').focus();
}

function syncDefaultControl() {
  const {card} = state;
  const block = $("definition").querySelectorAll(".definition-block")[2];
  if (card.type === "choice") {
    block.querySelector(".block-title").nextElementSibling.outerHTML = choiceEditor(card.config).defaults;
  } else if (card.type === "number" && card.config.mode === "multiple") {
    block.querySelectorAll(".field > span").forEach((label, index) => {
      label.textContent = card.config.fields[index].name || `子项 ${index + 1}`;
    });
  }
}

function edit(input, structural) {
  const {card} = state;
  const path = input.dataset.bind;
  const parts = path.split(".");
  const property = parts.pop();
  const target = parts.reduce((value, part) => value[part], card);
  const previous = target[property];
  let value = input.type === "number" ? (Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null) :
    input.type === "checkbox" ? input.checked : input.value;
  let c = card.config;
  if (path === "config.default" && card.type === "choice") {
    value = value === "" ? null : c.mode === "boolean" ? value === "true" : value;
  }
  if (path === "config.default" && card.type === "text") value = value || null;
  if (path === "config.percent_scale") value = value || null;
  if (path === "config.check") value = value ? "sum_to_percent" : null;
  target[property] = value;

  if (path === "type") {
    card.config = newConfig(value);
    c = card.config;
  }
  if (path === "config.mode" && card.type === "choice") c.default = null;
  if (path === "config.percent_scale" && !value) {
    c.check = null;
    c.tolerance = null;
  }
  if (path === "config.check") c.tolerance = value ? (c.percent_scale === "100" ? 0.01 : 0.0001) : null;
  if (card.type === "project") {
    if (!availableSources(c.object).includes(c.source)) c.source = "project";
    if (!availableStrategies(c).includes(c.default)) c.default = "none";
    if (c.source === "project" || path === "config.source") c.dependency = "";
  }
  if (path.startsWith("config.options.") && property === "code") {
    if (c.default === previous) c.default = value || null;
    else if (Array.isArray(c.default) && c.default.includes(previous)) {
      c.default = Array.from(new Set(c.default.flatMap(code => code === previous ? (value ? [value] : []) : [code])));
    }
    const current = state.preview.value;
    if (current === previous) state.preview.value = value || null;
    else if (Array.isArray(current) && current.includes(previous)) {
      state.preview.value = Array.from(new Set(current.flatMap(code => code === previous ? (value ? [value] : []) : [code])));
    }
  }

  if (structural) {
    state.preview = initialPreview(card);
    renderEditor();
  } else {
    if (path.startsWith("config.options.") || path.startsWith("config.fields.") && property === "name") syncDefaultControl();
    if (property === "default") state.preview = initialPreview(card);
  }
  heading();
  mockForm();
  renderResults();
  workflow();
  if (structural) $("definition").querySelector(`[data-bind="${path}"]`)?.focus();
}

function toggleValue(values, value, on) {
  return on ? [...new Set([...(values || []), value])] : (values || []).filter(item => item !== value);
}
$("definition").addEventListener("input", event => {
  const input = event.target;
  if (input.dataset.bind && input.tagName !== "SELECT" && input.type !== "checkbox") edit(input, false);
});
$("definition").addEventListener("change", event => {
  const input = event.target;
  if (input.hasAttribute("data-default-choice")) {
    const c = state.card.config;
    c.default = toggleValue(c.default, input.value, input.checked);
    state.preview = initialPreview(state.card);
    mockForm();
    renderResults();
    workflow();
  } else if (input.dataset.bind && (input.tagName === "SELECT" || input.type === "checkbox")) {
    edit(input, true);
  }
});

function previewInput(input) {
  const {preview, card} = state;
  if (input.hasAttribute("data-preview-choice")) {
    preview.value = toggleValue(preview.value, input.value, input.checked);
  } else if (input.dataset.preview === "parent") {
    preview.parent = input.value;
    preview.value = projectDefault(card.config, preview.parent);
    mockForm();
    $("form-preview").querySelector('[data-preview="parent"]')?.focus();
  } else if (input.dataset.preview === "single") {
    preview.value = input.value === "" ? null : card.config.mode === "boolean" ? input.value === "true" : input.value;
  } else if (input.dataset.preview === "text") {
    preview.value = input.value;
  } else if (input.dataset.preview !== undefined) {
    preview.value[Number(input.dataset.preview)] = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null;
  }
  renderResults();
}
$("form-preview").addEventListener("input", event => {
  if (event.target.tagName !== "SELECT" && event.target.type !== "checkbox") previewInput(event.target);
});
$("form-preview").addEventListener("change", event => {
  if (event.target.tagName === "SELECT" || event.target.type === "checkbox") previewInput(event.target);
});

function modifyRows(button) {
  const {card} = state;
  const action = button.dataset.action;
  const index = Number(button.dataset.index);
  const c = card.config;
  if (action === "format") {
    const kind = button.dataset.value;
    if (kind === preset(c)) return;
    const config = numberConfig(kind);
    if (kind === "single") {
      Object.assign(config.fields[0], c.fields[0], {name: "", code: ""});
    } else if (kind === "range") {
      config.fields.forEach((item, i) => {
        if (c.fields[i]) Object.assign(item, c.fields[i], {name: item.name, code: item.code});
      });
    } else {
      config.fields = c.fields;
    }
    card.config = config;
  }
  if (action === "add-field") c.fields.push(field());
  if (action === "remove-field") c.fields.splice(index, 1);
  if (action === "add-option") c.options.push(option());
  if (action === "remove-option") {
    const [item] = c.options.splice(index, 1);
    if (c.default === item.code) c.default = null;
    if (Array.isArray(c.default)) c.default = c.default.filter(code => code !== item.code);
  }
  state.preview = initialPreview(card);
  renderEditor();
  mockForm();
  renderResults();
  workflow();
  if (action === "add-field" || action === "add-option") {
    const path = action === "add-field" ? `config.fields.${c.fields.length - 1}.name` : `config.options.${c.options.length - 1}.name`;
    $("definition").querySelector(`[data-bind="${path}"]`)?.focus();
  }
}

function setTab(tab, update = true) {
  state.tab = tab;
  document.querySelectorAll(".code-tab").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tab === tab)));
  if (update) renderResults();
}

function notify(message, error = false) {
  $("toast").textContent = message;
  $("toast").className = error ? "toast error" : "toast";
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 6500 : 3300);
}

async function request(options) {
  const response = await fetch(endpoint, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "无法连接参数库。");
  return data;
}
async function load() {
  try {
    const {cards} = await request();
    state.cards = cards;
    $("load-error").hidden = true;
    $("new-card").disabled = false;
    $("export-library").disabled = false;
    const first = cards.find(card => key(card) === sessionStorage.getItem("skyao-parameter-selection")) ||
      cards.find(card => card.code === "gene_count_range") || cards[0];
    if (first) choose(first);
    else createCard();
  } catch (error) {
    $("load-error").hidden = false;
    $("load-error").innerHTML = `<p>${esc(error.message)}</p>${btn("reload", "重新载入", "primary")}`;
  }
}

async function save(action) {
  if (state.busy) return;
  if (["pending", "confirmed"].includes(action) && definitionIssues(state.card, state.cards).length) {
    notify("请先修正预览区列出的配置问题。", true);
    $("validation").scrollIntoView({block: "nearest"});
    return;
  }
  if (action === "confirmed" && dirty()) {
    notify("请先保存修改，再确认入库。", true);
    return;
  }
  state.busy = true;
  $("definition").inert = true;
  workflow();
  try {
    const originalPreview = state.preview;
    const card = await request({method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({action, card: state.card})});
    const index = state.cards.findIndex(item => key(item) === key(card));
    if (index >= 0) state.cards[index] = card;
    else state.cards.unshift(card);
    if (!filteredCards().includes(card)) {
      $("status-filter").value = "";
      $("type-filter").value = "";
      $("search").value = "";
    }
    choose(card);
    if (action !== "new_version") {
      state.preview = originalPreview;
      mockForm();
      renderResults();
    }
    sessionStorage.setItem("skyao-parameter-selection", key(card));
    notify({draft: "草稿已保存。", pending: "已保存，等待生信确认。", confirmed: "参数已确认入库。", new_version: `已创建 v${card.version} 草稿。`}[action]);
  } catch (error) {
    notify(error.message, true);
  } finally {
    state.busy = false;
    $("definition").inert = false;
    workflow();
  }
}

function review() {
  if (dirty() || definitionIssues(state.card, state.cards).length) {
    notify(dirty() ? "请先保存修改，再确认入库。" : "请先修正参数定义中的问题。", true);
    return;
  }
  $("review-form").reset();
  $("review-target").textContent = `${state.card.name} · ${state.card.code} · v${state.card.version}`;
  $("review-dialog").showModal();
}
$("cancel-review").addEventListener("click", () => $("review-dialog").close());
$("review-form").addEventListener("submit", event => {
  event.preventDefault();
  $("review-dialog").close();
  save("confirmed");
});

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMarkdown(card) {
  const c = card.config;
  const missing = "未设置";
  const heading = value => String(value).replace(/[\r\n]+/g, " ");
  const cell = value => heading(value ?? missing).replace(/\|/g, "\\|");
  const table = (columns, rows) => [
    `| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.map(cell).join(" | ")} |`),
  ];
  let configLines;
  if (card.type === "number") {
    configLines = table(["子项", "子项代码", "数值类型", "最小允许值", "最大允许值", "默认值"],
      c.fields.map(item => [item.name || card.name, c.mode === "single" ? "—" : item.code,
        item.number_type === "integer" ? "整数" : "小数", item.minimum ?? "不限制", item.maximum ?? "不限制", item.default]));
    if (c.percent_scale) configLines.push("", `百分比传值尺度 0–${c.percent_scale}。`);
    if (c.check === "min_lte_max") configLines.push("", "组合检查 下界 ≤ 上界。");
    if (c.check === "sum_to_percent") configLines.push("", `组合检查 合计为 ${c.percent_scale}，允许误差 ±${c.tolerance}。`);
  } else if (card.type === "choice") {
    const options = c.mode === "boolean" ? [{name: "是", code: true}, {name: "否", code: false}] : c.options;
    configLines = [c.mode === "multiple" ? "多选" : "单选", "", ...table(["选项", "选项代码", "默认选中"],
      options.map(item => [item.name, item.code, c.default === item.code || (Array.isArray(c.default) && c.default.includes(item.code)) ? "是" : "否"]))];
  } else if (card.type === "project") {
    configLines = [`- 选择对象 ${objects[c.object]}`, `- 选择方式 ${c.mode === "single" ? "单选" : "多选"}`,
      `- 选项来源 ${sources[c.source]}`, `- 关联参数 ${c.dependency || "无"}`, `- 默认策略 ${strategies[c.default]}`];
  } else {
    configLines = [`- 输入形式 ${c.mode === "single" ? "单行" : "多行"}`, `- 允许空白 ${c.allow_blank ? "是" : "否"}`,
      `- 最大长度 ${c.max_length ?? "不限制"}`, `- 默认文字 ${c.default === null ? missing : JSON.stringify(c.default)}`];
  }
  const issues = definitionIssues(card, state.cards);
  const payload = JSON.stringify(submission(card, initialPreview(card, true)), null, 2);
  download(`${/^[a-z][a-z0-9_]*$/.test(card.code) ? card.code : "parameter"}-v${card.version}.md`, [
    `# ${heading(card.name || "未命名参数")}`, "", `- 参数代码 \`${heading(card.code || "未填写")}\``,
    `- 填写类型 ${types[card.type]}`, `- 版本 v${card.version}`, `- 状态 ${statuses[card.status]}`,
    `- 参数 ID ${card.id}`, `- 修改时间 ${card.updated_at}`, "", "## 参数说明", "", card.description || "暂无说明。",
    "", "## 取值与默认设置", "", ...configLines, "", "## 提交示例", "", "\`\`\`json", payload, "\`\`\`",
    "", "## 待确认问题", "", ...(issues.length ? issues.map(issue => `- ${issue}`) :
      [card.status === "confirmed" ? "已确认。" : "待核对代码、取值含义、默认值及提交数据。"]), "",
  ].join("\n"), "text/markdown;charset=utf-8");
}

function exportLibrary() {
  const cards = filteredCards();
  if (!cards.length) return notify("当前筛选范围内没有可导出的参数。", true);
  const csv = value => {
    let text = String(value ?? "");
    if (/^[\t\r\n]|^\s*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const rows = [["参数名称", "参数代码", "填写类型", "状态", "版本", "修改时间", "参数 ID", "参数说明"],
    ...cards.map(card => [card.name, card.code, types[card.type], statuses[card.status], card.version, card.updated_at, card.id, card.description])];
  download("SkyAO-参数总表.csv", "\uFEFF" + rows.map(row => row.map(csv).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  notify(`已导出当前筛选的 ${cards.length} 张参数卡。`);
}

$("search").addEventListener("input", library);
$("type-filter").addEventListener("change", library);
$("status-filter").addEventListener("change", library);
$("new-card").addEventListener("click", createCard);
$("export-library").addEventListener("click", exportLibrary);
$("copy-json").addEventListener("click", async () => {
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
});
$("card-list").addEventListener("click", event => {
  const item = event.target.closest("[data-card]");
  if (!item || (state.card && key(state.card) === item.dataset.card) || !canLeave()) return;
  const card = state.cards.find(card => key(card) === item.dataset.card);
  choose(card);
  sessionStorage.setItem("skyao-parameter-selection", key(card));
});
document.addEventListener("click", event => {
  const tab = event.target.closest("[data-tab]");
  if (tab) setTab(tab.dataset.tab);
  const button = event.target.closest("[data-action]");
  if (!button) return;
  switch (button.dataset.action) {
    case "format": case "add-field": case "remove-field": case "add-option": case "remove-option": modifyRows(button); break;
    case "save": save(state.card.status); break;
    case "pending": save("pending"); break;
    case "review": review(); break;
    case "version": save("new_version"); break;
    case "markdown": exportMarkdown(state.saved); break;
    case "latest": {
      const latest = state.cards.filter(card => card.id === state.card.id).sort((a, b) => b.version - a.version)[0];
      choose(latest);
      sessionStorage.setItem("skyao-parameter-selection", key(latest));
      break;
    }
    case "reload": load(); break;
  }
});
window.addEventListener("beforeunload", event => {
  if (dirty()) {
    event.preventDefault();
    event.returnValue = true;
  }
});
document.querySelectorAll("[data-icon]").forEach(node => { node.innerHTML = icon(node.dataset.icon); });
$("new-card").disabled = true;
$("export-library").disabled = true;
load();
