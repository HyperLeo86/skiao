import {types, objects, dependencyTypes, projectOptions, parentOptions, projectDefault} from "./parameter-model.js";
import {esc, icon, opt, labeled, checklist, toggleValue} from "./workbench-ui.js";

export function parameterForm(card, preview, {required = false, linked = false, showCode = false} = {}) {
  const c = card.config;
  const title = `<div class="mock-label"><strong>${esc(card.name.trim() || "未命名参数")}</strong><span>${types[card.type]}</span>${required ? '<span class="required-tag">必填</span>' : ""}</div>`;
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
      c.options.map((item, index) => [item.code, item.name || `选项 ${index + 1}`]);
    control = c.mode === "multiple" ? checklist(options, preview.value, "preview-choice", "添加选项后可试填。") :
      mockSelect(options, preview.value, "试填固定选项");
  } else if (card.type === "project") {
    const options = projectOptions(c, preview.parent);
    const parent = c.source === "project" ? "" : linked ? `<span class="hint">来源参数 <code>${esc(c.dependency)}</code></span>` : labeled(`${objects[dependencyTypes[c.source]]}（示例）`,
      `<select data-preview="parent">${opt([["", "请选择"], ...parentOptions(c)], preview.parent)}</select>`);
    control = `<span class="demo-source">${icon("info", 14)} 使用示例项目数据</span>${parent}${c.mode === "multiple" ?
      checklist(options, preview.value, "preview-choice", "当前来源无可选对象。") : mockSelect(options, preview.value, "试填项目对象")}`;
  } else {
    control = c.mode === "multiple" ? `<textarea rows="3" aria-label="试填文本" data-preview="text" placeholder="请输入文字">${esc(preview.value)}</textarea>` :
      `<input aria-label="试填文本" data-preview="text" value="${esc(preview.value)}" placeholder="请输入文字">`;
  }
  return title + (showCode ? `<code class="ref-code">${esc(card.code)} · v${card.version}</code>` : "") + control + (card.description.trim() ? `<p class="mock-help">${esc(card.description)}</p>` : "");
}

export function updateParameterTrial(input, card, preview) {
  if (input.hasAttribute("data-preview-choice")) {
    preview.value = toggleValue(preview.value, input.value, input.checked);
  } else if (input.dataset.preview === "parent") {
    preview.parent = input.value;
    preview.value = projectDefault(card.config, preview.parent);
    return true;
  } else if (input.dataset.preview === "single") {
    preview.value = input.value === "" ? null : card.config.mode === "boolean" ? input.value === "true" : input.value;
  } else if (input.dataset.preview === "text") {
    preview.value = input.value;
  } else if (input.dataset.preview !== undefined) {
    preview.value[Number(input.dataset.preview)] = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null;
  }
  return false;
}
