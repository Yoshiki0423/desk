/* 社長の机（本番）
 * この入れ物には会社のデータを一切置かない。開いたときに、社長の鍵で GitHub の API から読む。
 *   画面のデータ … app-company の data/desk.json（Contents API）
 *   リレーの成否 … Actions API（読めなければ desk.json の値）
 *   答え済みの判定 … 各 Issue のコメントに、社長が書いた「<!-- desk:answer 依頼のid -->」があるか
 *   答える … Issue のコメントとして書き込む（社長の鍵なので、書いた人は社長になる）
 * 画面は「公開までの線表」（2026-10-20 に社長が方向を確定）。上に結論2つ（公開まで何日・止めているもの何件）、真ん中に線表、下に予定と返事待ち。
 * 止めているもの＝desk.json の requests[]。件数のリンクと線表の行の「社長」の印から、答える欄へ飛ぶ。
 */
(function (global) {
  "use strict";

  const CONFIG = {
    api: "https://api.github.com",
    owner: "Yoshiki0423",
    repo: "app-company",
    dataPath: "data/desk.json",
    workflow: "relay.yml",
    boss: "Yoshiki0423",          // 答えを書く人（社長の GitHub アカウント）
    tokenKey: "desk.token",       // 鍵を置く localStorage の名前
    perPage: 100,
    maxCommentPages: 10,          // 1つの Issue で読むコメントの上限（100件 × 10 ページ）
    runsPerPage: 20,
    branch: "main",
    imageDir: "data/desk-images", // 画像の置き場（app-company の中）。data/<日付>/<依頼id>/ の下に、時刻つきの名前で置く
    maxImages: 6,                 // 1回の答えに付けられる枚数
    maxSide: 1600,                // 送る前に縮める長い辺（px）
    jpegQuality: 0.82
  };
  const MARK_RE = /^\s*<!--\s*desk:answer\s+(\S+)\s*-->[ \t]*\r?\n?/;
  const RUN_FAIL = new Set(["failure", "timed_out", "startup_failure"]);
  const SAFE_HREF = /^(https?:|exp:)/i;

  const doc = global.document;
  const $ = (s) => doc.querySelector(s);

  /* ============ 鍵の置き場（この端末の localStorage だけ） ============ */
  let memToken = "";   // localStorage が使えない環境（プライベートモード等）では、開いている間だけ覚える
  const keyStore = {
    get() { try { return global.localStorage.getItem(CONFIG.tokenKey) || memToken; } catch (e) { return memToken; } },
    set(v) { memToken = v; try { global.localStorage.setItem(CONFIG.tokenKey, v); return true; } catch (e) { return false; } },
    clear() { memToken = ""; try { global.localStorage.removeItem(CONFIG.tokenKey); } catch (e) { /* 消せなくても画面は進める */ } }
  };

  /* ============ GitHub の呼び出し ============ */
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function gh(path, token, opt) {
    const o = opt || {};
    const headers = {
      Accept: o.accept || "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (o.body) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await global.fetch(CONFIG.api + path, {
        method: o.method || "GET", headers, cache: "no-store",
        body: o.body ? JSON.stringify(o.body) : undefined
      });
    } catch (e) {
      throw new ApiError(0, "GitHub につながりませんでした（電波か、GitHub の不調）");
    }
    if (!res.ok) throw new ApiError(res.status, "GitHub が " + res.status + " を返しました");
    return res;
  }

  const repoPath = (p) => `/repos/${CONFIG.owner}/${CONFIG.repo}${p}`;

  async function loadDesk(token) {
    const res = await gh(repoPath("/contents/" + CONFIG.dataPath), token, { accept: "application/vnd.github.raw+json" });
    let data;
    try { data = JSON.parse(await res.text()); } catch (e) { throw new ApiError(-1, "desk.json が JSON として読めませんでした"); }
    return normalize(data);
  }

  /* 欠けている欄があっても画面が落ちないように、空の値で埋める */
  function normalize(d) {
    if (d && typeof d === "object" && Array.isArray(d.issues) && !Array.isArray(d.timeline)) {
      throw new ApiError(-1, "desk.json がまだ古い形です（線表の timeline がありません）。事業部長が新しい形に書き直すと表示されます");
    }
    if (!d || typeof d !== "object" || !Array.isArray(d.requests) || !Array.isArray(d.timeline)) {
      throw new ApiError(-1, "desk.json の形が違います（timeline と requests が要ります）");
    }
    return {
      version: d.version || 2,
      asOf: d.asOf || null,
      sourceNote: d.sourceNote || "",
      goal: { date: "", label: "公開", outlook: "warn", outlookText: "", concern: "", ...(d.goal || {}) },
      range: d.range || null,
      timeline: d.timeline.map((g) => ({ group: "", ...g, rows: Array.isArray(g.rows) ? g.rows.map((r) => ({ segments: [], ...r })) : [] })),
      requests: d.requests.filter((r) => r && r.id && r.answer),
      waiting: Array.isArray(d.waiting) ? d.waiting : [],
      upcoming: Array.isArray(d.upcoming) ? d.upcoming : [],
      relay: { recent: [], failNote: "", ...(d.relay || {}) }
    };
  }

  /* リレーの実行履歴を、試作と同じ形（失敗は先頭に「!」）にする。実行中・飛ばした回は数えない */
  function relayFromRuns(runs) {
    const done = (runs || []).filter((r) => r && r.status === "completed" && (r.conclusion === "success" || RUN_FAIL.has(r.conclusion)));
    const recent = done.map((r) => (RUN_FAIL.has(r.conclusion) ? "!" : "") + r.created_at);
    const ng = done.filter((r) => RUN_FAIL.has(r.conclusion));
    const failNote = ng.length
      ? `失敗${ng.length}回（いちばん新しい失敗 ${jst(ng[0].created_at)}）。原因はこの画面では見ていません。`
      : "この範囲はすべて成功。";
    return { recent, failNote };
  }

  async function loadRelay(token) {
    const res = await gh(repoPath(`/actions/workflows/${CONFIG.workflow}/runs?per_page=${CONFIG.runsPerPage}`), token);
    const j = await res.json();
    return relayFromRuns(j.workflow_runs);
  }

  async function loadComments(token, n) {
    const all = [];
    for (let page = 1; page <= CONFIG.maxCommentPages; page++) {
      const res = await gh(repoPath(`/issues/${n}/comments?per_page=${CONFIG.perPage}&page=${page}`), token);
      const list = await res.json();
      if (!Array.isArray(list)) break;
      all.push(...list);
      if (list.length < CONFIG.perPage) return all;
    }
    // 上限まで読んでも続きがある：古い順なので、新しいコメントを読み落としている可能性がある
    throw new ApiError(-2, "コメントが多すぎて最後まで読めませんでした");
  }

  /* 社長が書いた、印つきのコメントだけを拾う。同じ依頼に何度も答えていたら、いちばん新しいもの */
  function findAnswers(comments) {
    const out = {};
    for (const c of comments || []) {
      if (!c || !c.user || c.user.login !== CONFIG.boss) continue;
      const m = MARK_RE.exec(c.body || "");
      if (!m) continue;
      const prev = out[m[1]];
      if (!prev || prev.at < c.created_at) out[m[1]] = { text: (c.body || "").slice(m[0].length), at: c.created_at, url: c.html_url || "" };
    }
    return out;
  }

  const buildBody = (id, text) => `<!-- desk:answer ${id} -->\n${text}`;

  async function postAnswer(token, issue, id, text) {
    const res = await gh(repoPath(`/issues/${issue}/comments`), token, { method: "POST", body: { body: buildBody(id, text) } });
    const j = await res.json().catch(() => ({}));
    return { url: j.html_url || "", at: j.created_at || new Date().toISOString() };
  }

  /* ============ 画像（端末の中で縮めて、app-company の中に保存する） ============ */
  const safeName = (x) => String(x).replace(/[^A-Za-z0-9._-]/g, "_");
  const two = (n) => String(n).padStart(2, "0");
  const jstParts = (ms) => { const d = new Date(ms + 9 * 3600e3); return { ymd: `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`, hms: `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}` }; };
  /* 置き場所：data/desk-images/<日付>/<依頼id>/<時刻>-<連番>.jpg。時刻まで入れるので、同じ依頼に何度答えてもぶつからない */
  function imagePath(id, n) { const t = jstParts(Date.now()); return `${CONFIG.imageDir}/${t.ymd}/${safeName(id)}/${t.hms}-${n}.jpg`; }
  const imageUrl = (path) => `https://github.com/${CONFIG.owner}/${CONFIG.repo}/blob/${CONFIG.branch}/${path}`;
  const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

  /* 縮める：長い辺を maxSide に収める JPEG にする。写真は 3〜10MB あるので、そのまま送ると電波が弱いと失敗し、リポジトリも重くなる。画面の細かい文字が読める大きさは残す */
  async function shrinkImage(file) {
    if (typeof global.DESK_SHRINK === "function") return global.DESK_SHRINK(file);   // テスト用
    let bmp;
    try { bmp = await global.createImageBitmap(file); }
    catch (e) {
      const url = await new Promise((ok, ng) => { const fr = new global.FileReader(); fr.onload = () => ok(fr.result); fr.onerror = ng; fr.readAsDataURL(file); });
      bmp = await new Promise((ok, ng) => { const im = new global.Image(); im.onload = () => ok(im); im.onerror = ng; im.src = url; });   // data: は CSP で許可済み
    }
    const w0 = bmp.width, h0 = bmp.height, k = Math.min(1, CONFIG.maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = doc.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
    const dataUrl = c.toDataURL("image/jpeg", CONFIG.jpegQuality);
    return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(",") + 1), w, h };
  }

  async function putImage(token, img, id) {
    const path = encPath(img.path);
    const put = () => gh(repoPath("/contents/" + path), token, { method: "PUT", body: { message: `社長の画面：画像を保存（${id}）`, content: img.base64, branch: CONFIG.branch } });
    try {
      try { await put(); }
      catch (e) { if (e.status === 409) await put(); else throw e; }   // ほかの更新とぶつかったときは1回だけやり直す
    } catch (e) {
      if (e.status === 422) {   // 同じ名前が既にある＝前の送信で保存済み。あることを確かめて、保存済みとして進める
        try { await gh(repoPath("/contents/" + path + "?ref=" + CONFIG.branch), token); return; } catch (e2) { /* あると確かめられなければ元の失敗を返す */ }
      }
      throw e;
    }
  }

  /* 全部読む。desk.json が読めなければ全体が失敗。リレーとコメントは、読めなかったことを画面に出して進める */
  async function loadAll(token) {
    const data = await loadDesk(token);
    const nums = [...new Set(data.requests.map((r) => r.issue))];
    const [relay, ...perIssue] = await Promise.all([
      loadRelay(token).then((v) => ({ v }), (e) => ({ e })),
      ...nums.map((n) => loadComments(token, n).then((c) => ({ n, a: findAnswers(c) }), (e) => ({ n, e })))
    ]);
    const answers = {}, unknownIssues = [];
    perIssue.forEach((x) => { if (x.e) unknownIssues.push(x.n); else answers[x.n] = x.a; });
    let relaySource = "desk";
    if (relay.v) { data.relay = { ...data.relay, ...relay.v }; relaySource = "actions"; }
    return { data, answers, unknownIssues, relaySource, loadedAt: new Date().toISOString() };
  }

  /* ============ 表示の道具（試作と同じ） ============ */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeHref = (h) => (SAFE_HREF.test(String(h || "")) ? String(h) : "");
  const jst = (iso) => {
    const t = new Date(iso).getTime();
    if (!isFinite(t)) return "時刻不明";
    const d = new Date(t + 9 * 3600e3);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };

  let DATA = null;              // いま表示している中身（loadAll の結果の data）
  let LOAD = null;              // いちばん新しい読み込みの結果
  let lastOk = null;            // 最後に読み込めた時刻
  let state = {};               // 依頼ごとの入力と送信の状態
  const nodes = new Map();      // 依頼カードは読み込みごとに1回だけ作り、切り替えでは使い回す

  function realHtml(r) {
    let h = "";
    if (r.kind === "posts" && Array.isArray(r.posts)) {
      h += r.posts.map((p, i) => `<div class="post" id="${esc(r.id)}-p${i}"><div class="post-meta"><span><b>${esc(p.day)}</b>　${esc(p.note)}</span><button type="button" class="flagbtn" data-flag="${esc(r.id)}|${i}" aria-pressed="false">ここを直したい</button></div><p>${esc(p.text)}</p></div>`).join("");
    }
    if (r.kind === "steps" && Array.isArray(r.steps)) h += `<ol class="checks">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
    if (r.kind === "links" && Array.isArray(r.links)) {
      h += `<ul class="linklist">${r.links.map((l) => { const href = safeHref(l.href); return `<li>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>` : `${esc(l.label)}<span class="unk">（リンクの形が開けないものだったので外しました）</span>`}</li>`; }).join("")}</ul>`;
      const cp = r.links.find((l) => l.copy && safeHref(l.href));
      if (cp) h += `<div class="btnrow"><button type="button" class="btn" data-copy="${esc(cp.href)}">リンクをコピー</button></div><div class="src" id="${esc(r.id)}-copied" role="status"></div>`;
      if (r.checksOrdered) h += `<div><div class="real-label">${esc(r.checksTitle)}</div><ol class="checks">${r.checksOrdered.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>`;
    }
    if (r.realNote) h += `<div class="src">${esc(r.realNote)}</div>`;
    if (r.kind !== "links" && Array.isArray(r.checks)) h += `<details><summary>確かめたこと</summary><ul class="checks">${r.checks.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></details>`;
    return h;
  }

  function imgsHtml(r) {
    const list = (state[r.id] && state[r.id].images) || [];
    return list.map((im, i) => `<figure class="thumb"><img src="${esc(im.dataUrl)}" alt="付ける画像 ${i + 1}"><button type="button" class="x" data-rmimg="${esc(r.id)}|${i}" aria-label="画像 ${i + 1} を外す">外す</button></figure>`).join("");
  }
  function paintImgs(r) {
    const box = nodes.get(r.id).querySelector(`[id="${CSS_ID(r.id)}-imgs"]`);
    if (box) box.innerHTML = imgsHtml(r);
  }
  const imgMsg = (r, text) => { const m = nodes.get(r.id).querySelector(`[id="${CSS_ID(r.id)}-msg"]`); if (m) m.textContent = text; };

  /* 選んだ写真を縮めて、付ける画像に加える */
  async function addImages(r, files) {
    const s = state[r.id];
    const list = [...files].filter((f) => f && (/^image\//.test(f.type || "") || !f.type));
    if (!list.length) return;
    let bad = 0, over = 0;
    for (const f of list) {
      if (s.images.length >= CONFIG.maxImages) { over++; continue; }
      try {
        const sh = await shrinkImage(f);
        s.imgSeq = (s.imgSeq || 0) + 1;
        s.images.push({ dataUrl: sh.dataUrl, base64: sh.base64, path: imagePath(r.id, s.imgSeq), saved: false });
      } catch (e) { bad++; }
    }
    if (!nodes.has(r.id)) return;
    paintImgs(r);
    const parts = [];
    if (over) parts.push(`1回に付けられるのは ${CONFIG.maxImages} 枚までです`);
    if (bad) parts.push(`${bad} 枚は読めませんでした`);
    if (parts.length) imgMsg(r, parts.join("。") + "。");
  }

  function answerHtml(r) {
    const a = r.answer, id = esc(r.id);
    let h = `<div class="answer" id="${id}-ans">`;
    if (a.type === "choice") h += `<div class="btnrow" role="group" aria-label="答えを選ぶ">${(a.choices || []).map((c) => `<button type="button" class="btn choice" data-choice="${id}|${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join("")}</div>`;
    h += `<label class="hint" for="${id}-note">${a.type === "choice" ? "一言（任意）" : "直すなら一言（OK だけなら空でよい）"}</label>`;
    h += `<textarea id="${id}-note" class="note" rows="2" placeholder="${esc(a.notePlaceholder || "")}"></textarea>`;
    h += `<div class="imgbox"><div class="imgs" id="${id}-imgs">${imgsHtml(r)}</div><button type="button" class="linkbtn" data-pick="${id}">画像を付ける（写真・スクリーンショット）</button><input class="sr" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" data-file="${id}" id="${id}-file"></div>`;
    h += `<div class="btnrow">`;
    if (a.type === "choice") h += `<button type="button" class="btn primary" data-send="${id}|choice" id="${id}-go" disabled>この答えで送る</button>`;
    else h += `<button type="button" class="btn primary" data-send="${id}|ok">${esc(a.okLabel || "OK")}</button><button type="button" class="btn" data-send="${id}|note">一言を送る</button>`;
    h += `</div><p class="hint" id="${id}-msg">送り先：Issue #${esc(r.issue)} に、社長のコメントとして書き込みます。</p></div>`;
    return h;
  }

  function sentHtml(r) {
    const s = state[r.id];
    const link = s.sentUrl && safeHref(s.sentUrl) ? `　<a href="${esc(s.sentUrl)}" target="_blank" rel="noopener noreferrer">GitHub で見る</a>` : "";
    const head = s.fromHistory
      ? `<b>回答済み（${esc(jst(s.sentAt))}）。</b>Issue #${esc(r.issue)} に社長のコメントとして、次の文があります。`
      : `<b>送りました。</b>Issue #${esc(r.issue)} に社長のコメントとして、次の文を書き込みました。`;
    return `<div class="answer"><div class="sent" role="status">${head}${link}<pre>${esc(s.sent)}</pre></div><button type="button" class="linkbtn" data-undo="${esc(r.id)}">もう一度答える（新しいコメントになり、前の答えも残ります）</button></div>`;
  }

  function failedHtml(r) {
    const s = state[r.id], n = s.images.length, done = s.images.filter((x) => x.saved).length;
    const prog = n ? `<br>画像：${n} 枚のうち ${done} 枚は保存できました、${n - done} 枚は送れていません。答えのコメントは まだ書き込んでいません。「もう一度送る」で、送れていない分から続けます（保存できた画像は二重に保存しません）。` : "";
    const dropBtn = s.canDrop && n ? `<button type="button" class="btn" data-dropimg="${esc(r.id)}">画像を外して、言葉だけ送る</button>` : "";
    return `<div class="answer"><div class="sent ng" role="alert"><b>送れませんでした。</b>${esc(s.error)}。${n && s.imgFail ? "" : "Issue にはまだ書き込まれていない可能性が高いです。"}${prog}<pre>${esc(s.pending)}</pre></div>
      <div class="btnrow"><button type="button" class="btn primary" data-retry="${esc(r.id)}">もう一度送る</button>${dropBtn}</div>
      <button type="button" class="linkbtn" data-undo="${esc(r.id)}">書き直す</button></div>`;
  }

  function makeNode(r) {
    const el = doc.createElement("article");
    const id = esc(r.id);
    el.className = "req"; el.id = r.id; el.dataset.urgent = String(r.urgency === "need");
    const urg = r.urgency === "need" ? `<span class="pill warn">答えが要る</span>` : `<span class="pill">お願い・急ぎではない</span>`;
    const unknown = LOAD && LOAD.unknownIssues.includes(r.issue) ? `<span class="pill bad">回答済みか確かめられませんでした</span>` : "";
    const commentLink = safeHref(r.commentUrl) ? `　<a href="${esc(r.commentUrl)}" target="_blank" rel="noopener noreferrer">GitHub の元のコメント</a>` : "";
    el.innerHTML = `<button type="button" class="req-head" data-toggle="${id}" aria-expanded="false" aria-controls="${id}-body">
        <span class="tags">${urg}<span class="pill acc">${esc(r.dept)}</span><span class="pill">Issue #${esc(r.issue)}</span><span class="pill good" id="${id}-sentpill" hidden>回答済み</span>${unknown}</span>
        <span class="rh-title">${esc(r.title)}</span>
        <span class="rh-more" id="${id}-more">開いて実物を見る・答える</span>
      </button>
      <div id="${id}-body" hidden>
        <div class="req-main">
          <p class="lead"><b>決めること</b>　${esc(r.decide)}</p>
          <div class="real"><div class="real-label">実物</div>${realHtml(r)}</div>
          <p class="lead">${esc(r.effect)}</p>
          <div class="push"><b>推し</b>　${esc(r.push)}</div>
          <dl class="facts"><dt>お金</dt><dd>${esc(r.money)}</dd><dt>取り消せるか</dt><dd>${esc(r.reversible)}</dd><dt>効く範囲</dt><dd>${esc(r.scope)}</dd></dl>
          <div class="src">詳しくは ${esc(r.source)}${commentLink}</div>
        </div>
        <div id="${id}-zone"></div>
      </div>`;
    return el;
  }

  /* 依頼カードの答える欄を、状態に合わせて描き直す */
  function paintZone(r) {
    const el = nodes.get(r.id), s = state[r.id];
    const zone = el.querySelector(`[id="${CSS_ID(r.id)}-zone"]`);
    if (s.sent) zone.innerHTML = sentHtml(r);
    else if (s.error) zone.innerHTML = failedHtml(r);
    else {
      zone.innerHTML = answerHtml(r);
      const note = zone.querySelector("textarea");
      if (note) note.value = s.note || "";
      if (s.choice) {
        zone.querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.choice === `${r.id}|${s.choice}`)));
        const go = zone.querySelector(`[data-send="${CSS_ID(r.id)}|choice"]`);
        if (go) go.disabled = false;
      }
    }
    el.querySelectorAll(".flagbtn").forEach((b) => {
      const on = s.flags.includes(+b.dataset.flag.split("|")[1]);
      b.setAttribute("aria-pressed", String(on)); b.closest(".post").classList.toggle("flag", on);
    });
    el.querySelector(`[id="${CSS_ID(r.id)}-sentpill"]`).hidden = !s.sent;
  }
  const CSS_ID = (s) => String(s).replace(/["\\]/g, "\\$&");

  function setOpen(el, open) {
    el.querySelector(".req-head").setAttribute("aria-expanded", String(open));
    el.querySelector(`[id$="-body"]`).hidden = !open;
    el.querySelector(".rh-more").textContent = open ? "閉じる" : "開いて実物を見る・答える";
  }

  function noteOf(r) {
    const el = nodes.get(r.id), t = el && el.querySelector("textarea");
    return (t ? t.value : state[r.id].note || "").trim();
  }

  /* 送る文（試作の buildComment と同じ）。先頭の印は送るときに付ける */
  function buildComment(r, mode) {
    const s = state[r.id], note = noteOf(r), parts = [];
    if (mode === "ok") parts.push("OK");
    if (mode === "choice" && s.choice) parts.push(s.choice);
    const flagged = [...(s.flags || [])].sort((a, b) => a - b).map((i) => r.posts && r.posts[i] && r.posts[i].day).filter(Boolean);
    if (flagged.length) parts.push(`直したい：${flagged.join("・")}`);
    if (note) parts.push(note);
    return parts.join("\n") + imageLines(s);
  }

  /* 答えのコメントに入れる、画像の置き場所（リポジトリ内のパス。部署の AI はこれで画像を開く）と GitHub で開けるリンク */
  function imageLines(s) {
    const list = (s && s.images) || [];
    if (!list.length) return "";
    return `\n\n画像 ${list.length} 枚（app-company リポジトリ内に保存）：\n` + list.map((im) => `- ${im.path}\n  ${imageUrl(im.path)}`).join("\n");
  }

  async function deliver(r, text) {
    const s = state[r.id];
    s.sending = true; s.pending = text; s.error = null;
    nodes.get(r.id).querySelectorAll("[data-send],[data-retry]").forEach((b) => { b.disabled = true; });
    const msg = nodes.get(r.id).querySelector(`[id="${CSS_ID(r.id)}-msg"]`);
    if (msg) msg.textContent = "送っています…";
    s.canDrop = false; s.imgFail = false;
    try {
      // 画像を先に保存し、全部成功したら答えのコメントを書く。保存済みの画像は飛ばす
      for (const im of s.images) {
        if (im.saved) continue;
        if (msg) msg.textContent = `画像を保存しています…（${s.images.filter((x) => x.saved).length + 1} / ${s.images.length}）`;
        try { await putImage(keyStore.get(), im, r.id); im.saved = true; }
        catch (e) { s.imgFail = true; if (e.status === 403 || e.status === 404) s.canDrop = true; throw Object.assign(e, { phase: "image" }); }
      }
      if (msg) msg.textContent = "送っています…";
      const out = await postAnswer(keyStore.get(), r.issue, r.id, text);
      Object.assign(s, { sent: text, sentUrl: out.url, sentAt: out.at, fromHistory: false, pending: null, note: "", images: [], imgSeq: 0 });
    } catch (e) {
      s.error = reasonOf(e, e && e.phase === "image" ? "image" : "send");
    }
    s.sending = false;
    paintZone(r); draw();
  }

  function send(r, mode) {
    if (state[r.id].sending) return;
    const text = buildComment(r, mode);
    state[r.id].mode = mode;
    if (!text.trim()) { const m = nodes.get(r.id).querySelector(`[id="${CSS_ID(r.id)}-msg"]`); if (m) m.textContent = "答えか一言を入れてください。"; return; }
    return deliver(r, text);
  }

  /* ---------- 日付（日本時間の「日」で数える） ---------- */
  const DAY = 864e5;
  const dayNum = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : NaN; };
  const todayNum = () => {
    const o = global.DESK_TODAY;   // テスト用に今日を決められる
    if (o && isFinite(dayNum(o))) return dayNum(o);
    return Math.floor((Date.now() + 9 * 3600e3) / DAY);
  };
  const md = (n) => { const d = new Date(n * DAY); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
  const mdOf = (s) => (isFinite(dayNum(s)) ? md(dayNum(s)) : esc(s));

  /* 線表の1行ぶんの区間に、描く位置（日数）を決める。
   * 始まりが無ければ前の区間の終わり。終わりが無ければ、「いま」は今日から7日先まで、それ以外は次の区間の始まり（無ければ公開日）まで。 */
  function resolveSegments(row, today, goalN, startN) {
    const segs = row.segments || [];
    const out = [];
    let prevEnd = startN;
    segs.forEach((s, i) => {
      let a = dayNum(s.from), b = dayNum(s.to);
      if (!isFinite(a)) a = prevEnd;
      if (!isFinite(b)) {
        if (s.state === "now") b = Math.max(a, today) + 7;
        else { const nx = dayNum((segs[i + 1] || {}).from); b = isFinite(nx) ? nx : goalN; }
      }
      out.push({ ...s, a, b });
      prevEnd = b;
    });
    return out;
  }

  const blocking = (rowId) => DATA.requests.filter((r) => r.row === rowId && !state[r.id].sent);
  const openAll = () => DATA.requests.filter((r) => !state[r.id].sent);
  const STATE_JA = { done: "済み", now: "いま", plan: "予定", undated: "日付未定" };
  const LEVELS = ["ok", "warn", "stop"];

  /* ---------- 部品 ---------- */
  function verdictHtml() {
    const g = DATA.goal, today = todayNum(), gn = dayNum(g.date);
    const left = isFinite(gn) ? gn - today : null;
    const open = openAll();
    const days = left === null ? `<div class="big">—</div>`
      : left >= 0 ? `<div class="big">${left}<small>日</small></div>` : `<div class="big" style="color:var(--stop)">${-left}<small>日過ぎた</small></div>`;
    const lvl = LEVELS.includes(g.outlook) ? g.outlook : "warn";
    const concern = g.concern ? ` 気になるのは <span class="pill ${lvl}"><span class="dot"></span>${esc(g.concern)}</span> だけ` : "";
    const goalTxt = `<b>${esc(g.label || "公開")}（${isFinite(gn) ? mdOf(g.date) : esc(g.date)}）まで</b><br>${esc(g.outlookText || "見込みは未確認")}${concern}`;
    const links = open.map((r) => `<a class="jump" href="#${esc(r.id)}" data-jump="${esc(r.id)}">${esc(r.short || r.title)} →</a>`).join("<br>");
    const blk = `<div class="big" id="blkN" style="color:var(--me)">${open.length}<small>件</small></div>
      <p id="blkP"><b>社長が止めているもの</b><br>${open.length ? links : "いまはなし"}</p>`;
    return `<section class="panel verdict">${days}<p>${goalTxt}</p>${blk}</section>`;
  }

  function chartHtml() {
    const today = todayNum(), gn = dayNum(DATA.goal.date);
    const all = [];
    DATA.timeline.forEach((g) => g.rows.forEach((r) => (r.segments || []).forEach((s) => { all.push(dayNum(s.from), dayNum(s.to)); })));
    const finite = all.filter(isFinite);
    const given = (k, dflt) => { const v = dayNum((DATA.range || {})[k]); return isFinite(v) ? v : dflt; };
    const S = given("from", Math.min(today - 1, ...finite));
    const E = given("to", Math.max(isFinite(gn) ? gn + 9 : today + 30, ...finite));
    const span = Math.max(1, E - S);
    const pct = (n) => (Math.min(100, Math.max(0, ((n - S) / span) * 100))).toFixed(2) + "%";
    const wid = (a, b) => (Math.max(0, ((Math.min(E, b) - Math.max(S, a)) / span) * 100)).toFixed(2) + "%";
    const ticks = [];
    let t = new Date(S * DAY);
    for (;;) {   // 月の初めに目盛り
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
      const n = t.getTime() / DAY; if (n >= E) break;
      if (n > S) ticks.push(`<span style="left:${pct(n)}">${t.getUTCMonth() + 1}月</span>`);
    }
    let rowsHtml = "";
    DATA.timeline.forEach((g) => {
      if (g.group) rowsHtml += `<div class="grp">${esc(g.group)}</div>`;
      g.rows.forEach((r) => {
        const bl = blocking(r.id);
        const st = bl.length ? "me" : (LEVELS.includes(r.status) ? r.status : "ok");
        const segs = resolveSegments(r, today, gn, S).filter((s) => s.b > S && s.a < E && s.b > s.a);
        const segHtml = segs.map((s) => {
          const cls = STATE_JA[s.state] ? s.state : "plan";
          const tip = `${s.name}（${STATE_JA[cls]}${s.wait ? "・" + s.wait : ""}）`;
          return `<div class="seg ${cls}${s.wait ? " waitb" : ""}" style="left:${pct(s.a)};width:${wid(s.a, s.b)}" title="${esc(tip)}">${esc(s.name)}</div>`;
        }).join("");
        const sr = `<span class="sr">${(r.segments || []).map((s) => `${esc(s.name)}（${STATE_JA[s.state] || "予定"}${s.wait ? "・" + esc(s.wait) : ""}）`).join("、")}</span>`;
        const badge = bl.length ? `<a class="badge" href="#${esc(bl[0].id)}" data-jump="${esc(bl[0].id)}">社長</a>` : "";
        rowsHtml += `<div class="row" data-row="${esc(r.id)}"><div class="nm ${st}"><span class="dot"></span>${esc(r.label || r.id)}${badge}</div><div class="track">${segHtml}${sr}</div></div>`;
      });
    });
    const marks = (isFinite(gn) ? [[today, "today", "今日"], [gn, "goal", DATA.goal.label || "公開"]] : [[today, "today", "今日"]]);
    const lines = marks.filter(([n]) => n >= S && n <= E)
      .map(([n, c, l]) => `<div class="vline ${c}" style="left:${pct(n)}"></div><div class="vlab ${c}" style="left:${pct(n)}">${esc(l)}</div>`).join("");
    return `<section class="panel"><div class="lbl">公開までの線表</div>
      <div class="chart"><div class="axis"><div></div><div class="ticks">${ticks.join("")}</div></div>${rowsHtml}
        <div style="position:absolute;left:76px;right:0;top:0;bottom:0;pointer-events:none">${lines}</div></div>
      <div class="legend">
        <span><i style="background:var(--done)"></i>済み</span>
        <span><i style="background:var(--now)"></i>いま</span>
        <span><i style="border:1.5px solid var(--plan)"></i>予定</span>
        <span><i style="background:repeating-linear-gradient(45deg,var(--plan) 0 3px,transparent 3px 7px)"></i>日付が未定</span>
        <span><i style="box-shadow:0 0 0 2px var(--warn);background:var(--plan)"></i>外の返事待ち</span>
      </div></section>`;
  }

  function aheadHtml() {
    const up = DATA.upcoming.map((e) => `<div class="ag"><time>${mdOf(e.date)}</time><div>${esc(e.title)}${e.sub ? `<small>${esc(e.sub)}</small>` : ""}</div></div>`).join("");
    const wt = DATA.waiting.map((w) => `<div><span class="dot ${LEVELS.includes(w.level) ? w.level : "warn"}"></span> ${esc(w.text)}${w.note ? `<span class="n">${esc(w.note)}</span>` : ""}</div>`).join("");
    return `<section class="panel"><div class="lbl">この先の予定</div>
      <div class="agenda">${up || `<div class="ag"><div>記録にある予定はありません</div></div>`}</div>
      <div class="lbl" style="margin-top:12px">返事待ち（社長の操作はいらない）</div>
      <div class="wait">${wt || "いまはなし"}</div></section>`;
  }

  function relayHtml() {
    const rel = DATA.relay.recent, ng = rel.filter((x) => x[0] === "!").length;
    if (!rel.length) return "";
    const bars = rel.slice().reverse().map((x) => `<i class="${x[0] === "!" ? "ng" : ""}"></i>`).join("");
    const src = LOAD.relaySource === "actions" ? "（GitHub の実行履歴より）" : `（<span class="unk">実行履歴が読めなかったので desk.json の記録</span>）`;
    return `<section class="panel relay"><span class="lbl">リレー直近${rel.length}回</span><b>${rel.length - ng} / ${rel.length} 成功</b>
      <span class="bars" role="img" aria-label="古い順に左から。失敗${ng}回">${bars}</span><span>${esc(DATA.relay.failNote)}${src}</span></section>`;
  }

  function viewHtml() {
    const todo = DATA.requests.length
      ? `<section class="panel" id="todo"><div class="lbl">社長がやること</div><div id="req-slot"></div></section>` : "";
    return verdictHtml() + todo + chartHtml() + aheadHtml() + relayHtml();
  }

  function stampText() {
    if (!lastOk) return "まだ読み込めていません";
    const rec = DATA && DATA.asOf ? `・最新の記録 ${jst(DATA.asOf)}` : "";
    return `読み込み ${jst(lastOk)}${rec}`;
  }

  function draw() {
    $("#stamp").textContent = stampText();
    if (!DATA) return;
    $("#view").innerHTML = viewHtml();
    const slot = $("#req-slot");
    if (slot) DATA.requests.forEach((r) => slot.appendChild(nodes.get(r.id)));
  }

  /* 線表の「社長」の印や上の件数から、その依頼の答える欄へ飛ぶ */
  function jumpTo(id) {
    const el = nodes.get(id); if (!el) return;
    el.dataset.touched = "1"; setOpen(el, true);
    let calm = false; try { calm = global.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* 動かなくてよい */ }
    try { el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" }); } catch (e) { /* 動かなくてよい */ }
    el.classList.add("flash"); global.setTimeout(() => el.classList.remove("flash"), 1600);
    try { el.querySelector(".req-head").focus({ preventScroll: true }); } catch (e) { /* 動かなくてよい */ }
  }

  /* ============ 鍵が無いとき・読めなかったとき ============ */
  function setupHtml(msg) {
    return `<section class="panel setup" id="setup">
      <h2>はじめに：GitHub の鍵を貼ってください</h2>
      <p>この画面は、社長の鍵で app-company の記録を読み、答えを Issue のコメントとして書き込みます。鍵はこの端末のこのブラウザの中にだけ保存し、GitHub 以外には送りません。</p>
      <p class="notice">iPhone は、先に Safari の共有ボタンから「ホーム画面に追加」をして、ホーム画面のアイコンから開いてから貼ってください。Safari とホーム画面のアイコンでは保存場所が別なので、Safari で貼ってもアイコン側には入りません。</p>
      <h3>鍵の作り方（5分ほど）</h3>
      <ol class="checks" id="key-steps">
        <li>GitHub にログインした状態で、<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">鍵を作る画面</a>を開く（右上のアイコン → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token と同じ画面）</li>
        <li>「Token name」に「社長の画面」と入れる（名前は何でもよい）</li>
        <li>「Resource owner」は Yoshiki0423 のままにする</li>
        <li>「Expiration」（期限）を選ぶ。おすすめは 90 days。期限が切れたらこの画面がそう知らせるので、同じ手順で作り直す</li>
        <li>「Repository access」で「Only select repositories」を選び、app-company だけを選ぶ</li>
        <li>「Permissions」の「Repository permissions」で、次の3つだけを変える。Issues を「Read and write」、Contents を「Read-only」、Actions を「Read-only」（Metadata は自動で「Read-only」になる。ほかは触らない）</li>
        <li>いちばん下の「Generate token」を押し、出てきた鍵（github_pat_ で始まる長い文字）をコピーする。画面を閉じると二度と表示されない</li>
        <li>下の欄に貼って「保存して開く」を押す</li>
      </ol>
      <label class="hint" for="token-in">鍵</label>
      <input id="token-in" class="keyin" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_ で始まる文字を貼る">
      <div class="btnrow"><button type="button" class="btn primary" data-act="save-token">保存して開く</button></div>
      <p class="hint" id="token-msg" role="status">${esc(msg || "")}</p>
    </section>`;
  }

  function showSetup(msg) {
    DATA = null; LOAD = null;
    $("#tools").hidden = true;
    $("#notice").innerHTML = "";
    $("#stamp").textContent = "鍵がまだありません";
    $("#view").innerHTML = setupHtml(msg);
  }

  function reasonOf(e, phase) {
    const s = e && e.status;
    if (s === 401) return "鍵が使えませんでした。期限が切れたか、貼り間違いの可能性があります";
    if (phase === "image" && s === 403) return "鍵に書き込みの権限がありません（Contents が「Read-only」のままです）。作り直し方：GitHub で鍵を作り直し、Repository permissions の Contents を「Read and write」にして、新しい鍵を貼り直してください（手順は、鍵を消して出てくる最初の案内と同じです）。言葉だけの答えは、画像を外せば送れます";
    if (phase === "image" && s === 404) return "画像の保存先が見つかりませんでした。鍵の対象に app-company が入っているか、Contents が「Read and write」か確かめてください";
    if (phase === "image" && s === 422) return "画像を GitHub が受け付けませんでした";
    if (s === 403) return phase === "send"
      ? "書き込みが断られました。鍵の Issues が「Read and write」になっているか確かめてください（GitHub が混み合っているときも出ます）"
      : "読み込みが断られました。鍵の Contents が「Read-only」以上か確かめてください（GitHub が混み合っているときも出ます）";
    if (s === 404) return phase === "send"
      ? "書き込み先の Issue が見つかりませんでした。鍵の対象に app-company が入っているか確かめてください"
      : "app-company の data/desk.json が見つかりませんでした。鍵の「Repository access」に app-company が入っているか確かめてください";
    if (s === 422) return "GitHub が文を受け付けませんでした";
    return (e && e.message) || "原因がわかりませんでした";
  }

  function showLoadError(e) {
    const reason = reasonOf(e, "load");
    const keep = DATA ? `<p>下は ${esc(jst(lastOk))} に読み込んだときの中身です。</p>` : "";
    $("#notice").innerHTML = `<div class="err" role="alert">読み込めませんでした。<p>${esc(reason)}。</p>${keep}<div class="btnrow"><button type="button" class="btn" data-act="reload">読み直す</button><button type="button" class="btn" data-act="forget">鍵を消して貼り直す</button></div></div>`;
  }

  function showPartialNotice(L) {
    const notes = [];
    if (L.unknownIssues.length) notes.push(`Issue #${L.unknownIssues.join("・#")} のコメントが読めず、答え済みかどうか確かめられませんでした。二重に答えないよう、GitHub で確かめてから答えてください`);
    if (L.relaySource !== "actions") notes.push("リレーの実行履歴が読めませんでした（鍵の Actions が「Read-only」か確かめてください）。リレーの欄は desk.json の記録です");
    $("#notice").innerHTML = notes.map((n) => `<p class="notice">${esc(n)}。</p>`).join("");
  }

  /* ============ 読み込み ============ */
  async function reload() {
    const token = keyStore.get();
    if (!token) { showSetup(); return; }
    $("#tools").hidden = false;
    $("#stamp").textContent = "読み込み中…" + (lastOk ? `（前回 ${jst(lastOk)}）` : "");
    let L;
    try { L = await loadAll(token); } catch (e) { draw(); showLoadError(e); return; }
    // 送っていない入力は、読み直しても残す
    const prev = state;
    nodes.forEach((el, id) => { const t = el.querySelector("textarea"); if (t && prev[id]) prev[id].note = t.value; });
    LOAD = L; DATA = L.data; lastOk = L.loadedAt; state = {}; nodes.clear();
    DATA.requests.forEach((r) => {
      const a = (L.answers[r.issue] || {})[r.id], p = prev[r.id];
      state[r.id] = a
        ? { choice: null, flags: [], sent: a.text, sentUrl: a.url, sentAt: a.at, fromHistory: true, note: "", images: [] }
        : { choice: p && !p.sent ? p.choice : null, flags: p && !p.sent ? p.flags : [], sent: null, note: p && !p.sent ? p.note : "", images: p && !p.sent ? p.images || [] : [], imgSeq: p && !p.sent ? p.imgSeq || 0 : 0 };
      nodes.set(r.id, makeNode(r));
      paintZone(r);
    });
    draw();
    showPartialNotice(L);
  }

  /* ============ 押されたとき ============ */
  async function onClick(e) {
    const jl = e.target.closest("a[data-jump]");
    if (jl) { e.preventDefault(); if (DATA) jumpTo(jl.dataset.jump); return; }
    const t = e.target.closest("button"); if (!t) return;
    const ds = t.dataset;
    const reqOf = (id) => DATA && DATA.requests.find((r) => r.id === id);
    if (ds.act === "reload") return reload();
    if (ds.act === "forget") {
      let ok = true; try { ok = global.confirm("この端末から鍵を消します。また使うときは、鍵を貼り直します。よいですか？"); } catch (err) { ok = true; }
      if (!ok) return;
      keyStore.clear(); lastOk = null; showSetup("鍵を消しました。"); return;
    }
    if (ds.act === "save-token") {
      const v = ($("#token-in").value || "").trim();
      if (!v) { $("#token-msg").textContent = "鍵を貼ってください。"; return; }
      const stored = keyStore.set(v);
      if (!stored) $("#notice").innerHTML = `<p class="notice">この端末では鍵を保存できませんでした（プライベートブラウズなど）。開いている間だけ使えます。</p>`;
      return reload();
    }
    if (!DATA) return;
    if (ds.toggle) { const el = nodes.get(ds.toggle); el.dataset.touched = "1"; setOpen(el, t.getAttribute("aria-expanded") !== "true"); }
    else if (ds.flag) {
      const i = ds.flag.lastIndexOf("|"), id = ds.flag.slice(0, i), n = +ds.flag.slice(i + 1), s = state[id];
      const on = !s.flags.includes(n); s.flags = on ? [...s.flags, n] : s.flags.filter((x) => x !== n);
      t.setAttribute("aria-pressed", String(on)); t.closest(".post").classList.toggle("flag", on);
    }
    else if (ds.choice) {
      const i = ds.choice.indexOf("|"), id = ds.choice.slice(0, i), c = ds.choice.slice(i + 1);
      state[id].choice = c;
      nodes.get(id).querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", String(b === t)));
      const go2 = nodes.get(id).querySelector(`[data-send="${CSS_ID(id)}|choice"]`); if (go2) go2.disabled = false;
    }
    else if (ds.send) { const i = ds.send.lastIndexOf("|"); const r = reqOf(ds.send.slice(0, i)); if (r) return send(r, ds.send.slice(i + 1)); }
    else if (ds.pick) { const inp = nodes.get(ds.pick).querySelector(`[id="${CSS_ID(ds.pick)}-file"]`); if (inp) inp.click(); }
    else if (ds.rmimg) {
      const i = ds.rmimg.lastIndexOf("|"), id = ds.rmimg.slice(0, i), s = state[id];
      s.images.splice(+ds.rmimg.slice(i + 1), 1); paintImgs(reqOf(id));
    }
    else if (ds.dropimg) {
      const r = reqOf(ds.dropimg), s = r && state[r.id];
      if (s && !s.sending) {
        s.images = []; s.imgSeq = 0; s.canDrop = false;
        const text = String(s.pending || "").replace(/\n*画像 \d+ 枚（app-company リポジトリ内に保存）：[\s\S]*$/, "");   // 送ろうとしていた文から、画像の行だけ除く
        if (!text.trim()) { s.error = null; s.pending = null; paintZone(r); draw(); return; }   // 言葉が無かったので、入力欄に戻す
        return deliver(r, text);
      }
    }
    else if (ds.retry) { const r = reqOf(ds.retry); if (r && state[r.id].pending && !state[r.id].sending) return deliver(r, state[r.id].pending); }
    else if (ds.undo) { const r = reqOf(ds.undo); if (r) { state[r.id] = { choice: null, flags: [], sent: null, note: "", images: [] }; paintZone(r); draw(); } }
    else if (ds.copy) {
      const out = t.closest(".real").querySelector(".src[role=status]");
      try { await global.navigator.clipboard.writeText(ds.copy); out.textContent = "コピーしました。Safari のアドレス欄に貼ってください。"; }
      catch (err) { out.textContent = "コピーできませんでした。上のリンクを長押しして選んでください。"; }
    }
  }

  function start() {
    doc.addEventListener("click", (e) => { onClick(e).catch(() => { /* 画面は落とさない */ }); });
    doc.addEventListener("change", (e) => {
      const inp = e.target && e.target.closest && e.target.closest("input[data-file]");
      if (!inp || !DATA) return;
      const r = DATA.requests.find((x) => x.id === inp.dataset.file); if (!r) return;
      const files = [...(inp.files || [])];
      try { inp.value = ""; } catch (err) { /* 同じ写真を選び直せなくても進める */ }
      addImages(r, files).catch(() => { /* 画面は落とさない */ });
    });
    doc.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target && e.target.id === "token-in") { const b = doc.querySelector('[data-act="save-token"]'); if (b) b.click(); } });
    return reload();
  }

  global.Desk = {
    CONFIG, findAnswers, buildBody, relayFromRuns, normalize, safeHref, resolveSegments,
    started: null,
    start() { this.started = start(); return this.started; }
  };
  if (!global.DESK_NO_AUTOSTART) global.Desk.start();
})(window);
