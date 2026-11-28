# 斯凯奥 SkyAO 结果接收器 · MVP V0.2

用两个本地进程模拟 Nextflow 输出节点和云端接收器。发送端把 Manifest 与 CSV 保存为不可变快照，再通过 HTTP multipart 上传。接收端校验后持久化到 SQLite 和本地文件区，页面从接收端 API 读取、绘图和下载。默认使用附件中的原始合成测试集。

## 结果投送演练台

在接收器目录运行：

```sh
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -m skyao.server --demo --port 18767 --data-dir .sky-demo/rehearsal
```

打开 [结果投送演练台](http://127.0.0.1:18767/demo/rehearsal)。选择默认的合成模板创建空项目，再下载全部或当前节点的 ZIP。解压后选择原始 CSV 或 PNG，并按材料说明绑定。PCA 的 A、B 文件使用不同的预制坐标。热图先投矩阵或注释均可，两个位置都有已接收文件后会生成图片。

顶部可进入同源的本地参数、节点和云流程编辑器。默认从本仓库的 `heatmap-editor` 读取静态资源，独立目录可使用同级 `SkyAO-workbench`，可用 `SKYAO_WORKBENCH_DIR` 指向其他工作台仓库目录。项目创建可以选用当前浏览器同源的已确认流程，也可选择已有的流程定义 JSON 和对应的节点定义 JSON。导入实例只写入演练项目。

本页以 `POST /demo/rehearsal/api/v3/deliveries` 接收 Manifest V0.3 和 multipart 文件。V0.3 的 `result_items` 仅更新有绑定的结果位置。旧 `/api/v1/deliveries` 继续使用 V0.2 整单元快照。演练 SQLite 使用 `rehearsal_*` 表，上传文件和生成的 PNG 存在演练数据目录的 `rehearsal_objects/`。数据库视图中的存储位置相对于该数据目录。

PCA 绘制接收的 PC1/PC2，热图绘制接收的表达矩阵与注释。当前不启动真实重分析程序。自定义节点的绘图还需匹配已接入的脚本与输入契约。

### HTTPS 演练入口

将公网 HTTPS 反向代理转发到接收器的回环端口。使用 `--share-origin` 指定对外的 HTTPS 源，另设独立数据目录。例如以实际代理地址替换下方域名：

```sh
.venv/bin/python -m skyao.server --demo --port 18768 \
  --data-dir .sky-demo/rehearsal-share --share-origin https://demo.example.org
```

共享入口使用浏览器 Cookie 隔离项目。通过该入口只提供演练台、运行它所需的资源和工作台编辑页面。从旧工作台链接导出的流程与节点定义 JSON，可以在创建项目时导入。

## 生信参数编辑器

在接收器测试台导航中点「参数编辑器」，或直接打开 [参数编辑器](http://127.0.0.1:18765/demo/parameters)。首次启动会载入 15 张示例卡。编辑区登记填写规则，预览区可以试填并查看提交 JSON。保存、提交待确认和确认入库均写入 Demo 的 SQLite 数据库。已确认版本可另存为新草稿，原版本仍可查找和导出。

项目对象预览采用示例项目数据。参数总表导出当前筛选结果，Markdown 导出当前卡片已保存的版本。当前入口运行于本机 Demo，人工确认使用页面内的核对清单。

## 看一份文件从磁盘发到接收器

打开 [文件投送追踪](http://127.0.0.1:18765/demo/transfer)。用编辑器打开项目里的 `delivery-demo/reading.csv`，修改 `demo-A` 后面的值并保存。点「重新读取磁盘」，左边会显示新内容，右边保留上次收到的旧内容。点「发送当前文件」后，浏览器把清单和 CSV 通过 `POST /api/v1/deliveries` 发到本机接收器。右边会显示真实落盘路径、新版本、文件内容和下载入口。

连接到私有 GitHub 仓库后，可以从终端继续把接收器已保存并核对过的合成 CSV 归档到 GitHub。使用具备该仓库写权限的 GitHub CLI 会话，并将 `owner/name` 换成你的私有测试仓库：

```sh
.venv/bin/python -m skyao.publish_github --repo owner/name
```

归档命令从接收器下载文件，经 GitHub Contents API 写入 `deliveries/<投送编号>/reading.csv`。它会按 GitHub 返回的提交编号读回数据，验证两边字节一致后再输出文件链接。刷新「文件投送追踪」会显示已验证的 GitHub 链接。

## 网页自助测试

在 Demo 目录启动接收器测试台。当前安装完成后可直接运行：

```sh
.venv/bin/python -m skyao.server --demo --port 18765
```

打开 [接收器测试台](http://127.0.0.1:18765/demo)。选中案例可以检查 Manifest、文件名、字节数和实际摘要。点「发送此包」把浏览器 Fetch 构建的 multipart 请求发往 `POST /api/v1/deliveries`，回执面板显示 HTTP 状态、错误码、处理版本和原始 JSON。

| 试法 | 操作 |
|---|---|
| 首投与重试 | 选择 01，点「发送此包」再点「重发此包」。空库中会依次收到 201、200 |
| 局部更新 | 01 成功后选择 04。点击「查看结果」，切换样本验证 S01 版本 1、S02 版本 2 |
| 摘要错误 | 选择 91。页面会标出 S02.csv 的实际摘要与清单不一致，接收器返回 422 `CHECKSUM_MISMATCH` |
| 完整验收 | 点「运行整套验收」，依序发送 12 次请求，包含正常包、重传和五个拒绝场景 |
| 用自己的文件 | 点「上传自己的文件」，选择 V0.2 Manifest JSON 和清单列出的文件。请求由同一个接收 API 处理 |
| 在终端复现 | 在页面底部选择 curl 或 skyctl，复制对应命令，在 Demo 目录执行。curl 直发，skyctl 支持本地预检、快照和重试 |

测试台只监听本机。临时测试令牌在服务启动时生成，浏览器通过同源会话取得；常规启动仍使用环境变量提供 Bearer 令牌。测试台默认写入独立的 `.sky-demo`。若想从零重演，在另一个终端启动独立实例：

```sh
.venv/bin/python -m skyao.server --demo --port 18766 --data-dir "$(mktemp -d)"
```

打开 `http://127.0.0.1:18766/demo`，可从 201 开始重复测试。前台启动的实例可以用 Ctrl+C 停止。

## 标准模式与命令行

在 Demo 目录执行，需 Python 3.10+、Node.js 20+。安装后绘图资源从本机加载。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
```

在同一个终端执行以下命令，生成本次演示的临时令牌，并启动监听在本机的接收器。macOS 的 `pbcopy` 将令牌放入剪贴板，方便在页面输入框粘贴。服务启动时自动导入 `fixtures/seed.json`，重复启动会保留已接受的数据。

```sh
export SKYAO_TOKEN="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe())')"
printf '%s' "$SKYAO_TOKEN" | pbcopy
export SKYAO_BASE_URL=http://127.0.0.1:8000
.venv/bin/python -m skyao.server &
SKYAO_DEMO_PID=$!
curl --fail --retry 5 --retry-connrefused --silent "$SKYAO_BASE_URL/health"
```

打开 [本地结果页](http://127.0.0.1:8000/runs/RUN-TEST-001)，粘贴令牌并点击「打开结果」。在刚才的终端发送第一包，然后在页面点击「刷新结果」。

```sh
skyctl() { .venv/bin/python -m skyao.client "$@"; }

skyctl send --manifest fixtures/01_samples/manifest.json --files-dir fixtures/01_samples/files
skyctl status --run-id RUN-TEST-001 --delivery-id DEL-TEST-001
skyctl retry --run-id RUN-TEST-001 --delivery-id DEL-TEST-001
```

`send` 首次收到 201，`retry` 收到 200 并返回 `replayed: true`。命令在 stdout 打印回执，在 stderr 打印状态日志。继续上传其余四包，并再次刷新页面。

```sh
for folder in fixtures/0[2-5]_*; do
  skyctl send --manifest "$folder/manifest.json" --files-dir "$folder/files" || break
done
```

| 页面操作 | 预期看到 |
|---|---|
| 在「样本表达量分布」切换 Sample 1 / Sample 2 | S01 版本 1、S02 版本 2。支持箱线图、小提琴图、密度图和只读表，图形颜色和字号可编辑 |
| 在「基因差异表达分析」切换 A vs B / B vs C | 两组各自的火山图、MA 图和数据表 |
| 打开「整体表达概览」 | 热图、PCA 和表达矩阵表，整体结果无需下拉框 |
| 在「多层级差异分析」选择 A vs B / 转录本，再切到 B vs C | 切换后回到基因层级，B vs C 仅有基因层级 |
| 在查看图表时点击「下载 文件名」 | 下载接收端保存的原始字节 |

可在 bash 或 zsh 中直接运行 `skyctl` 函数，也可使用等价命令 `.venv/bin/python -m skyao.client`。重复执行 `send` 会检查输入与同 ID 的本地快照是否一致。网络故障后用 `retry` 重传原快照，`status` 从本地 spool 读取状态；原始输出可以移动或被替换。若草稿省略 ID，在状态日志中按 `delivery_id` 查找自动生成的编号。

可运行 `skyctl prune --older-than-days 30` 清理已接受且满 30 天的本地文件副本。清理保留 Manifest 和回执，`status` 会标记 `files_pruned`。如需再次传送已清理的同一包，可用原文件运行 `send`。

## API 和开发配置

| 接口 | 用途 |
|---|---|
| `POST /api/v1/deliveries` | 一个 UTF-8 文本字段 `manifest` 和多项 `files` |
| `GET /api/v1/runs/{run_id}/deliveries/{delivery_id}` | 查询已接受的回执，可用于确认响应丢失前是否已提交 |
| `GET /api/v1/runs/{run_id}/results` | 目录、字典及当前版本。加 `?history=1` 可查每个单元的所有版本及各版文件 ID |
| `GET /api/v1/runs/{run_id}/artifacts/{artifact_id}` | 下载已登记文件 |
| `GET /health` | 存活检查 |

业务 API 需 Bearer 令牌。以下命令绕过客户端，验证服务端直接拒绝损坏包并返回 HTTP 422 `CHECKSUM_MISMATCH`。

```sh
curl -sS -w '\nHTTP %{http_code}\n' -X POST "$SKYAO_BASE_URL/api/v1/deliveries" \
  -H "Authorization: Bearer $SKYAO_TOKEN" \
  -F 'manifest=<fixtures/91_bad_checksum/manifest.json' \
  -F 'files=@fixtures/91_bad_checksum/files/S01.csv' \
  -F 'files=@fixtures/91_bad_checksum/files/S02.csv'
```

| 环境变量 | 默认值或用法 |
|---|---|
| `SKYAO_TOKEN` | 发送端与服务端使用同一临时测试值。页面输入后保存在当前页面内存 |
| `SKYAO_BASE_URL` | `http://127.0.0.1:8000`。远端地址需要 HTTPS，保留证书校验 |
| `SKYAO_SPOOL_DIR` / `SKYAO_DATA_DIR` | `.sky-client` / `.sky-server` |
| `SKYAO_MAX_ATTEMPTS` | 4 次，含首次请求。按 1、2、4 秒退避，长于 30 秒的 Retry-After 留待稍后手动重试 |
| `SKYAO_MAX_FILE_BYTES` / `SKYAO_MAX_TOTAL_BYTES` | 20 MiB / 100 MiB |
| `SKYAO_MAX_MANIFEST_BYTES` / `SKYAO_MAX_FILES` | 1 MiB / 100 个文件 |

服务端也接受 `--seed PATH`、`--data-dir PATH`、`--port PORT`。各次验收使用独立临时目录。关闭手动启动的服务可运行 `kill "$SKYAO_DEMO_PID"`。如需从空数据重演，可用 `SKYAO_DATA_DIR` 和 `SKYAO_SPOOL_DIR` 指向两个新目录。确认本次演示状态无需保留后，可删除项目内的 `.sky-server` 和 `.sky-client`。

## 自动验收

```sh
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
# macOS 优先使用已安装的 Google Chrome，其他环境可先安装 Playwright Chromium
# npx playwright install chromium
npm run test:browser
```

验收日志见 [verification.log](verification.log)。正常包的最终结果有 2 个非空一级目录、4 个二级节点、8 个当前结果单元、9 个版本及 5 条成功投送记录。HTTP 测试使用真实进程和文件，浏览器测试从接收器服务读取绘图数据。图表使用合成数值，供端到端工程测试使用。

## 实现边界

- 运行环境为 macOS 或 Linux，默认监听回环地址。SQLite、磁盘、单任务令牌用于本地验证。
- 实现八种必验视图。图片、PDF、独立下载渲染为协议的可选类型，当前可下载八种视图关联的 CSV。历史文件通过 API 追溯。
- 本地 CLI 为同步命令，保留 spool 和回执供追溯。服务端事务失败可能留下未登记对象，业务 API 无法访问这些对象；开发目录可在确认无需保留后整体清理。
- 现有 Nextflow 与生产环境接入属于后续范围。当前按接收成功顺序分配版本，`compute_job_id` 返回 `JOB_NOT_SUPPORTED`。
