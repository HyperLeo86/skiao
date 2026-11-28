import {csv, plotSpec} from "./charts.js";
import {demoSession} from "./session.js";

const $ = id => document.getElementById(id);
const run = decodeURIComponent(location.pathname.split("/").pop());
const api = "/api/v1/runs/" + encodeURIComponent(run);
$("run").textContent = run;

let token = "";
let results = null;
let node = null;
let sectionKey = null;
let unit = null;
let desired = {};
let selected = new Set();
let activeType = null;
const artifactCache = new Map();
const styles = new Map();

function element(tag, text) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  return item;
}

function button(text, action) {
  const item = element("button", text);
  item.type = "button";
  item.addEventListener("click", action);
  return item;
}

async function fetchRun(path) {
  const response = await fetch(api + path, {headers: {Authorization: "Bearer " + token}});
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.code ?? "HTTP " + response.status);
  }
  return response;
}

async function load() {
  if (!token) return;
  const controls = [...$("access").querySelectorAll("button")];
  controls.forEach(control => { control.disabled = true; });
  $("notice").hidden = false;
  $("notice").classList.remove("error");
  $("notice").textContent = "正在读取结果…";
  $("result").hidden = true;
  clearViews();
  try {
    results = await (await fetchRun("/results")).json();
    const entries = results.sections.flatMap(section => section.nodes.map(item => [section.section_key, item]));
    const previous = entries.find(([key, item]) => key === sectionKey && item.node_key === node?.node_key);
    const current = previous ?? entries[0];
    node = current?.[1] ?? null;
    sectionKey = current?.[0] ?? null;
    drawDirectory();
    $("refresh").hidden = false;
    if (node) {
      $("notice").hidden = true;
      $("result").hidden = false;
      applySelection();
    } else {
      $("title").textContent = "结果接收器";
      $("notice").textContent = "本任务暂无已接收结果。投送后点击「刷新结果」。";
    }
  } catch (error) {
    results = null;
    $("directory").replaceChildren();
    $("title").textContent = "结果接收器";
    $("notice").classList.add("error");
    $("notice").textContent = "读取结果失败 · " + error.message;
  } finally {
    controls.forEach(control => { control.disabled = false; });
  }
}

$("access").addEventListener("submit", event => {
  event.preventDefault();
  token = $("token").value.trim();
  $("token").value = "";
  artifactCache.clear();
  load();
});
$("refresh").addEventListener("click", load);
$("mode").addEventListener("change", drawViews);

demoSession().then(session => {
  if (!session || session.run_id !== run) return;
  $("console-link").hidden = false;
  if (!token) {
    token = session.token;
    load();
  }
}).catch(() => {});

function drawDirectory() {
  $("directory").replaceChildren();
  for (const section of results.sections) {
    const block = element("section");
    block.append(element("h3", section.title));
    for (const entry of section.nodes) {
      const item = button(entry.node_title, () => {
        if (entry === node) return;
        node = entry;
        sectionKey = section.section_key;
        desired = {};
        drawDirectory();
        applySelection();
        $("directory").querySelector('[aria-current="true"]').focus();
      });
      if (entry === node) item.setAttribute("aria-current", "true");
      block.append(item);
    }
    $("directory").append(block);
  }
}

function applySelection(focusKey) {
  $("title").textContent = node.node_title;
  $("selectors").replaceChildren();
  let candidates = node.result_units;
  for (const key of node.selector_keys) {
    const dictionary = results.dimensions[key];
    const available = [...new Set(candidates.map(item => item.selectors[key]))];
    const value = available.includes(desired[key]) ? desired[key] : available[0];
    const label = element("label", dictionary.title);
    const select = element("select");
    select.id = "selector-" + key;
    label.htmlFor = select.id;
    for (const choice of available) {
      const option = element("option", dictionary.values[choice] ?? choice);
      option.value = choice;
      select.append(option);
    }
    select.value = value;
    select.addEventListener("change", () => {
      desired = {...unit.selectors, [key]: select.value};
      applySelection(key);
    });
    const field = element("div");
    field.className = "selector";
    field.append(label, select);
    $("selectors").append(field);
    if (focusKey === key) select.focus();
    candidates = candidates.filter(item => item.selectors[key] === value);
  }
  unit = candidates[0];
  desired = {...unit.selectors};
  $("revision").textContent = "版本 " + unit.revision + " · " + unit.delivery_id;
  const all = renderTypes();
  selected = new Set([...selected].filter(type => all.includes(type)));
  if (selected.size === 0) selected.add(all[0]);
  drawTypeControls(all);
  drawViews();
}

function renderTypes() {
  return unit.render_groups.flatMap(group => group.render_types);
}

function labelFor(type) {
  return results.renderers[type].title;
}

function drawTypeControls(all) {
  $("types").querySelectorAll("label, p").forEach(item => item.remove());
  for (const type of all) {
    const label = element("label");
    const check = element("input");
    check.type = "checkbox";
    check.checked = selected.has(type);
    check.addEventListener("change", () => {
      if (check.checked) selected.add(type);
      else selected.delete(type);
      drawViews();
    });
    label.append(check, labelFor(type));
    $("types").append(label);
  }
}

function clearViews() {
  $("views").querySelectorAll(".js-plotly-plot").forEach(item => window.Plotly?.purge(item));
  $("views").replaceChildren();
}

function drawViews() {
  if (!unit || !results) return;
  const types = renderTypes().filter(type => selected.has(type));
  const single = $("mode").value === "single";
  if (!types.includes(activeType)) activeType = types[0];
  $("tabs").replaceChildren();
  clearViews();
  if (!types.length) {
    $("views").append(element("p", "选择要查看的图表。"));
    return;
  }
  if (single) {
    for (const type of types) {
      const tab = button(labelFor(type), () => {
        activeType = type;
        drawViews();
        $("tabs").querySelector('[aria-selected="true"]').focus();
      });
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(activeType === type));
      $("tabs").append(tab);
    }
  }
  for (const type of single ? [activeType] : types) drawCard(type);
}

function getArtifact(id) {
  if (!artifactCache.has(id)) {
    const data = fetchRun("/artifacts/" + encodeURIComponent(id)).then(response => response.blob());
    artifactCache.set(id, data);
    data.catch(() => {
      if (artifactCache.get(id) === data) artifactCache.delete(id);
    });
  }
  return artifactCache.get(id);
}

async function download(source) {
  const url = URL.createObjectURL(await getArtifact(source.artifact_id));
  const link = element("a");
  link.href = url;
  link.download = source.file_name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawCard(type) {
  const group = unit.render_groups.find(item => item.render_types.includes(type));
  const card = element("article");
  card.className = "view";
  card.dataset.type = type;
  const header = element("header");
  const downloads = element("div");
  downloads.className = "downloads";
  const body = element("div");
  const message = element("p", "正在从接收端读取数据…");
  message.className = "chart-message";
  message.setAttribute("role", "status");
  function failure(error) {
    message.hidden = false;
    message.textContent = "读取失败 · " + error.message;
    message.classList.add("error");
  }
  for (const source of Object.values(group.sources)) {
    downloads.append(button("下载 " + source.file_name, () => download(source).catch(failure)));
  }
  header.append(element("h2", labelFor(type)), downloads);
  card.append(header, message, body);
  $("views").append(card);
  Promise.all(Object.entries(group.sources).map(async ([role, source]) => {
    const file = await getArtifact(source.artifact_id);
    return [role, csv(new TextDecoder("utf-8").decode(await file.arrayBuffer()))];
  })).then(async entries => {
    if (!card.isConnected) return;
    const data = Object.fromEntries(entries);
    if (type === "table") drawTable(body, data.data);
    else await drawChart(body, type, data, group.can_edit[type], failure);
    message.hidden = true;
  }).catch(failure);
}

function drawTable(body, data) {
  const frame = element("div");
  frame.className = "table-wrap";
  const table = element("table");
  const headers = element("tr");
  for (const name of data.columns) headers.append(element("th", name));
  table.createTHead().append(headers);
  const rows = table.createTBody();
  frame.append(table);
  const pager = element("div");
  pager.className = "pager";
  const counter = element("span");
  const pageSize = 100;
  let offset = 0;
  const previous = button("上一页", () => { offset -= pageSize; showPage(); });
  const next = button("下一页", () => { offset += pageSize; showPage(); });
  function showPage() {
    const end = Math.min(data.rows.length, offset + pageSize);
    rows.replaceChildren(...data.rows.slice(offset, end).map(values => {
      const row = element("tr");
      row.append(...values.map(value => element("td", value)));
      return row;
    }));
    counter.textContent = data.rows.length ? (offset + 1) + "–" + end + " / " + data.rows.length + " 行" : "0 行";
    previous.disabled = offset === 0;
    next.disabled = end === data.rows.length;
    frame.scrollTop = 0;
  }
  pager.append(counter);
  if (data.rows.length > pageSize) pager.append(previous, next);
  body.append(frame, pager);
  showPage();
}

async function drawChart(body, type, data, editable, onError) {
  const style = editable && styles.get(type) || {color: "#176552", fontSize: 13};
  const plot = element("div");
  plot.className = "plot";
  body.append(plot);
  function paint() {
    const spec = plotSpec(type, data, style);
    return window.Plotly.react(plot, spec.traces, spec.layout, {displayModeBar: false, responsive: true});
  }
  if (editable) {
    const controls = element("div");
    controls.className = "style";
    const colorLabel = element("label", "颜色");
    const color = element("input");
    color.type = "color";
    color.value = style.color;
    const sizeLabel = element("label", "字号");
    const size = element("input");
    size.type = "number";
    size.min = 9;
    size.max = 28;
    size.value = style.fontSize;
    const save = () => {
      style.color = color.value;
      style.fontSize = Math.max(9, Math.min(28, size.valueAsNumber || 13));
      size.value = style.fontSize;
      styles.set(type, style);
      paint().catch(onError);
    };
    color.addEventListener("change", save);
    size.addEventListener("change", save);
    colorLabel.append(color);
    sizeLabel.append(size);
    controls.append(colorLabel, sizeLabel);
    body.prepend(controls);
  }
  await paint();
}
