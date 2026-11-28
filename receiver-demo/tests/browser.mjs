import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {createHash, randomBytes} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as pause} from "node:timers/promises";
import {after, before, test} from "node:test";
import {promisify} from "node:util";
import {chromium} from "playwright";

const run = "RUN-TEST-001";
const root = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.SKYAO_PYTHON || join(root, ".venv", "bin", "python");
const token = randomBytes(32).toString("hex");
const execute = promisify(execFile);
const cases = await readdir(join(root, "fixtures"));
let browser, work, server, url, env;

function caseDir(number) {
  return join(root, "fixtures", cases.find(name => name.startsWith(number + "_")));
}

async function send(number) {
  const directory = caseDir(number);
  await execute(python, [
    "-m", "skyao.client", "send", "--manifest", join(directory, "manifest.json"), "--files-dir", join(directory, "files"),
  ], {env, cwd: root, timeout: 10000});
}

async function expected(number, file) {
  const content = await readFile(join(caseDir(number), "files", file), "utf8");
  return content.trim().split(/\r?\n/).slice(1).map(row => row.split(","));
}

async function startReceiver(directory, environment, ...options) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const address = "http://127.0.0.1:" + port;
  const runtime = {...environment, SKYAO_BASE_URL: address, SKYAO_SPOOL_DIR: join(directory, "client")};
  const process = spawn(python, ["-m", "skyao.server", "--port", String(port), "--data-dir", join(directory, "server"), ...options], {
    cwd: root, env: runtime, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  process.stdout.on("data", chunk => { log += chunk; });
  process.stderr.on("data", chunk => { log += chunk; });
  let ready = false;
  for (let i = 0; i < 100 && process.exitCode === null; i += 1) {
    try {
      ready = (await fetch(address + "/health", {signal: AbortSignal.timeout(250)})).ok;
    } catch {}
    if (ready) break;
    await pause(50);
  }
  if (!ready) await stopReceiver(process);
  assert.ok(ready, log);
  return {address, runtime, process};
}

async function stopReceiver(process) {
  if (process && process.exitCode === null && process.signalCode === null) {
    const stopped = once(process, "exit");
    process.kill();
    await stopped;
  }
}

before(async () => {
  work = await mkdtemp(join(tmpdir(), "skyao-browser-"));
  ({address: url, runtime: env, process: server} = await startReceiver(work, {...process.env, SKYAO_TOKEN: token}));
  for (const number of ["01", "02", "03", "04", "05"]) await send(number);
  const hasChrome = existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  browser = await chromium.launch(hasChrome ? {channel: "chrome"} : {});
});

after(async () => {
  if (browser) await browser.close();
  await stopReceiver(server);
  if (work) await rm(work, {force: true, recursive: true});
});

async function open(t, viewport = {width: 1360, height: 950}) {
  const page = await browser.newPage({acceptDownloads: true, viewport});
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.goto(url + "/runs/" + run);
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", {name: "打开结果"}).click();
  await page.getByRole("heading", {name: "样本表达量分布"}).waitFor();
  return page;
}

function chart(page, type) {
  return page.locator('[data-type="' + type + '"]');
}

async function plot(page, type) {
  const selector = '[data-type="' + type + '"] .plot';
  await page.waitForFunction(css => {
    const element = document.querySelector(css);
    return element?._fullLayout && element?.querySelector("svg.main-svg");
  }, selector);
  return page.locator(selector).evaluate(element => ({traces: element.data, font: element.layout.font}));
}

test("sample selection and all four views render, with style-only editing and an exact download", async t => {
  const page = await open(t);
  assert.equal(await page.locator("#directory button").count(), 4);
  const old = await expected("01", "S01.csv");
  assert.deepEqual((await plot(page, "boxplot")).traces[0].y, old.map(row => Number(row[1])));
  await page.getByLabel("样本", {exact: true}).selectOption("S02");
  await page.getByText("版本 2 · DEL-TEST-004").waitFor();
  const current = await expected("04", "S02.csv");
  assert.deepEqual((await plot(page, "boxplot")).traces[0].y, current.map(row => Number(row[1])));

  for (const name of ["小提琴图", "密度分布图", "数据表"]) {
    await page.getByRole("checkbox", {name, exact: true}).check();
  }
  assert.equal(await page.getByRole("tab").count(), 4);
  await page.getByRole("tab", {name: "小提琴图"}).click();
  assert.deepEqual((await plot(page, "violin")).traces[0].y, current.map(row => Number(row[1])));
  await page.getByLabel("展示方式").selectOption("multiple");
  for (const type of ["boxplot", "violin", "density"]) await plot(page, type);
  await chart(page, "table").getByRole("table").waitFor();
  assert.equal(await page.getByRole("tab").count(), 0);
  const [density] = (await plot(page, "density")).traces;
  assert.equal(density.x.length, 120);
  assert.ok(density.y.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(new Set(density.y).size > 50);
  assert.equal(await chart(page, "table").locator("tbody tr").count(), current.length);
  assert.equal(await chart(page, "table").locator("tbody tr td").first().textContent(), current[0][0]);
  assert.equal(await chart(page, "table").getByLabel("颜色").count(), 0);

  await chart(page, "boxplot").getByLabel("颜色").fill("#4422dd");
  await chart(page, "boxplot").getByLabel("字号").fill("19");
  await chart(page, "boxplot").getByLabel("字号").press("Tab");
  await page.waitForFunction(() => document.querySelector('[data-type="boxplot"] .plot')?.layout?.font?.size === 19);
  const edited = await plot(page, "boxplot");
  assert.equal(edited.traces[0].marker.color, "#4422dd");
  assert.deepEqual(edited.traces[0].y, current.map(row => Number(row[1])));

  const downloaded = page.waitForEvent("download");
  await chart(page, "boxplot").getByRole("button", {name: "下载 S02.csv"}).click();
  const file = await downloaded;
  assert.equal(file.suggestedFilename(), "S02.csv");
  const bytes = await readFile(await file.path());
  const manifest = JSON.parse(await readFile(join(caseDir("04"), "manifest.json"), "utf8"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.artifacts[0].sha256);
});

test("comparisons switch the actual volcano and MA coordinates", async t => {
  const page = await open(t);
  await page.getByRole("button", {name: "基因差异表达分析"}).click();
  const select = page.getByLabel("比对组", {exact: true});
  await select.selectOption("C_BC");
  const data = await expected("02", "C_BC.csv");
  const [volcano] = (await plot(page, "volcano")).traces;
  assert.deepEqual(volcano.x, data.map(row => Number(row[2])));
  assert.equal(volcano.y.length, data.length);
  volcano.y.forEach((value, index) => {
    assert.ok(Math.abs(value + Math.log10(Number(data[index][3]))) < 1e-12);
  });
  await page.getByRole("checkbox", {name: "MA 图"}).check();
  await page.getByRole("tab", {name: "MA 图"}).click();
  const [ma] = (await plot(page, "ma_plot")).traces;
  assert.deepEqual(ma.x, data.map(row => Number(row[1])));
  assert.deepEqual(ma.y, data.map(row => Number(row[2])));
});

test("overall result renders the joined heatmap and fixture PCA, even on a narrow viewport", async t => {
  const page = await open(t, {width: 430, height: 890});
  await page.getByRole("button", {name: "整体表达概览"}).click();
  assert.equal(await page.locator("#selectors select").count(), 0);
  const [heatmap] = (await plot(page, "heatmap")).traces;
  const matrix = await expected("03", "matrix.csv");
  assert.deepEqual(heatmap.z, matrix.map(row => row.slice(1).map(Number)));
  assert.deepEqual(heatmap.x, ["S01 · A", "S02 · A", "S03 · B", "S04 · B", "S05 · C", "S06 · C"]);
  await page.getByRole("checkbox", {name: "PCA 图"}).check();
  await page.getByRole("tab", {name: "PCA 图"}).click();
  const [pca] = (await plot(page, "pca")).traces;
  const coordinates = await expected("03", "pca.csv");
  assert.deepEqual(pca.x, coordinates.map(row => Number(row[2])));
  assert.deepEqual(pca.y, coordinates.map(row => Number(row[3])));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test("sparse selector combinations stay valid and available chart choices persist", async t => {
  const page = await open(t);
  await page.getByRole("button", {name: "基因差异表达分析"}).click();
  await page.getByRole("checkbox", {name: "MA 图"}).check();
  await page.getByRole("button", {name: "多层级差异分析"}).click();
  assert.equal(await page.getByRole("checkbox", {name: "火山图"}).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", {name: "MA 图"}).count(), 0);
  const level = page.getByLabel("分析层级", {exact: true});
  await level.selectOption("isoform");
  const isoform = await expected("05", "C_AB_isoform.csv");
  assert.deepEqual((await plot(page, "volcano")).traces[0].x, isoform.map(row => Number(row[2])));
  await page.getByLabel("比对组", {exact: true}).selectOption("C_BC");
  assert.equal(await level.inputValue(), "gene");
  assert.deepEqual(await level.locator("option").allTextContents(), ["基因"]);
  const gene = await expected("05", "C_BC_gene.csv");
  assert.deepEqual((await plot(page, "volcano")).traces[0].x, gene.map(row => Number(row[2])));
});

test("test console sends real fixture bytes, reports receipts and produces usable CLI and curl commands", async t => {
  const folder = await mkdtemp(join(tmpdir(), "skyao-console-"));
  t.after(() => rm(folder, {force: true, recursive: true}));
  const demo = await startReceiver(folder, process.env, "--demo");
  t.after(() => stopReceiver(demo.process));
  const page = await browser.newPage({viewport: {width: 1350, height: 930}});
  t.after(() => page.close());
  page.setDefaultTimeout(7000);
  const unavailable = await fetch(url + "/demo/session", {headers: {"X-SkyAO-Demo": "test-console"}});
  assert.equal(unavailable.status, 404);
  const noHeader = await fetch(demo.address + "/demo/session");
  assert.equal(noHeader.status, 403);
  const foreignOrigin = await fetch(demo.address + "/demo/session", {
    headers: {"X-SkyAO-Demo": "test-console", Origin: "http://127.0.0.1:3000"},
  });
  assert.equal(foreignOrigin.status, 403);

  await page.goto(demo.address + "/");
  await page.getByText("已连接 · RUN-TEST-001").waitFor();
  await page.getByText("S01.csv", {exact: true}).waitFor();
  await page.getByRole("button", {name: "发送此包", exact: true}).click();
  await page.locator("#activity details").first().getByText("HTTP 201", {exact: true}).waitFor();
  await page.getByText("接收器已有此投送的回执 · S01 版本 1，S02 版本 1", {exact: true}).waitFor();
  await page.getByRole("button", {name: "重发此包", exact: true}).click();
  await page.locator("#activity details").first().getByText("HTTP 200", {exact: true}).waitFor();
  assert.match(await page.locator("#activity details").first().textContent(), /重放回执/);

  await page.getByRole("button", {name: "skyctl · 预检和重试"}).click();
  const cliCode = await page.locator("#command").textContent();
  const cli = await execute("bash", ["-c", cliCode], {env: demo.runtime, cwd: root, timeout: 10000});
  assert.equal(JSON.parse(cli.stdout).replayed, true);

  await page.getByRole("button", {name: /91.*文件摘要错误/}).click();
  await page.getByText("摘要不符", {exact: false}).waitFor();
  await page.getByRole("button", {name: "curl · 直接发送"}).click();
  const curlCode = await page.locator("#command").textContent();
  const curl = await execute("bash", ["-c", curlCode], {env: demo.runtime, cwd: root, timeout: 10000});
  assert.match(curl.stdout, /CHECKSUM_MISMATCH/);
  assert.match(curl.stdout, /HTTP 422/);

  await page.getByRole("button", {name: "运行整套验收", exact: true}).click();
  await page.getByText("12 / 12 次请求符合预期", {exact: true}).waitFor();
  assert.equal(await page.locator("#nodes").textContent(), "4");
  assert.equal(await page.locator("#units").textContent(), "8");
  assert.equal(await page.locator("#versions").textContent(), "9");
  await page.getByRole("link", {name: "查看结果", exact: true}).click();
  await page.getByRole("heading", {name: "样本表达量分布", exact: true}).waitFor();
  await page.getByLabel("样本", {exact: true}).selectOption("S02");
  await page.getByText("版本 2 · DEL-TEST-004", {exact: true}).waitFor();
  assert.equal((await plot(page, "boxplot")).traces.length, 1);
  await page.getByRole("link", {name: "返回接收器测试台"}).click();
  await page.waitForFunction(() => document.querySelectorAll("#activity details").length === 14);
  assert.equal(await page.locator("#activity details").count(), 14);

  await page.getByRole("button", {name: "上传自己的文件"}).click();
  const original = JSON.parse(await readFile(join(caseDir("04"), "manifest.json"), "utf8"));
  original.delivery_id = "DEMO-CUSTOM-001";
  await page.locator("#manifest-input").setInputFiles({
    name: "manifest.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(original)),
  });
  await page.locator("#files-input").setInputFiles(join(caseDir("04"), "files", "S02.csv"));
  await page.getByRole("button", {name: "发送此包", exact: true}).click();
  await page.locator("#activity details").first().getByText("HTTP 201", {exact: true}).waitFor();
  await page.waitForFunction(() => document.querySelector("#versions").textContent === "10");
  assert.match(await page.locator("#activity details").first().textContent(), /DEMO-CUSTOM-001/);
});

test("editable-file trace identifies the exact source, HTTP upload and stored bytes", async t => {
  const temp = await mkdtemp(join(tmpdir(), "skyao-trace-"));
  const demo = await startReceiver(temp, process.env, "--demo");
  t.after(async () => {
    await stopReceiver(demo.process);
    await rm(temp, {force: true, recursive: true});
  });
  const page = await browser.newPage({viewport: {width: 1300, height: 900}, acceptDownloads: true});
  t.after(() => page.close());
  page.setDefaultTimeout(7000);
  await page.goto(demo.address + "/demo/transfer");
  await page.getByText("源文件已读到。接收器还没有这份文件。", {exact: true}).waitFor();
  const source = join(root, "delivery-demo", "reading.csv");
  const data = await readFile(source);
  assert.equal(await page.locator("#source-path").textContent(), source);
  assert.equal(await page.locator("#post-url").textContent(), "POST " + demo.address + "/api/v1/deliveries");
  await page.getByRole("button", {name: "发送当前文件"}).click();
  await page.getByText("已核对 · 本机源文件与接收副本的 SHA-256 一致。", {exact: true}).waitFor();
  assert.match(await page.locator("#last-send").textContent(), /^HTTP 201/);
  assert.deepEqual(await readFile(await page.locator("#destination-path").textContent()), data);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", {name: "下载接收副本"}).click();
  assert.deepEqual(await readFile(await (await downloaded).path()), data);
});

test("parameter definitions keep trial values separate and preserve confirmed versions", async t => {
  const temp = await mkdtemp(join(tmpdir(), "skyao-parameters-"));
  const demo = await startReceiver(temp, process.env, "--demo");
  t.after(async () => {
    await stopReceiver(demo.process);
    await rm(temp, {force: true, recursive: true});
  });
  const page = await browser.newPage({viewport: {width: 1440, height: 900}, acceptDownloads: true});
  t.after(() => page.close());
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  const current = () => page.locator("#selected-name").textContent();
  const value = async () => JSON.parse(await page.locator("#json-preview").textContent());
  const openCard = async code => page.locator("#card-list button").filter({hasText: code}).first().click();
  const action = name => page.getByRole("button", {name, exact: true});
  const edit = path => page.locator(`[data-bind="${path}"]`);

  await page.goto(demo.address + "/demo");
  await page.getByRole("link", {name: "参数编辑器"}).click();
  await page.getByRole("heading", {name: "基因数范围", exact: true}).waitFor();
  assert.equal(await page.locator("#card-list button").count(), 15);
  assert.deepEqual(await value(), {gene_count_range: {min: 10, max: 100}});
  await page.getByLabel("试填 下界", {exact: true}).fill("120");
  await page.locator("#validation").getByText(/下界必须小于/).waitFor();
  await page.getByLabel("试填 上界", {exact: true}).fill("150");
  assert.deepEqual(await value(), {gene_count_range: {min: 120, max: 150}});
  await action("参数定义").click();
  assert.deepEqual((await value()).config.fields.map(item => item.default), [null, null]);

  await action("确认入库").click();
  const review = page.locator("#review-dialog");
  for (const control of await review.getByRole("checkbox").all()) await control.check();
  await review.getByRole("button", {name: "确认入库"}).click();
  await action("另存新版本").waitFor();
  assert.equal(await edit("name").isDisabled(), true);
  await action("另存新版本").click();
  await action("保存草稿").waitFor();
  await edit("name").fill("基因数范围第二版");
  await action("保存草稿").click();
  await page.locator("#toast").getByText("草稿已保存。").waitFor();
  await page.reload();
  await page.getByRole("heading", {name: "基因数范围第二版"}).waitFor();
  const {cards} = await (await fetch(demo.address + "/demo/parameters/data")).json();
  const versions = cards.filter(card => card.code === "gene_count_range");
  assert.deepEqual(versions.map(card => [card.version, card.status, card.name]), [
    [1, "confirmed", "基因数范围"], [2, "draft", "基因数范围第二版"],
  ]);
  assert.equal(versions[0].id, versions[1].id);
  const stale = await fetch(demo.address + "/demo/parameters/data", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({action: "draft", card: {...versions[1], revision: versions[1].revision - 1}}),
  });
  assert.equal(stale.status, 409);

  await openCard("category_proportions");
  await page.getByLabel("试填 类别 A 占比").fill("25");
  await page.getByLabel("试填 类别 B 占比").fill("74");
  await page.locator("#validation").getByText(/合计应为 100/).waitFor();
  await page.getByLabel("试填 类别 B 占比").fill("75");
  await page.locator("#validation").getByText(/通过校验/).waitFor();

  await openCard("enable_clustering");
  await page.getByLabel("试填固定选项").selectOption("false");
  assert.deepEqual(await value(), {enable_clustering: false});
  await openCard("databases");
  await page.locator("#form-preview").getByLabel("KEGG").check();
  assert.deepEqual(await value(), {databases: ["go", "kegg"]});
  await edit("config.options.1.code").fill("go");
  await page.locator("#validation").getByText(/选项代码 go 重复/).waitFor();
  await action("提交待确认").click();
  await page.locator("#toast").getByText(/修正预览区/).waitFor();

  await openCard("group_ids");
  await page.locator('#form-preview [data-preview="parent"]').selectOption("GS002");
  await page.locator("#form-preview").getByLabel("第 7 天").check();
  assert.deepEqual(await value(), {group_ids: ["G005"]});

  await openCard("task_name");
  await page.getByLabel("试填文本").fill("   ");
  await page.locator("#validation").getByText("请填写非空白文字。").waitFor();
  await page.getByLabel("试填文本").fill("复验");
  assert.deepEqual(await value(), {task_name: "复验"});
  assert.equal(await current(), "子任务名称");

  const markdown = page.waitForEvent("download");
  await action("Markdown").click();
  assert.match(await readFile(await (await markdown).path(), "utf8"), /## 提交示例[\s\S]*"task_name"/);
  await page.getByLabel("筛选状态").selectOption("confirmed");
  const csv = page.waitForEvent("download");
  await action("导出参数总表").click();
  const csvText = await readFile(await (await csv).path(), "utf8");
  assert.match(csvText, /gene_count_range.*已确认/);
  assert.equal(csvText.split("\r\n").length, 2);

  await page.getByRole("button", {name: "新增参数"}).click();
  await edit("name").fill("结果展示条数");
  await edit("code").fill("result_display_count");
  await edit("config.fields.0.minimum").fill("1");
  await edit("config.fields.0.default").fill("0");
  await page.locator("#validation").getByText(/默认值不得小于 1/).waitFor();
  await edit("config.fields.0.default").fill("5");
  await action("提交待确认").click();
  await page.locator("#toast").getByText("已保存，等待生信确认。").waitFor();
  await action("提交示例").click();
  assert.deepEqual(await value(), {result_display_count: 5});

  await page.setViewportSize({width: 375, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  assert.deepEqual(errors, []);
});

test("rehearsal downloads real files, commits V0.3 deltas and exposes SQLite history", async t => {
  const directory = await mkdtemp(join(tmpdir(), "skyao-rehearsal-"));
  const demo = await startReceiver(directory, process.env, "--demo");
  t.after(async () => {
    await stopReceiver(demo.process);
    await rm(directory, {force: true, recursive: true});
  });
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1500, height: 950}});
  t.after(() => page.close());
  page.setDefaultTimeout(16000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", {name, exact: true});
  const link = name => page.getByRole("link", {name, exact: true});
  const get = async path => {
    const res = await page.request.get(demo.address + path);
    assert.ok(res.ok(), await res.text());
    return res.json();
  };
  const rehearsal = "/demo/rehearsal/api";
  await page.goto(demo.address + "/demo/rehearsal");
  await button("＋ 创建演练项目").click();
  await page.getByLabel("项目名称").fill("文件链路验收");
  await button("创建空项目").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-directory-section]").length === 10);
  const project = await page.locator("#project-select").inputValue();
  const api = rehearsal + "/projects/" + project;
  const database = async () => (await get(api + "/database")).tables;
  let db = await database();
  assert.ok(db.rehearsal_slots.every(slot => slot.status === "empty" && !slot.current_version_id));
  assert.deepEqual([db.rehearsal_nodes.length,db.rehearsal_deliveries.length,db.rehearsal_files.length],[10,0,0]);

  async function download(locator, target) {
    const waiting = page.waitForEvent("download");
    await locator.click();
    const file = await waiting;
    await file.saveAs(target);
  }
  const zip = join(directory,"materials.zip");
  const samples = join(directory,"materials");
  await download(link("下载全部材料"),zip);
  await execute(python, ["-m","zipfile","-e",zip,samples]);
  const packs = (await readdir(samples)).filter(name=>/^\d\d_/.test(name)).sort();
  assert.equal(packs.length,10);
  const resource = (node,name) => join(samples,packs[node-1],name);
  assert.match(await readFile(resource(6,"投递说明.txt"),"utf8"),/主成分分析 → PCA 展示[\s\S]*pca_B\.csv[\s\S]*G1/);
  await download(link("下载当前节点材料"),join(directory,"node.zip"));
  assert.equal((await database()).rehearsal_files.length,0);

  const nodes = db.rehearsal_nodes;
  const selectNode = async i => page.locator("#node-select").selectOption(nodes[i-1].id);
  const slots = (data,i,result) => data.rehearsal_slots.find(slot=>slot.project_node_id===nodes[i-1].id&&slot.result_item_id===result);
  const view = async (data,i,result) => page.locator(`[data-slot="${slots(data,i,result).id}"]`).click();
  const clearFiles = async () => {
    while (await page.locator("[data-remove-file]").count()) await page.locator("[data-remove-file]").first().click();
  };
  const selectFiles = files => page.locator("#local-files").setInputFiles(files);
  const bind = (file,result) => page.locator("#bindings select").filter({has: page.locator(`option[value="${result}"]`)})
    .and(page.getByLabel(file+" 投递结果项",{exact:true})).selectOption(result);
  const send = async () => {
    const sent = page.waitForResponse(response=>response.url().endsWith("/v3/deliveries"));
    await button("检查并投送").click();
    const response = await sent;
    await page.waitForFunction(() => !document.querySelector("#send").disabled);
    return {status:response.status(),body:await response.json()};
  };
  const fresh = async (i,result,status) => {
    for (let attempts=0; attempts<100; attempts+=1) {
      const data = await database();
      if (slots(data,i,result).status===status) return data;
      await pause(100);
    }
    const data = await database();
    assert.fail(JSON.stringify(data.rehearsal_plots));
  };
  const versionCount = (data,slot) => data.rehearsal_versions.filter(version=>version.slot_id===slot.id).length;
  const recordFor = (data,i,result) => {
    const slot = slots(data,i,result);
    const version = data.rehearsal_versions.find(version=>version.id===slot.current_version_id);
    return data.rehearsal_files.find(file=>file.id===version?.file_id);
  };
  const getFile = async file => Buffer.from(await (await page.request.get(demo.address+api+"/files/"+file.id)).body());

  await selectFiles(resource(1,"qc_A.csv"));
  await bind("qc_A.csv","T1");
  await page.locator(".manifest").getByText("schema_version",{exact:true}).waitFor();
  const sha = createHash("sha256").update(await readFile(resource(1,"qc_A.csv"))).digest("hex");
  await page.locator(".manifest").getByText(sha,{exact:true}).waitFor();
  await button("JSON").click();
  const expectedManifest = JSON.parse(await page.locator("#manifest-json").textContent());
  const first = await send();
  assert.equal(first.status,201);
  assert.deepEqual(first.body.manifest,expectedManifest);
  db = await database();
  await view(db,1,"T1");
  await page.locator("#result-csv").getByText("94.8",{exact:true}).waitFor();
  assert.deepEqual(await getFile(recordFor(db,1,"T1")),await readFile(resource(1,"qc_A.csv")));

  await clearFiles();
  await selectNode(4);
  await selectFiles(resource(4,"distribution_A.png"));
  await bind("distribution_A.png","P1");
  assert.equal((await send()).status,201);
  db = await database();
  await view(db,4,"P1");
  await page.waitForFunction(() => document.querySelector(".result-image")?.naturalWidth===720);
  assert.deepEqual(await getFile(recordFor(db,4,"P1")),await readFile(resource(4,"distribution_A.png")));

  await clearFiles();
  await selectNode(6);
  await selectFiles(resource(6,"pca_A.csv"));
  await bind("pca_A.csv","T1");
  assert.equal((await send()).status,201);
  db = await fresh(6,"G1","ready");
  await view(db,6,"T1");
  await page.locator("#result-csv").getByRole("columnheader",{name:"PC2"}).waitFor();
  const pcaA=await getFile(recordFor(db,6,"G1"));
  await view(db,6,"G1");
  await page.waitForFunction(() => document.querySelector(".result-image")?.naturalWidth>0);
  await clearFiles();
  await selectFiles(resource(6,"pca_B.csv"));
  await bind("pca_B.csv","T1");
  const updated = await send();
  assert.equal(updated.status,201);
  db = await fresh(6,"G1","ready");
  assert.notDeepEqual(await getFile(recordFor(db,6,"G1")),pcaA);
  assert.equal(versionCount(db,slots(db,6,"T1")),2);
  assert.equal(versionCount(db,slots(db,6,"G1")),2);
  await view(db,6,"G1");
  await page.locator(".history summary").getByText("历史版本（2）").click();
  await page.locator(".history").getByRole("button",{name:"v1 · G1_pca.png"}).click();
  await page.getByText("历史版本",{exact:true}).waitFor();
  const counts = db.rehearsal_versions.length;
  const replay = await send();
  assert.equal(replay.status,200);
  assert.equal(replay.body.id,updated.body.id);
  assert.equal(replay.body.replayed,true);
  assert.equal((await database()).rehearsal_versions.length,counts);
  await page.locator("#inspection").getByText(/重复投送/).waitFor();

  await clearFiles();
  await selectNode(7);
  await selectFiles(resource(7,"matrix_A.csv"));
  await bind("matrix_A.csv","T1");
  const matrix = await send();
  assert.equal(matrix.body.plots[0].status,"waiting");
  await page.locator("#inspection").getByText("等待其他绘图输入",{exact:true}).waitFor();
  await clearFiles();
  await selectFiles(resource(7,"annotation_A.csv"));
  await bind("annotation_A.csv","T2");
  assert.equal((await send()).status,201);
  db = await fresh(7,"G1","ready");
  await view(db,7,"G1");
  await page.waitForFunction(() => document.querySelector(".result-image")?.naturalWidth>0);
  assert.equal(versionCount(db,slots(db,7,"T1")),1);
  assert.equal(versionCount(db,slots(db,7,"T2")),1);
  assert.equal(db.rehearsal_plots.find(job=>job.delivery_id===matrix.body.id).status,"waiting");

  await clearFiles();
  await selectFiles({name:"annotation_wrong.csv",mimeType:"text/csv",buffer:Buffer.from("sample_id,group\nS99,A\n")});
  await bind("annotation_wrong.csv","T2");
  assert.equal((await send()).status,201);
  db = await fresh(7,"G1","failed");
  await view(db,7,"G1");
  await page.locator("#inspection").getByText("样本注释与数值矩阵的样本编号不一致。",{exact:true}).waitFor();
  assert.equal(await page.locator(".result-image").count(),0);
  assert.equal(versionCount(db,slots(db,7,"G1")),1);
  assert.equal(versionCount(db,slots(db,7,"T1")),1);
  assert.equal(versionCount(db,slots(db,7,"T2")),2);
  assert.equal(slots(db,7,"G1").current_version_id,null);

  await clearFiles();
  await selectNode(3);
  await selectFiles([resource(3,"quant_A.csv"),resource(3,"quant_summary_A.csv")]);
  await bind("quant_A.csv","T1");
  await bind("quant_summary_A.csv","T2");
  assert.equal((await send()).status,201);
  db = await database();
  const savedSummary = slots(db,3,"T2").current_version_id;
  await clearFiles();
  await selectFiles(resource(3,"quant_B.csv"));
  await bind("quant_B.csv","T1");
  assert.equal((await send()).status,201);
  db = await database();
  assert.equal(slots(db,3,"T2").current_version_id,savedSummary);
  assert.equal(versionCount(db,slots(db,3,"T1")),2);
  assert.equal(versionCount(db,slots(db,3,"T2")),1);

  await clearFiles();
  await selectFiles([{name:"quant_A.csv",mimeType:"text/csv",buffer:await readFile(resource(3,"quant_A.csv"))},{
    name:"bad_summary.csv",mimeType:"text/csv",buffer:Buffer.from("metric,count\n"),
  }]);
  await bind("quant_A.csv","T1");
  await bind("bad_summary.csv","T2");
  const badSummary = await send();
  assert.equal(badSummary.status,422);
  assert.match(badSummary.body.error.message,/至少一条数据行/);
  assert.deepEqual(await database(),db);

  await clearFiles();
  await selectNode(6);
  await selectFiles({name:"错误坐标.csv",mimeType:"text/csv",buffer:Buffer.from("sample_id,group,PC1\nS01,A,3\n")});
  await bind("错误坐标.csv","T1");
  const bad = await send();
  assert.equal(bad.status,422);
  assert.match(bad.body.error.message,/PCA 坐标表缺少 PC2 列/);
  await page.locator("#send-error").getByText(/缺少 PC2/).waitFor();
  assert.equal(await page.locator("#bindings select").inputValue(),"T1");
  assert.equal((await database()).rehearsal_versions.length,db.rehearsal_versions.length);
  await view(db,3,"T1");
  await page.locator("#result-csv").getByText("215",{exact:true}).waitFor();
  await page.reload();
  await button("结果预览").click();
  await page.locator("#result-csv").getByText("215",{exact:true}).waitFor();
  await page.locator("#database-region > summary").click();
  const records = page.locator('[data-db-table="rehearsal_slots"]');
  await records.locator("tr.pointer").first().waitFor();
  assert.equal((await database()).rehearsal_versions.length,db.rehearsal_versions.length);
  assert.deepEqual(errors, []);
  await page.setViewportSize({width:375,height:850});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),375);
  const sources = await page.evaluate(async () => {
    const workbench = await (await fetch("/demo/rehearsal/api/projects")).json();
    if (!workbench.workbench) return null;
    const [parameter, node, flow] = await Promise.all([
      import("/workbench/parameter-editor/workbench-storage.js"),
      import("/workbench/node-editor/node-model.js"),
      import("/workbench/flow-editor/flow-model.js"),
    ]);
    const sample = (await parameter.parameterLibrary.read()).find(item=>item.code==="p_value_cutoff");
    const referenced = node.newNode();
    Object.assign(referenced,{name:"工作台节点",status:"confirmed",version:3,revision:1});
    node.addResult(referenced,"table").name = "工作台结果表";
    referenced.reanalysis.mode = "local";
    referenced.reanalysis.parameters.push(node.makeReference({...sample,status:"confirmed"}));
    await node.nodeLibrary.update(records=>records.push(referenced));
    const template = flow.newFlow();
    Object.assign(template,{name:"工作台来源",status:"confirmed",version:2,revision:1});
    const section = flow.newSection(template);
    section.title = "工作台目录";
    flow.addEntry(template,section,referenced);
    await flow.flowLibrary.update(records=>records.push(template));
    return {flow:template.id,node:referenced.id,nodeLibrary:JSON.stringify(await node.nodeLibrary.read()),
      flowLibrary:JSON.stringify(await flow.flowLibrary.read())};
  });
  if (sources) {
    await button("＋ 创建演练项目").click();
    await page.locator("#template-select").selectOption(sources.flow+"@2");
    await button("创建空项目").click();
    await page.waitForFunction(() => document.querySelectorAll("[data-directory-section]").length===1);
    const created = await page.locator("#project-select").inputValue();
    const copy = (await get(rehearsal+"/projects/"+created+"/database")).tables;
    assert.equal(copy.rehearsal_projects[0].flow_id,sources.flow);
    assert.equal(copy.rehearsal_projects[0].flow_version,2);
    assert.equal(copy.rehearsal_nodes[0].node_id,sources.node);
    assert.equal(copy.rehearsal_nodes[0].node_version,3);
    assert.equal(copy.rehearsal_nodes[0].definition.source_node.reanalysis.parameters[0].parameter_code,"p_value_cutoff");
    assert.equal(copy.rehearsal_slots[0].status,"empty");
    assert.equal(await page.evaluate(()=>localStorage.getItem("skyao-static-node-library-v1")),sources.nodeLibrary);
    assert.equal(await page.evaluate(()=>localStorage.getItem("skyao-static-flow-library-v1")),sources.flowLibrary);
    assert.deepEqual(await database(),db);
  }
});
