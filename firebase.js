/* ============================================================
   Firebase 整合層（ES module）
   - 初始化 App / Auth / Firestore
   - 對外掛一組簡單 API 到 window.LB，給傳統的 script.js 呼叫
   - 就緒後發出 "firebase-ready" 事件，讓 script.js 接手綁定
   資料模型：collection "scores"，每位玩家每個「難度×提醒」只留一筆最佳
     doc id = `${uid}_${size}_${hint?1:0}`
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, getDocs,
  collection, query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const provider = new GoogleAuthProvider();

// 對外 API：window.LB（LeaderBoard）
window.LB = {
  ready: true,
  currentUser: null,

  // 訂閱登入狀態變化（重整後也會自動恢復登入）
  onAuth(cb){
    onAuthStateChanged(auth, (u) => {
      window.LB.currentUser = u;
      try { cb(u); } catch(e){}
    });
  },

  login(){  return signInWithPopup(auth, provider); },
  logout(){ return signOut(auth); },

  // 上傳成績：只有比自己線上最佳更快時才寫入（省流量、也讓榜=個人最佳）
  // 回傳：{skipped} 未登入 | {improved:false,best} 沒更快 | {improved:true} 有更新
  async submitScore({ size, hint, ms, errors, seed }){
    const u = auth.currentUser;
    if(!u) return { skipped: true };

    const id  = `${u.uid}_${size}_${hint ? 1 : 0}`;
    const ref = doc(db, "scores", id);

    const snap = await getDoc(ref);
    if(snap.exists() && snap.data().ms <= ms){
      return { improved: false, best: snap.data().ms };
    }

    await setDoc(ref, {
      uid:    u.uid,
      name:   (u.displayName || "玩家").slice(0, 20),
      photo:  u.photoURL || "",
      size:   size,
      hint:   !!hint,
      ms:     ms,
      errors: errors || 0,
      seed:   seed || "",
      ts:     Date.now()
    });
    return { improved: true };
  },

  // 取某難度×提醒模式的前 n 名（依時間由快到慢）
  async topScores(size, hint, n = 50){
    const q = query(
      collection(db, "scores"),
      where("size", "==", size),
      where("hint", "==", !!hint),
      orderBy("ms", "asc"),
      limit(n)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data());
  }
};

// 通知 script.js：Firebase 已就緒，可以綁定登入/排行榜了
window.dispatchEvent(new Event("firebase-ready"));
