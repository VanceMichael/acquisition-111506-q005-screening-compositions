# 展映交付收件台：合作来源契约

这是仅含虚构字节的IMF Interoperable Master Format样例，不执行播放、图像音频处理或转码。`/packages/base`与`/packages/supplement`返回该包的AssetMap、PKL和CPL成员标识；`/objects/{id}`返回成员对象。按唯一Asset UUID连接PKL哈希与AssetMap分块；资源文件名相似不构成身份。资源分块入口`/chunks/{id}`返回确切字节和ETag，收件须核对PKL声明与整资源范围内的实际字节。夹具中的Package hashes采用SHA256占位格式，需要按本文定义的本地表示核验；不存在远程文件清单或真实片源。

CPL资源包含TrackFileId、editRate、entryPoint、sourceDuration、repeatCount、intrinsicDuration。时间值以有理数保存；重复数影响组合时间长度，播放清单使用的时基与轨道采样时基并非一个单位。localized CPL引用基础包画面并改用补充语言轨道，基础包和补充包拥有不同发行者；被引用对象可能不在当前选择包。`/objects/same-named`用于表示与同名轨道不同身份的对象。通过实际CPL选择资源并保留跨包来源，不必领不相关的包成员，也不需要构造可播放组合。

若分块只代表资源片段，整体校验仍需覆盖完整资源声明的全部字节；不能仅凭请求到的一个分块宣布PKL通过。现有人工交付键按compositionId，新增表示可以追加所选CPL、资源身份、分块摘要与有理数时间线，不要把三种校验状态揉成一个布尔值。

## 来源与支持范围

格式参考：`https://pub.smpte.org/pub/st2067-3/st2067-3-2020.pdf`。这里运行的是只含虚构资料的本地合作端，不是公网生产服务；只需支持本文明确给出的范围。来源实现和样例可以阅读，自动接入应使用声明的交互入口，不把服务内部对象或预先写好的采集结论当作数据来源。原始依据、结构化内容和完整性状态应能在收件端回查；新增自动接口的名称与内部设计由开发者决定。
