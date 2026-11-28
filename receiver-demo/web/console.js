import {demoSession} from "./session.js";

const $ = id => document.getElementById(id);
const acceptances = ["01", "01", "02", "03", "04", "01", "05", "90", "91", "92", "93", "94"];
const caseCache = new Map();
const tried = new Set();
const results = $("activity");
let session, cases = [], selection, packet, busy = false, commandTool = "curl", selectionVersion = 0;

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function setConnection(text, state) {
  $("connection").textContent = text;
  $("indicator").dataset.state = state;
}

async function checked(path) {
  const reply = await fetch(path);
  if (!reply.ok) throw new Error("HTTP " + reply.status);
  return reply;
}

function auth() {
  return {Authorization: "Bearer " + session.token};
}

async function refreshCounts() {
  const api = "/api/v1/runs/" + encodeURIComponent(session.run_id) + "/results?history=1";
  const reply = await fetch(api, {headers: auth()});
  if (!reply.ok) throw new Error("HTTP " + reply.status);
  const data = await reply.json();
  const nodes = data.sections.flatMap(section => section.nodes);
  const units = nodes.flatMap(node => node.result_units);
  $("nodes").textContent = nodes.length;
  $("units").textContent = units.length;
  $("versions").textContent = units.reduce((count, unit) => count + unit.history.length, 0);
}

async function refreshExistingReceipt(test, payload) {
  const id = payload?.doc?.delivery_id;
  if (!test || test.expected_code || !id) return;
  const path = "/api/v1/runs/" + encodeURIComponent(session.run_id) + "/deliveries/" + encodeURIComponent(id);
  try {
    const reply = await fetch(path, {headers: auth()});
    if (!reply.ok) return;
    const receipt = await reply.json();
    if (packet !== payload) return;
    const label = $("server-receipt");
    label.textContent = "接收器已有此投送的回执 · " + unitVersions(receipt);
    label.hidden = false;
  } catch {
    // Receipt lookup is independent from sending.
  }
}

function caseButton(test) {
  const button = element("button", undefined, "case");
  button.type = "button";
  button.dataset.case = test.id;
  button.setAttribute("aria-pressed", "false");
  button.append(element("span", test.id, "case-number mono"), document.createTextNode(test.title));
  button.addEventListener("click", () => choose(test));
  return button;
}

function renderCases() {
  for (const [title, group] of [
    ["正常投送", cases.filter(test => !test.expected_code)],
    ["拒绝场景", cases.filter(test => test.expected_code)],
  ]) {
    const section = element("section", undefined, "case-group");
    section.append(element("h3", title), ...group.map(caseButton));
    $("case-list").append(section);
  }
}

async function hash(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

function fixture(test) {
  if (!caseCache.has(test.id)) {
    const load = (async () => {
      const url = "/demo/cases/" + test.id + "/";
      const raw = await (await checked(url + "manifest.json")).text();
      const doc = JSON.parse(raw);
      const files = await Promise.all(doc.artifacts.map(async declared => {
        const blob = await (await checked(url + encodeURIComponent(declared.file_name))).blob();
        return {name: declared.file_name, blob, sha: await hash(blob), declared};
      }));
      return {raw, doc, name: "manifest.json", files};
    })();
    caseCache.set(test.id, load);
    load.catch(() => caseCache.delete(test.id));
  }
  return caseCache.get(test.id);
}

async function choose(test) {
  if (busy) return;
  const version = ++selectionVersion;
  selection = test;
  packet = null;
  $("custom-input").hidden = Boolean(test);
  for (const button of $("case-list").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.case === test?.id));
  }
  $("custom").setAttribute("aria-pressed", String(!test));
  $("payload-id").textContent = test?.folder || "";
  $("payload-title").textContent = test?.title || "上传自己的文件";
  $("payload-description").textContent = test?.description || "";
  $("expected").hidden = !test;
  if (test) {
    $("expected").dataset.kind = test.expected_code ? "reject" : "accept";
    $("expected").textContent = test.expected_code ? "预期 " + test.expected_status : "预期 201 / 重发 200";
  }
  $("send-note").textContent = test ? "读取测试包…" : "";
  $("server-receipt").hidden = true;
  paintPacket();
  updateControls();
  try {
    const snapshot = test ? await fixture(test) : await customPacket();
    if (selectionVersion !== version) return;
    packet = snapshot;
    $("send-note").textContent = "";
    paintPacket();
    refreshExistingReceipt(test, snapshot);
  } catch (error) {
    if (selectionVersion === version) $("send-note").textContent = "读取失败 · " + error.message;
  }
  updateControls();
}

async function customPacket() {
  const manifest = $("manifest-input").files[0];
  if (!manifest) return null;
  const raw = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(await manifest.arrayBuffer());
  let doc;
  try { doc = JSON.parse(raw); } catch { doc = null; }
  const files = Array.from($("files-input").files).map(blob => ({
    blob, name: blob.name, declared: Array.isArray(doc?.artifacts) ?
      doc.artifacts.find(item => item?.file_name === blob.name) : null,
  }));
  return {raw, doc, name: manifest.name, files};
}

function row(cells) {
  const line = element("tr");
  for (const content of cells) {
    const cell = element("td");
    cell.append(content);
    line.append(cell);
  }
  $("files").append(line);
}

function paintPacket() {
  $("manifest-meta").replaceChildren();
  $("files").replaceChildren();
  $("manifest-details").hidden = !packet;
  $("manifest").textContent = packet?.raw ?? "";
  if (packet) {
    const doc = packet.doc;
    for (const [title, value] of [
      ["投送编号", doc?.delivery_id], ["二级节点", doc?.node_title], ["结果单元", doc?.result_units?.length],
    ]) {
      if (typeof value !== "string" && typeof value !== "number") continue;
      const label = element("span", title + " ");
      label.append(element("strong", String(value)));
      $("manifest-meta").append(label);
    }
    row([element("code", "manifest"), packet.name, String(new Blob([packet.raw]).size), ""]);
    for (const file of packet.files) {
      const mismatch = file.sha && file.declared?.sha256 !== file.sha;
      const digest = element("code", file.sha ? file.sha.slice(0, 12) + "…" : file.declared?.sha256?.slice?.(0, 12) || "—");
      digest.title = file.sha ? "实际 SHA-256 " + file.sha + (mismatch ? "\n清单 SHA-256 " + file.declared?.sha256 : "") : "";
      const display = element("span");
      display.append(digest);
      if (mismatch) display.append(element("span", " 摘要不符", "error"));
      row([element("code", "files"), file.name, String(file.blob.size), display]);
    }
  }
  paintCommand();
}

function paintCommand() {
  $("curl-choice").setAttribute("aria-pressed", String(commandTool === "curl"));
  $("cli-choice").setAttribute("aria-pressed", String(commandTool === "skyctl"));
  const env = [
    "export SKYAO_BASE_URL=" + location.origin,
    "export SKYAO_TOKEN=\"$(curl -fsS -H 'X-SkyAO-Demo: test-console' \"$SKYAO_BASE_URL/demo/session\" |",
    "  .venv/bin/python -c 'import json,sys; print(json.load(sys.stdin)[\"token\"])')\"",
  ];
  if (!selection || !packet) {
    $("command").textContent = selection ? "正在生成命令…" :
      [...env, ".venv/bin/python -m skyao.client send --manifest ./your-package/manifest.json --files-dir ./your-package/files"].join("\n");
    $("command-note").textContent = selection ? "" : "把命令中的两个路径替换为你的 Manifest 和数据目录。";
    return;
  }
  const folder = "fixtures/" + selection.folder;
  const lineContinued = " " + String.fromCharCode(92) + "\n  ";
  const command = commandTool === "curl" ? [
    "curl -sS -w '\\nHTTP %{http_code}\\n' -X POST \"$SKYAO_BASE_URL/api/v1/deliveries\"",
    "-H \"Authorization: Bearer $SKYAO_TOKEN\"",
    "-F 'manifest=<" + folder + "/manifest.json'",
    ...packet.files.map(file => "-F 'files=@" + folder + "/files/" + file.name + ";filename=" + file.name + "'"),
  ].join(lineContinued) : [
    ".venv/bin/python -m skyao.client send",
    "--manifest '" + folder + "/manifest.json'",
    "--files-dir '" + folder + "/files'",
  ].join(lineContinued);
  $("command").textContent = [...env, "", command].join("\n");
  $("command-note").textContent = commandTool === "curl" ?
    "curl 直发附件原始文件。网页使用浏览器 Fetch 发送同样的字段和文件。" :
    "skyctl 会先预检并保存待传快照。用 91 测试云端校验时，请用网页或 curl 发送。";
}

function updateControls() {
  $("suite").disabled = !session || busy;
  $("custom").disabled = !session || busy;
  for (const item of $("case-list").querySelectorAll("button")) item.disabled = busy;
  $("manifest-input").disabled = busy;
  $("files-input").disabled = busy;
  $("send").disabled = busy || !packet?.files.length;
  $("replay").disabled = $("send").disabled || !tried.has(selection?.id || packet);
  $("copy").disabled = !session || Boolean(selection && !packet);
}

function verdict(test, status, body, replay) {
  if (!test || status === 0) return null;
  if (test.expected_code) return status === test.expected_status && body.error?.code === test.expected_code;
  return replay ? status === 200 && body.replayed === true :
    (status === 201 || (status === 200 && body.replayed === true)) && body.status === "accepted";
}

async function send(test, payload, replay = false) {
  const fields = new FormData();
  fields.append("manifest", payload.raw);
  for (const file of payload.files) fields.append("files", file.blob, file.name);
  const start = performance.now();
  let status = 0, body;
  try {
    const reply = await fetch("/api/v1/deliveries", {method: "POST", headers: auth(), body: fields});
    status = reply.status;
    body = await reply.json().catch(() => ({error: {code: "INVALID_RESPONSE"}}));
  } catch {
    body = {error: {code: "NETWORK_ERROR", message: "无法连接本机接收器。"}};
  }
  tried.add(test?.id || payload);
  const record = {
    title: test?.title || "自定义投送", status, body, elapsed: Math.round(performance.now() - start),
    id: payload.doc?.delivery_id || "未提供", files: payload.files.map(file => file.name),
    pass: verdict(test, status, body, replay), time: new Date().toLocaleTimeString(),
  };
  drawRecord(record);
  if (test) {
    const saved = [...readActivity(), record].slice(-35);
    try { sessionStorage.setItem("skyao-activity", JSON.stringify(saved)); } catch {}
  }
  return record;
}

function readActivity() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("skyao-activity"));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function unitVersions(body) {
  return (body.accepted_units ?? []).map(unit => {
    const values = Object.values(unit.selectors).join(" / ") || "整体";
    return values + " 版本 " + unit.revision;
  }).join("，");
}

function drawRecord(record, expand = true) {
  for (const item of results.querySelectorAll("details")) item.open = false;
  const details = element("details");
  details.open = expand;
  const status = element("span", record.status ? "HTTP " + record.status : "网络错误", "outcome");
  status.dataset.kind = record.status >= 200 && record.status < 300 ? "accept" : record.pass ? "reject" : "error";
  const state = record.pass === true ? "符合预期" : record.pass === false ? "与预期不同" :
    record.body.status === "accepted" ? "已接收" : "请求未接受";
  const summary = element("summary");
  summary.append(document.createTextNode(record.time + " · " + record.title), status, document.createTextNode(state));
  const fields = element("dl");
  const revisions = unitVersions(record.body) || record.body.error?.code || "—";
  for (const [title, value] of [
    ["工具", "浏览器 Fetch"], ["接口", "POST /api/v1/deliveries"],
    ["投送编号", record.id], ["文件", [ "Manifest JSON", ...record.files ].join("、")],
    ["处理结果", revisions + (record.body.replayed ? "（重放回执）" : "")], ["耗时", record.elapsed + " ms"],
  ]) fields.append(element("dt", title), element("dd", value));
  details.append(summary, fields, element("pre", JSON.stringify(record.body, null, 2)));
  results.prepend(details);
  if (results.childElementCount > 35) results.lastElementChild.remove();
  $("empty").hidden = true;
}

async function runSteps(steps) {
  busy = true;
  updateControls();
  let passed = 0;
  try {
    for (const [index, step] of steps.entries()) {
      $("send-note").textContent = steps.length > 1 ? "正在发送 " + (index + 1) + " / " + steps.length : "正在发送…";
      const outcome = await send(step.test, step.packet || await fixture(step.test), step.replay);
      if (outcome.pass) passed += 1;
    }
    await refreshCounts();
    refreshExistingReceipt(selection, packet);
    $("send-note").textContent = steps.length > 1 ? passed + " / " + steps.length + " 次请求符合预期" : "已收到回执，见下方记录。";
  } catch (error) {
    $("send-note").textContent = "测试未完成 · " + error.message;
  } finally {
    busy = false;
    updateControls();
  }
}

$("custom").addEventListener("click", () => choose(null));
for (const field of ["manifest-input", "files-input"]) {
  $(field).addEventListener("change", () => choose(null));
}
$("send").addEventListener("click", () => runSteps([{test: selection, packet}]));
$("replay").addEventListener("click", () => runSteps([{test: selection, packet, replay: true}]));
$("suite").addEventListener("click", () => runSteps(acceptances.map((id, index) => ({
  test: cases.find(item => item.id === id), replay: index === 1 || index === 5,
}))));
for (const [button, tool] of [["curl-choice", "curl"], ["cli-choice", "skyctl"]]) {
  $(button).addEventListener("click", () => {
    commandTool = tool;
    paintCommand();
  });
}
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("command").textContent);
    $("command-note").textContent = "命令已复制。";
  } catch {
    const text = document.createRange();
    text.selectNodeContents($("command"));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(text);
    $("command-note").textContent = "已选择命令文本，请使用系统复制快捷键。";
  }
});

async function start() {
  try {
    session = await demoSession();
    if (!session) throw new Error("请使用 --demo 启动接收器");
    const reply = await checked("/demo/cases");
    cases = (await reply.json()).cases;
    const link = $("result-link");
    link.href = "/runs/" + encodeURIComponent(session.run_id);
    link.hidden = false;
    await refreshCounts();
    setConnection("已连接 · " + session.run_id, "ok");
    renderCases();
    for (const record of readActivity()) drawRecord(record, false);
    await choose(cases[0]);
  } catch (error) {
    setConnection("连接失败 · " + error.message, "error");
  }
}

start();
