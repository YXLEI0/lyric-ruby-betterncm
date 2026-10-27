# 歌词注音 · lyric-ruby

给歌词标注读音：日语歌词的汉字标**振假名**（平假名 / 片假名），拉丁字母 / 西里尔字母 / 希腊字母标片假名，中文汉字和朝鲜语谚文也能标片假名

![截图](src/preview.png)

## 环境

- 网易云音乐 3.x (在 3.1.39 上实测)
- [BetterNCM](https://github.com/std-microblock/BetterNCM) 1.3.0+

## 安装

从 [Releases](../../releases) 下载 `lyric-ruby.plugin`, 放进 BetterNCM 的插件目录后重启网易云

> 从旧版（`western-katakana.plugin`）升级：把旧的那个文件删掉再放新的，两个同时装会重复注音。配置 / 学会的词 / 用量会自动从老键搬过来。
> 装过 `jp-furigana` / `JapaneseFonts` 的可以卸掉了 —— 振假名现在是本插件的一部分（词典随插件分发，离线可用）。

自己打包:

```bash
npm ci                   # 依赖按 package-lock.json 装
npm run build            # 产出 builds/lyric-ruby.plugin
npm run install:plugin   # 顺便复制到 C:\betterncm\plugins
```

包体约 15 MB: 其中 14 MB 是振假名用的 kuromoji + IPADIC 词典 (`vendor/`), 词典在第一次出现日语歌词时才读, 不拖慢启动。

发版: 推一个 `v*` tag (`git tag v0.1.1 && git push origin v0.1.1`) 会触发 CI —— 跑完 `npm run check` 与全套测试后打包, 把 `western-katakana.plugin` 挂到 [Releases](../../releases); 也可以在 Actions 页面手动 Run workflow 发一版 (tag 留空就用 `src/manifest.json` 里的版本号)。

## 说明

- 日语歌词的汉字标振假名 (设置面板「开关 → 日语歌词给汉字标振假名」, **默认开**, 写法可选平假名 / 片假名): 读**日语读音**, 不是普通话读音 —— `今日` きょう、`一人` ひとり、`東京` とうきょう; 送假名留在底字外面 (`食べる` 只给 `食` 注 た), 作词者自己写的括号注音 (`漢字(かな)`) 直接用括号里的读音
- 读音按五层顺序取: 离线词典 (6895 条) > 日式罗马音 > 大模型校正 > 免费接口 > 英文音译规则。顺序可以在设置面板里上下调
- 推荐填一个大模型 API Key (默认 DeepSeek, 任何 OpenAI 兼容接口都行), 只存在本机 localStorage。留空则这一层不工作, 自动退回免费接口。按「词 + 它所在的那句歌词」缓存, 所以同一个词在不同句子里会分别判断
- 模型答过两次、读音一致的词会自动沉淀成离线词条, 以后不再问模型; 面板「操作 → 导出词库素材」可以把攒下来的词筛进离线词典 (`npm run promote:learned`)
- 记号 (`D/N/A` / `R&B` / `X-Y` / `M・I・D・I`) 按字母名逐字母读, 而且一个字母一个注音 (`&` 读 アンド, 分隔符不发音); 紧贴假名的缩写按字母名 (`ATフィールド` → エーティー), 单个希腊字母读字母名 (`Ω` 按单位读 オーム); 颜文字里的字符不标 (`(#^ω^)`); 缩写 (`you're` / `I'll` / `don't`) 拆成"词干 + 尾巴"; 不发音字母也认 (`knock` ノック, `climb` クライム, `subtle` サトル)
- 西文各语种另有各自的拼读: 德语 / 拉丁语 / 葡萄牙语 / 西班牙语 / 荷兰语 / 斯瓦希里语 / 汉语拼音 / 法语 / 俄语(西里尔) / 希腊语。按整行判定语种, 所以同一首歌里的英文行照旧按英语读 —— `die Ruinenstadt` ディー・ルイーネンスタト, `Novum mundum` ノヴム・ムンドゥム, `Shambulia` シャンブリア, `Виват Анастасия` ヴィヴァト・アナスタシヤ; 西语 `En mi propio camino seguiré lejos de ti` エン・ミ・プロピオ・カミノ・セギレ・レホス・デ・ティ, `Y me cansé` イ・メ・カンセ
- 另有 [sljfaq](https://www.sljfaq.org/afaq/gairaigo.html) 的法语 / 德语 / 荷兰语 / 葡萄牙语 / 俄语借词表 (`tools/vendor/loan/`, `npm run build:loan`, 共 314 条), 记的是日语通行写法 (`Lied` リート, `bier` ビール, `pao` パン, `норма` ノルマ), 只在该语言的行上生效 —— `rose` 在法语行是 ロゼ、英文行仍是 ローズ; 另外收了两批官方读音: [Project Sekai 主数据库](https://pjsekai.moe/#/music/803) 里单词歌名的官方读法 (`Nostalogic` ノスタロジック、`CHAOS` カオス) 和 [sljfaq「English words from Japanese」](https://www.sljfaq.org/afaq/japanese-in-english.html) 那批日语来源英文词 (`kudzu` クズ、`rickshaw` ジンリキシャ)
- 只标歌词原文行和播放栏标题, 含汉字的行也照标; 中文翻译层、罗马音层、制作信息行 (作词/作曲/编曲/演唱/曲绘…) 和版权行 (`Copyright` / `©` / `℗`) 跳过
- RNP 的「复制模式」(总览视图) 整块不注音, 复制歌词时不会带上注音文字
- 非日语歌 (整首歌词一个假名都没有的纯英文 / 西文各语种 / 中文歌) 可选是否标注, 见设置面板「范围」
- 汉字 / 谚文也能注音 (设置面板「开关」里两个选项, **默认关**):
  - 汉字按普通话读音, 一个字一个 ruby (`src/core/hanzi.js`, 20856 个字的读音表, `npm run build:hanzi` 从 pinyin-pro 生成): `我爱上给我勇气` → ウォ アイ シャン ゲイ ウォ ヨン チ
  - **多音字交给大模型按整句挑**: 离线表一个字只有一档 (`行` シン), 开着大模型时把这一句连同候选读音一起发过去 (`银行` → ハン、`行走` → シン), 答案按「字 + 这句话」缓存; 候选之外的读音不收
  - 谚文按朝鲜语读音, 一个音节一个 ruby (纯规则, 不需要词表): `안녕` アンニョン、`김치` キムチ、`감사합니다` カムサハムニダ (连读的鼻音化和浊化也做了)
  - 只标「非日语歌、且这一行没有假名」的行 —— 日语歌里的汉字必须留日语读音 (`東京` 是 トウキョウ, 不是 ドンジン)
- 连字符标记长音: 全大写、形如罗马字音节、被短横线串起来的词每一节都读长音 (`MO-SO` モーソー、`KYO-SO` キョーソー)。这种词要整首歌词一起看, 因为它常被换行拆开 (上一行结尾 `SO-`、下一行开头 `ZO`), 只看一行判不出来。德语复合词 (`Looser-Krankheit-Was`)、小写词、记号里的单字母 (`X-Y`) 不受影响
- 整首 / 整句专属读音 (`src/core/songs.js`, `npm run build:songs`): 有些读音只在这一首歌里成立, 歌名命中 (或歌词里出现识别词) 时按表读 (`the EmpErroR` 的 `the` 是 ジ、`Disco No.39` 的 `No.` 是 ナンバー、`potatoになっていく` 的 `potato` 是 ポテト), 别的歌不受影响; 单句专属的走 `Xだけの…` 里的 X 读 ツイッター 那种。进表的前提是有官方读音可查 (Sekai 主数据或别的官方读法), 自己按词义猜的不进表
- 振假名的读音来源是 kuromoji + IPADIC (`vendor/kuromoji.js`、`vendor/dict/`, 词典随插件分发、完全离线); 词典读不出来的时候留白, 不猜
- `jp-furigana` / `JapaneseFonts` 不必再装: 装两个会在同一行上各注一次。共存补丁 (`npm run patch:furigana` / `patch:fonts`) 在 1.0 里已经删掉
- 桌面歌词无效, 那是原生窗口而不是网页
- 读音来源、规则依据、词典怎么生成、排障、实现要点、已知限制见 [docs/notes.md](docs/notes.md)

## 许可

插件自身的代码采用 MIT 协议, 见 [LICENSE](LICENSE)

读音词典的数据来源与分发注意事项见 [NOTICE.md](NOTICE.md)
