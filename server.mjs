// Fillow 매니페스트 빌더 - 로컬 서버 (설치할 것 없음: node server.mjs)
//
// ★ 에셋 흐름 ★
//   1) 시뮬레이터에서 [검수 완료]  → fillow_simulator/assets/approved/ 로 옮겨지고,
//                                    같은 파일이 여기 inbox/ 로 복사된다 (같은 하위 경로)
//   2) 빌더에서 [받은 에셋]을 열어 매니페스트를 다듬고 [저장]   → inbox/ 의 파일을 고친다
//   3) [다이어리에 추가]           → fillow_diary/public/asset/<같은 하위 경로>/ 로 복사하고
//                                    build-inventory 를 돌린 뒤, 빌더 쪽 파일은 done/ 으로 옮긴다
//
// index.html은 서버 없이 더블클릭으로 열어도 예전처럼 동작한다 (받은 에셋/다이어리 버튼만 빠진다).
//
// ★ id · 분류 ★ 기준은 다이어리의 src/data/taxonomy.js 하나다. 빌더 화면은 /api/taxonomy 로 받아 쓴다.
//   /api/next-id 는 다이어리 · 빌더(inbox/done) · 시뮬레이터(approved/pending)를 모두 훑어 다음 번호를 준다.
//
// 옵션:  --port 5181   --diary <경로>   --sim <경로>   --no-open
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const PORT = Number(arg('port', 5181));
const DIARY = path.resolve(HERE, arg('diary', process.env.FILLOW_DIARY || '../fillow_diary'));
const DIARY_ASSET = path.join(DIARY, 'public', 'asset');
const SIM_ASSETS = path.join(path.resolve(HERE, arg('sim', process.env.FILLOW_SIM || '../fillow_simulator')), 'assets');

/** 분류 어휘 목록 (다이어리 src/data/taxonomy.js) - 못 읽으면 null (분류 없이도 빌더는 동작한다) */
let TAXO = null;
try {
  TAXO = await import(pathToFileURL(path.join(DIARY, 'src', 'data', 'taxonomy.js')).href);
} catch (err) {
  console.warn(`  ⚠ 분류 목록을 못 읽음 (${err.message}) - type 선택·id 자동 번호 없이 동작`);
}

/** 빌더가 관리하는 두 폴더 - inbox = 받은 것(편집 중), done = 다이어리에 넣은 것 */
const ROOTS = { inbox: path.join(HERE, 'inbox'), done: path.join(HERE, 'done') };
Object.values(ROOTS).forEach((d) => fs.mkdirSync(d, { recursive: true }));

const IMAGE_EXT = new Set(['.png', '.webp']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp',
};

const toPosix = (p) => p.split(path.sep).join('/');
function safeJoin(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const sameBytes = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));

/** 그림 하나에 딸린 파일 묶음 (그림 · 매니페스트 · 뒷모습) */
function bundleOf(img) {
  const json = img.replace(/\.[^.]+$/, '.json');
  const m = fs.existsSync(json) ? readJson(json) : null;
  const backName = typeof m?.back === 'string' ? m.back : path.basename(img).replace(/(\.[^.]+)$/, '_back$1');
  const back = path.join(path.dirname(img), backName);
  return { img, json, back, manifest: m, files: [img, json, back].filter((f) => fs.existsSync(f)) };
}

/** 폴더 안 에셋 목록 - 뒷모습 그림은 따로 세지 않는다 */
function listRoot(root) {
  const dir = ROOTS[root];
  const images = walk(dir).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  const bundles = images.map(bundleOf);
  const backs = new Set(bundles.filter((b) => fs.existsSync(b.back)).map((b) => b.back));
  return bundles.filter((b) => !backs.has(b.img) || !bundles.some((o) => o.img !== b.img && o.back === b.img))
    .map((b) => {
      const rel = toPosix(path.relative(dir, b.img));
      const v = Math.round(fs.statSync(b.img).mtimeMs);
      const url = (f) => `/api/file/${root}/${toPosix(path.relative(dir, f)).split('/').map(encodeURIComponent).join('/')}?v=${v}`;
      return {
        root, rel, id: b.manifest?.id ?? null, manifest: b.manifest,
        image: url(b.img), json: fs.existsSync(b.json) ? url(b.json) : null, back: fs.existsSync(b.back) ? url(b.back) : null,
      };
    });
}

/** 다이어리 에셋 id → 매니페스트 경로 */
function diaryIndex() {
  const map = new Map();
  walk(DIARY_ASSET).filter((f) => f.endsWith('.json')).forEach((f) => {
    const m = readJson(f);
    if (m?.id) map.set(String(m.id), f);
  });
  return map;
}

/**
 * 겹친 id 대신 쓸 다음 id.
 *   규칙 id(fur-chair-00012)  → 같은 카테고리의 다음 번호 (fur-chair-00178)
 *   옛 id(furniture-chair-01) → 끝 번호만 올린다 (furniture-chair-13)
 */
function nextFreeId(id, taken) {
  const p = TAXO?.parseAssetId(id);
  if (p) return TAXO.formatAssetId(p.category, p.slug, TAXO.nextSerial(p.category, allIds()));
  const m = /^(.*?)(\d+)$/.exec(id);
  const prefix = m ? m[1] : `${id}-`;
  const width = m ? m[2].length : 2;
  let max = 0;
  taken.forEach((t) => {
    if (!t.startsWith(prefix)) return;
    const n = Number(t.slice(prefix.length));
    if (Number.isInteger(n)) max = Math.max(max, n);
  });
  return prefix + String(max + 1).padStart(width, '0');
}
function takenIds() {
  const ids = new Set(diaryIndex().keys());
  Object.keys(ROOTS).forEach((r) => listRoot(r).forEach((it) => it.id && ids.add(it.id)));
  return ids;
}
/** 번호 매길 때 볼 전체 id - 다이어리 · 빌더 · 시뮬레이터 */
function allIds() {
  const ids = takenIds();
  walk(SIM_ASSETS).filter((f) => f.endsWith('.json')).forEach((f) => { const m = readJson(f); if (m?.id) ids.add(String(m.id)); });
  return ids;
}

function list() {
  const diary = diaryIndex();
  const items = [...listRoot('inbox'), ...listRoot('done')].map((it) => {
    const inDiary = it.id ? diary.get(it.id) : null;
    // 같은 id가 다이어리에 있는데, 거기 그림이 이 그림과 다르면 "다른 에셋과 id 겹침"
    let conflict = false;
    if (inDiary && it.root === 'inbox') {
      const diaryImg = inDiary.replace(/\.json$/, '.png');
      conflict = !sameBytes(diaryImg, safeJoin(ROOTS[it.root], it.rel));
    }
    return { ...it, inDiary: inDiary ? toPosix(path.relative(DIARY, inDiary)) : null, conflict };
  });
  return { diary: { dir: DIARY, exists: fs.existsSync(DIARY_ASSET) }, items };
}

function runInventory() {
  return new Promise((resolve) => {
    execFile(process.execPath, ['scripts/build-inventory.mjs'], { cwd: DIARY, timeout: 60000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, log: out.split(/\r?\n/).slice(-30).join('\n') });
    });
  });
}

function removeEmptyDirs(start, root) {
  let d = start;
  while (d.startsWith(root + path.sep) && fs.existsSync(d) && fs.readdirSync(d).length === 0) {
    fs.rmdirSync(d); d = path.dirname(d);
  }
}

// ───────────────────────── 저장 (빌더에서 고친 것 → inbox/done 같은 자리) ─────────────────────────
function save({ root, rel, base, files }) {
  if (!ROOTS[root]) throw new Error('저장 위치가 잘못됨');
  const img = safeJoin(ROOTS[root], rel);
  if (!img) throw new Error('잘못된 경로');
  if (!/^[\w.-]+$/.test(base || '')) throw new Error(`파일명에 쓸 수 없는 글자가 있음: ${base}`);
  const dir = path.dirname(img);
  const old = fs.existsSync(img) ? bundleOf(img) : null;
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  files.forEach(({ name, data }) => {
    if (!name.startsWith(base) || !/^[\w.-]+$/.test(name)) throw new Error(`파일명이 잘못됨: ${name}`);
    const full = path.join(dir, name);
    fs.writeFileSync(full, Buffer.from(data, 'base64'));
    written.push(full);
  });
  // 파일명을 바꿨거나 뒷모습을 뺐으면 예전 파일은 지운다
  old?.files.filter((f) => !written.includes(f)).forEach((f) => fs.unlinkSync(f));
  return { rel: toPosix(path.relative(ROOTS[root], path.join(dir, `${base}${path.extname(img) || '.png'}`))) };
}

// ───────────────────────── 다이어리에 추가 ─────────────────────────
async function exportToDiary({ root, rel, replace = false }) {
  if (!fs.existsSync(DIARY_ASSET)) throw Object.assign(new Error(`다이어리 폴더를 찾지 못함: ${DIARY_ASSET}`), { code: 'no-diary' });
  const img = ROOTS[root] && safeJoin(ROOTS[root], rel);
  if (!img || !fs.existsSync(img)) throw new Error(`파일이 없음: ${rel}`);
  const b = bundleOf(img);
  if (!b.manifest?.id) throw new Error('매니페스트(.json)가 없거나 id가 없음 - 빌더에서 먼저 저장하세요');
  const id = String(b.manifest.id);
  const targetDir = safeJoin(DIARY_ASSET, path.dirname(rel));
  const targets = b.files.map((f) => [f, path.join(targetDir, path.basename(f))]);

  const existing = diaryIndex().get(id);
  if (existing) {
    const exImg = existing.replace(/\.json$/, '.png');
    if (sameBytes(exImg, img) && sameBytes(existing, b.json)) {
      throw Object.assign(new Error(`이미 다이어리에 똑같이 들어 있음: ${toPosix(path.relative(DIARY, existing))}`), { code: 'same' });
    }
    if (!replace) {
      throw Object.assign(new Error(`다이어리에 같은 id(${id})의 다른 에셋이 있음: ${toPosix(path.relative(DIARY, existing))}`), {
        code: 'id-exists', existing: toPosix(path.relative(DIARY, existing)), suggestId: nextFreeId(id, takenIds()),
      });
    }
    // 교체: 다이어리 /asset/** 는 1년 immutable 캐시 - 같은 파일명으로 덮으면 기존 유저에게 안 보인다
    const exBundle = bundleOf(exImg);
    // 그림이 바뀌었는데 파일명이 같으면 막는다 (매니페스트만 고친 경우는 같은 파일명이어도 된다)
    const clash = targets.find(([src, dst]) => /\.(png|webp)$/i.test(dst)
      && exBundle.files.some((f) => path.basename(f) === path.basename(dst) && !sameBytes(f, src)));
    if (clash) {
      throw Object.assign(new Error(`교체하려면 그림 파일명을 바꿔야 함 (캐시 때문): ${path.basename(clash[1])} → [_v2] 버튼`), { code: 'same-filename' });
    }
    exBundle.files.forEach((f) => fs.unlinkSync(f));
    removeEmptyDirs(path.dirname(exImg), DIARY_ASSET);
  }
  const busy = targets.find(([, dst]) => fs.existsSync(dst));
  if (busy) throw Object.assign(new Error(`다이어리에 같은 파일명이 이미 있음: ${toPosix(path.relative(DIARY, busy[1]))}`), { code: 'file-exists' });

  fs.mkdirSync(targetDir, { recursive: true });
  targets.forEach(([src, dst]) => fs.copyFileSync(src, dst));
  const inventory = await runInventory();

  // 빌더 쪽은 done/ 으로 (이미 done이면 그대로)
  if (root === 'inbox') {
    b.files.forEach((src) => {
      const dst = path.join(ROOTS.done, path.relative(ROOTS.inbox, src));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (fs.existsSync(dst)) fs.unlinkSync(dst);
      fs.renameSync(src, dst);
    });
    removeEmptyDirs(path.dirname(img), ROOTS.inbox);
  }
  return {
    id, replaced: Boolean(existing),
    copied: targets.map(([, dst]) => toPosix(path.relative(DIARY, dst))),
    inventory,
  };
}

// ───────────────────────── 서버 ─────────────────────────
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function sendFile(res, full) {
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
}
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (p === '/' || p === '/index.html') { sendFile(res, path.join(HERE, 'index.html')); return; }
    if (p === '/api/list') { sendJson(res, 200, list()); return; }
    if (p.startsWith('/api/file/')) {
      const [root, ...rest] = p.slice('/api/file/'.length).split('/');
      sendFile(res, ROOTS[root] && safeJoin(ROOTS[root], rest.join('/')));
      return;
    }
    if (p === '/api/save' && req.method === 'POST') { sendJson(res, 200, { ok: true, ...save(await readBody(req)) }); return; }
    if (p === '/api/export' && req.method === 'POST') { sendJson(res, 200, { ok: true, ...(await exportToDiary(await readBody(req))) }); return; }
    if (p === '/api/taxonomy') {
      if (!TAXO) { sendJson(res, 200, { ok: false }); return; }
      sendJson(res, 200, { ok: true, categoryCodes: TAXO.CATEGORY_CODES, digits: TAXO.SERIAL_DIGITS, groups: TAXO.GROUPS, tags: TAXO.TAGS });
      return;
    }
    if (p === '/api/next-id' && req.method === 'POST') {
      if (!TAXO) throw new Error('분류 목록(taxonomy.js)을 못 읽어 자동 번호를 줄 수 없음');
      const { category, slug, current } = await readBody(req);
      const ids = allIds();
      if (current) ids.delete(String(current)); // 지금 고치는 에셋 자신의 번호는 빼고 센다
      sendJson(res, 200, { ok: true, id: TAXO.formatAssetId(category, slug, TAXO.nextSerial(category, ids)) });
      return;
    }
    if (p === '/api/suggest-id' && req.method === 'POST') {
      const { id } = await readBody(req);
      sendJson(res, 200, { ok: true, id: nextFreeId(String(id || 'item-01'), takenIds()) });
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message, code: err.code, existing: err.existing, suggestId: err.suggestId });
  }
});

function listen(port, tries = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 10) listen(port + 1, tries + 1);
    else { console.error(err); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  fillow 매니페스트 빌더  →  ${url}\n`);
    console.log(`  받은 에셋   ${ROOTS.inbox}`);
    console.log(`  넣은 에셋   ${ROOTS.done}`);
    console.log(`  다이어리    ${DIARY_ASSET}${fs.existsSync(DIARY_ASSET) ? '' : '  (⚠ 찾지 못함 - --diary <경로>)'}`);
    console.log(`  시뮬레이터  ${SIM_ASSETS}${fs.existsSync(SIM_ASSETS) ? '' : '  (⚠ 찾지 못함 - --sim <경로>, 번호 계산에서 빠짐)'}\n`);
    if (!args.includes('--no-open')) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
      exec(cmd, () => {});
    }
  });
}
listen(PORT);
