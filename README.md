# 展映交付收件台

这个服务保存组合的人工收件、按组合自动领取、历史版本和原始依据。重复提交相同业务内容与依据返回原收件；内容变化形成历史版本，原始字节用内容摘要回查。合作来源运行在本机，具体交互见 `docs/source-contract.md`。人工收件与自动领取分账记录，自动领取通过声明的 HTTP 入口接入合作来源。

## 运行环境

需要 Node.js 22.22.1 至 22.x，使用内置模块，没有第三方依赖。依赖锁文件随代码保存；`npm ci --offline --ignore-scripts --no-audit --no-fund` 不会下载包。数据目录默认是 `var`，可用 `DATA_DIR` 指定；不可让两个进程同时写同一目录。来源和收件服务默认只监听回环地址，不使用真实机构账号或外网数据。

## 开发与运行

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run demo
```

`npm start` 启动收件服务，默认端口4310；另一终端用 `npm run source` 启动来源端，默认端口4311。可分别通过 `PORT`、`SOURCE_PORT` 修改端口。测试和演示使用系统分配的端口，结束时关闭服务并删除临时收件数据，不需要固定等待时间。

## 已有收件接口

`GET /health` 查看状态；`POST /api/manual` 接收 `record` 和 `evidence`。业务内容需要 `compositionId, assets, timeline`，其中 `compositionId` 是已有人工收件标识。每份依据包含来源 `source`、原始字节 `bytesBase64`，可选 `mediaType` 和需要核对的 `sha256`。`GET /api/records` 返回当前版本，`GET /api/history?key=...` 返回单个业务标识的历史，`GET /api/evidence/摘要` 返回原始字节。人工入口不推断自动采集是否完整；新增来源接入可以扩展领域状态，但应保留这些已用接口。

`fixtures/manual.json` 是可用的人工收件样例。`npm run demo` 实际启动两个本地服务，执行人工提交、重复收件和原始依据回查，并展示按组合自动领取、跨包来源、时间线与不足组合；它只使用本地来源，不用外部网络。

## 按组合自动领取（IMF）

`POST /api/claims` 接收 `{ packageIds, cplId, sourceBaseUrl? }`，从选定包的 CPL、PKL 和 AssetMap 找齐组合实际用到的资源。它只按 Asset UUID 连接身份，不按文件名补位；配音版 CPL 通过 `base` 关联基础 CPL，画面等借用轨道的跨包来源逐条保留。每个 TrackFile 按 AssetMap 拉取全部分块，逐块用实际 sha256 与来源 ETag 比对。

领取单给出三个**彼此独立**的状态，而不是一个布尔值：

- `bytesComplete` 文件字节已齐（声明分块全部取到）；
- `digestsVerified` 校验通过（全部分块摘要比对通过，覆盖完整资源）；
- `sufficientForComposition` 足以支撑这份组合（无缺失引用、身份歧义/不符、对象缺失或时间线越界）。

来源缺失或有歧义时不替操作员选同名文件：问题写入 `issues`，不足组合仍返回可核对的领取单（201），仅来源不可达（502）或目标 CPL 取不到（409）才报错。`timeline` 用有理数把不同编辑率的资源段排成一条统一组合时间线，记录每段截取窗口、重复数、秒数区间；`trackUsage` 汇总资源复用次数、出现过的编辑率与各截取区间。原始字节按 sha256 内容寻址存入 `blobs/`，可经 `/api/evidence/{sha256}` 回查。回查入口：`GET /api/claims`、`GET /api/claims/history?key=...`、`GET /api/claims/{identity}`。来源默认地址用环境变量 `SOURCE_URL`（默认 `http://127.0.0.1:4311`），也可在请求体用 `sourceBaseUrl` 指定。该流程只做收件与核对，不播放、不转码。

## 容器

```sh
docker build -t screening-compositions-intake .
docker run --rm --network none screening-compositions-intake npm test
docker run --rm --network none screening-compositions-intake npm run demo
```

镜像内容由 Dockerfile 的 SHA256 摘要固定；Node.js 22 主版本标签与 package.json 的 >=22.22.1 <23 兼容范围对应，验证环境可使用该范围内的补丁版本。构建需要本地已有该基础镜像；正式运行、测试和演示不安装系统包、不下载模型或数据。服务默认数据放在容器内临时目录，持久运行时可挂载单独卷。演示完整输出可在90秒内展示，不播放预先保存的日志。
