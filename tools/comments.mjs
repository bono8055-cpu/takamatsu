// Firestore에 쌓인 가족 의견을 읽어 일정 라벨을 붙여 출력하는 CLI (읽기 전용)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = join(here, '..', 'index.html');
const STATE = join(here, '.comments-state.json');

function die(msg){ console.error('오류: ' + msg); process.exit(1); }

/* index.html 을 단일 출처로 삼는다 — 설정과 일정을 스크립트에 복사하면 반드시 어긋난다. */
function loadFromHtml(){
  if(!existsSync(HTML)) die(`index.html 을 찾을 수 없다: ${HTML}`);
  const s = readFileSync(HTML, 'utf8');

  const cfgM = /const FIREBASE_CONFIG = (\{[\s\S]*?\});/.exec(s);
  if(!cfgM) die('index.html 에서 FIREBASE_CONFIG 를 찾지 못했다. 구조가 바뀌었는지 확인해라.');
  const cfg = new Function(`return ${cfgM[1]};`)();
  if(!cfg.projectId || !cfg.apiKey) die('FIREBASE_CONFIG 에 projectId 또는 apiKey 가 비어 있다.');

  const a = s.indexOf('const P = {'), b = s.indexOf('const PH=[');
  if(a < 0 || b < 0 || b <= a) die('index.html 에서 DAYS 블록 경계를 찾지 못했다. 구조가 바뀌었는지 확인해라.');
  const { DAYS } = new Function(`${s.slice(a, b)}\nreturn { DAYS };`)();
  if(!Array.isArray(DAYS) || !DAYS.length) die('DAYS 파싱 결과가 비어 있다.');

  return { cfg, DAYS };
}

const label = (DAYS, stop) => {
  if(stop === 'board') return '[요청] 탭';
  const m = /^d(\d+)s(\d+)$/.exec(stop || '');
  if(!m) return stop || '(위치 불명)';
  const d = DAYS[+m[1]], o = d && d.stops[+m[2]];
  return o ? `${d.tab} · ${o.t} ${o.h}` : stop;
};

async function signIn(apiKey){
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method:'POST', headers:{'content-type':'application/json'}, body:'{"returnSecureToken":true}' });
  const j = await r.json().catch(()=>({}));
  if(!r.ok || !j.idToken) die(`익명 로그인 실패 (${r.status}). Firebase 콘솔에서 익명 로그인이 켜져 있는지 확인해라. ${JSON.stringify(j).slice(0,200)}`);
  return j.idToken;
}

const plain = f => {
  const v = Object.values(f)[0];
  return f.integerValue !== undefined ? Number(f.integerValue)
       : f.doubleValue  !== undefined ? Number(f.doubleValue)
       : v;
};

async function fetchAll(projectId, token, col){
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${col}`;
  const out = [];
  let page = '';
  do {
    const r = await fetch(`${base}?pageSize=300${page ? `&pageToken=${page}` : ''}`,
      { headers:{ authorization:`Bearer ${token}` } });
    if(!r.ok) die(`${col} 조회 실패 (${r.status}). ${(await r.text()).slice(0,200)}`);
    const j = await r.json();
    for(const d of j.documents || []){
      const o = { id: d.name.split('/').pop() };
      for(const [k,v] of Object.entries(d.fields || {})) o[k] = plain(v);
      out.push(o);
    }
    page = j.nextPageToken || '';
  } while(page);
  return out;
}

const fmt = ts => {
  const d = new Date(ts), p = n => String(n).padStart(2,'0');
  return `${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const all = process.argv.includes('--all');
const { cfg, DAYS } = loadFromHtml();
const token = await signIn(cfg.apiKey);
const comments = (await fetchAll(cfg.projectId, token, 'comments')).sort((x,y) => (x.at||0) - (y.at||0));

const seen = existsSync(STATE) ? (JSON.parse(readFileSync(STATE,'utf8')).lastAt || 0) : 0;
const fresh = comments.filter(c => (c.at||0) > seen);
const show = all ? comments : fresh;

console.log(`전체 ${comments.length}건 · 새 의견 ${fresh.length}건` + (all ? ' · 전체 출력' : (seen ? ` (마지막 확인 ${fmt(seen)} 이후)` : ' (첫 실행이라 전부 새 의견)')));
console.log('');
if(!show.length){
  console.log(all ? '남겨진 의견이 없다.' : '새 의견 없음.');
} else {
  for(const c of show){
    console.log(`${(c.at||0) > seen ? '[NEW] ' : '      '}${fmt(c.at)}  ${c.by || '이름없음'} — ${label(DAYS, c.stop)}`);
    console.log(`        ${String(c.text || '').replace(/\n/g, '\n        ')}`);
    console.log('');
  }
}

if(comments.length) writeFileSync(STATE, JSON.stringify({ lastAt: Math.max(seen, ...comments.map(c => c.at || 0)) }) + '\n');
