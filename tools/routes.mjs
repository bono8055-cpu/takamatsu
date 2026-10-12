// 동선 지도의 선을 실제 도로 경로로 다시 그리는 CLI
// 사용: node tools/routes.mjs          → 보이는 날(alt 제외)의 모든 선을 다시 그려 index.html 에 쓴다
//       node tools/routes.mjs --dry    → 쓰지 않고 거리 · 점 개수만 보여준다
//       node tools/routes.mjs --all    → 숨긴 안(alt:1)까지 포함한다
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = join(here, '..', 'index.html');
const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');
const MOCK = process.env.ROUTES_MOCK === '1';   // 네트워크 없이 치환 로직만 시험할 때

function die(msg){ console.error('오류: ' + msg); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 차는 자동차 경로, 'w'(도보)는 보행자 경로, 's'(무료 셔틀)는 차 경로로 받는다 */
const SERVERS = {
  car:  ['https://routing.openstreetmap.de/routed-car/route/v1/driving/', 'https://router.project-osrm.org/route/v1/driving/'],
  foot: ['https://routing.openstreetmap.de/routed-foot/route/v1/driving/'],
};

/* 특정 길을 꼭 지나야 하는 구간만 경유점을 둔다. 키: "탭|출발 이름|도착 이름", 값: [[lat,lng],...] */
const VIA = {
  // 일정 문구가 '아케이드를 지나'라고 안내하는 도보 구간은 마루가메마치 아케이드를 거치게 한다
  '16(금)|에너지 스탠드|숙소': [[34.34204, 134.04783]],
  '17(토)|숙소|미라쿠': [[34.34204, 134.04783]],
  '17(토)|미라쿠|숙소': [[34.34204, 134.04783]],
};

function loadHtml(){
  if(!existsSync(HTML)) die(`index.html 을 찾을 수 없다: ${HTML}`);
  const s = readFileSync(HTML, 'utf8');
  const a = s.indexOf('const P = {'), b = s.indexOf('const PH=[');
  if(a < 0 || b < 0 || b <= a) die('index.html 에서 DAYS 블록 경계를 찾지 못했다. 구조가 바뀌었는지 확인해라.');
  const { DAYS } = new Function(`${s.slice(a, b)}\nreturn { DAYS };`)();
  if(!Array.isArray(DAYS) || !DAYS.length) die('DAYS 파싱 결과가 비어 있다.');
  return { s, DAYS };
}

/* 미터 단위 Douglas-Peucker. 1m 이하로 휘는 점만 버려서 최대로 확대해도 길에서 벗어나지 않는다 */
function simplify(pts, tol = 1){
  if(pts.length < 3) return pts;
  const k = 111320, kx = k * Math.cos(pts[0][0] * Math.PI / 180);
  const xy = pts.map(([la, ln]) => [ln * kx, la * k]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while(st.length){
    const [i, j] = st.pop(); let md = 0, mi = -1;
    const [x1, y1] = xy[i], [x2, y2] = xy[j], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1e-9;
    for(let m = i + 1; m < j; m++){
      const d = Math.abs(dy * (xy[m][0] - x1) - dx * (xy[m][1] - y1)) / L;
      if(d > md){ md = d; mi = m; }
    }
    if(md > tol){ keep[mi] = 1; st.push([i, mi], [mi, j]); }
  }
  return pts.filter((_, m) => keep[m]);
}

async function route(prof, pts){
  if(MOCK){
    const [a, b] = [pts[0], pts.at(-1)];
    return { coords: [a, [(a[0] + b[0]) / 2 + 0.0005, (a[1] + b[1]) / 2], b], km: 0, min: 0 };
  }
  const q = pts.map(([la, ln]) => `${ln},${la}`).join(';') + '?overview=full&geometries=geojson';
  let last;
  for(const base of SERVERS[prof]){
    try{
      const r = await fetch(base + q, { headers: { 'user-agent': 'takamatsu-family-trip-app/1.0' } });
      if(!r.ok){ last = `${base} → HTTP ${r.status}`; continue; }
      const j = await r.json();
      if(j.code !== 'Ok' || !j.routes?.length){ last = `${base} → ${j.code}`; continue; }
      const rt = j.routes[0];
      return { coords: rt.geometry.coordinates.map(([ln, la]) => [la, ln]), km: rt.distance / 1000, min: rt.duration / 60 };
    }catch(e){ last = `${base} → ${e.cause?.code || e.message}`; }
  }
  throw new Error(last);
}

const fmt = pts => pts.map(([la, ln]) => `[${+la.toFixed(5)},${+ln.toFixed(5)}]`).join(',');

async function main(){
  let { s, DAYS } = loadHtml();
  const tabs = [...s.matchAll(/\{tab:'([^']+)'/g)].map(m => ({ tab: m[1], at: m.index }));
  let done = 0, fail = 0;
  for(const d of DAYS){
    if(d.alt && !ALL) continue;
    if(!d.maps) continue;
    for(const m of d.maps){
      for(const [L, , mode] of m.path){
        const A = d.route[L], B = d.route[L + 1];
        if(!A?.p?.ll || !B?.p?.ll){ console.log(`- ${d.tab} ${L + 1}→${L + 2}: 좌표 없는 지점이라 건너뜀`); continue; }
        const prof = mode === 'w' ? 'foot' : 'car';
        const via = VIA[`${d.tab}|${A.n}|${B.n}`] || [];
        const label = `${d.tab} ${L + 1}→${L + 2} ${A.n} → ${B.n} (${prof === 'foot' ? '도보' : '차'})`;
        try{
          const r = await route(prof, [A.p.ll, ...via, B.p.ll]);
          /* 핀 위치에서 선이 시작·끝나도록 정확한 지점 좌표를 양 끝에 붙인다 */
          const pts = simplify([A.p.ll, ...r.coords, B.p.ll]);
          console.log(`✓ ${label}: ${r.km.toFixed(2)}km · ${Math.round(r.min)}분 · 점 ${pts.length}개`);
          /* 그날 블록 안에서만 같은 번호의 선을 찾아 바꾼다 */
          const t = tabs.findIndex(x => x.tab === d.tab);
          const from = tabs[t].at, to = t + 1 < tabs.length ? tabs[t + 1].at : s.length;
          const blk = s.slice(from, to);
          const re = new RegExp(`\\[${L},\\[(\\[[-0-9.]+,[-0-9.]+\\](?:,\\[[-0-9.]+,[-0-9.]+\\])*)\\]`);
          if(!re.test(blk)){ console.log(`  ! ${d.tab} 블록에서 ${L}번 선을 찾지 못했다`); fail++; continue; }
          s = s.slice(0, from) + blk.replace(re, `[${L},[${fmt(pts)}]`) + s.slice(to);
          // 블록 길이가 바뀌었으니 탭 위치를 다시 잡는다
          tabs.splice(0, tabs.length, ...[...s.matchAll(/\{tab:'([^']+)'/g)].map(m2 => ({ tab: m2[1], at: m2.index })));
          done++;
        }catch(e){ console.log(`✗ ${label}: ${e.message}`); fail++; }
        if(!MOCK) await sleep(1100);   // 공개 서버라 1초에 한 번만 묻는다
      }
    }
  }
  if(!DRY && done) writeFileSync(HTML, s);
  console.log(`\n${DRY ? '(시험 실행 · 저장 안 함) ' : ''}다시 그린 선 ${done}개 · 실패 ${fail}개`);
  if(fail) process.exitCode = 1;
}

main();
