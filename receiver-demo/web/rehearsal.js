import {csv} from "./charts.js";

const $ = id => document.getElementById(id);
const base = "/demo/rehearsal/api";
const types = {sample:"样本", comparison:"比较对"};
const statusText = {empty:"等待文件", received:"文件已接收", waiting:"等待其他绘图输入", queued:"等待绘图",
  running:"绘图中", ready:"可查看", succeeded:"绘图完成", failed:"绘图失败", accepted:"已接收"};
const groups = {rehearsal_projects:"项目", rehearsal_nodes:"项目节点", rehearsal_deliveries:"投送记录",
  rehearsal_slots:"结果位置", rehearsal_versions:"结果版本", rehearsal_files:"文件记录", rehearsal_plots:"绘图操作"};
const columns = {id:"主键", analysis_run_id:"运行编号", name:"名称", flow_id:"来源流程", flow_name:"流程名称",
  flow_version:"流程版本", created_at:"创建时间", project_id:"所属项目", section_id:"目录编号", section_title:"目录",
  entry_id:"流程条目", node_id:"来源节点", node_version:"节点版本", node_title:"节点名称", position:"展示顺序",
  definition:"定义", project_node_id:"项目节点", fingerprint:"投送指纹", manifest:"投送清单", status:"状态",
  accepted_at:"接收时间", file_name:"文件名称", size_bytes:"字节数", sha256:"SHA-256", media_type:"文件类型",
  kind:"文件来源", storage_key:"存储位置", delivery_id:"投送编号", result_item_id:"结果项", result_name:"结果名称",
  type:"结果类型", selectors:"结果范围", current_version_id:"当前版本指针", plot_id:"绘图操作",
  updated_delivery_id:"最后更新投送", slot_id:"所属结果位置", revision:"版本号", file_id:"关联文件",
  script:"脚本", inputs:"输入", parameters:"参数", message:"消息", output_file_id:"输出文件", started_at:"开绘时间", finished_at:"完成时间"};
const state = {projects:[], project:null, node:null, scope:{}, files:new Map(), tables:{}, labels:groups,
  selectedSlot:null, currentDelivery:null, receipt:null, replayed:false, manifest:null, signature:null,
  tab:"manifest", manifestMode:"table", busy:false, poll:null, refreshToken:0, materials:new Set(),
  limits:null, builtin:null, workbench:false, templates:new Map(), previewFile:null, error:""};
const esc = value => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[character]));
const tag = (value, kind = "system") => `<span class="tag ${kind}">${esc(value)}</span>`;
const stateTag = key => tag(statusText[key] ?? key, statusText[key] ? key : "system");
const opt = (pairs, value) => pairs.map(([id, label]) =>
  `<option value="${esc(id)}"${id === value ? " selected" : ""}>${esc(label)}</option>`).join("");
const units = () => state.tables.rehearsal_slots || [];
const nodes = () => state.tables.rehearsal_nodes || [];
const versions = () => state.tables.rehearsal_versions || [];
const actualFiles = () => state.tables.rehearsal_files || [];
const jobs = () => state.tables.rehearsal_plots || [];
const route = project => base + "/projects/" + encodeURIComponent(project?.id ?? state.project.id);
const fileUrl = (id, download = false) => route() + "/files/" + encodeURIComponent(id) + (download ? "?download=1" : "");
const path = node => `${node.section_title} → ${node.node_title}`;
const scopeKey = scope => JSON.stringify(Object.entries(scope).sort(([a],[b])=>a.localeCompare(b)));
const scopeText = (scope, node) => Object.keys(scope).length ? Object.entries(scope).map(([key, value]) =>
  `${types[key] ?? key} ${node.definition.selectors[key]?.[value] ?? value}（${value}）`).join(" / ") : "整体";
const time = value => value ? new Date(value).toLocaleString("zh-CN", {hour12:false}) : "—";
const bytes = size => size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;

async function api(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
  return result;
}

function setError(message) {
  state.error = message;
  $("send-error").textContent = message;
  $("send-error").hidden = !message;
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tab === tab)));
  renderInspection();
}

function refreshSteps() {
  const step = !state.project ? "project" : state.currentDelivery ? "inspect" :
    state.files.size ? "prepare" : state.materials.has(state.project.id) ? "prepare" : "materials";
  document.querySelectorAll("[data-step]").forEach(button => {
    if (button.dataset.step === step) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
}

function persistSelection() {
  if (state.project) sessionStorage.setItem("skyao-rehearsal-selection", JSON.stringify({
    project:state.project.id, node:state.node?.id, slot:state.selectedSlot, scope:state.scope,
  }));
}

function renderDirectory() {
  const positions = units();
  const waiting = positions.filter(slot=>slot.status==="empty").length;
  $("position-count").hidden = !state.project;
  $("position-count").textContent = `${positions.length} 项 · ${waiting} 待收`;
  $("project-select").innerHTML = opt(state.projects.length ? state.projects.map(project =>
    [project.id, `${project.name} · ${time(project.created_at)}`]) : [["","暂无演练项目"]], state.project?.id);
  $("project-select").disabled = !state.projects.length || state.busy;
  $("project-id").textContent = state.project ? state.project.id + " · " + state.project.flow_name : "";
  const sections = new Map();
  for (const node of nodes()) {
    if (!sections.has(node.section_id)) sections.set(node.section_id, {title:node.section_title, nodes:[]});
    sections.get(node.section_id).nodes.push(node);
  }
  $("directory").innerHTML = Array.from(sections.values(), section => `<section data-directory-section><h3>${esc(section.title)}</h3>` +
    section.nodes.map(node => {
      let currentScope = "";
      return `<button class="dir-node" type="button" data-node="${esc(node.id)}"${state.node?.id === node.id ? ' aria-current="true"' : ""}>
        <span>${esc(node.node_title)}</span></button>` + positions.filter(slot=>slot.project_node_id===node.id).map(slot => {
        const key = scopeKey(slot.selectors);
        const scope = key !== currentScope && Object.keys(slot.selectors).length ? `<p class="dir-scope">${esc(scopeText(slot.selectors,node))}</p>` : "";
        currentScope = key;
        return scope + `<button class="dir-slot" type="button" data-slot="${esc(slot.id)}"${state.selectedSlot === slot.id ? ' aria-current="true"' : ""}>
          <span><code>${esc(slot.result_item_id)}</code> ${esc(slot.result_name)}</span>${stateTag(slot.status)}</button>`;
      }).join("");
    }).join("") + "</section>").join("") || '<p class="drill-body muted">创建项目后会在这里显示所有目录和结果位置。</p>';
}

function updateLinks() {
  for (const [id, url] of [["download-all", state.project ? route()+"/materials" : null],
    ["download-node", state.node ? route()+"/materials/"+encodeURIComponent(state.node.id) : null]]) {
    if (url) $(id).href = url;
    else $(id).removeAttribute("href");
  }
}

function renderPreparation() {
  const node = state.node;
  $("node-select").innerHTML = opt(node ? nodes().map(item => [item.id,path(item)]) : [["","创建项目后选择节点"]], node?.id);
  $("node-select").disabled = !node || state.busy;
  $("scope-controls").innerHTML = node ? Object.entries(node.definition.selectors).map(([dimension, allowed]) =>
    `<label class="field"><span>${esc(types[dimension] ?? dimension)}</span><select data-scope="${esc(dimension)}" ${state.busy ? "disabled" : ""}>${opt(Object.entries(allowed).map(([id,label])=>[id,`${label}（${id}）`]),state.scope[dimension])}</select></label>`).join("") : "";
  $("pick-files").disabled = !node || state.busy;
  const targetOptions = [["","选择结果项"],...(node?.definition.results.filter(spec=>spec.type!=="render")
    .map(spec=>[spec.id,`${spec.id} · ${spec.name}`]) ?? [])];
  $("bindings").innerHTML = state.files.size ? `<div class="table-overflow"><table class="drill-table">
    <thead><tr><th>本地文件</th><th>大小</th><th>投递结果项</th><th>角色</th><th></th></tr></thead><tbody>` +
    Array.from(state.files.entries(), ([name,item]) =>
      `<tr><td>${esc(name)}${item.digesting ? '<p class="muted">计算摘要中</p>' : ""}</td><td>${bytes(item.file.size)}</td>
      <td><select aria-label="${esc(name)} 投递结果项" data-bind-file="${esc(name)}" ${state.busy ? "disabled" : ""}>${opt(targetOptions,item.target)}</select></td>
      <td><code>data</code></td><td><button class="remove" type="button" data-remove-file="${esc(name)}" aria-label="移除 ${esc(name)}" ${state.busy ? "disabled" : ""}>移除</button></td></tr>`).join("") +
    "</tbody></table></div>" : '<p class="muted">从本机选择文件，再指定每个文件的目标。可以分多次选入。</p>';
  $("send").disabled = !node || !state.files.size || state.busy || [...state.files.values()].some(item=>item.digesting);
  $("send-state").textContent = state.busy ? "正在上传实际文件与 Manifest…" :
    state.files.size ? `已选 ${state.files.size} 个本地文件` : "";
  updateLinks();
}

function prepareManifest() {
  if (!state.node) {
    state.signature = state.manifest = null;
    return;
  }
  const files = Array.from(state.files.values());
  const context = {
    schema_version:"0.3", analysis_run_id:state.project.analysis_run_id, project_node_id:state.node.id,
    result_units:[{selectors:{...state.scope},result_items:files.map(item=>({
      result_item_id:item.target, sources:{data:item.file.name},
    }))}],
    artifacts:files.map(item=>({file_name:item.file.name,size_bytes:item.file.size,sha256:item.sha ?? ""})),
  };
  const signature = JSON.stringify(context);
  const id = state.signature === signature ? state.manifest.delivery_id : "DEL-" + crypto.randomUUID();
  state.signature = signature;
  state.manifest = {delivery_id:id, ...context};
}

function checks(doc) {
  if (!doc || !state.files.size) return ["请先选择本地文件。"];
  const issues = [];
  const used = new Set();
  const specs = new Map(state.node.definition.results.map(spec=>[spec.id,spec]));
  let total = 0;
  const files = doc.artifacts;
  if (files.length > state.limits.files) issues.push(`最多接收 ${state.limits.files} 个文件。`);
  files.forEach((file,index) => {
    const item = doc.result_units[0].result_items[index];
    const spec = specs.get(item.result_item_id);
    total += file.size_bytes;
    if (!/^[\p{L}\p{N}_ .()+-]{1,160}$/u.test(file.file_name) || [".",".."].includes(file.file_name)) {
      issues.push(`${file.file_name} 文件名含不可用标点。可使用中文、字母、数字、空格、点和短横线。`);
    }
    if (!spec || spec.type === "render") issues.push(`请为 ${file.file_name} 指定可上传的结果项。`);
    if (spec && !file.file_name.toLowerCase().endsWith(spec.type === "table" ? ".csv" : ".png")) {
      issues.push(`${spec.id} ${spec.name} 需要 ${spec.type === "table" ? "CSV" : "PNG"} 文件。`);
    }
    if (used.has(item.result_item_id) && item.result_item_id) issues.push(`${item.result_item_id} 绑定了多个文件。`);
    used.add(item.result_item_id);
    if (!file.size_bytes || file.size_bytes > state.limits.file_bytes) issues.push(`${file.file_name} 为空或超过 ${bytes(state.limits.file_bytes)}。`);
    if (!file.sha256) issues.push(`${file.file_name} 尚未计算 SHA-256。`);
  });
  if (total > state.limits.total_bytes) issues.push(`单次文件总量不得超过 ${bytes(state.limits.total_bytes)}。`);
  return issues;
}

function manifestTable(doc) {
  const table = ["<thead><tr><th>字段路径</th><th>中文含义</th><th>实际值</th><th>值的来源</th><th>检查结果</th></tr></thead><tbody>"];
  const group = title => table.push(`<tr class="group"><td colspan="5">${esc(title)}</td></tr>`);
  const row = (field, label, value, source, kind, invalid = false, display = "") => {
    const missing = value === "" || value === null || value === undefined;
    const bad = invalid || missing;
    table.push(`<tr><td><code>${esc(field)}</code></td><td>${esc(label)}</td>
      <td>${tag(missing ? "待填写" : value, bad ? "bad" : kind)}${display ? `<span class="manifest-label">${esc(display)}</span>` : ""}</td>
      <td>${esc(source)}</td><td>${bad ? tag("待核对","bad") : "通过"}</td></tr>`);
  };
  const node = state.node;
  row("schema_version","协议版本",doc.schema_version,"系统","system");
  row("delivery_id","投送编号",doc.delivery_id,"系统","system");
  row("analysis_run_id","项目运行编号",doc.analysis_run_id,"项目","target",false,state.project.name);
  row("project_node_id","项目节点编号",doc.project_node_id,"节点","target",false,path(node));
  doc.result_units.forEach((unit,index)=>{
    const prefix = `result_units[${index}]`;
    group(`结果单元 ${index+1} · ${scopeText(unit.selectors,node)}`);
    const scopes = Object.entries(unit.selectors);
    if (!scopes.length) row(prefix+".selectors","结果范围","{}","节点定义","scope",false,"整体");
    for (const [key,value] of scopes) row(prefix+".selectors."+key,types[key] ?? key,value,"手动选择","scope",false,node.definition.selectors[key]?.[value]);
    if (!unit.result_items.length) row(prefix+".result_items","结果项列表","[]","绑定表","target",true);
    const duplicate = unit.result_items.map(item=>item.result_item_id);
    unit.result_items.forEach((item,i)=>{
      const field = prefix + `.result_items[${i}]`;
      const spec = node.definition.results.find(candidate=>candidate.id===item.result_item_id);
      row(field+".result_item_id","结果项编号",item.result_item_id,"绑定表","target",
        !spec || duplicate.filter(id=>id===item.result_item_id).length>1,spec?.name);
      row(field+".sources.data","数据文件",item.sources.data,"本地选择","file",Boolean(spec && !item.sources.data.toLowerCase().endsWith(spec.type==="table"?".csv":".png")));
    });
  });
  doc.artifacts.forEach((file,index)=>{
    group(`文件 ${index+1} · ${file.file_name}`);
    const field = `artifacts[${index}]`;
    row(field+".file_name","文件名称",file.file_name,"本地选择","file",
      !/^[\p{L}\p{N}_ .()+-]{1,160}$/u.test(file.file_name) || [".",".."].includes(file.file_name));
    row(field+".size_bytes","文件大小",file.size_bytes,"实际字节","file",!file.size_bytes||file.size_bytes>state.limits.file_bytes);
    row(field+".sha256","文件摘要",file.sha256,"实际字节","file");
  });
  return `<div class="table-overflow manifest"><table class="drill-table">${table.join("")}</tbody></table></div>`;
}

function resultLink(slot, text = "查看结果位置") {
  return `<button type="button" class="btn" data-view-result="${esc(slot)}">${esc(text)}</button>`;
}

function receiptView() {
  const receipt = state.receipt;
  if (!receipt) return '<p class="muted">投送成功后会显示来自接收器的回执。</p>';
  const node = nodes().find(item=>item.id===receipt.project_node_id);
  return `<div class="receipt">
    <h3>已接收 · ${esc(state.project.name)} → ${esc(path(node))}</h3>
    <p>${tag(receipt.id,"target")} ${tag(state.replayed ? "重复投送 · 原回执" : "已接收","file")}</p>
    <p class="muted">接收时间 ${esc(time(receipt.accepted_at))}</p>
    ${receipt.results.map(item=>`<article class="receipt-item">
      <p><strong>${esc(item.result_name)} ${esc(item.result_item_id)}</strong> ${tag("v"+item.revision,"target")}</p>
      <p class="muted">${esc(scopeText(item.selectors,node))} · ${esc(item.file_name)} · ${bytes(item.size_bytes)}</p>
      <p>文件 ID ${tag(item.file_id,"file")}</p>${resultLink(item.slot_id)}
      </article>`).join("")}
    ${receipt.plots.length ? receipt.plots.map(job=>`<article class="receipt-item">
      <p><strong>${esc(job.result_name)} ${esc(job.result_item_id)}</strong> ${stateTag(job.status)}</p>
      <p class="muted">脚本 ${esc(job.script)} · ${esc(job.id)}${job.message ? " · "+esc(job.message) : ""}</p>
      ${job.output_file_id ? `<p>输出文件 ${tag(job.output_file_id,"file")}</p>` : ""}
      ${resultLink(job.slot_id,"查看绘图位置")}</article>`).join("") : '<p class="muted">本批次没有绘图操作。</p>'}
    </div>`;
}

const csvCache = new Map();
function loadTable(file, container) {
  const id = file.id;
  if (!csvCache.has(id)) {
    csvCache.set(id, fetch(fileUrl(id)).then(async response => {
      if (!response.ok) throw new Error("CSV 文件读取失败。");
      return csv((await response.text()).replace(/^\uFEFF/,""));
    }).catch(error => {
      csvCache.delete(id);
      throw error;
    }));
  }
  csvCache.get(id).then(table => {
    if (!container.isConnected) return;
    container.innerHTML = `<p class="muted" data-table-rows>${table.rows.length} 行 · ${table.columns.length} 列${table.rows.length>50 ? " · 预览前 50 行" : ""}</p>
      <div class="table-overflow"><table class="drill-table"><thead><tr>${table.columns.map(value=>`<th>${esc(value)}</th>`).join("")}</tr></thead>
      <tbody>${table.rows.slice(0,50).map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }).catch(error => {
    if (container.isConnected) container.textContent = error.message;
  });
}

function resultView() {
  const slot = units().find(item=>item.id===state.selectedSlot);
  if (!slot) return '<p class="muted">从项目目录或回执选择一个结果位置。</p>';
  const node = nodes().find(item=>item.id===slot.project_node_id);
  const history = versions().filter(item=>item.slot_id===slot.id);
  const historyVersion = history.find(item=>item.id===state.previewFile);
  const current = historyVersion || history.find(item=>item.id===slot.current_version_id);
  const file = actualFiles().find(item=>item.id===current?.file_id);
  const job = jobs().find(item=>item.id===slot.plot_id);
  const fileMeta = file ? `<p><strong>${esc(file.file_name)}</strong> ${tag("v"+current.revision,"target")}
    ${historyVersion ? tag("历史版本","system") : ""}</p>
    <p class="muted">批次 ${esc(file.delivery_id)} · ${esc(time(file.created_at))}</p>
    <div><a class="btn" href="${fileUrl(file.id,true)}">下载${file.kind==="generated" ? "生成图片" : "原文件"}</a></div>` : "";
  const content = !file ? "" : file.media_type==="image/png" ?
    `<img class="result-image" src="${fileUrl(file.id)}" alt="${esc(slot.result_name)}">` :
    '<div id="result-csv" class="result-data muted">正在读取接收文件…</div>';
  return `<header class="result-header">
    <p class="muted">${esc(state.project.name)} → ${esc(path(node))}</p>
    <h3>${esc(slot.result_name)} ${tag(slot.result_item_id,"target")}</h3>
    <p>${stateTag(slot.status)} <span class="muted">${esc(scopeText(slot.selectors,node))}</span></p>
    ${job?.message ? `<p class="muted">${esc(job.message)}</p>` : ""}
    ${job ? `<p class="muted">绘图脚本 ${esc(job.script)} · ${esc(job.id)}</p>` : ""}
    ${fileMeta}
    </header>${content}
    ${history.length ? `<details class="history"><summary>历史版本（${history.length}）</summary><ol>${history.map(version=>{
      const record = actualFiles().find(item=>item.id===version.file_id);
      return `<li><button type="button" class="btn" data-history-version="${esc(version.id)}">v${version.revision} · ${esc(record.file_name)}</button>
        ${version.id===slot.current_version_id ? tag("当前","target") : ""} <a href="${fileUrl(record.id,true)}">下载</a></li>`;
    }).join("")}</ol>${historyVersion ? '<button class="btn" type="button" data-history-version="">返回当前版本</button>' : ""}</details>` : ""}`;
}

function renderInspection() {
  const region = $("inspection");
  if (state.tab==="manifest") {
    if (!state.manifest) {
      region.innerHTML = '<p class="muted">选择投递目标后，可在这里核对实际提交的 Manifest。</p>';
      return;
    }
    region.innerHTML = `<div class="manifest-toolbar">
      <button class="btn" type="button" data-manifest-mode="table" aria-pressed="${state.manifestMode==="table"}">可读表格</button>
      <button class="btn" type="button" data-manifest-mode="json" aria-pressed="${state.manifestMode==="json"}">JSON</button>
      <button class="btn" type="button" id="copy-manifest">复制 JSON</button></div>` +
      (state.manifestMode==="table" ? manifestTable(state.manifest) :
        `<pre class="drill-json" id="manifest-json">${esc(JSON.stringify(state.manifest,null,2))}</pre>`);
  } else if (state.tab==="receipt") {
    region.innerHTML = receiptView();
  } else {
    const history = region.querySelector(".history")?.open;
    region.innerHTML = resultView();
    if (history && region.querySelector(".history")) region.querySelector(".history").open = true;
    const container = $("result-csv");
    if (container) {
      const slot = units().find(item=>item.id===state.selectedSlot);
      const version = versions().find(item=>item.id===(state.previewFile || slot.current_version_id));
      loadTable(actualFiles().find(item=>item.id===version.file_id), container);
    }
  }
}

function flatten(value, prefix = "", rows = []) {
  if (value !== null && typeof value === "object" && Object.keys(value).length) {
    for (const [key,item] of Object.entries(value)) {
      const field = Array.isArray(value) ? `${prefix}[${key}]` : prefix ? prefix+"."+key : key;
      flatten(item,field,rows);
    }
  } else {
    rows.push([prefix || "值",value !== null && typeof value==="object" ? JSON.stringify(value) : value]);
  }
  return rows;
}

function databaseCell(key, value) {
  if (value===null) return "—";
  if (typeof value==="object") return `<details class="db-json"><summary>展开内容</summary><ul>${flatten(value).map(([path,value])=>
    `<li><code>${esc(path)}</code> · ${esc(value ?? "null")}</li>`).join("")}</ul>
    <details><summary>原始 JSON</summary><pre class="drill-json">${esc(JSON.stringify(value,null,2))}</pre></details></details>`;
  if (key==="status") return stateTag(value);
  if (key.endsWith("_at")) return `${esc(time(value))}<br><code>${esc(value)}</code>`;
  if (key==="id" || key.endsWith("_id")) return tag(value,key.includes("file") ? "file" : "target");
  if (key==="sha256" || key==="fingerprint" || key==="storage_key") return `<code>${esc(value)}</code>`;
  return esc(value);
}

function renderDatabase() {
  const old = Object.fromEntries([...$("database").querySelectorAll("[data-db-table]")].map(item=>[item.dataset.dbTable,item.open]));
  const expanded = new Set([...$("database").querySelectorAll("details[data-db-cell][open]")].map(item=>item.dataset.dbCell));
  $("database-count").textContent = state.project ? `${Object.values(state.tables).reduce((count, rows)=>count+rows.length,0)} 条` : "";
  $("db-message").textContent = !state.project ? "创建或选择项目后查询 SQLite。" : !state.currentDelivery ?
    "当前项目的真实记录。绿色表示当前批次关联记录，紫色表示结果位置或版本指针更新。" :
    `高亮批次 ${state.currentDelivery}${state.replayed ? " · 重发显示原批次" : ""}。绿色为批次记录，紫色为位置更新。`;
  $("database").innerHTML = state.project ? Object.entries(groups).map(([table,label])=>{
    const records = state.tables[table] || [];
    const keys = Object.keys(records[0] || {});
    const shouldOpen = old[table] ?? (table==="rehearsal_deliveries" || table==="rehearsal_slots");
    return `<details class="db-table" data-db-table="${table}"${shouldOpen ? " open" : ""}>
      <summary>${esc(state.labels[table] || label)} <code>${table}</code> · ${records.length}</summary>` +
      (records.length ? `<div class="table-overflow"><table class="drill-table"><thead><tr>${keys.map(key=>
        `<th>${esc(columns[key] || key)}<br><code>${esc(key)}</code></th>`).join("")}</tr></thead>
      <tbody>${records.map(row=>{
        const changed = state.currentDelivery && (row.delivery_id===state.currentDelivery || table==="rehearsal_deliveries" && row.id===state.currentDelivery);
        const pointer = state.currentDelivery && row.updated_delivery_id===state.currentDelivery;
        return `<tr class="${pointer ? "pointer" : changed ? "changed" : ""}" data-db-row="${esc(row.id)}">${keys.map(key=>{
          const html = databaseCell(key,row[key]);
          const id = table+"|"+row.id+"|"+key;
          return `<td>${(pointer || changed) && key==="id" ? tag(pointer ? "批次更新" : state.replayed ? "原批次" : "批次关联",pointer ? "target" : "file")+" " : ""}${html.replace('<details class="db-json">',`<details class="db-json" data-db-cell="${esc(id)}"${expanded.has(id)?" open":""}>`)}</td>`;
        }).join("")}</tr>`;
      }).join("")}</tbody></table></div>` : '<p class="drill-body muted">暂无记录。</p>') + "</details>";
  }).join("") : "";
}

function renderAll() {
  refreshSteps();
  renderDirectory();
  renderPreparation();
  renderInspection();
  renderDatabase();
}

function chooseNode(node, requestedScope = {}) {
  if (state.node?.id !== node?.id) {
    state.node = node;
    for (const file of state.files.values()) file.target = "";
  }
  state.scope = node ? Object.fromEntries(Object.entries(node.definition.selectors).map(([key, values])=>
    [key,Object.hasOwn(values,requestedScope[key]) ? requestedScope[key] : Object.keys(values)[0]])) : {};
  state.selectedSlot = null;
  state.previewFile = null;
  setError("");
  prepareManifest();
  persistSelection();
  renderAll();
}

function openResult(id) {
  const slot = units().find(item=>item.id===id);
  if (!slot) return;
  if (state.node?.id !== slot.project_node_id || scopeKey(state.scope)!==scopeKey(slot.selectors)) {
    chooseNode(nodes().find(item=>item.id===slot.project_node_id),slot.selectors);
  }
  state.selectedSlot = slot.id;
  state.previewFile = null;
  persistSelection();
  renderDirectory();
  setTab("result");
}

async function refresh({saved, initial = false} = {}) {
  const project = state.project;
  if (!project) return;
  clearTimeout(state.poll);
  const token = ++state.refreshToken;
  const data = await api(route(project)+"/database");
  if (state.refreshToken !== token) return;
  state.tables = data.tables;
  state.labels = data.labels;
  if (initial) {
    const selected = nodes().find(item=>item.id===saved?.node) || nodes()[0];
    chooseNode(selected,saved?.scope);
    if (units().some(item=>item.id===saved?.slot)) state.selectedSlot = saved.slot;
    state.currentDelivery = data.tables.rehearsal_deliveries[0]?.id ?? null;
  }
  if (state.currentDelivery) {
    const receipt = await api(route(project)+"/receipts/"+encodeURIComponent(state.currentDelivery));
    if (state.refreshToken !== token) return;
    state.receipt = receipt;
  }
  persistSelection();
  renderAll();
  if (jobs().some(job=>job.status==="queued" || job.status==="running")) {
    state.poll = setTimeout(() => refresh().catch(showLoadError), 400);
  }
}

function showLoadError(error) {
  $("global-error").textContent = error.message;
  $("global-error").hidden = false;
}

async function chooseProject(project, saved) {
  ++state.refreshToken;
  clearTimeout(state.poll);
  state.project = project;
  state.node = null;
  state.scope = {};
  state.files.clear();
  state.signature = state.manifest = null;
  state.receipt = state.currentDelivery = state.selectedSlot = state.previewFile = null;
  state.tables = {};
  state.replayed = false;
  $("global-error").hidden = true;
  setError("");
  setTab("manifest");
  renderAll();
  if (project) await refresh({saved,initial:true});
}

async function digestRecord(record) {
  try {
    const hash = await crypto.subtle.digest("SHA-256",await record.file.arrayBuffer());
    record.sha = [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  } catch (error) {
    if (state.files.get(record.file.name)===record) setError(`无法读取 ${record.file.name} · ${error.message}`);
  } finally {
    record.digesting = false;
    if (state.files.get(record.file.name)===record) {
      prepareManifest();
      renderPreparation();
      if (state.tab==="manifest") renderInspection();
    }
  }
}

async function upload() {
  if (state.busy) return;
  const doc = state.manifest;
  const issues = checks(doc);
  if (issues.length) {
    setError(issues.join(" "));
    setTab("manifest");
    return;
  }
  setError("");
  state.busy = true;
  $("new-project").disabled = true;
  renderPreparation();
  renderDirectory();
  const body = new FormData();
  body.append("manifest",JSON.stringify(doc));
  for (const file of doc.artifacts) body.append("files",state.files.get(file.file_name).file,file.file_name);
  try {
    const reply = await api(base+"/v3/deliveries",{method:"POST",body});
    ++state.refreshToken;
    state.currentDelivery = reply.id;
    state.receipt = reply;
    state.replayed = reply.replayed;
    state.selectedSlot = reply.results[0]?.slot_id;
    state.previewFile = null;
    setTab("receipt");
    await refresh();
  } catch (error) {
    setError(error.message);
  } finally {
    state.busy = false;
    $("new-project").disabled = false;
    renderPreparation();
    renderDirectory();
    refreshSteps();
  }
}

async function localTemplates() {
  state.templates.clear();
  if (!state.workbench) return;
  const [{flowLibrary,definition,resolveNode},{nodeLibrary}] = await Promise.all([
    import("/workbench/flow-editor/flow-model.js"),
    import("/workbench/node-editor/node-model.js"),
  ]);
  const [flows,nodes_] = await Promise.all([flowLibrary.read(),nodeLibrary.read()]);
  for (const flow of flows.filter(item=>item.status==="confirmed")) {
    const selected = new Map();
    let complete = true;
    for (const section of flow.sections) for (const entry of section.nodes) {
      const node = resolveNode(flow,entry,nodes_);
      if (node) selected.set(node.id+"@"+node.version,node);
      else complete = false;
    }
    if (complete) state.templates.set(flow.id+"@"+flow.version,{flow:definition(flow),nodes:[...selected.values()]});
  }
}

async function openCreate() {
  if (state.busy) return;
  const form = $("create-form");
  form.reset();
  $("create-error").hidden = true;
  $("import-template").hidden = true;
  try { await localTemplates(); } catch { state.templates.clear(); }
  const options = [["builtin",state.builtin.name+" v"+state.builtin.version],
    ...Array.from(state.templates, ([id,data])=>[id,data.flow.name+" v"+data.flow.version+" · 工作台已确认"]),
    ["import","从已导出的定义 JSON 导入"]];
  $("template-select").innerHTML = opt(options,"builtin");
  if (!$("create-dialog").open) $("create-dialog").showModal();
}

async function importedTemplate() {
  const files = [...$("template-files").files];
  if (!files.length || files.reduce((sum,file)=>sum+file.size,0)>1024*1024) throw new Error("请选择总大小在 1 MB 内的模板 JSON。");
  const records = await Promise.all(files.map(async file=> {
    try { return JSON.parse(await file.text()); }
    catch { throw new Error(file.name+" 不是有效 JSON。"); }
  }));
  if (records.length===1 && records[0]?.flow && Array.isArray(records[0].nodes)) return records[0];
  const flows = records.filter(item=>Array.isArray(item?.sections));
  const nodes_ = records.filter(item=>Array.isArray(item?.results));
  if (flows.length!==1 || nodes_.length<1 || flows.length+nodes_.length!==records.length) {
    throw new Error("请选择一份流程定义和它引用的全部节点定义 JSON。");
  }
  return {flow:flows[0],nodes:nodes_};
}

async function createProject(event) {
  event.preventDefault();
  const button = $("create-submit");
  button.disabled = true;
  $("create-error").hidden = true;
  try {
    const id = $("template-select").value;
    const template = id==="import" ? await importedTemplate() : state.templates.get(id);
    const project = await api(base+"/projects",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name:$("project-name").value.trim(),template})});
    state.projects.unshift(project);
    $("create-dialog").close();
    await chooseProject(project);
  } catch (error) {
    const node = $("create-dialog").open ? $("create-error") : $("global-error");
    node.textContent = error.message;
    node.hidden = false;
  } finally {
    button.disabled = false;
  }
}

$("new-project").addEventListener("click",openCreate);
$("cancel-create").addEventListener("click",()=>$("create-dialog").close());
$("create-form").addEventListener("submit",createProject);
$("template-select").addEventListener("change",()=>{ $("import-template").hidden = $("template-select").value!=="import"; });
$("project-select").addEventListener("change",event=>{
  const project = state.projects.find(item=>item.id===event.target.value);
  chooseProject(project).catch(showLoadError);
});
$("node-select").addEventListener("change",event=>{
  chooseNode(nodes().find(item=>item.id===event.target.value));
  setTab("manifest");
});
$("scope-controls").addEventListener("change",event=>{
  if (!event.target.dataset.scope) return;
  chooseNode(state.node,{...state.scope,[event.target.dataset.scope]:event.target.value});
  setTab("manifest");
});
$("pick-files").addEventListener("click",()=>$("local-files").click());
$("local-files").addEventListener("change",event=>{
  setError("");
  for (const file of event.target.files) {
    const previous = state.files.get(file.name);
    const record = {file,target:previous?.target ?? "",sha:"",digesting:false};
    state.files.set(file.name,record);
    if (file.size && file.size <= state.limits.file_bytes) {
      record.digesting = true;
      digestRecord(record);
    }
  }
  event.target.value = "";
  prepareManifest();
  renderPreparation();
  refreshSteps();
  setTab("manifest");
});
$("bindings").addEventListener("change",event=>{
  const file = state.files.get(event.target.dataset.bindFile);
  if (!file) return;
  file.target = event.target.value;
  setError("");
  prepareManifest();
  setTab("manifest");
});
$("bindings").addEventListener("click",event=>{
  const remove = event.target.closest("[data-remove-file]");
  if (!remove || state.busy) return;
  state.files.delete(remove.dataset.removeFile);
  setError("");
  prepareManifest();
  renderPreparation();
  refreshSteps();
  setTab("manifest");
});
$("directory").addEventListener("click",event=>{
  if (state.busy) return;
  const slot = event.target.closest("[data-slot]");
  const node = event.target.closest("[data-node]");
  if (slot) openResult(slot.dataset.slot);
  else if (node) {
    chooseNode(nodes().find(item=>item.id===node.dataset.node));
    setTab("manifest");
  }
});
$("send").addEventListener("click",upload);
for (const id of ["download-all","download-node"]) $(id).addEventListener("click",()=>{
  if (state.project) state.materials.add(state.project.id);
  refreshSteps();
});
$("steps").addEventListener("click",event=>{
  const button = event.target.closest("[data-step]");
  if (!button) return;
  const step = button.dataset.step;
  if (step==="project" && !state.project) { openCreate(); return; }
  $(step==="project" ? "project-region" : step==="materials" ? "materials-region" : step==="prepare" ? "prepare-region" : "inspect-region")
    .scrollIntoView({block:"nearest"});
  if (step==="inspect") {
    $("database-region").open = Boolean(state.project);
    setTab(state.receipt ? "receipt" : "result");
  }
});
document.querySelectorAll("[data-tab]").forEach(button=>button.addEventListener("click",()=>setTab(button.dataset.tab)));
$("inspection").addEventListener("click",async event=>{
  if (event.target.closest("#copy-manifest") && state.manifest) {
    const content = JSON.stringify(state.manifest,null,2);
    try {
      await navigator.clipboard.writeText(content);
      $("copy-manifest").textContent = "已复制";
    } catch {
      state.manifestMode = "json";
      renderInspection();
      const range = document.createRange();
      range.selectNodeContents($("manifest-json"));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  }
  const mode = event.target.closest("[data-manifest-mode]");
  if (mode) {
    state.manifestMode = mode.dataset.manifestMode;
    renderInspection();
  }
  const view = event.target.closest("[data-view-result]");
  if (view && !state.busy) openResult(view.dataset.viewResult);
  const history = event.target.closest("[data-history-version]");
  if (history) {
    state.previewFile = history.dataset.historyVersion || null;
    renderInspection();
  }
});

async function boot() {
  renderAll();
  try {
    const response = await api(base+"/projects");
    Object.assign(state,{projects:response.projects,builtin:response.builtin_flow,workbench:response.workbench,limits:response.limits});
    if (!state.workbench) {
      const hosted = "https://hyperleo86.github.io/skiao/heatmap-editor/";
      for (const link of document.querySelectorAll('.drill-top a[href^="/workbench/"]')) {
        link.href = hosted + link.getAttribute("href").slice("/workbench/".length);
      }
    }
    const saved = JSON.parse(sessionStorage.getItem("skyao-rehearsal-selection") || "null");
    const project = state.projects.find(item=>item.id===saved?.project) || state.projects[0];
    $("new-project").disabled = false;
    await chooseProject(project,saved);
  } catch (error) {
    showLoadError(error);
  }
}
boot();
