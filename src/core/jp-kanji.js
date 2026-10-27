/*
 * 简体 / 繁中特有的汉字 -> 日标汉字（只用于"读"，不改显示）。
 *
 * 为什么要这张表：歌词里偶尔会混进简体写法（`爱`、`时`、`说`），IPADIC 里没有这些字形，
 * kuromoji 切不出词、也就没有读音 —— 振假名会整段留白。把读音用的文本先换成日标写法
 * （`爱` -> `愛`），读音就有了；显示的还是原文，位置也一一对应（一对一映射，长度不变）。
 *
 * 表从 JapaneseFonts（作者 Mutton_String）的 main.js 里取出，是标准的
 * 「简体 -> 日标汉字」对应表；只保留一对一的部分。
 *
 * 挂到 globalThis.WKJpKanji。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKJpKanji = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 两条字符串按位置一一对应：SRC[i] 换成 DST[i]
  var SRC = "爱为异伟汇违维遗纬员阴饮韵亩运云咏卫园烟远铅冈亿忆华货涡过祸个课贺饿开阶块溃谐贝盖该较阁确获吓额辖贯唤换间闲汉惯监缓还馆环简韩舰顽颜愿纪轨记规几挥贵弃毁辉机骑义仪拟议级纠宫给穷许鱼渔协况胁强桥矫镜竞响惊业极仅紧锦谨银训军计启倾庆鲸剧决结杰洁见轩坚绢宪贤谦键茧悬现减库夸顾后语误护红贡绞项沟构纲兴钢讲购刚狱驹顷垦恳诈锁灾细债载际财栅错册杀产伞斩暂师纸视词试诗资饲挚赐时饵识轴执质车谢肿种树终习众丑袭缩术纯顺润书绪诸绍讼胜伤详赏偿场锭饰织职针绅进诊审亲阵寻肾须帅锤势圣诚请责积绩设节羡铣迁选荐鲜渐组诉础仓扫创丧层赠则侧测贼孙损逊贷队态题诺浊达夺谁绽诞锻谈坛耻筑冲驻贮长帐张钓顶鸟胀贴肠调惩沉陈赁镇坠鹤贞订侦缔适敌彻电涂赌东冻岛讨栋汤统头誊腾动铜导顿贪钝谜锅软难认热纳农浓马骂败辈买赔剥缚罚阀贩饭烦颁范盘飞费罢备笔评标贫宾频负妇肤赋谱风复纷喷坟愤奋闻并闭币饼别编补访报饱缝纺贸谋颊扑脉务无梦雾铭鸣灭绵网门纹问约跃输邮涌犹游诱忧优预扬叶阳窑养拥罗络滥蓝栏里离陆侣虏虑凉领疗粮伦轮临类铃丽连练吕赂笼论话贿醫悅歐毆奧橫溫畫會學嶽幹卻腳舊虛禦峽挾狹區徑莖攜獻嚮黃號國參蠶慘殘辭濕寫壽敘將稱條狀觸囑寢盡隨樞數據聲靜稅竊淺踐潛雙壯爭裝屬墮體滯脫擔膽斷癡蟲晝點鬥燈當黨盜獨屆內麥蠻貓寶沒萬與譽踴來亂禮勵戀爐樓灣";
  var DST = "愛為異偉彙違維遺緯員陰飲韻畝運雲詠衛園煙遠鉛岡億憶華貨渦過禍個課賀餓開階塊潰諧貝蓋該較閣確獲嚇額轄貫喚換間閑漢慣監緩還館環簡韓艦頑顔願紀軌記規幾揮貴棄毀輝機騎義儀擬議級糾宮給窮許魚漁協況脅強橋矯鏡競響驚業極僅緊錦謹銀訓軍計啓傾慶鯨劇決結傑潔見軒堅絹憲賢謙鍵繭懸現減庫誇顧後語誤護紅貢絞項溝構綱興鋼講購剛獄駒頃墾懇詐鎖災細債載際財柵錯冊殺産傘斬暫師紙視詞試詩資飼摯賜時餌識軸執質車謝腫種樹終習衆醜襲縮術純順潤書緒諸紹訟勝傷詳賞償場錠飾織職針紳進診審親陣尋腎須帥錘勢聖誠請責積績設節羨銑遷選薦鮮漸組訴礎倉掃創喪層贈則側測賊孫損遜貸隊態題諾濁達奪誰綻誕鍛談壇恥築沖駐貯長帳張釣頂鳥脹貼腸調懲沈陳賃鎮墜鶴貞訂偵締適敵徹電塗賭東凍島討棟湯統頭謄騰働銅導頓貪鈍謎鍋軟難認熱納農濃馬罵敗輩買賠剝縛罰閥販飯煩頒範盤飛費罷備筆評標貧賓頻負婦膚賦譜風複紛噴墳憤奮聞併閉幣餅別編補訪報飽縫紡貿謀頰撲脈務無夢霧銘鳴滅綿網門紋問約躍輸郵湧猶遊誘憂優預揚葉陽窯養擁羅絡濫藍欄里離陸侶虜慮涼領療糧倫輪臨類鈴麗連練呂賂籠論話賄医悦欧殴奥横温画会学岳干却脚旧虚御峡挟狭区径茎携献向黄号国参蚕惨残辞湿写寿叙将称条状触嘱寝尽随枢数拠声静税窃浅践潜双壮争装属堕体滞脱担胆断痴虫昼点斗灯当党盗独届内麦蛮猫宝没万与誉踊来乱礼励恋炉楼湾";

  var table = null;
  function build() {
    var t = {};
    for (var i = 0; i < SRC.length && i < DST.length; i++) {
      if (SRC.charAt(i) !== DST.charAt(i)) t[SRC.charAt(i)] = DST.charAt(i);
    }
    table = t;
    return t;
  }

  /** 有没有需要换的字（整行先过一遍，纯假名 / 纯日文时直接返回原串） */
  function needs(text) {
    if (!text) return false;
    var t = table || build();
    for (var i = 0; i < text.length; i++) {
      if (Object.prototype.hasOwnProperty.call(t, text.charAt(i))) return true;
    }
    return false;
  }

  /**
   * 换成日标写法。**只看单个字**，所以长度与原文一一对应 ——
   * 调用方按位置把读音对回原文时不用做偏移换算。
   */
  function toJapanese(text) {
    var s = String(text == null ? "" : text);
    if (!s || !needs(s)) return s;
    var t = table || build();
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      out += Object.prototype.hasOwnProperty.call(t, c) ? t[c] : c;
    }
    return out;
  }

  return {
    toJapanese: toJapanese,
    needs: needs,
    /** 表里有几对（调试 / 面板显示用） */
    size: function () {
      var t = table || build();
      var n = 0;
      for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) n++;
      return n;
    },
  };
});
