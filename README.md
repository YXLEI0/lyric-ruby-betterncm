# 歌词注音 · lyric-ruby

在网易云音乐的歌词上方标注读音: 日语歌词的汉字标振假名, 西文字母标片假名, 中文 / 朝鲜语歌词标普通话 / 朝鲜语读音

![截图](docs/images/lyrics-page.png)

## 环境

- 网易云音乐 **3.x** (在 3.1.39 上实测)
- [BetterNCM](https://github.com/std-microblock/BetterNCM) **1.3.0+**

## 安装

从 [Releases](https://github.com/YXLEI0/lyric-ruby-betterncm/releases) 下载 `lyric-ruby.plugin`, 放进 BetterNCM 的插件目录后重启网易云

从旧版 `western-katakana.plugin` 升级要先删掉旧文件 (两个同时装会重复注音), 配置 / 学会的词 / 用量会自动搬过来. 装过 `jp-furigana` 或 `JapaneseFonts` 的可以卸掉了, 振假名和日文字体都已经是本插件的一部分

自己打包:

```bash
npm ci                   # 依赖按 package-lock.json 装
npm run build            # 产出 builds/lyric-ruby.plugin
npm run install:plugin   # 顺便复制到 C:\betterncm\plugins
```

包体约 15 MB, 其中绝大部分是振假名用的 kuromoji + IPADIC 词典 (`vendor/`, 解压后 17 MB). 词典在第一次出现日语歌词时才读 (约 0.7 秒), 不拖启动

## 读音来源

日语歌词的振假名有两档, 在插件设置的 "读音来源" 里选:

| 选项 | 说明 |
| --- | --- |
| 离线词典 (默认) | 完全离线, 由内置的 kuromoji + IPADIC 推读音; 词典读不出的字再用页面上的音译行反推 (`霽れを待つ君` + `ha re o ma tsu ki mi` → 霽 は) |
| 外部网站 | 从 [UtaTen](https://utaten.com/) 获取振假名, 或从 [歌ネット](https://www.uta-net.com/) 获取罗马音再对齐到汉字; 网站没收录或对不上的行仍用词典 |

外部网站默认关闭. 第一次开启时会弹出提示: 歌词和读音的著作权属于权利人及相应网站, 以程序方式获取可能违反网站的使用条款, 请自行判断并仅用于个人学习. 确认后才会联网, 每首歌的歌词和读音缓存在 `<BetterNCM 数据目录>/lyrics/jp-furigana/` 下的一个 JSON 文件里 (格式与 jp-furigana 一致, 两个插件可共用同一份). 想撤回时, 点设置里 "读音来源" 下方的 "撤销网站同意", 会切回词典. 查哪家可以固定 (自动 / 只用 UtaTen / 只用 Uta-net)

西文字母的片假名读音走另一套层序, 顺序可在高级设置里调:

| 层 | 说明 |
| --- | --- |
| 离线词典 | 6895 条人工核对过的词 (外来语 / 官方歌名 / 运行期沉淀) |
| 日式罗马音 | 歌词里官方写的罗马音 (`sekai` → セカイ) |
| 大模型校正 | 词典外的词按整句语境判; 需要自己填 API Key |
| 免费接口 | Google 翻译, 不需要 Key |
| 英文音译规则 | 兜底, 永远给得出结果, 但会标记为 "没把握" |

中文歌词的汉字查 20856 字的普通话读音表 (面板 "其它语言" 里打开), 多音字可由大模型按整句挑; 谚文按朝鲜语规则现拼

## 设置面板

歌词页右上角的齿轮打开, 面板按用途分块:

| 分区 | 内容 |
| --- | --- |
| 启用注音 | 总开关 |
| 读音来源 | 词典 / 外部网站 (UtaTen、Uta-net) · 查询哪家 · 状态 · 重新获取 / 查看来源网页 / 手动指定歌词页 |
| 日语歌词 | 标振假名 (平假名 / 片假名) · 用日文字体 |
| 其它语言 | 西文歌词标片假名 · 日语歌里夹的西文也标 · 中文歌词标普通话读音 · 朝鲜语歌词标朝鲜语读音 |
| 大模型校正 | 开关 · API Key · 测试连接 |
| 预览 | 深色框里的示例歌词, 字号 / 写法 / 字体一改当场变 |

"高级设置" (默认收起) 里是外观 (注音字号 / 不透明度 / 日文字体名 + 重置)、范围 (标注范围 / 自定义选择器 / 播放栏 / 非日语歌 / 联网校正)、本地歌词 (缓存目录 + 列表 + 删除)、接口 (地址 / 模型)、读音来源顺序、API 用量、操作 (重扫 / 重试 / 导出词库 / 清缓存 / 清学会的词)

装了 RefinedNowPlayingNext 时, 它的播放页设置栏里会多一栏 "注音", 其中 `ふりがな` 按钮关掉整个插件的注音

## 怎么调

双击一个注音可以就地改读音 (汉字、西文词都一样): 回车保存, 清空输入框 = 恢复词典读音, 输入 `-` = 这一处不注音, 输入斜杠 = 按字切词 (`あざ/わら`、`-/わら`)

有多个常用读法的词 (`明日` / `行く` / `抱く` / `解く` / `何` / `良` / `皆` / `泥水` / `灯` / `弄る` …) 和数字 (`4` よん/し、`7` なな/しち) 双击时下面会列一排候选, 点一下直接切; 单字还会补上常用漢字表里的音读 / 训读和音便 (连浊 / 半浊 / 促音便). 编辑器两边的 ← / → 把相邻那个注音并进来 (`辛`+`辛` → `辛辛` からがら)

面板 "高级设置 → 操作 → 重置本首读音" 清掉这一首里就地改过的读音, 回到词典读音

## 说明

- 只标网页里的歌词 (播放页 / 歌词栏 / 逐字歌词). 桌面歌词是原生窗口而不是网页, 改不到
- 中文翻译层、罗马音层、制作信息与版权行一律跳过
- 音译 / 翻译行的文字不会被当成歌词, 也不会被拿去判语种
- 读音取不到时留白, 不猜
- 日语歌里的西文另有一个开关 (`日语歌里夹的西文也标`), 听日语歌嫌吵可以单独关掉

## 已知限制

- 振假名依赖 IPADIC: 生僻字、造词、纯英文夹杂处可能留白
- 日语歌里的中文行按普通话读音注; 日文和中文都会写的字 (比如 `愛`) 在纯汉字行里可能判错
- 大模型校正和免费接口要联网, 没填 Key 或断网时自动退回上面三层本地结果

## 开发

```bash
npm run check        # 静态自检 (ES5 / manifest / 注入顺序 / 词典完整性 / 密钥)
npm test             # 全套测试
npm run build        # 打包
npm run build:dict   # 重新生成西文读音词典
npm run build:hanzi  # 重新生成普通话读音表
```

读音来源、判据与实现要点见 [docs/notes.md](docs/notes.md); 第三方组件与数据来源见 [NOTICE.md](NOTICE.md)

## 致谢

- 外部网站读音、本地歌词管理与多插件共存的思路来自 [Leleawa/jp-furigana](https://github.com/Leleawa/jp-furigana) (MIT); 读音缓存与它共用同一份格式
- 振假名的第三方组件 (kuromoji.js / IPADIC / furigana.js) 取自 jp-furigana 的分发包
- 日文字体的字表与默认字体栈来自 [MuttonString/Furigana](https://github.com/MuttonString/Furigana) (作者 Mutton_String)
- 常用漢字的音读 / 训读表由 [davidluzgouveia/kanji-data](https://github.com/davidluzgouveia/kanji-data) (MIT) 生成

## 许可

插件自身的代码采用 **MIT** 协议, 见 [LICENSE](LICENSE)

打包分发的第三方组件见 [NOTICE.md](NOTICE.md):

| 组件 | 许可 |
| --- | --- |
| `vendor/kuromoji.js` | Apache-2.0 ([LICENSE-kuromoji.txt](vendor/LICENSE-kuromoji.txt)), 已修改, 文件头带修改说明 |
| `vendor/dict/*.dat.gz` | mecab-ipadic-2.7.0-20070801, NAIST + ICOT |
| `vendor/furigana.js` | MIT ([LICENSE-furigana.txt](vendor/LICENSE-furigana.txt)) |

歌词与读音的著作权属于权利人及相应网站, 程序化获取仅限个人学习

> 代码是需求一路加出来的, 以 "真机上结果对" 为验收标准, 注释里写了很多踩坑现场; 不要拿它当工程范本
