/* ============================================================
   舒爾特方格 · 邏輯 script.js（原生 JS，無框架）
   結構：
     1) 純函式工具（種子亂數、時間格式、localStorage、網址）
     2) 全域狀態 state
     3) 抓 DOM 元素
     4) 畫面切換 / 主題 / 戰績渲染
     5) 遊戲流程（開始、計時、點擊、結算）
     6) 挑戰連結、複製
     7) Firebase：登入 / 上傳成績 / 玩家排行榜
     8) init()：載入設定、綁事件、開場
   ============================================================ */
(function(){
  "use strict";

  /* =========================================================
     1) 純函式工具
     ========================================================= */

  // 把種子字串雜湊成一個 32 位元整數（給亂數產生器當起點）
  function hashStr(str){
    let h = 1779033703 ^ str.length;
    for(let i=0;i<str.length;i++){
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return (h ^ (h >>> 16)) >>> 0;
  }

  // mulberry32：一個小型「可重現」亂數產生器；同一個起點 => 同一串亂數
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 依「種子 + 大小」洗出方格數字順序。相同輸入 => 相同排列（這就是同題的關鍵）
  function seededOrder(seed, n){
    const rand = mulberry32(hashStr(seed + ":" + n));
    const a = [...Array(n*n)].map((_, i) => i + 1);   // [1,2,...,n*n]
    for(let i = a.length - 1; i > 0; i--){            // Fisher–Yates 洗牌，但用可重現亂數
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 產生一個 5 碼題號（避開容易看錯的字：0/O、1/I）
  function newSeed(){
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for(let i=0;i<5;i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // 毫秒 -> "0.00" 秒字串
  const fmt = ms => (ms / 1000).toFixed(2);

  // 轉義使用者輸入（暱稱來自 Google，仍防禦性 escape 再塞進 innerHTML）
  function escapeHtml(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]
    ));
  }

  // 時間戳 -> 好讀的日期時間
  function fmtWhen(ts){
    const d = new Date(ts), now = new Date(), p = x => String(x).padStart(2, "0");
    const t = p(d.getHours()) + ":" + p(d.getMinutes());
    return d.toDateString() === now.toDateString()
      ? ("今天 " + t)
      : ((d.getMonth() + 1) + "/" + d.getDate() + " " + t);
  }

  // 安全版 localStorage：某些環境（如沙箱 iframe）會禁止存取而丟錯，
  // 這裡全部 try/catch，存不了就當作沒有，程式照跑不會壞。
  const store = {
    get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
    set(k, v){ try{ localStorage.setItem(k, v); }catch(e){} },
    del(k){ try{ localStorage.removeItem(k); }catch(e){} }
  };

  // 依目前題目組出可分享的網址
  function buildUrl(seed, size, hint){
    return location.origin + location.pathname +
      "?seed=" + encodeURIComponent(seed) + "&size=" + size + "&hint=" + (hint ? 1 : 0);
  }

  // 從網址讀挑戰參數；沒有 seed 就回傳 null（代表不是挑戰連結）
  function readParams(){
    const p = new URLSearchParams(location.search);
    const seed = p.get("seed");
    if(!seed) return null;
    let size = parseInt(p.get("size"), 10);
    if(![5,6,7,8].includes(size)) size = 5;
    const hint = p.get("hint") === "0" ? false : true;
    return { seed: seed.toUpperCase().slice(0, 12), size, hint };
  }

  /* =========================================================
     2) 全域狀態
     ========================================================= */
  const state = {
    theme: "dark",
    size: 5,
    hint: true,
    seed: null,
    challenge: null,   // 若從別人連結進來，這裡放 {seed,size,hint}
    // 進行中的一局
    total: 25,
    expected: 1,
    errors: 0,
    startT: 0,
    raf: null,
    playing: false,
    // 戰績（localStorage）
    stats: [],
    // 結算暫存
    res: { seed:"", size:5, hint:true, errors:0 },
    // 排行榜檢視（目前在看哪個難度/提醒模式的榜）
    lbSize:5, lbHint:true
  };

  const LABELS = { 5:"入門", 6:"進階", 7:"困難", 8:"魔王" };

  /* =========================================================
     3) 抓 DOM 元素（集中管理，方便維護）
     ========================================================= */
  const $ = id => document.getElementById(id);
  const el = {
    themeBtn:$("themeBtn"), iconMoon:$("iconMoon"), iconSun:$("iconSun"),
    screens:{
      setup:$("screen-setup"), stats:$("screen-stats"),
      game:$("screen-game"), result:$("screen-result"),
      leaderboard:$("screen-leaderboard")
    },
    // 帳號列
    accountBar:$("accountBar"), loginBtn:$("loginBtn"),
    acctUser:$("acctUser"), acctPhoto:$("acctPhoto"),
    acctName:$("acctName"), logoutBtn:$("logoutBtn"),
    // setup
    banner:$("challengeBanner"), bannerText:$("challengeText"),
    sizeChips:$("sizeChips"), hintToggle:$("hintToggle"),
    startBtn:$("startBtn"), makeLinkBtn:$("makeLinkBtn"),
    linkbox:$("linkbox"), linkUrl:$("linkUrl"), copyBtn:$("copyBtn"),
    pbGrid:$("pbGrid"), viewStatsRow:$("viewStatsRow"), viewStatsBtn:$("viewStatsBtn"),
    newChallengeCard:$("newChallengeCard"), newChallengeBtn:$("newChallengeBtn"),
    // 排行榜
    leaderboardBtn:$("leaderboardBtn"),
    lbSizeChips:$("lbSizeChips"), lbHintTabs:$("lbHintTabs"),
    lbList:$("lbList"), lbBackBtn:$("lbBackBtn"), resLbNote:$("resLbNote"),
    // stats
    pbGridStats:$("pbGridStats"), histCard:$("histCard"),
    statsBackBtn:$("statsBackBtn"), clearStatsBtn:$("clearStatsBtn"),
    // game
    timerVal:$("timerVal"), targetNum:$("targetNum"),
    metaInfo:$("metaInfo"), metaCode:$("metaCode"),
    progBar:$("progBar"), board:$("board"), abortBtn:$("abortBtn"),
    // result
    resCap:$("resCap"), resTime:$("resTime"), resMeta:$("resMeta"),
    againBtn:$("againBtn"), shareBtn:$("shareBtn"), resultBackBtn:$("resultBackBtn"),
    resLinkbox:$("resLinkbox"), resLinkUrl:$("resLinkUrl"), resCopyBtn:$("resCopyBtn")
  };

  /* =========================================================
     4) 畫面切換 / 主題 / 戰績渲染
     ========================================================= */

  // 只顯示指定畫面，其他隱藏
  function showScreen(name){
    Object.keys(el.screens).forEach(k=>{
      el.screens[k].classList.toggle("hidden", k !== name);
    });
  }

  // 套用主題：設定 <html data-theme> 並切換 icon
  function applyTheme(){
    document.documentElement.dataset.theme = state.theme;
    const dark = state.theme === "dark";
    el.iconMoon.classList.toggle("hidden", !dark);
    el.iconSun.classList.toggle("hidden", dark);
  }
  function toggleTheme(){
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    store.set("schulte:theme", state.theme);
  }

  // 從 stats 算出每種大小、每種提醒模式的個人最佳（毫秒）
  // 回傳 { [size]: { on:ms|undefined, off:ms|undefined } }
  function bestBySizeHint(){
    const m = {};
    state.stats.forEach(r=>{
      const k = r.hint ? "on" : "off";
      if(!m[r.size]) m[r.size] = {};
      if(m[r.size][k] == null || r.ms < m[r.size][k]) m[r.size][k] = r.ms;
    });
    return m;
  }

  // 取某難度、某提醒模式的個人最佳（毫秒），沒有回 undefined
  function bestOf(size, hint){
    const b = bestBySizeHint()[size];
    return b ? b[hint ? "on" : "off"] : undefined;
  }

  // 把「個人最佳」畫進指定容器（設定頁和戰績頁共用）
  // 每格同時顯示「提醒開 / 提醒關」兩個成績
  function renderBests(container){
    const best = bestBySizeHint();
    container.innerHTML = [5,6,7,8].map(n=>{
      const b = best[n] || {};
      const cell = (v)=>{
        const txt = v == null ? "—" : fmt(v);
        const cls = v == null ? "v empty" : "v";
        return '<span class="'+cls+'">'+txt+'</span>';
      };
      return '<div class="pb-cell">'+
               '<div class="s">'+n+'×'+n+'</div>'+
               '<div class="pb-two">'+
                 '<div class="pb-line"><span class="pb-tag">提醒開</span>'+cell(b.on)+'</div>'+
                 '<div class="pb-line"><span class="pb-tag off">提醒關</span>'+cell(b.off)+'</div>'+
               '</div>'+
             '</div>';
    }).join("");
  }

  // 畫最近紀錄列表
  function renderRecent(){
    if(state.stats.length === 0){
      el.histCard.innerHTML = '<div class="empty-hint">還沒有紀錄，玩一局就會出現</div>';
      return;
    }
    el.histCard.innerHTML = state.stats.slice(0, 12).map(r=>{
      const mode = (r.hint ? "提醒開" : "提醒關") + (r.errors ? (" · " + r.errors + " 錯") : " · 全對") + " · " + r.seed;
      return '<div class="hist-item">'+
               '<div class="hist-left"><div class="hist-size">'+r.size+'</div>'+
                 '<div><div class="hist-when">'+fmtWhen(r.ts)+'</div>'+
                 '<div class="hist-mode">'+mode+'</div></div></div>'+
               '<div class="hist-time">'+fmt(r.ms)+'</div>'+
             '</div>';
    }).join("");
  }

  // 更新設定頁的戰績摘要（含「查看完整戰績」是否顯示）
  function refreshStatsSummary(){
    renderBests(el.pbGrid);
    el.viewStatsRow.classList.toggle("hidden", state.stats.length === 0);
  }

  /* =========================================================
     5) 挑戰模式 UI（鎖定難度/提醒、切換相關按鈕）
     ========================================================= */
  function applyChallengeUI(){
    const on = !!state.challenge;
    // 反映鎖定的難度/提醒到畫面
    [...el.sizeChips.children].forEach(btn=>{
      btn.classList.toggle("on", +btn.dataset.size === state.size);
      btn.disabled = on;
    });
    el.hintToggle.classList.toggle("on", state.hint);
    el.hintToggle.classList.toggle("locked", on);

    el.banner.classList.toggle("hidden", !on);
    el.makeLinkBtn.classList.toggle("hidden", on);           // 挑戰者不需要再產生連結
    el.newChallengeCard.classList.toggle("hidden", !on);
    el.startBtn.textContent = on ? "開始挑戰" : "開始";

    if(on){
      el.bannerText.innerHTML =
        '<b>朋友的挑戰</b> · ' + state.size + '×' + state.size + ' · ' +
        (state.hint ? '提醒開' : '提醒關') +
        ' · 題號 <span class="code">' + state.seed + '</span><br>按「開始挑戰」玩同一題';
    }
  }

  /* =========================================================
     6) 遊戲流程
     ========================================================= */

  function startGame(){
    if(!state.seed) state.seed = newSeed();     // 自己練習：給一個新題號
    const n = state.size;
    state.total = n * n;
    state.expected = 1;
    state.errors = 0;

    // 依種子產生排列，動態建立格子
    const order = seededOrder(state.seed, n);
    const fontSize = Math.max(13, Math.round(34 - (n - 5) * 4)) + "px";
    el.board.style.gridTemplateColumns = "repeat(" + n + ",minmax(0,1fr))";
    el.board.style.gap = n >= 7 ? "5px" : "7px";
    el.board.innerHTML = "";
    order.forEach(val=>{
      const c = document.createElement("button");
      c.className = "cell";
      c.textContent = val;
      c.style.fontSize = fontSize;
      c.dataset.val = val;
      c.addEventListener("click", (e) => tapCell(c, val, e));
      el.board.appendChild(c);
    });

    // 重置畫面資訊
    el.targetNum.textContent = 1;
    el.progBar.style.width = "0%";
    el.metaInfo.textContent = n + "×" + n + " · " + (state.hint ? "提醒開" : "提醒關");
    el.metaCode.textContent = "題號 " + state.seed;
    el.resLinkbox.classList.add("hidden");

    showScreen("game");

    // 開始計時
    state.playing = true;
    state.startT = performance.now();
    tick();
  }

  // 用 requestAnimationFrame 持續更新計時顯示
  function tick(){
    if(!state.playing) return;
    el.timerVal.textContent = fmt(performance.now() - state.startT);
    state.raf = requestAnimationFrame(tick);
  }

  // 點某一格
  function tapCell(cell, val, e){
    if(!state.playing) return;
    // 只接受真人產生的點擊：console 用 .click()/dispatchEvent 造的事件 isTrusted 為 false
    if(e && e.isTrusted === false) return;
    if(cell.classList.contains("done")) return;   // 已標記完成的不再處理

    if(val === state.expected){
      // 點對：閃綠。提醒模式開才留下「已完成」記號，關掉就恢復原狀（更難）
      cell.classList.add("hit");
      const remember = state.hint;
      setTimeout(()=>{
        cell.classList.remove("hit");
        if(remember) cell.classList.add("done");
      }, 110);

      state.expected++;
      el.targetNum.textContent = state.expected;
      el.progBar.style.width = ((state.expected - 1) / state.total * 100) + "%";
      if(state.expected > state.total) finishGame();   // 全部點完
    } else {
      // 點錯：閃紅震一下
      state.errors++;
      cell.classList.add("wrong");
      setTimeout(()=>cell.classList.remove("wrong"), 300);
    }
  }

  function stopTimer(){
    state.playing = false;
    if(state.raf){ cancelAnimationFrame(state.raf); state.raf = null; }
  }

  function abortGame(){
    stopTimer();
    showScreen("setup");
  }

  function finishGame(){
    const elapsed = performance.now() - state.startT;
    stopTimer();

    const size = state.size;
    const prevBest = bestOf(size, state.hint);         // 這次之前、相同提醒模式的最佳
    const isPB = (prevBest == null || elapsed < prevBest);

    // 存進戰績（最多留 300 筆）
    state.stats.unshift({ size, ms:elapsed, errors:state.errors, hint:state.hint, seed:state.seed, ts:Date.now() });
    if(state.stats.length > 300) state.stats.length = 300;
    store.set("schulte:stats", JSON.stringify(state.stats));

    // 暫存結算資訊（給「再玩 / 分享」用）
    state.res = { seed:state.seed, size, hint:state.hint, errors:state.errors, ms:elapsed };

    // 畫結算頁
    el.resCap.textContent = isPB ? "個人最佳 New Best" : (size + "×" + size + " 完成");
    el.resCap.className = "cap " + (isPB ? "pb" : "ok");
    el.resTime.textContent = fmt(elapsed);
    let meta = size + "×" + size + " · " + (state.hint ? "提醒開" : "提醒關") +
               (state.errors ? (" · " + state.errors + " 次點錯") : " · 全對") +
               ' · 題號 <span class="rcode">' + state.seed + '</span>';
    if(!isPB) meta += "<br>個人最佳 " + fmt(prevBest) + " 秒";
    el.resMeta.innerHTML = meta;
    el.resLinkbox.classList.add("hidden");

    uploadScore(state.res);  // 上傳玩家排行榜（未登入會提示登入）
    refreshStatsSummary();   // 更新設定頁摘要
    showScreen("result");
  }

  /* =========================================================
     7) 挑戰連結 / 複製
     ========================================================= */

  // 顯示連結框並自動嘗試複製；which 用來標記是哪個複製鈕（setup / result）
  function showLink(urlEl, boxEl, btn, url){
    urlEl.textContent = url;
    boxEl.classList.remove("hidden");
    btn.textContent = "複製連結";
    btn.classList.remove("done");
    copy(url, btn);
  }

  function copy(text, btn, resetLabel){
    resetLabel = resetLabel || "複製連結";
    const done = ()=>{
      btn.textContent = "已複製 ✓";
      btn.classList.add("done");
      setTimeout(()=>{ btn.textContent = resetLabel; btn.classList.remove("done"); }, 1800);
    };
    const fallback = ()=>{   // 舊瀏覽器 / 無 clipboard API 時的備援
      try{
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta); done();
      }catch(e){ btn.textContent = "請手動長按複製"; }
    };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
  }

  // 組出可分享的成績文字（含挑戰連結）。文字模板集中此處，方便日後調字。
  function buildShareText(res){
    const label = LABELS[res.size] ? "（" + LABELS[res.size] + "）" : "";
    const score = res.errors ? (res.errors + " 次點錯") : "全對";
    return "舒特爾方格挑戰\n\n" +
           "時間　" + fmt(res.ms) + " 秒\n" +
           "難度　" + res.size + "×" + res.size + label + "\n" +
           "表現　" + score + "\n\n" +
           "換你挑戰同一題，看看誰的專注度比較好 \n" +
           buildUrl(res.seed, res.size, res.hint);
  }

  // 分享成績：手機優先叫系統分享面板（可直接選 LINE / Discord / IG），
  // 不支援時退回「複製整段文字」，並在框內顯示讓桌機也能手動複製。
  function shareResult(){
    const text = buildShareText(state.res);
    // 先把文字放進結算頁的框，桌機看得到、可再複製
    el.resLinkUrl.textContent = text;
    el.resLinkbox.classList.remove("hidden");
    el.resCopyBtn.textContent = "複製成績";
    el.resCopyBtn.classList.remove("done");
    if(navigator.share){
      navigator.share({ title:"舒爾特方格", text }).catch(()=>{});
    } else {
      copy(text, el.resCopyBtn, "複製成績");
    }
  }

  // 回到「自己出題」狀態（清掉網址上的挑戰參數）
  function newChallenge(){
    try{ history.replaceState(null, "", location.origin + location.pathname); }catch(e){}
    state.challenge = null;
    state.seed = null;
    el.linkbox.classList.add("hidden");
    applyChallengeUI();
    showScreen("setup");
  }

  /* =========================================================
     7.5) Firebase：登入狀態 / 上傳成績 / 玩家排行榜
     ========================================================= */

  // 依登入狀態更新帳號列
  function renderAccount(u){
    el.loginBtn.classList.toggle("hidden", !!u);
    el.acctUser.classList.toggle("hidden", !u);
    if(u){
      el.acctName.textContent = u.displayName || "玩家";
      if(u.photoURL){ el.acctPhoto.src = u.photoURL; el.acctPhoto.classList.remove("hidden"); }
      else el.acctPhoto.classList.add("hidden");
    }
  }

  // Firebase 就緒後：綁登入/登出、監聽登入狀態
  function bindFirebase(){
    const LB = window.LB;
    if(!LB) return;
    el.loginBtn.addEventListener("click", ()=>{
      LB.login().catch(err => alert("登入失敗：" + (err && err.message ? err.message : err)));
    });
    el.logoutBtn.addEventListener("click", ()=> LB.logout());
    LB.onAuth(renderAccount);
  }

  // 上傳這局成績（結算時呼叫，不阻塞畫面）
  function uploadScore(res){
    const LB = window.LB;
    if(!LB || !LB.currentUser){
      el.resLbNote.innerHTML = "登入 Google 就能把成績傳上玩家排行榜";
      el.resLbNote.className = "lb-note muted";
      return;
    }
    el.resLbNote.textContent = "上傳中…";
    el.resLbNote.className = "lb-note muted";
    LB.submitScore(res).then(r=>{
      if(r.skipped){ el.resLbNote.textContent = ""; }
      else if(r.improved){
        el.resLbNote.innerHTML = "🏆 已更新你的玩家排行榜成績";
        el.resLbNote.className = "lb-note good";
      } else {
        el.resLbNote.innerHTML = "排行榜個人最佳 " + fmt(r.best) + " 秒 · 這次沒更快";
        el.resLbNote.className = "lb-note muted";
      }
    }).catch(()=>{
      el.resLbNote.innerHTML = "排行榜上傳失敗（稍後再試）";
      el.resLbNote.className = "lb-note muted";
    });
  }

  // 讀取並畫出目前選定難度/提醒的排行榜
  function renderLeaderboard(){
    const LB = window.LB;
    // 更新 tab 視覺狀態
    [...el.lbSizeChips.children].forEach(b => b.classList.toggle("on", +b.dataset.size === state.lbSize));
    [...el.lbHintTabs.children].forEach(b => b.classList.toggle("on", (b.dataset.hint === "1") === state.lbHint));

    if(!LB){
      el.lbList.innerHTML = '<div class="empty-hint">排行榜載入中…（Firebase 尚未就緒）</div>';
      return;
    }
    el.lbList.innerHTML = '<div class="empty-hint">載入中…</div>';
    const myUid = LB.currentUser && LB.currentUser.uid;
    LB.topScores(state.lbSize, state.lbHint, 50).then(rows=>{
      if(!rows.length){
        el.lbList.innerHTML = '<div class="empty-hint">這個榜還沒有成績，來當第一名！</div>';
        return;
      }
      el.lbList.innerHTML = rows.map((r, i)=>{
        const rank = i + 1;
        const badge = rank <= 3 ? ["🥇","🥈","🥉"][rank-1] : rank;
        const me = (myUid && r.uid === myUid) ? " me" : "";
        const av = r.photo
          ? '<img class="lb-av" src="'+escapeHtml(r.photo)+'" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility=\'hidden\'">'
          : '<div class="lb-av lb-av-empty"></div>';
        return '<div class="lb-row'+me+'">'+
                 '<div class="lb-rank">'+badge+'</div>'+
                 av+
                 '<div class="lb-name">'+escapeHtml(r.name || "玩家")+'</div>'+
                 '<div class="lb-time">'+fmt(r.ms)+'</div>'+
               '</div>';
      }).join("");
    }).catch(err=>{
      // 最常見：缺複合索引（size==、hint==、orderBy ms）→ console 會給建立連結
      el.lbList.innerHTML = '<div class="empty-hint">讀取失敗，請稍後再試'+
        '<br><small>第一次使用可能需在 Firebase 建立索引（見 console）</small></div>';
      console.error("[排行榜] 讀取失敗：", err);
    });
  }

  function openLeaderboard(){
    state.lbSize = state.size;   // 預設先看目前選的難度/提醒
    state.lbHint = state.hint;
    renderLeaderboard();
    showScreen("leaderboard");
  }

  /* =========================================================
     8) init：載入設定、綁事件、開場
     ========================================================= */
  function init(){
    // 主題
    state.theme = store.get("schulte:theme") === "light" ? "light" : "dark";
    applyTheme();

    // 戰績
    try{
      const s = store.get("schulte:stats");
      const arr = s ? JSON.parse(s) : [];
      state.stats = Array.isArray(arr) ? arr : [];
    }catch(e){ state.stats = []; }

    // 挑戰連結參數
    const c = readParams();
    if(c){ state.size = c.size; state.hint = c.hint; state.seed = c.seed; state.challenge = c; }

    // ---- 綁事件 ----
    el.themeBtn.addEventListener("click", toggleTheme);

    // 難度鈕（挑戰模式下鎖定）
    el.sizeChips.addEventListener("click", e=>{
      const btn = e.target.closest(".chip");
      if(!btn || state.challenge) return;
      [...el.sizeChips.children].forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      state.size = +btn.dataset.size;
      el.linkbox.classList.add("hidden");   // 設定改了，舊連結作廢
    });

    // 提醒開關
    el.hintToggle.addEventListener("click", ()=>{
      if(state.challenge) return;
      state.hint = !state.hint;
      el.hintToggle.classList.toggle("on", state.hint);
      el.linkbox.classList.add("hidden");
    });

    // 開始（練習模式每次都換新題號，挑戰模式維持同一題）
    el.startBtn.addEventListener("click", ()=>{
      if(!state.challenge) state.seed = newSeed();
      startGame();
    });

    // 產生挑戰連結
    el.makeLinkBtn.addEventListener("click", ()=>{
      state.seed = newSeed();
      showLink(el.linkUrl, el.linkbox, el.copyBtn, buildUrl(state.seed, state.size, state.hint));
    });
    el.copyBtn.addEventListener("click", ()=> copy(el.linkUrl.textContent, el.copyBtn));

    // 戰績頁
    el.viewStatsBtn.addEventListener("click", ()=>{
      renderBests(el.pbGridStats);
      renderRecent();
      el.clearStatsBtn.classList.toggle("hidden", state.stats.length === 0);
      showScreen("stats");
    });
    el.statsBackBtn.addEventListener("click", ()=> showScreen("setup"));
    el.clearStatsBtn.addEventListener("click", ()=>{
      state.stats = [];
      store.del("schulte:stats");
      renderBests(el.pbGridStats); renderRecent(); refreshStatsSummary();
      el.clearStatsBtn.classList.add("hidden");
    });

    // 遊戲 / 結算
    el.abortBtn.addEventListener("click", abortGame);
    el.againBtn.addEventListener("click", ()=>{
      // 再玩一次：沿用難度/提醒，但換一個新題號
      state.size = state.res.size; state.hint = state.res.hint;
      state.seed = newSeed();
      startGame();
    });
    el.shareBtn.addEventListener("click", shareResult);
    el.resCopyBtn.addEventListener("click", ()=> copy(el.resLinkUrl.textContent, el.resCopyBtn, "複製成績"));
    el.resultBackBtn.addEventListener("click", ()=> showScreen("setup"));
    el.newChallengeBtn.addEventListener("click", newChallenge);

    // ---- Firebase：登入 / 玩家排行榜 ----
    if(window.LB) bindFirebase();
    else window.addEventListener("firebase-ready", bindFirebase, { once:true });

    el.leaderboardBtn.addEventListener("click", openLeaderboard);
    el.lbBackBtn.addEventListener("click", ()=> showScreen("setup"));
    el.lbSizeChips.addEventListener("click", e=>{
      const b = e.target.closest(".chip"); if(!b) return;
      state.lbSize = +b.dataset.size; renderLeaderboard();
    });
    el.lbHintTabs.addEventListener("click", e=>{
      const b = e.target.closest(".lb-htab"); if(!b) return;
      state.lbHint = b.dataset.hint === "1"; renderLeaderboard();
    });

    // ---- 開場渲染 ----
    applyChallengeUI();
    refreshStatsSummary();
    showScreen("setup");
  }

  // defer 腳本會在 DOM 解析完後執行，這裡直接呼叫即可
  init();
})();
