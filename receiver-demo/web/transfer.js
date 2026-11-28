import {demoSession} from "./session.js";

const $ = id => document.getElementById(id);
const endpoint = "/api/v1/deliveries";
let session, state;

function status(message, kind = "ok") {
  $("progress").textContent = message;
  $("progress").dataset.status = kind;
}

function headers() {
  return {Authorization: "Bearer " + session.token};
}

function show(id, content) {
  $(id).textContent = content;
  $(id).hidden = false;
}

function fileMeta(file) {
  return file.size_bytes + " 字节 · SHA-256 " + file.sha256.slice(0, 12) + "…";
}

function display() {
  const {source, receiver, cloud} = state;
  $("source-path").textContent = source.path;
  $("source-info").textContent = fileMeta(source);
  $("source-info").title = source.sha256;
  $("source-preview").textContent = source.preview;
  $("manifest-label").textContent = "查看待发送清单";
  $("manifest").textContent = JSON.stringify(source.manifest, null, 2);
  if (!receiver) {
    status("源文件已读到。接收器还没有这份文件。", "awaiting");
  } else {
    $("destination-empty").hidden = true;
    show("destination-path", receiver.path);
    show("destination-info", "版本 " + receiver.revision + " · " + fileMeta(receiver));
    $("destination-info").title = receiver.sha256;
    show("destination-preview", receiver.preview);
    if (!receiver.verified) {
      status("接收文件未通过磁盘校验。", "error");
    } else {
      const identical = receiver.sha256 === source.sha256;
      status(identical ? "已核对 · 本机源文件与接收副本的 SHA-256 一致。" :
        "源文件已修改。接收端仍保存上一次发送的版本。", identical ? "ok" : "awaiting");
    }
  }
  if (cloud) {
    const link = $("cloud-link");
    link.href = cloud.file_url;
    link.hidden = false;
    $("cloud-evidence").hidden = false;
    $("cloud-path").textContent = cloud.repo + "/" + cloud.file_path;
    $("cloud-method").textContent = "GitHub Contents API · PUT 后按提交编号读回核对 · SHA-256 " + cloud.sha256;
    $("cloud-state").textContent = cloud.repo + " · " +
      (receiver?.sha256 === cloud.sha256 ? "与当前接收副本一致" : "这是上一次归档的版本") +
      " · " + cloud.commit.slice(0, 12);
  }
}

async function readDisk() {
  const response = await fetch("/demo/transfer/state", {headers: headers()});
  if (!response.ok) {
    const message = await response.json().catch(() => ({}));
    throw new Error(message.error?.message || "HTTP " + response.status);
  }
  state = await response.json();
  display();
}

function controls(busy) {
  $("reload").disabled = busy || !session;
  $("send").disabled = busy || !session;
  $("copy-path").disabled = busy || !state;
  $("download").disabled = busy || !state?.receiver;
}

async function act(operation) {
  controls(true);
  try {
    await operation();
  } catch (error) {
    status(error.message, "error");
  } finally {
    controls(false);
  }
}

async function send() {
  await readDisk();
  const {source} = state;
  const data = new FormData();
  data.append("manifest", JSON.stringify(source.manifest));
  data.append("files", new Blob([Uint8Array.from(atob(source.base64), value => value.charCodeAt(0))]), source.name);
  status("正在发送 " + source.name + "…");
  const response = await fetch(endpoint, {method: "POST", headers: headers(), body: data});
  const receipt = await response.json();
  $("reply").textContent = JSON.stringify(receipt, null, 2);
  $("reply-wrap").hidden = false;
  $("last-send").textContent = "HTTP " + response.status + " · " +
    (receipt.delivery_id || receipt.error?.code || "");
  function sentManifest() {
    $("manifest-label").textContent = "查看本次实际发送的清单";
    $("manifest").textContent = JSON.stringify(source.manifest, null, 2);
  }
  sentManifest();
  if (!response.ok) throw new Error("发送失败 · " + (receipt.error?.message || response.status));
  await readDisk();
  sentManifest();
}

$("reload").addEventListener("click", () => act(readDisk));
$("send").addEventListener("click", () => act(send));
$("copy-path").addEventListener("click", () => act(async () => {
  await navigator.clipboard.writeText(state.source.path);
  status("已复制源文件路径。");
}));
$("download").addEventListener("click", () => act(async () => {
  const response = await fetch(state.receiver.download, {headers: headers()});
  if (!response.ok) throw new Error("下载失败 · HTTP " + response.status);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = state.receiver.file_name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));

act(async () => {
  session = await demoSession();
  if (!session) throw new Error("使用 --demo 启动接收器后再打开本页。");
  $("post-url").textContent = "POST " + location.origin + endpoint;
  const link = $("result-link");
  link.href = "/runs/" + encodeURIComponent(session.run_id);
  link.hidden = false;
  await readDisk();
});
