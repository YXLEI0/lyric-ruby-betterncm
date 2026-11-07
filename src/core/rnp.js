/*
 * RefinedNowPlayingNext 播放页设置菜单里的「注音」一栏。
 *
 * 为什么要单独一个模块：RNP 的设置菜单是它自己渲染的一组 `.rnp-group`（按 tab 分栏），
 * 只有等它被点开、真的插进 DOM 之后才能往里加东西。这个模块只做一件事：
 * 盯着 `.rnp-settings-menu`，一出现就在「歌词」那一栏后面补一个「注音」栏，
 * 把 BetterNCM 插件设置页里那些项（振假名 / 假名类型 / 日文字体 / 字号 / 不透明度 /
 * 行距 / 其它语言 / 外部网站）搬过来，复用 RNP 自己的开关、按钮和滑块样式。
 * **不修改 RNP 的任何文件**；它没装或改版了就什么都不做（设置仍在 BetterNCM 页里）。
 *
 * 挂到 globalThis.WKRnpPanel。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKRnpPanel = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TAB = "lyric-ruby";
  var STYLE_ID = "lyric-ruby-rnp-style";

  function install(api, doc) {
    doc = doc || document;
    var win = doc.defaultView || window;
    var menus = [];
    var stopped = false;

    function ensureStyle() {
      if (doc.getElementById(STYLE_ID)) return;
      var style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent =
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-note{opacity:.65;font-size:13px;line-height:1.5;margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-row button{flex:1 1 120px;min-width:0;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-sub{font-size:16px;opacity:.6;margin:18px 0 10px;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-text{display:flex;gap:8px;align-items:center;margin:0 0 12px;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-text input{flex:1 1 auto;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:inherit;}' +
        '.rnp-group[data-tab="' + TAB + '"] .wk-rnp-text button{flex:0 0 auto;}';
      (doc.head || doc.documentElement).appendChild(style);
    }

    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function checkbox(group, key, label) {
      var wrap = el("div", "rnp-checkbox-wrapper");
      var input = el("input", "rnp-checkbox");
      input.type = "checkbox";
      input.id = "wk-rnp-" + key;
      input.dataset.key = key;
      var lb = el("label", "rnp-checkbox-label", label);
      lb.setAttribute("for", input.id);
      wrap.appendChild(input);
      wrap.appendChild(lb);
      group.appendChild(wrap);
      return input;
    }

    function choice(group, key, label, options) {
      var wrap = el("div", "rnp-select-group-wrapper");
      wrap.appendChild(el("div", "rnp-select-group-label", label));
      var box = el("div", "rnp-select-group");
      box.dataset.choice = key;
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", label);
      for (var i = 0; i < options.length; i++) {
        var b = el("button", "rnp-select-group-btn", options[i][1]);
        b.type = "button";
        b.dataset.value = options[i][0];
        b.setAttribute("aria-pressed", "false");
        box.appendChild(b);
      }
      wrap.appendChild(box);
      group.appendChild(wrap);
      return box;
    }

    function slider(group, key, label, min, max, step, unit) {
      var wrap = el("div", "rnp-slider-wrapper");
      var lb = el("label", "rnp-slider-label");
      lb.setAttribute("for", "wk-rnp-" + key);
      lb.appendChild(doc.createTextNode(label + " "));
      var out = el("span", "", "");
      out.dataset.valueFor = key;
      lb.appendChild(out);
      var input = el("input", "rnp-slider");
      input.type = "range";
      input.id = "wk-rnp-" + key;
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.dataset.key = key;
      input.dataset.unit = unit || "";
      wrap.appendChild(lb);
      wrap.appendChild(input);
      group.appendChild(wrap);
      return { input: input, out: out };
    }

    function textRow(group, key, placeholder, buttonLabel, buttonAction) {
      var row = el("div", "wk-rnp-text");
      var input = el("input", "");
      input.type = "text";
      input.placeholder = placeholder;
      input.dataset.key = key;
      row.appendChild(input);
      var btn = el("button", "rnp-select-group-btn", buttonLabel);
      btn.type = "button";
      btn.dataset.action = buttonAction;
      row.appendChild(btn);
      group.appendChild(row);
      return { input: input, button: btn };
    }

    function buildGroup() {
      var group = el("div", "rnp-group");
      group.dataset.tab = TAB;
      group.appendChild(el("div", "rnp-group-title", "注音"));

      var enabled = checkbox(group, "enabled", "启用注音");
      var furigana = checkbox(group, "furigana", "歌词标振假名");
      var kana = choice(group, "furiganaKana", "假名类型", [
        ["hiragana", "平假名"],
        ["katakana", "片假名"],
      ]);
      var jpnFont = checkbox(group, "jpnFont", "日语歌词用日文字体");
      var fontRow = textRow(group, "jpnFontFamily", "字体名（逗号分隔多个）", "重置", "fontReset");

      var rtSize = slider(group, "rtSize", "注音字号", 30, 120, 1, "%");
      var rtOpacity = slider(group, "rtOpacity", "注音不透明度", 10, 100, 1, "%");
      var uniform = checkbox(group, "uniformLineHeight", "统一行距（有注音 / 没注音一样高）");
      var lineHeight = slider(group, "lineHeight", "行高", 1.2, 2.6, 0.1, "");

      group.appendChild(el("div", "wk-rnp-sub", "其它语言"));
      var latin = checkbox(group, "annotateLatin", "西文歌词标片假名");
      var latinJa = checkbox(group, "annotateLatinJa", "日语歌里夹的西文也标");
      var hanzi = checkbox(group, "annotateHanzi", "中文歌词标普通话读音");
      var hangul = checkbox(group, "annotateHangul", "朝鲜语歌词标朝鲜语读音");

      group.appendChild(el("div", "wk-rnp-sub", "外部网站"));
      var source = choice(group, "source", "读音来源", [
        ["dict", "离线词典"],
        ["external", "外部网站"],
      ]);
      var provider = choice(group, "provider", "查询哪家", [
        ["auto", "自动"],
        ["utaten", "UtaTen"],
        ["utanet", "Uta-net"],
      ]);
      var actions = el("div", "wk-rnp-row");
      var retry = el("button", "rnp-select-group-btn", "重新获取本首");
      retry.type = "button";
      retry.dataset.action = "retry";
      var open = el("button", "rnp-select-group-btn", "查看来源网页");
      open.type = "button";
      open.dataset.action = "open";
      actions.appendChild(retry);
      actions.appendChild(open);
      group.appendChild(actions);

      var status = el("p", "wk-rnp-note");
      status.setAttribute("role", "status");
      group.appendChild(status);

      var all = group.querySelectorAll("[data-key]");

      function refresh() {
        var cfg = api.config();
        var info = api.status();
        for (var i = 0; i < all.length; i++) {
          var node = all[i];
          var key = node.dataset.key;
          var value = cfg[key];
          if (node.type === "checkbox") {
            node.checked = !!value;
          } else if (node.type === "range") {
            if (doc.activeElement !== node) node.value = String(value);
            var out = group.querySelector('[data-value-for="' + key + '"]');
            if (out) out.textContent = String(value) + (node.dataset.unit || "");
          } else if (doc.activeElement !== node) {
            node.value = value == null ? "" : String(value);
          }
        }
        var boxes = [kana, source, provider];
        for (var b = 0; b < boxes.length; b++) {
          var key2 = boxes[b].dataset.choice;
          var want = key2 === "source" ? (cfg.external ? "external" : "dict") : cfg[key2];
          for (var j = 0; j < boxes[b].children.length; j++) {
            var btn = boxes[b].children[j];
            var on = btn.dataset.value === want;
            btn.classList.toggle("selected", on);
            btn.setAttribute("aria-pressed", String(on));
          }
        }
        provider.parentNode.hidden = !cfg.external;
        var text = info && info.text ? String(info.text) : "";
        if (status.textContent !== text) status.textContent = text;
        retry.disabled = !(info && info.canRetry);
        open.disabled = !(info && info.canOpen);
        group.querySelector('[data-key="jpnFontFamily"]').disabled = !cfg.jpnFont;
      }

      function readValue(node) {
        if (node.type === "checkbox") return node.checked;
        if (node.type === "range") return Number(node.value);
        return node.value;
      }

      for (var i = 0; i < all.length; i++) {
        (function (node) {
          var commit = function () {
            api.set(node.dataset.key, readValue(node));
            refresh();
          };
          node.addEventListener("change", commit);
          if (node.type === "range") node.addEventListener("input", commit);
        })(all[i]);
      }

      group.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("button") : null;
        if (!btn) return;
        if (btn.disabled && btn.dataset.action !== "fontReset") return;
        var box = btn.parentElement && btn.parentElement.dataset ? btn.parentElement.dataset.choice : "";
        if (box === "furiganaKana") api.set("furiganaKana", btn.dataset.value);
        else if (box === "source") api.set("external", btn.dataset.value === "external");
        else if (box === "provider") api.set("externalProvider", btn.dataset.value);
        else if (btn.dataset.action === "retry") api.retry();
        else if (btn.dataset.action === "open") api.openSource();
        else if (btn.dataset.action === "fontReset") api.set("jpnFontFamily", "");
        refresh();
      });

      return { group: group, refresh: refresh };
    }

    function mount(menu) {
      if (!menu || !menu.querySelector) return;
      if (menu.querySelector('[data-tab="' + TAB + '"]')) return;
      var tabs = menu.querySelector(".rnp-settings-menu-tabs");
      var inner = menu.querySelector(".rnp-settings-menu-inner");
      var lyricTab = tabs && tabs.querySelector('[data-tab="lyric"]');
      var lyricGroup = inner && inner.querySelector('.rnp-group[data-tab="lyric"]');
      // 改版 / 结构不同就什么都不做（设置仍在 BetterNCM 插件设置页）
      if (!lyricTab || !lyricGroup) return;
      ensureStyle();

      var tab = el("div", "rnp-settings-menu-tab", "注音");
      tab.dataset.tab = TAB;
      tab.tabIndex = 0;
      tab.setAttribute("role", "button");
      var built = buildGroup();
      if (lyricTab.parentNode) lyricTab.parentNode.insertBefore(tab, lyricTab.nextSibling);
      if (lyricGroup.parentNode) lyricGroup.parentNode.insertBefore(built.group, lyricGroup.nextSibling);

      function go() {
        try {
          inner.scrollTo({ top: built.group.offsetTop + 5, behavior: "smooth" });
        } catch (e) {
          inner.scrollTop = built.group.offsetTop || 0;
        }
      }
      tab.addEventListener("click", go);
      tab.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });

      menus.push({ menu: menu, tab: tab, entry: built });
      built.refresh();
    }

    function scan() {
      if (stopped) return;
      for (var i = menus.length - 1; i >= 0; i--) {
        var m = menus[i];
        if (!m.menu.isConnected || !m.entry.group.isConnected || !m.tab.isConnected) {
          if (m.entry.group.parentNode) m.entry.group.parentNode.removeChild(m.entry.group);
          if (m.tab.parentNode) m.tab.parentNode.removeChild(m.tab);
          menus.splice(i, 1);
        }
      }
      var found = doc.querySelectorAll(".rnp-settings-menu");
      for (var j = 0; j < found.length; j++) mount(found[j]);
    }

    /*
     * 菜单是 RNP 点开设置才渲染的，但歌词动画每秒会制造成百上千条 DOM 变更。
     * 每条都去分析、去 querySelector 就是卡顿的来源 —— 这里只挂一个节流：
     * 一批变更最多排一次 400ms 后的 scan，scan 里再按"菜单还在不在"决定要不要动。
     */
    var scanTimer = null;
    function scheduleScan() {
      if (scanTimer || stopped) return;
      scanTimer = setTimeout(function () {
        scanTimer = null;
        scan();
      }, 400);
    }

    var observer = new win.MutationObserver(function () {
      scheduleScan();
    });
    observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
    scan();

    return {
      scan: scan,
      refresh: function () {
        for (var i = 0; i < menus.length; i++) menus[i].entry.refresh();
      },
      destroy: function () {
        stopped = true;
        if (scanTimer) clearTimeout(scanTimer);
        observer.disconnect();
        for (var i = 0; i < menus.length; i++) {
          if (menus[i].entry.group.parentNode) menus[i].entry.group.parentNode.removeChild(menus[i].entry.group);
          if (menus[i].tab.parentNode) menus[i].tab.parentNode.removeChild(menus[i].tab);
        }
        menus = [];
      },
    };
  }

  return { install: install };
});
