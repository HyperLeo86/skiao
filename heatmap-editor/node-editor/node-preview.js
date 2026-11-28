import {dependencies, initialPreview, projectDefault} from "../parameter-editor/parameter-model.js";
import {esc, icon, opt, labeled} from "../parameter-editor/workbench-ui.js";
import {parameterForm} from "../parameter-editor/parameter-form.js";
import {resultTypes, scripts, identity, resolve} from "./node-model.js";

const glyphs = {table: "form", image: "eye", render: "edit"};
const heatmapExample = new URL("../index.html?node-preview=example", import.meta.url);
const scriptLabel = ref => Object.hasOwn(scripts, ref) ? `${scripts[ref]}（${ref}）` : ref;
const scriptStatus = ref => Object.hasOwn(scripts, ref) ? "示例预览可用" : "未接入";
export {scriptLabel, scriptStatus};

export function prepareNodeTrials(node, cards, previous = new Map()) {
  const pinned = node.reanalysis.parameters.map(ref => resolve(ref, cards)).filter(Boolean);
  const trials = new Map(pinned.map(card => [identity(card), previous.get(identity(card)) ??
    initialPreview(card, false, {showRangeExample: false})]));
  for (const card of pinned) {
    if (card.type !== "project" || card.config.source === "project") continue;
    const parent = dependencies(card, pinned).find(item => item.code === card.config.dependency);
    const trial = trials.get(identity(card));
    const value = parent ? trials.get(identity(parent))?.value ?? "" : "";
    if (trial.parent !== value) {
      trial.parent = value;
      trial.value = projectDefault(card.config, value);
    }
  }
  return trials;
}

export function nodeTrialForms(node, cards, trials) {
  const assignments = node.reanalysis.parameters.map(ref => ({ref, card: resolve(ref, cards)}));
  return assignments.map(({ref, card}, index) => card ? `<div class="mock-form" data-trial-index="${index}">
    ${parameterForm(card, trials.get(identity(card)), {required: ref.required, linked: true, showCode: true})}</div>` :
    `<div class="validation has-issues">无法解析 ${esc(ref.parameter_code)} v${ref.parameter_version}。</div>`).join("");
}

function resultPreview(node, result, chartSelections) {
  const placeholder = text => `<div class="result-placeholder">${icon(glyphs[result.type], 22)}${esc(text)}</div>`;
  let content;
  if (result.type === "table") {
    content = '<div class="table-scroller"><table class="config-table"><thead><tr><th>Protein</th><th>Control_01</th><th>Control_02</th><th>TreatA_01</th></tr></thead><tbody><tr><td>ALB</td><td>4.1</td><td>4.0</td><td>2.8</td></tr><tr><td>APOA1</td><td>3.4</td><td>3.6</td><td>2.5</td></tr><tr><td>ACTB</td><td>2.2</td><td>2.1</td><td>2.2</td></tr></tbody></table></div>';
  } else if (result.type === "image") {
    content = placeholder("成品图片占位");
  } else {
    const source = node.results.find(item => item.type === "table" && item.id === result.source_table_id);
    const requested = chartSelections.get(result.id);
    const selected = result.script_refs.includes(requested) ? requested : result.default_script_ref;
    const choices = result.script_refs.map(ref => [ref, scriptLabel(ref)]);
    content = `<p class="mock-help">来源 ${source ? esc(`${source.id} · ${source.name || "未命名表格"}`) : "待配置"}
      <br>默认脚本 ${result.default_script_ref ? esc(scriptLabel(result.default_script_ref)) : "待配置"}</p>
      ${choices.length > 1 ? labeled("切换预览脚本", `<select data-chart="${esc(result.id)}">${opt([["", "选择脚本"], ...choices], selected)}</select>`) : ""}
      ${source && selected === "heatmap" ? `<iframe class="node-preview-frame" src="${esc(heatmapExample)}" loading="lazy" title="现有热图编辑器的示例渲染"></iframe>` :
        placeholder(source && selected ? `${scriptLabel(selected)} · 绘图入口未接入` : "待配置来源表格及脚本")}`;
  }
  return `<article class="mock-form preview-result" data-preview-result="${esc(result.id)}">
    <div class="mock-label"><strong>${esc(result.name || "未命名结果")}</strong><span>${resultTypes[result.type]}</span></div>
    <code class="ref-code">${esc(result.id)} · 示例</code>${content}</article>`;
}

export function nodeResultsPreview(node, chartSelections = new Map()) {
  const visible = node.results.filter(result => result.type !== "table" || result.visible);
  const hidden = node.results.filter(result => result.type === "table" && !result.visible);
  return visible.map(result => resultPreview(node, result, chartSelections)).join("") +
    (hidden.length ? `<p class="hint">仅作为绘图来源：${hidden.map(result => esc(`${result.id} ${result.name}`)).join("、")}</p>` : "") +
    (!visible.length && !hidden.length ? '<p class="hint">添加结果项后可查看示例。</p>' : "");
}
