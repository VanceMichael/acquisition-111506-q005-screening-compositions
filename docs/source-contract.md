# 展映交付收件台：合作来源契约

这是仅含虚构字节的IMF Interoperable Master Format样例，不执行播放、图像音频处理或转码。`/packages/base`与`/packages/supplement`返回该包的AssetMap、PKL和CPL成员标识；`/objects/{id}`返回成员对象。按唯一Asset UUID连接PKL哈希与AssetMap分块；资源文件名相似不构成身份。资源分块入口`/chunks/{id}`返回确切字节和ETag，收件须核对PKL声明与整资源范围内的实际字节。夹具中的Package hashes采用SHA256占位格式，需要按本文定义的本地表示核验；不存在远程文件清单或真实片源。

CPL资源包含TrackFileId、editRate、entryPoint、sourceDuration、repeatCount、intrinsicDuration。时间值以有理数保存；重复数影响组合时间长度，播放清单使用的时基与轨道采样时基并非一个单位。localized CPL引用基础包画面并改用补充语言轨道，基础包和补充包拥有不同发行者；被引用对象可能不在当前选择包。`/objects/same-named`用于表示与同名轨道不同身份的对象。通过实际CPL选择资源并保留跨包来源，不必领不相关的包成员，也不需要构造可播放组合。

若分块只代表资源片段，整体校验仍需覆盖完整资源声明的全部字节；不能仅凭请求到的一个分块宣布PKL通过。现有人工交付键按compositionId，新增表示可以追加所选CPL、资源身份、分块摘要与有理数时间线，不要把三种校验状态揉成一个布尔值。

## 收件端自动领取语义（已实现）

`POST /api/claims` 接收 `{ packageIds, cplId, sourceBaseUrl? }`，按选定组合执行领取，结果独立建账（`claims.jsonl`），原始字节仍按 sha256 内容寻址存入 `blobs/` 并可经 `/api/evidence/{sha256}` 回查。处理规则：

1. 逐包读取 AssetMap/PKL/CPL 成员标识，按 Asset UUID 建立跨包目录；身份只由 UUID 连接，文件名相似（如 `same-named`）不构成身份，绝不据此补位。
2. 领取目标 CPL（及其 `base` 指向的基础 CPL），再按 CPL 各资源段的 TrackFileId 解析实际用到的 TrackFile；不领取与组合无关的包成员。
3. 每个 TrackFile 按 AssetMap 声明拉取**全部**分块，逐块用分块字节的实际 sha256 与来源 ETag 比对。仅覆盖到部分分块不算校验通过。PKL 上的哈希是占位 URN（如 `sha256:picture-v1`），与真实字节摘要不同，故原样保留为身份声明，不作为字节核验依据。
4. 三种状态分别给出、互不合并：
   - `bytesComplete`：组合用到的每个资产，其声明分块是否全部取到（字节已齐）；
   - `digestsVerified`：在字节已齐的前提下，全部分块摘要是否比对通过（校验通过）；
   - `sufficientForComposition`：在二者之外，是否不存在缺失引用、身份歧义/不符、对象缺失或时间线越界（足以支撑组合）。
5. 来源有歧义或缺失时不替操作员选择：`missing-reference`、`object-missing`、`identity-mismatch`、`ambiguous-identity`、`chunk-missing`、`digest-mismatch`、`manifest-inconsistency`、`timeline-invalid` 等问题写入 `issues`，不足组合仍出可核对的领取单（HTTP 201），仅来源不可达或目标 CPL 取不到才报错。
6. `timeline` 用有理数（分子/分母整数）把不同编辑率的资源段排成一条统一组合时间线，给出每段的 `entryPoint/sourceDuration/repeatCount`、编辑单位时长、秒数区间，并在 `trackUsage` 汇总同一资源的复用次数、出现过的编辑率和各截取窗口。

回查入口：`GET /api/claims`（最新领取单）、`GET /api/claims/history?key=...`（按 compositionId）、`GET /api/claims/{identity}`（单条）。来源地址默认取 `SOURCE_URL`，可被请求体的 `sourceBaseUrl` 覆盖。

## 来源与支持范围

格式参考：`https://pub.smpte.org/pub/st2067-3/st2067-3-2020.pdf`。这里运行的是只含虚构资料的本地合作端，不是公网生产服务；只需支持本文明确给出的范围。来源实现和样例可以阅读，自动接入应使用声明的交互入口，不把服务内部对象或预先写好的采集结论当作数据来源。原始依据、结构化内容和完整性状态应能在收件端回查；新增自动接口的名称与内部设计由开发者决定。
