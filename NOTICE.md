# 第三方组件与数据来源

本插件由 YXLEI0 维护：https://github.com/YXLEI0/lyric-ruby-betterncm

分发的文件是本仓库 `src/` 下的代码、生成的读音词典（`src/core/dict.js` / `core/hanzi.js`）、一张预览图，
以及 `vendor/` 下用于日语振假名的第三方组件（见下面第 0 节）。

## 0. 振假名的第三方组件 `vendor/`

- `vendor/kuromoji.js`：日语形态素解析器 [kuromoji.js](https://github.com/takuyaa/kuromoji.js)，Apache License 2.0（全文见 `vendor/LICENSE-kuromoji.txt`）。
  与上游的区别只有一处：加了 `globalThis.__FURIGANA_DICT_LOADER__` 钩子，让词典通过 BetterNCM 的 `betterncm.fs` 读，而不是 XHR。
- `vendor/dict/*.dat.gz`：IPADIC 词典（mecab-ipadic，BSD 类许可；版权与条件见 `vendor/NOTICE-furigana.md`）。
- `vendor/furigana.js`：把分词结果对齐成「底字 → 读音」片段，MIT（见 `vendor/LICENSE-furigana.txt`）。

  这三个都取自 [jp-furigana](https://github.com/Leleawa/jp-furigana) 的分发包（同一套 Apache-2.0 + IPADIC 组合）。
  本插件只调用 furigana.js 的纯文本层（`tokensToSegments` 等），渲染走自己的 `core/annotate.js`。

振假名完全离线，运行时不请求任何第三方服务。

## 1. 离线读音词典 `src/core/dict.js`

- 生成脚本：`tools/build-dict.js` (不联网, 只把现成的表合成一个文件)
- 数据源 (优先级从高到低)：
  1. `tools/seed-words.js` (人工核过): 把一份现成的「片假名外来语 → 英文原词」对照表反转过来, 正好是「英文 → 片假名读音」, 而且取的都是日语里的真实写法, 不是规则拼出来的。再加上手工补充的 J-pop 歌词高频词与变形词 (`shining` / `dancing` / `stories` 这类规则音译一定会拼错的), 以及 [sci.lang.japan FAQ「What English words come from Japanese?」](https://www.sljfaq.org/afaq/japanese-in-english.html) 那批日语来源的英文词在日语里的读法 (`kudzu` クズ、`honcho` ハンチョウ、`rickshaw` ジンリキシャ…);
  2. `tools/seed-words-sekai.js` (生成物): [Project Sekai 主数据库](https://pjsekai.moe/#/music/803) 里单个西文词歌名的官方读音 (`Nostalogic` ノスタロジック、`CHAOS` カオス)。原始数据在 `tools/vendor/sekai/musics.json`, 取自 [Sekai-World/sekai-master-db-diff](https://github.com/Sekai-World/sekai-master-db-diff) 的 `musics.json` (游戏主数据, 非站点二次加工);
  3. `tools/seed-words-learned.js` (生成物): 运行期由大模型答案沉淀、经脚本筛选的词;
  4. `tools/seed-words-llm.js` (生成物): 大模型按英文词频批量生成的读音。

生成脚本会拦住三类脏数据: 英文侧不是纯小写字母、读音不是纯片假名 (可带长音符)、同一个词有两种写法。`npm run build:dict` / `npm run build:sekai` 是开发步骤, 不属于插件的运行流程。

运行时还会用到另外两层读音来源, 都不依赖本词典:

- 罗马音切分：把 `sekai` / `shinjiteru` 这类罗马音歌词按音节转成片假名;
- 英文音译规则：兜底, 永远给得出结果, 但会标记为「没把握」;
- 在线校正：Google 翻译 (`translate.google.cn` 一类接口, en→ja), 只接受纯片假名的返回值。这是一个未公开文档的接口, 可能随时失效、限流或改变行为; 失效时插件自动退回上面三层本地结果, 功能不受影响。使用者需要自行判断在所在地与自身用途下这样做是否合适。

## 2. 开发期依赖

`jsdom` (MIT) 仅用于单元测试 (`devDependencies`), 不会被打进 `.plugin` 包。

## 3. 参考实现

- [Leleawa/jp-furigana](https://github.com/Leleawa/jp-furigana)：同生态的「日语歌词振假名」插件。本插件参考了它的 BetterNCM 生命周期写法、设置面板的 `data-k` 绑定结构、`MutationObserver` 记录清理方式, 以及判断内核是否支持 ruby 排版的实测探针。未复制其代码, 但思路来自该项目的公开实现。几个注音插件同时开着时互不打架, 靠的是 `tools/patch-jp-furigana.js` 给它打的共存补丁 (见 README「和另外两个插件共存」)。
- [MuttonString/Furigana](https://github.com/MuttonString/Furigana) (插件名 JapaneseFonts)：只做「给日文歌换日文字体」。它用整行 innerHTML 里有没有假名判断一首歌是不是日文歌, 会把本插件注出来的片假名当成日文歌的证据, 所以也需要一处共存补丁 (`tools/patch-japanese-fonts.js`, 让它剔掉别家注音再看假名)。未复制其代码。
- [BetterNCM](https://github.com/BetterNCM)：插件框架与 manifest 规范。
