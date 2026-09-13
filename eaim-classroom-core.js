/* ══════════════════════════════════════════════════════════
   에임 케어 — Classroom Core
   사회·역사 플랫폼의 eaim-classroom-core.js를 에임 케어용으로 정리한 것.
   Firebase 프로젝트(eaim-classroom)는 그대로 재사용합니다.

   경로 구조 (기존과 동일)
     teachers/{uid}/rooms/{roomId}
     roomCodes/{code} → {teacherUid, roomId, app}
     teachers/{uid}/rooms/{roomId}/students/{studentId}
     teachers/{uid}/rooms/{roomId}/reflections/{id}      ← 마음 트랙 (행발 원료)
     teachers/{uid}/rooms/{roomId}/koreanProgress/{id}   ← 한국어 트랙 (개인 진도)

   ⚠️ 기존 Firestore 규칙은 rooms/{roomId}/{하위컬렉션}/{문서} 딱 2단계까지만
      "if true" 와일드카드가 걸려 있습니다. 그래서 reflections·koreanProgress도
      더 깊이 중첩하지 않고 방 바로 아래 평평하게 둡니다. 규칙 추가 불필요.

   각 HTML에서 아래 두 값을 먼저 지정하세요.
     window.EAIM_APP_TYPE = 'korean-sentence';   // 앱 구분
     window.EAIM_TRACK    = 'korean';            // 'mind' | 'korean'
   ══════════════════════════════════════════════════════════ */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut,
  signInAnonymously, onAuthStateChanged, setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc,
  collection, addDoc, query, where, orderBy, getDocs,
  onSnapshot, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBalg0f5x0ydfHxn_nzgZ1pAELvJw6PzoY",
  authDomain: "eaim-classroom.firebaseapp.com",
  projectId: "eaim-classroom",
  storageBucket: "eaim-classroom.firebasestorage.app",
  messagingSenderId: "294479576192",
  appId: "1:294479576192:web:c60e994e319dbd2f11ba65",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// 공용 컴퓨터 보호: 브라우저를 완전히 닫으면 자동 로그아웃.
const persistenceReady = setPersistence(auth, browserSessionPersistence).catch((e) => {
  console.warn('로그인 지속성 설정 실패(기본값으로 동작):', e);
});

const APP_TYPE = () => window.EAIM_APP_TYPE || 'unknown';
const TRACK = () => window.EAIM_TRACK || 'mind';
const WORK_COL = () => (TRACK() === 'korean' ? 'koreanProgress' : 'reflections');

/* ════════ 스튜디오 앱 목록 ════════ */
export const CARE_APPS = {
  'mind-scale':      { track: 'mind',   file: 'mind-scale.html',       name: '마음 저울',       icon: '⚖️' },
  'music-rep':       { track: 'mind',   file: 'music_rep.html',        name: '뮤직랩',          icon: '🎵' },
  'life-action':     { track: 'mind',   file: 'life-action-q.html',    name: '라이프 액션Q',    icon: '⚡' },
  'vibe-runway':     { track: 'mind',   file: 'my-vibe-runway.html',   name: '마이 바이브 런웨이', icon: '✨' },
  'family-harmony':  { track: 'mind',   file: 'family-harmony.html',   name: '패밀리 하모니',   icon: '🏠' },
  'emotion-story':   { track: 'mind',   file: 'emotion-story.html',    name: '감정 스토리',     icon: '🎢' },
  'round-words':     { track: 'mind',   file: 'round-words.html',      name: '동그란 말 연습',  icon: '🌈' },
  'feel-guess':      { track: 'mind',   file: 'feel-guess.html',       name: '우리 반 마음 맞히기', icon: '🫧' },
  'hangeul':         { track: 'korean', file: 'hangeul-letter.html',   name: '한글 놀이터',     icon: '✍️' },
  'korean-sentence': { track: 'korean', file: 'korean-sentence.html',  name: '한국어 놀이터',   icon: '🗨️' },
};

/* ════════ 교사 인증 ════════ */
export async function teacherLogin() {
  await persistenceReady;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    // 학교 보안 프로그램이 팝업을 조용히 막는 환경에서는 리디렉션으로 자동 전환.
    if (e?.code === 'auth/popup-blocked') return signInWithRedirect(auth, provider);
    throw e;
  }
}
getRedirectResult(auth).catch((e) => console.warn('리디렉션 로그인 처리 중 오류(무시 가능):', e));

export function teacherLogout() { return signOut(auth); }
export function onTeacherAuthChange(cb) { return onAuthStateChanged(auth, cb); }

/* ════════ 학생 익명 입장 ════════ */
export async function studentEnter() {
  await persistenceReady;
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}

/* ════════ 수업방 ════════ */
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자(0/O, 1/I) 제외
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * 교사: 새 수업방 만들기
 * app     : CARE_APPS의 키
 * mode    : 'class' 반 전체 | 'group' 모둠별(groupSize 필요) | 'individual' 개인별
 * classes : [{name:'1반', count:24}, ...]
 */
export async function createRoom({ appType, title, mode = 'individual', classes = [], groupSize = 4 }) {
  const uid = auth.currentUser.uid;
  const type = appType || APP_TYPE();
  const roomRef = await addDoc(collection(db, `teachers/${uid}/rooms`), {
    app: type,
    track: CARE_APPS[type]?.track || TRACK(),
    title, mode, classes, groupSize,
    isOpen: true,
    createdAt: serverTimestamp(),
  });

  let code = genCode();
  await runTransaction(db, async (tx) => {
    let ref = doc(db, 'roomCodes', code);
    let snap = await tx.get(ref);
    let tries = 0;
    while (snap.exists() && tries < 5) {
      code = genCode();
      ref = doc(db, 'roomCodes', code);
      snap = await tx.get(ref);
      tries++;
    }
    tx.set(ref, { teacherUid: uid, roomId: roomRef.id, app: type });
  });

  await updateDoc(roomRef, { code });
  return { roomId: roomRef.id, code };
}

export async function toggleRoomOpen(roomId, isOpen) {
  const uid = auth.currentUser.uid;
  await updateDoc(doc(db, `teachers/${uid}/rooms/${roomId}`), { isOpen });
}

/** appType을 주면 그 앱의 방만, 안 주면 스튜디오 7개 앱의 방을 모두 가져옵니다. */
export async function listMyRooms(appType = null) {
  const uid = auth.currentUser.uid;
  const col = collection(db, `teachers/${uid}/rooms`);
  const snap = appType
    ? await getDocs(query(col, where('app', '==', appType)))
    : await getDocs(col);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => !appType ? !!CARE_APPS[r.app] : true)
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

export async function resolveRoomByCode(code) {
  const snap = await getDoc(doc(db, 'roomCodes', String(code).toUpperCase()));
  if (!snap.exists()) return null;
  const { teacherUid, roomId } = snap.data();
  const roomSnap = await getDoc(doc(db, `teachers/${teacherUid}/rooms/${roomId}`));
  if (!roomSnap.exists()) return null;
  const data = roomSnap.data();
  if (!data.isOpen) return { closed: true };
  return { teacherUid, roomId, ...data };
}

export async function joinRoom({ teacherUid, roomId, className, number, name }) {
  await studentEnter();
  const room = (await getDoc(doc(db, `teachers/${teacherUid}/rooms/${roomId}`))).data();
  let group = null;
  if (room.mode === 'group' && room.groupSize) group = Math.ceil(Number(number) / room.groupSize);
  const studentId = auth.currentUser.uid;
  await setDoc(doc(db, `teachers/${teacherUid}/rooms/${roomId}/students/${studentId}`), {
    className: className || null, number: number || null, group,
    name: name || null, app: APP_TYPE(), joinedAt: serverTimestamp(),
  }, { merge: true });
  return { studentId, group };
}

/* ════════ 학생 결과물 저장 ════════
   마음 트랙 → reflections (행발 참고용, 세특 아님)
   한국어 트랙 → koreanProgress (개인 진도)
   ⚠️ 두 컬렉션 모두 사회플랫폼의 submissions와 완전히 분리되어 있습니다.  */
export async function saveWork({ kind, title, content, extra = {} }) {
  const s = window.EAIM_STUDENT;
  if (!s) return null;                       // 수업방 없이 혼자 써볼 때는 저장 안 함
  const studentId = auth.currentUser?.uid;
  if (!studentId) return null;
  const ref = await addDoc(
    collection(db, `teachers/${s.teacherUid}/rooms/${s.roomId}/${WORK_COL()}`),
    {
      studentId,
      className: s.className || null,
      number: s.number || null,
      group: s.group ?? null,
      name: s.name || null,
      app: APP_TYPE(), track: TRACK(),
      kind, title, content, ...extra,
      createdAt: serverTimestamp(),
    }
  );
  return ref.id;
}

/** 교사: 방의 결과물 모두 가져오기 */
export async function listWorks(roomId, track = null) {
  const uid = auth.currentUser.uid;
  const col = (track === 'korean' || (!track && TRACK() === 'korean')) ? 'koreanProgress' : 'reflections';
  const snap = await getDocs(query(
    collection(db, `teachers/${uid}/rooms/${roomId}/${col}`),
    orderBy('createdAt', 'asc')
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function listStudents(roomId) {
  const uid = auth.currentUser.uid;
  const snap = await getDocs(collection(db, `teachers/${uid}/rooms/${roomId}/students`));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ══════════════════════════════════════════════════════════
   지난 기록 찾기 (다음 시간에 이어서 할 때)

   ⚠️ 학생은 익명 로그인이라 브라우저를 닫으면 studentId가 바뀝니다.
      그래서 지난 시간 기록은 uid가 아니라 반+번호로 찾습니다.
      (Firestore는 같음(==) 조건 여러 개는 색인 없이도 됩니다.
       orderBy를 붙이면 복합 색인이 필요해지므로 정렬은 여기서 합니다.)
   ══════════════════════════════════════════════════════════ */
export async function findMyPastWorks() {
  const s = window.EAIM_STUDENT;
  if (!s) return [];
  const filters = [where('number', '==', s.number)];
  if (s.className) filters.push(where('className', '==', s.className));
  const snap = await getDocs(query(
    collection(db, `teachers/${s.teacherUid}/rooms/${s.roomId}/${WORK_COL()}`),
    ...filters
  ));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(w => w.app === APP_TYPE())
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

/** 학생: 지난 기록에 결과를 덧붙이기 (예: 실천했는지 표시) */
export async function updateMyWork(workId, patch) {
  const s = window.EAIM_STUDENT;
  if (!s) return;
  await updateDoc(
    doc(db, `teachers/${s.teacherUid}/rooms/${s.roomId}/${WORK_COL()}/${workId}`),
    { ...patch, updatedAt: serverTimestamp() }
  );
}

/* ══════════════════════════════════════════════════════════
   실시간 피드백

   학생이 보낸 글은 koreanProgress 문서 한 개로 쌓이고,
   선생님 답장은 그 문서에 필드로 붙습니다.
     { ...학생 글..., feedback: '...', feedbackAt: ts, feedbackBy: 'teacher'|'ai-edited' }

   학생이 고쳐서 다시 보내면 새 문서가 하나 더 생기므로,
   시간 순으로 보면 주고받은 기록이 그대로 남습니다.

   ⚠️ 마음 트랙에서는 '마이 바이브 런웨이'만 이 기능을 씁니다.
      옷·음악 기획이라 되물을수록 좋아지는 글이기 때문입니다.
      가족·가치·감정을 다루는 나머지 앱은 답장을 돌려주지 않습니다.
   ══════════════════════════════════════════════════════════ */

/** 교사: 방에 들어오는 학생 글을 실시간으로 받기 (수업 중 화면용) */
export function listenWorks(roomId, cb, track = 'korean') {
  const uid = auth.currentUser.uid;
  const col = track === 'korean' ? 'koreanProgress' : 'reflections';
  const q = query(
    collection(db, `teachers/${uid}/rooms/${roomId}/${col}`),
    orderBy('createdAt', 'asc')
  );
  return onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

/** 교사: 글 하나에 답장 달기 */
export async function sendFeedback(roomId, workId, text, source = 'teacher', track = 'korean') {
  const uid = auth.currentUser.uid;
  const col = track === 'korean' ? 'koreanProgress' : 'reflections';
  await updateDoc(doc(db, `teachers/${uid}/rooms/${roomId}/${col}/${workId}`), {
    feedback: text,
    feedbackBy: source,
    feedbackAt: serverTimestamp(),
  });
}

/** 학생: 내가 보낸 글과 거기 달린 답장을 실시간으로 받기 */
export function listenMyWorks(cb) {
  const s = window.EAIM_STUDENT;
  const studentId = auth.currentUser?.uid;
  if (!s || !studentId) return () => {};
  const q = query(
    collection(db, `teachers/${s.teacherUid}/rooms/${s.roomId}/koreanProgress`),
    where('studentId', '==', studentId)
  );
  return onSnapshot(q, (snap) => {
    const rows = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    cb(rows);
  });
}

/* ══════════════════════════════════════════════════════════
   단체 게임 — "우리 반은 어떻게 느꼈을까"

   ⚠️ 경로를 얕게 유지합니다. 기존 Firestore 규칙이
      teachers/{uid}/rooms/{roomId}/{하위컬렉션}/{문서} 딱 2단계까지만
      열려 있기 때문에, 답안은 방 바로 아래 평평한 컬렉션에 둡니다.

     teachers/{uid}/rooms/{roomId}/liveGame/current
       { items, currentIndex:-1, status:'lobby'|'question'|'reveal'|'ended', sessionId }
     teachers/{uid}/rooms/{roomId}/liveGameAnswers/{sessionId}_{studentId}_{qIndex}
       { feel, guess, correct, points, ...학생정보 }

   점수는 '내 감정'이 아니라 '우리 반이 뭘 골랐을지 맞히기'에만 붙습니다.
   내가 느낀 감정은 맞고 틀리고가 없습니다.
   ══════════════════════════════════════════════════════════ */

export async function createLiveGame({ roomId, items }) {
  const uid = auth.currentUser.uid;
  const sessionId = String(Date.now());
  await setDoc(doc(db, `teachers/${uid}/rooms/${roomId}/liveGame/current`), {
    items, currentIndex: -1, status: 'lobby', sessionId, createdAt: serverTimestamp(),
  });
  return sessionId;
}

export function listenLiveGame(teacherUid, roomId, cb) {
  return onSnapshot(
    doc(db, `teachers/${teacherUid}/rooms/${roomId}/liveGame/current`),
    snap => cb(snap.exists() ? snap.data() : null)
  );
}

export async function setLiveGameState(roomId, patch) {
  const uid = auth.currentUser.uid;
  await updateDoc(doc(db, `teachers/${uid}/rooms/${roomId}/liveGame/current`), patch);
}

export async function submitGameAnswer({ qIndex, sessionId, feel, guess }) {
  const s = window.EAIM_STUDENT;
  const studentId = auth.currentUser?.uid;
  if (!s || !studentId) return;
  await setDoc(
    doc(db, `teachers/${s.teacherUid}/rooms/${s.roomId}/liveGameAnswers/${sessionId}_${studentId}_${qIndex}`),
    {
      sessionId, studentId, qIndex, feel, guess,
      className: s.className || null, number: s.number || null, name: s.name || null,
      createdAt: serverTimestamp(),
    }
  );
}

export function listenGameAnswers(teacherUid, roomId, sessionId, qIndex, cb) {
  const q = query(
    collection(db, `teachers/${teacherUid}/rooms/${roomId}/liveGameAnswers`),
    where('sessionId', '==', sessionId), where('qIndex', '==', qIndex)
  );
  return onSnapshot(q, snap => cb(snap.docs.map(d => d.data())));
}

export async function getGameAnswers(teacherUid, roomId, sessionId) {
  const q = query(
    collection(db, `teachers/${teacherUid}/rooms/${roomId}/liveGameAnswers`),
    where('sessionId', '==', sessionId)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data());
}

/** 가장 많이 나온 감정 (동률이면 여러 개) */
export function topFeelings(answers) {
  const c = {};
  answers.forEach(a => { if (a.feel) c[a.feel] = (c[a.feel] || 0) + 1; });
  const max = Math.max(0, ...Object.values(c));
  return { counts: c, top: Object.keys(c).filter(k => c[k] === max), max };
}

/* ════════ QR / 입장 링크 ════════ */
export function qrImageUrl(link, size = 260) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(link)}`;
}

export function studentLink(code, appType, baseUrl = location.origin + location.pathname.replace(/[^/]+$/, '')) {
  const file = CARE_APPS[appType]?.file || 'index.html';
  return `${baseUrl}${encodeURI(file)}?code=${code}`;
}

/* ══════════════════════════════════════════════════════════
   학생 입장 게이트
   앱 HTML에 <script type="module">로 이 파일을 불러온 뒤
   mountStudentGate()만 호출하면 됩니다.

   - URL에 ?code=XXXXXX 가 없으면 아무것도 안 하고 그냥 앱이 열립니다
     (선생님이 혼자 미리 볼 때 / 수업방 없이 쓸 때).
   - 코드가 있으면 반·번호·이름을 묻는 화면을 덮어씌우고,
     입장하면 window.EAIM_STUDENT 를 채운 뒤 화면을 걷어냅니다.
   ══════════════════════════════════════════════════════════ */
export async function mountStudentGate({ onReady } = {}) {
  const code = new URLSearchParams(location.search).get('code');
  if (!code) { onReady?.(null); return null; }

  const room = await resolveRoomByCode(code);

  const wrap = document.createElement('div');
  wrap.id = 'eaim-gate';
  wrap.innerHTML = `
    <style>
      #eaim-gate{position:fixed;inset:0;z-index:99999;background:#f7f5f2;
        display:flex;align-items:center;justify-content:center;padding:20px;
        font-family:'Pretendard','Malgun Gothic',sans-serif;color:#2b2b2b}
      #eaim-gate .card{background:#fff;border-radius:22px;padding:32px 26px;width:100%;max-width:380px;
        box-shadow:0 18px 40px rgba(0,0,0,.10)}
      #eaim-gate h2{margin:0 0 6px;font-size:1.35rem}
      #eaim-gate .room{color:#666;font-size:.92rem;margin:0 0 22px}
      #eaim-gate label{display:block;font-weight:700;font-size:.88rem;margin:14px 0 6px}
      #eaim-gate input{width:100%;padding:13px 14px;border:2px solid #e3ded7;border-radius:12px;
        font-size:1.05rem;box-sizing:border-box;background:#fff}
      #eaim-gate input:focus{outline:none;border-color:#2f9e8f}
      #eaim-gate button{width:100%;margin-top:22px;padding:15px;border:0;border-radius:12px;
        background:#2f9e8f;color:#fff;font-size:1.05rem;font-weight:700;cursor:pointer}
      #eaim-gate button:disabled{background:#b9c4c2;cursor:default}
      #eaim-gate .err{color:#c0392b;font-size:.88rem;margin-top:12px;min-height:1.2em}
      #eaim-gate .row{display:flex;gap:10px}
      #eaim-gate .row>div{flex:1}
    </style>
    <div class="card">
      <h2>수업방 들어가기</h2>
      <p class="room"></p>
      <div class="row">
        <div><label for="eg-class">반</label><input id="eg-class" inputmode="numeric" placeholder="1"></div>
        <div><label for="eg-num">번호</label><input id="eg-num" inputmode="numeric" placeholder="7"></div>
      </div>
      <label for="eg-name">이름</label>
      <input id="eg-name" placeholder="이름을 써주세요">
      <button id="eg-go">들어가기</button>
      <p class="err" id="eg-err"></p>
    </div>`;
  document.body.appendChild(wrap);

  const err = wrap.querySelector('#eg-err');
  const btn = wrap.querySelector('#eg-go');
  const roomLine = wrap.querySelector('.room');

  if (!room) {
    roomLine.textContent = '이 코드에 맞는 수업방이 없어요. 선생님께 코드를 다시 확인해 주세요.';
    btn.disabled = true;
    return null;
  }
  if (room.closed) {
    roomLine.textContent = '아직 수업방이 열려 있지 않아요. 선생님이 열어주실 때까지 기다려 주세요.';
    btn.disabled = true;
    return null;
  }
  roomLine.textContent = room.title || '수업방';

  return new Promise((resolve) => {
    btn.addEventListener('click', async () => {
      const className = wrap.querySelector('#eg-class').value.trim();
      const number = wrap.querySelector('#eg-num').value.trim();
      const name = wrap.querySelector('#eg-name').value.trim();
      if (!number) { err.textContent = '번호를 써주세요.'; return; }
      btn.disabled = true; btn.textContent = '들어가는 중...';
      try {
        const { group } = await joinRoom({
          teacherUid: room.teacherUid, roomId: room.roomId,
          className: className ? `${className}반` : null, number, name,
        });
        window.EAIM_STUDENT = {
          teacherUid: room.teacherUid, roomId: room.roomId,
          className: className ? `${className}반` : null, number, name, group,
          roomTitle: room.title || '', mode: room.mode,
        };
        wrap.remove();
        onReady?.(window.EAIM_STUDENT);
        resolve(window.EAIM_STUDENT);
      } catch (e) {
        console.error(e);
        err.textContent = '입장하지 못했어요. 다시 눌러주세요.';
        btn.disabled = false; btn.textContent = '들어가기';
      }
    });
  });
}

/** 저장 성공/실패를 화면 아래에 잠깐 띄우는 공용 토스트 */
export function toast(msg, ok = true) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99998;
    background:${ok ? '#2f9e8f' : '#c0392b'};color:#fff;padding:13px 22px;border-radius:999px;
    font-family:'Pretendard','Malgun Gothic',sans-serif;font-weight:700;font-size:.95rem;
    box-shadow:0 8px 22px rgba(0,0,0,.18)`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}
