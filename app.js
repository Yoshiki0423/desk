/* 社長の机（管制室の型・ルートの本番）
 * 社長の画面の本番（管制室の型。2026-10-21 に v3/ から入れ替えた）。前の線表の画面は old/ に残してある。鍵の置き場（localStorage の desk.token）は前の画面と同じ。
 * この入れ物には会社のデータを一切置かない。開いたときに、社長の鍵で GitHub の API から読み、画面の中で数える。
 *   data/desk.json・approvals.jsonl・cases.json・results.json・desk-likes.json … Contents API
 *   実行（relay.yml の runs。名前は「工程｜Issue番号｜申し送り」）… Actions API → いま動いている・順番待ち・部署ごとの回数・仕組みの成否
 *   コミット … commits API → 作った機能・部署ごとの最後の仕事・1日あたりの記録の数
 *   Issue #2〜#6 のコメント … Issues API → やり取り・実機のリンク・社長が書いたコメント・答え済みの判定
 * 読めなかったものは、その面だけに「読めませんでした」と出し、ほかの面は壊さない。
 * 答える・画像を付ける・事業部長に話しかける・いいね候補は、前の画面（old/）の仕組みをそのまま持ってきた。
 */
(function (global) {
  "use strict";

  const CONFIG = {
    api: "https://api.github.com",
    owner: "Yoshiki0423",
    repo: "app-company",
    dataPath: "data/desk.json",
    likesPath: "data/desk-likes.json",   // 今日のいいね候補（X部が書く）
    approvalsPath: "data/approvals.jsonl",
    casesPath: "data/cases.json",
    resultsPath: "data/results.json",
    workflow: "relay.yml",
    boss: "Yoshiki0423",          // 答えを書く人（社長の GitHub アカウント）
    tokenKey: "desk.token",       // 鍵を置く localStorage の名前（前の画面と同じ。同じ端末なら貼り直さなくてよい）
    visitKey: "desk.v3.visit",    // 前にこの画面を開いた時刻を覚える localStorage の名前
    themeKey: "desk-theme",
    perPage: 100,
    maxCommentPages: 10,          // 1つの Issue で読むコメントの上限（100件 × 10 ページ）
    runsPerPage: 20,
    runPages: 3,                  // 実行の履歴を読むページ数（100件ずつ。きょうの回数が数えられる範囲）
    commitPages: 5,               // コミットを読むページ数（100件ずつ＝新しい方から最大500件）
    issues: [2, 3, 4, 5, 6],      // いつも読む Issue（2・3 アプリ／4 宣伝／5 事業部長との会話／6 押すだけの候補）。依頼のある Issue は足して読む
    branch: "main",
    imageDir: "data/desk-images", // 画像の置き場（app-company の中）。data/<日付>/<依頼id>/ の下に、時刻つきの名前で置く
    maxImages: 6,                 // 1回の答えに付けられる枚数
    maxSide: 1600,                // 送る前に縮める長い辺（px）
    jpegQuality: 0.82,
    talkIssue: 5,                 // 事業部長に話しかける先。リレーはここへの社長のコメントで事業部長を起こす
    likesIssue: 6,
    talkItems: 10,                // 「最近のやり取り」に出す件数
    talkOpen: 5,                  // そのうち、畳まずに見せる新しい方の件数
    talkFetch: 40,                // やり取りを作るために、#5 の新しい方から読むコメントの数
    staleDays: 2,                 // desk.json が何日前から「止まっている」か。事業部長は夜に書き直すので、1日前のままは普通に起きる。2日以上前なら書き直しが1回以上抜けたと見なす
    sameVisitMin: 30              // これより短い間隔の開き直しは「同じ訪問」とみなし、数え始めの時刻を動かさない（更新で数が0に戻らないように）
  };
  const STAGE_JA = {   // 実行の名前の「工程」→ 部署名。知らない工程はそのまま出す
    manager: "事業部長", planning: "企画部", screening: "審査部", review: "審査部", design: "デザイン部", trial: "試用部", development: "開発部",
    store: "ストア担当", x: "X部", video: "縦動画部", threads: "Threads部", knowledge: "ナレッジ部", research: "リサーチ部", image: "絵の工程", patrol: "見回り"
  };
  const DEPT_PREFIX = {   // コミットの書き出し（「開発(減酒): …」の「開発」）→ 部署名
    "開発": "開発部", "試用": "試用部", "試用部": "試用部", "企画": "企画部", "企画部": "企画部", "デザイン": "デザイン部", "デザイン部": "デザイン部",
    "審査": "審査部", "審査部": "審査部", "リサーチ": "リサーチ部", "リサーチ部": "リサーチ部", "ナレッジ": "ナレッジ部", "ナレッジ部": "ナレッジ部",
    "X部": "X部", "ストア担当": "ストア担当", "縦動画": "縦動画部", "縦動画部": "縦動画部", "Threads部": "Threads部", "事業部長": "事業部長"
  };
  const RUN_FAIL = new Set(["failure", "timed_out", "startup_failure"]);
  const SAFE_HREF = /^(https?:|exp:)/i;
  const MARK_RE = /^\s*<!--\s*desk:answer\s+(\S+)\s*-->[ \t]*\r?\n?/;
  const TALK_RE = /^\s*<!--\s*desk:talk\s*-->[ \t]*\r?\n?/;     // 話しかけ（答えではない相談・調べ物の頼み）の印
  const ANY_MARK_RE = /^\s*<!--\s*desk:(?:answer\s+\S+|talk)\s*-->[ \t]*\r?\n?/;

  const doc = global.document;
  const $ = (s) => doc.querySelector(s);

  /* ---- ここから下は前の画面(old/app.js)から持ってきた部品 ---- */
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

  /* 実行ごとの名前「工程｜Issue番号｜申し送り」を分ける。この形でなければ null（古い実行の「リレー」だけの名前など）。
   * 申し送りは長く、改行や「｜」を含むことがあるので、2つ目の「｜」から後ろは全部申し送りとして残す */
  function parseRunTitle(title) {
    const parts = String(title == null ? "" : title).split("｜");
    if (parts.length < 2) return null;
    const stage = parts[0].trim();
    if (!/^[A-Za-z][\w-]*$/.test(stage)) return null;
    const m = parts[1].trim().match(/^#?(\d+)$/);
    return { stage, issue: m ? Number(m[1]) : null, note: parts.slice(2).join("｜").trim() };
  }

  /* 実行の一覧から、いま動いているもの・順番待ちのものを拾う。人が起こした実行（workflow_dispatch）だけ。
   * コメントや push で起きる数秒の振り分けの実行は出さない。「工程｜」の形でない名前も出さない */
  function activeFromRuns(runs) {
    const seen = new Set(), running = [], waiting = [];
    (runs || []).forEach((r) => {
      if (!r || r.status === "completed" || r.event !== "workflow_dispatch" || seen.has(r.id)) return;
      const t = parseRunTitle(r.display_title);
      if (!t) return;
      seen.add(r.id);
      const item = { ...t, url: r.html_url || "", since: r.status === "in_progress" ? (r.run_started_at || r.created_at) : r.created_at };
      (r.status === "in_progress" ? running : waiting).push(item);
    });
    const byOld = (a, b) => String(a.since).localeCompare(String(b.since));
    return { running: running.sort(byOld), waiting: waiting.sort(byOld) };
  }

  /* 20件の一覧だと、短い実行が続いたときに動いているものを取りこぼす。確実なよう、状態で絞って別々に読む
   * （実行中と順番待ち。event で振り分けの実行も先に除く。waiting などの珍しい状態は、このリレーでは使っていない） */
  async function loadActive(token) {
    const q = (st) => gh(repoPath(`/actions/workflows/${CONFIG.workflow}/runs?status=${st}&event=workflow_dispatch&per_page=${CONFIG.runsPerPage}`), token).then((res) => res.json());
    const [a, b] = await Promise.all([q("in_progress"), q("queued")]);
    return activeFromRuns([...(a.workflow_runs || []), ...(b.workflow_runs || [])]);
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

  /* 社長が書いた、印つきのコメントだけを拾う。同じ依頼に何度も答えていたら、いちばん新しいもの。
   * requests（この Issue の依頼）を渡すと、同じ id で出し直された依頼（再依頼）に前回の答えが付かないよう、
   * 依頼の commentUrl のコメントの作成時刻より後の答えだけを数える。
   * commentUrl が無い、または Issue のコメントの中に見つからない依頼は、今までどおり（いちばん新しい答え） */
  function requestTime(comments, url) {
    if (!url) return "";
    const m = /issuecomment-(\d+)/.exec(url);
    const hit = (comments || []).find((c) => c && ((c.html_url && c.html_url === url) || (m && String(c.id) === m[1])));
    return hit && hit.created_at ? hit.created_at : "";
  }

  function findAnswers(comments, requests) {
    const since = {};
    for (const r of requests || []) if (r && r.id != null) { const t = requestTime(comments, r.commentUrl); if (t) since[r.id] = t; }
    const out = {};
    for (const c of comments || []) {
      if (!c || !c.user || c.user.login !== CONFIG.boss) continue;
      const m = MARK_RE.exec(c.body || "");
      if (!m) continue;
      if (since[m[1]] && !(c.created_at > since[m[1]])) continue;   // 依頼より前の答え（前回分）は数えない
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

  /* 今日のいいね候補。読めなくても画面全体は止めず、「出ていません」の表示にする */
  async function loadLikes(token) {
    let res;
    try { res = await gh(repoPath("/contents/" + CONFIG.likesPath), token, { accept: "application/vnd.github.raw+json" }); }
    catch (e) { return e && e.status === 404 ? { state: "missing" } : { state: "error", reason: (e && e.message) || "" }; }
    let d;
    try { d = JSON.parse(await res.text()); } catch (e) { return { state: "error", reason: "desk-likes.json が JSON として読めませんでした" }; }
    if (!d || typeof d !== "object" || !Array.isArray(d.items)) return { state: "error", reason: "desk-likes.json の形が違います（items が要ります）" };
    return { state: "ok", date: String(d.date || ""), commentUrl: d.commentUrl || "", removed: d.removed, follow: d.follow ? String(d.follow) : "",
      items: d.items.filter((x) => x && x.url) };
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeHref = (h) => (SAFE_HREF.test(String(h || "")) ? String(h) : "");
  const jst = (iso) => {
    const t = new Date(iso).getTime();
    if (!isFinite(t)) return "時刻不明";
    const d = new Date(t + 9 * 3600e3);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };


  /* ============ 読んだものを数える（画面の中でやる。テストできるよう Desk3 に出す） ============ */
  const clean = (t, n) => {
    const s = String(t == null ? "" : t).replace(/<!--[\s\S]*?-->/g, "").replace(/[*`#>]/g, "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const jstDay = (iso) => { const t = Date.parse(iso); return isFinite(t) ? jstParts(t).ymd : ""; };

  /* 実行1件を、部署・Issue・申し送りに分ける。名前が「工程｜Issue｜申し送り」の形でなければ、コメントで起きた受付か、部署名なし */
  function runInfo(r) {
    const t = parseRunTitle(r && r.display_title);
    if (t) return { dept: STAGE_JA[t.stage] || t.stage, issue: t.issue, note: t.note, named: true };
    const intake = r && (r.event === "issue_comment" || r.event === "issues");
    return { dept: intake ? "受付" : "部署名なし", issue: null, note: "", named: false };
  }
  function toRun(r) {
    return { id: r.id, at: r.created_at, day: jstDay(r.created_at), status: r.status, concl: r.conclusion, event: r.event, url: r.html_url || "", ...runInfo(r) };
  }

  /* コミットの1行目から、部署・アプリ・内容を取り出す。部署は末尾の（◯◯部）か書き出し、アプリは「開発(減酒):」「禁煙:」の形（アプリの名前は線表の行から） */
  function parseCommit(subject, appNames) {
    const s = String(subject || "").split("\n")[0];
    const apps = appNames || [];
    let dept = "";
    const m = /（([^）]*部|事業部長|ストア担当)）\s*$/.exec(s);
    if (m) dept = m[1]; else { const p = /^([^(（:：]+)/.exec(s); dept = (p && DEPT_PREFIX[p[1].trim()]) || ""; }
    let app = "";
    const a = /^[^(（:：]+[(（]([^)）]+)[)）]/.exec(s);
    if (a && apps.includes(a[1].trim())) app = a[1].trim();
    else { const b = /^([^(（:：]+)[:：]/.exec(s); if (b && apps.includes(b[1].trim())) app = b[1].trim(); }
    const what = s.replace(/（[^）]*(部|事業部長|ストア担当)）\s*$/, "").replace(/^[^(（:：]+([(（][^)）]+[)）])?[:：]\s*/, "");
    return { dept, app, what };
  }
  const toCommit = (c, apps) => ({ iso: c.iso, day: jstDay(c.iso), s: c.s, ...parseCommit(c.s, apps) });

  /* 部署ごとの数え方：きょうの実行（名前が分かるもの）・きょうの記録・最後にした仕事。runs / commits は新しい順 */
  function deptStats(runs, commits, todayYmd, names) {
    const out = {};
    names.forEach((n) => { out[n] = { name: n, runsToday: 0, commitsToday: 0, runLast: "", lastWhat: "", lastT: "", lastApp: "" }; });
    runs.forEach((r) => { const d = r.named && out[r.dept]; if (!d) return; if (r.day === todayYmd) d.runsToday++; if (!d.runLast) d.runLast = r.at; });
    commits.forEach((c) => {
      const d = out[c.dept]; if (!d) return;
      if (c.day === todayYmd) d.commitsToday++;
      if (!d.lastWhat) { d.lastWhat = c.what.slice(0, 80); d.lastT = c.iso; d.lastApp = c.app || "全体"; }
    });
    return out;
  }

  /* 前にこの画面を開いてから。stored は { baseline, at, kind } か null。初めてなら24時間前から */
  function visitBaseline(nowMs, stored) {
    if (stored && isFinite(stored.at)) {
      if (nowMs - stored.at < CONFIG.sameVisitMin * 60e3 && isFinite(stored.baseline)) return { baseline: stored.baseline, kind: stored.kind === "first" ? "first" : "prev" };
      return { baseline: stored.at, kind: "prev" };
    }
    return { baseline: nowMs - 24 * 3600e3, kind: "first" };
  }
  function readVisit() { try { const o = JSON.parse(global.localStorage.getItem(CONFIG.visitKey) || "null"); return o && typeof o === "object" ? o : null; } catch (e) { return null; } }
  function writeVisit(v) { try { global.localStorage.setItem(CONFIG.visitKey, JSON.stringify(v)); } catch (e) { /* 覚えられなくても画面は進める */ } }

  /* 前に開いてから：開発部の記録（「開発」で始まるコミット）と、社長が書いたコメント（そのあとの最初の返事つき） */
  function sinceCounts(baseMs, commits, comments) {
    const made = commits.filter((c) => Date.parse(c.iso) >= baseMs && /^開発/.test(c.s)).map((c) => ({ at: c.iso, app: c.app, s: c.what }));
    const words = [];
    Object.keys(comments).forEach((n) => {
      const cs = comments[n] || [];
      cs.forEach((x, i) => {
        if (!x.user || x.user.login !== CONFIG.boss || !(Date.parse(x.created_at) >= baseMs)) return;
        let rep = "";
        for (const y of cs.slice(i + 1)) { if (!y.user || y.user.login !== CONFIG.boss) { rep = clean(y.body, 140); break; } }
        words.push({ at: x.created_at, issue: +n, said: clean(x.body, 110), effect: rep });
      });
    });
    words.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { made, words };
  }

  /* desk.json の古さ。asOf が今日から staleDays 日以上前なら、止まっているとして日付を返す */
  function deskStale(asOf, todayN) {
    const n = dayNum(jstDay(asOf));
    if (!isFinite(n)) return null;
    const age = todayN - n;
    return age >= CONFIG.staleDays ? { md: md(n), days: age } : null;
  }

  /* Issue のコメントから、アプリの実機で開くリンク（exp://）を探す。複数のプロジェクトが混ざることがあるので、いちばん多く出るプロジェクトの最後のもの */
  function latestExp(comments) {
    const found = [];
    (comments || []).forEach((x) => { (String((x && x.body) || "").match(/exp:\/\/[^\s<>)）」]+/g) || []).forEach((u) => found.push({ u: u.replace(/[。、.,;:'"\]]+$/, ""), at: x.created_at })); });
    if (!found.length) return null;
    const pid = (u) => { const m = /exp:\/\/u\.expo\.dev\/([0-9a-f-]+)\//i.exec(u); return m ? m[1] : ""; };
    const cnt = {}; found.forEach((f) => { cnt[pid(f.u)] = (cnt[pid(f.u)] || 0) + 1; });
    const top = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    const last = found.filter((f) => pid(f.u) === top).pop();
    return { url: last.u, at: last.at };
  }
  function exchanges(comments, k) {
    return (comments || []).slice(-k).reverse().map((x) => ({ at: x.created_at, who: x.user && x.user.login === CONFIG.boss ? "社長" : "AI社員", body: clean(x.body, 230) }));
  }
  function parseApprovals(text) {
    return String(text || "").split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((a) => a && a.date && a.decision).reverse();
  }
  /* 日ごとの件数（新しい方から last 日ぶん、古い順）。days は "YYYY-MM-DD" の配列 */
  function countByDay(days, last) {
    const c = {}; days.forEach((d) => { if (d) c[d] = (c[d] || 0) + 1; });
    return Object.keys(c).sort().slice(-last).map((d) => [d, c[d]]);
  }

  /* ============ 読み込み ============ */
  const rawText = async (token, path) => (await gh(repoPath("/contents/" + encPath(path)), token, { accept: "application/vnd.github.raw+json" })).text();
  const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));

  /* desk.json を読む。形が違う・古い形のときは例外（理由つき） */
  async function loadDesk(token) {
    const txt = await rawText(token, CONFIG.dataPath);
    let data;
    try { data = JSON.parse(txt); } catch (e) { throw new ApiError(-1, "desk.json が JSON として読めませんでした"); }
    return normalize(data);
  }
  function emptyDesk() {
    return { version: 2, asOf: null, sourceNote: "", goal: { date: "", label: "公開", outlook: "warn", outlookText: "", concern: "" }, range: null, timeline: [], requests: [], waiting: [], upcoming: [], relay: { recent: [], failNote: "" } };
  }
  function normalize(d) {
    if (d && typeof d === "object" && Array.isArray(d.issues) && !Array.isArray(d.timeline)) {
      throw new ApiError(-1, "desk.json がまだ古い形です（線表の timeline がありません）。事業部長が新しい形に書き直すと表示されます");
    }
    if (!d || typeof d !== "object" || !Array.isArray(d.requests) || !Array.isArray(d.timeline)) {
      throw new ApiError(-1, "desk.json の形が違います（timeline と requests が要ります）");
    }
    return {
      version: d.version || 2, asOf: d.asOf || null, sourceNote: d.sourceNote || "",
      goal: { date: "", label: "公開", outlook: "warn", outlookText: "", concern: "", ...(d.goal || {}) },
      range: d.range || null,
      timeline: d.timeline.map((g) => ({ group: "", ...g, rows: Array.isArray(g.rows) ? g.rows.map((r) => ({ segments: [], ...r })) : [] })),
      requests: d.requests.filter((r) => r && r.id).map((r) => (r.answer ? r : { ...r, answer: { type: "ok_or_note" } })),
      waiting: Array.isArray(d.waiting) ? d.waiting : [],
      upcoming: Array.isArray(d.upcoming) ? d.upcoming : [],
      relay: { recent: [], failNote: "", ...(d.relay || {}) }
    };
  }

  /* 実行の履歴（新しい順）を、1ページ100件ずつ runPages ページまで */
  async function loadRuns(token) {
    const out = [];
    for (let p = 1; p <= CONFIG.runPages; p++) {
      const j = await (await gh(repoPath(`/actions/workflows/${CONFIG.workflow}/runs?per_page=100&page=${p}`), token)).json();
      const l = (j && j.workflow_runs) || [];
      out.push(...l);
      if (l.length < 100) break;
    }
    return out;
  }
  async function loadCommits(token) {
    const pages = await Promise.all(Array.from({ length: CONFIG.commitPages }, (_, i) =>
      gh(repoPath(`/commits?sha=${CONFIG.branch}&per_page=100&page=${i + 1}`), token).then((r) => r.json())));
    const out = [];
    pages.forEach((l) => { if (Array.isArray(l)) l.forEach((c) => { const m = (c && c.commit && c.commit.message) || ""; out.push({ iso: (c.commit && c.commit.author && c.commit.author.date) || "", s: m.split("\n")[0] }); }); });
    return out;
  }
  /* アプリの企画・試用メモのファイル（題・日付・リンク）。中身の要約はしない */
  async function loadAppFiles(token, label) {
    const list = await (await gh(repoPath("/contents/" + encPath("apps/" + label)), token)).json();
    if (!Array.isArray(list)) return { plan: [], trial: [] };
    const pick = (re) => list.filter((f) => f.type === "file" && /\.md$/.test(f.name) && re.test(f.name)).slice(0, 8);
    const withDate = async (f) => {
      let at = "";
      try { const c = await (await gh(repoPath(`/commits?sha=${CONFIG.branch}&path=${encPath(f.path)}&per_page=1`), token)).json(); at = (c[0] && c[0].commit && c[0].commit.author && c[0].commit.author.date) || ""; } catch (e) { /* 日付が取れなくても題は出す */ }
      return { name: f.name.replace(/\.md$/, ""), url: f.html_url || "", at };
    };
    const byNew = (a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0);
    const [plan, trial] = await Promise.all([Promise.all(pick(/^企画/).map(withDate)), Promise.all(pick(/^試用メモ/).map(withDate))]);
    return { plan: plan.sort(byNew), trial: trial.sort(byNew) };
  }

  const groupsOf = (d) => {
    const mk = d.timeline.find((g) => g.group === "広める");
    const ap = d.timeline.find((g) => g.group === "作る") || d.timeline.find((g) => g !== mk);
    return { apps: (ap && ap.rows) || [], mk: (mk && mk.rows) || [] };
  };

  /* 全部読む。鍵が使えない（401）以外は、読めなかったものを errors に入れて進む */
  async function loadAll(token) {
    const [deskR, runsR, actR, comR, apR, caseR, resR, likes] = await Promise.all([
      settle(loadDesk(token)), settle(loadRuns(token)), settle(loadActive(token)), settle(loadCommits(token)),
      settle(rawText(token, CONFIG.approvalsPath)), settle(rawText(token, CONFIG.casesPath)), settle(rawText(token, CONFIG.resultsPath)), loadLikes(token)
    ]);
    if (deskR.e && deskR.e.status === 401) throw deskR.e;
    const errors = { comments: {} };
    const data = deskR.v || emptyDesk();
    if (deskR.e) errors.desk = deskR.e;
    if (runsR.e) errors.runs = runsR.e;
    if (actR.e) errors.active = actR.e;
    if (comR.e) errors.commits = comR.e;
    let approvals = [], cases = [], results = null;
    if (apR.e) errors.approvals = apR.e; else approvals = parseApprovals(apR.v);
    if (caseR.e) errors.cases = caseR.e; else { try { cases = JSON.parse(caseR.v).cases || []; } catch (e) { errors.cases = new ApiError(-1, "cases.json が JSON として読めませんでした"); } }
    if (resR.e) errors.results = resR.e; else { try { results = JSON.parse(resR.v); } catch (e) { errors.results = new ApiError(-1, "results.json が JSON として読めませんでした"); } }

    const { apps: appRows } = groupsOf(data);
    const nums = [...new Set([...CONFIG.issues, ...data.requests.map((r) => r.issue), ...data.timeline.flatMap((g) => g.rows.map((r) => r.issue))].filter((n) => Number.isFinite(+n) && +n > 0).map(Number))];
    const [perIssue, perApp] = await Promise.all([
      Promise.all(nums.map((n) => settle(loadComments(token, n)).then((x) => ({ n, ...x })))),
      Promise.all(appRows.map((r) => settle(loadAppFiles(token, r.label)).then((x) => ({ id: r.id, ...x }))))
    ]);
    const comments = {}, answers = {}, unknownIssues = [];
    perIssue.forEach((x) => { if (x.e) { errors.comments[x.n] = x.e; unknownIssues.push(x.n); } else { comments[x.n] = x.v; answers[x.n] = findAnswers(x.v, data.requests.filter((r) => Number(r.issue) === x.n)); } });
    const files = {}, fileErr = {};
    perApp.forEach((x) => { if (x.e) fileErr[x.id] = x.e; else files[x.id] = x.v; });
    errors.files = fileErr;

    const rawRuns = runsR.v || [];
    const runs = rawRuns.map(toRun);
    const appNames = appRows.map((r) => r.label).filter(Boolean);
    const commits = (comR.v || []).map((c) => toCommit(c, appNames));
    let relaySource = "desk";
    if (runsR.v) { data.relay = { ...data.relay, ...relayFromRuns(rawRuns.slice(0, 40)) }; relaySource = "actions"; }
    return { data, likes, answers, unknownIssues, relaySource, active: actR.v || null, runs, commits, comments, approvals, cases, results, files, errors, loadedAt: new Date().toISOString() };
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

  /* ---- 投稿に付く画像・動画（media: [{kind, path}]）。path は他人が書いた文字なので、検査してから使う ---- */
  const MEDIA_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
  /* 使える path なら整えた path を、だめなら null を返す（先頭の / ・ .. ・ 空の部分 ・ バックスラッシュ ・ 制御文字は弾く） */
  function mediaPath(p) {
    if (typeof p !== "string" || !p || p.length > 500 || /[\\\u0000-\u001f]/.test(p) || p.startsWith("/")) return null;
    const parts = p.split("/");
    if (parts.some((x) => x === "" || x === "." || x === "..")) return null;
    return parts.join("/");
  }
  const mediaList = (p) => (p && Array.isArray(p.media) ? p.media.filter((m) => m && typeof m === "object") : []);
  const mediaCache = new Map();   // path -> 取れた blob の URL か、取れなかった理由。一度取ったら開き直しても取り直さない
  function mediaSlots(r, p, i) {
    const l = mediaList(p);
    return l.length ? `<div class="media">${l.map((m, j) => `<div class="mslot" data-mslot="${esc(r.id)}|${i}|${j}">読み込み前（依頼を開くと出ます）</div>`).join("")}</div>` : "";
  }
  /* 取り方：Contents API の raw 形式。blob 形式は base64 で 1MB までだが、raw は 100MB まで直接取れる。private リポジトリなので鍵つきで取り、blob の URL にして出す（img/video に鍵は付けられない） */
  async function fetchMedia(token, path) {
    const clean = mediaPath(path);
    if (!clean) throw new Error("場所の書き方が安全でないため読みません");
    const ext = (clean.split(".").pop() || "").toLowerCase();
    const type = MEDIA_TYPES[ext];
    if (!type) throw new Error("対応していない形式です（." + ext + "）");
    const res = await gh(repoPath("/contents/" + encPath(clean)) + "?ref=" + encodeURIComponent(CONFIG.branch), token, { accept: "application/vnd.github.raw+json" });
    const buf = await res.arrayBuffer();
    return global.URL.createObjectURL(new global.Blob([buf], { type }));
  }
  function loadMedia(r, el) {
    if (!el || el.dataset.mediaLoaded === "1") return;
    el.dataset.mediaLoaded = "1";
    const token = keyStore.get();
    (r.posts || []).forEach((p, i) => mediaList(p).forEach((m, j) => {
      const slot = el.querySelector(`[data-mslot="${CSS_ID(r.id)}|${i}|${j}"]`);
      if (!slot) return;
      const show = (url) => {
        slot.textContent = "";
        const video = m.kind === "video";
        const node = doc.createElement(video ? "video" : "img");
        if (video) { node.controls = true; node.setAttribute("playsinline", ""); node.muted = true; node.setAttribute("muted", ""); node.preload = "metadata"; node.src = url; slot.appendChild(node); return; }
        node.src = url; node.alt = "投稿に付ける画像 " + (j + 1);
        const a = doc.createElement("a");
        a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = "タップで原寸を開く";
        a.appendChild(node); slot.appendChild(a);
        const cap = doc.createElement("div"); cap.className = "src"; cap.textContent = "タップで大きく見られます";
        slot.appendChild(cap);
      };
      const fail = (why) => { slot.textContent = "読めませんでした（" + why + "）"; slot.classList.add("mfail"); };
      const key = typeof m.path === "string" ? m.path : "";
      let hit = mediaCache.get(key);
      if (!hit) {
        hit = fetchMedia(token, m.path).then((url) => ({ url }), (e) => ({ err: (e && e.status === 404) ? "リポジトリに見つかりません" : (e && e.message) || "不明な理由" }));
        mediaCache.set(key, hit);
      }
      slot.textContent = "読み込み中…";
      Promise.resolve(hit).then((x) => { if (x.url) show(x.url); else fail(x.err); });
    }));
  }

  function realHtml(r) {
    let h = "";
    if (r.kind === "posts" && Array.isArray(r.posts)) {
      h += r.posts.map((p, i) => `<div class="post" id="${esc(r.id)}-p${i}"><div class="post-meta"><span><b>${esc(p.day)}</b>　${esc(p.note)}</span><button type="button" class="flagbtn" data-flag="${esc(r.id)}|${i}" aria-pressed="false">ここを直したい</button></div><p>${esc(p.text)}</p>${mediaSlots(r, p, i)}</div>`).join("");
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
    h += `<textarea id="${id}-note" class="ta" rows="2" placeholder="${esc(a.notePlaceholder || "")}"></textarea>`;
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
    /* 中身が空の見出しは出さない（欠けた欄があっても、見出しだけが残らない） */
    const has = (v) => typeof v === "string" ? v.trim() !== "" : v != null;
    const real = realHtml(r);
    const facts = [["お金", r.money], ["取り消せるか", r.reversible], ["効く範囲", r.scope]].filter((x) => has(x[1]));
    const main = [
      has(r.decide) ? `<p class="lead"><b>決めること</b>　${esc(r.decide)}</p>` : "",
      real ? `<div class="real"><div class="real-label">実物</div>${real}</div>` : "",
      has(r.effect) ? `<p class="lead">${esc(r.effect)}</p>` : "",
      has(r.push) ? `<div class="push"><b>推し</b>　${esc(r.push)}</div>` : "",
      facts.length ? `<dl class="facts">${facts.map((x) => `<dt>${x[0]}</dt><dd>${esc(x[1])}</dd>`).join("")}</dl>` : "",
      has(r.source) || commentLink ? `<div class="src">詳しくは ${has(r.source) ? esc(r.source) : ""}${commentLink}</div>` : ""
    ].join("");
    el.innerHTML = `<button type="button" class="req-head" data-toggle="${id}" aria-expanded="false" aria-controls="${id}-body">
        <span class="tags">${urg}${has(r.dept) ? `<span class="pill acc">${esc(r.dept)}</span>` : ""}<span class="pill">Issue #${esc(r.issue)}</span><span class="pill good" id="${id}-sentpill" hidden>回答済み</span>${unknown}</span>
        <span class="rh-title">${esc(has(r.title) ? r.title : (r.short || r.id))}</span>
        <span class="rh-more" id="${id}-more">開いて実物を見る・答える</span>
      </button>
      <div id="${id}-body" hidden>
        ${main ? `<div class="req-main">${main}</div>` : ""}
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
    if (open && DATA) { const r = DATA.requests.find((x) => x.id === el.id); if (r && r.kind === "posts") loadMedia(r, el); }
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

  /* ============ 事業部長に話しかける（#5 に社長のコメントとして書く） ============ */
  const talk = { note: "", images: [], imgSeq: 0, sending: false, status: null, error: null, canDrop: false, imgFail: false, turns: null, loadErr: "", node: null };
  const buildTalkBody = (text) => `<!-- desk:talk -->\n${text}`;

  /* #5 の新しい方のコメントを読む（古い順で返す）。#5 には毎日の報告が溜まるので、全部は読まず、最後のページから戻る */
  async function loadTalkComments(token) {
    const issue = await (await gh(repoPath(`/issues/${CONFIG.talkIssue}`), token)).json();
    const total = +issue.comments || 0;
    if (!total) return [];
    const per = CONFIG.perPage, last = Math.ceil(total / per);
    let out = [];
    for (let page = last; page >= 1 && out.length < CONFIG.talkFetch; page--) {
      const list = await (await gh(repoPath(`/issues/${CONFIG.talkIssue}/comments?per_page=${per}&page=${page}`), token)).json();
      if (Array.isArray(list)) out = list.concat(out);
    }
    return out;
  }

  const isReport = (c) => /^\s*【事業部長】毎日の報告/.test((c && c.body) || "");

  /* コメントを1件ずつ、新しい順に n 件並べる（社長の言葉・返事・毎日の報告を区別せず、created_at の降順）。
     社長の相談で、次の社長の言葉や報告の前に返事が無いものには pending を付ける（「まだ返事はありません」用） */
  function buildTurns(comments, n) {
    const list = (comments || []).filter(Boolean);
    const items = [];
    list.forEach((c, i) => {
      const base = { text: c.body || "", at: c.created_at, url: c.html_url || "" };
      if (c.user && c.user.login === CONFIG.boss) {
        const kind = TALK_RE.test(base.text) ? "talk" : /^\s*<!--\s*desk:answer/.test(base.text) ? "answer" : "plain";
        let replied = false;
        for (let j = i + 1; j < list.length; j++) {
          const d = list[j];
          if ((d.user && d.user.login === CONFIG.boss) || isReport(d)) break;
          replied = true; break;
        }
        items.push({ who: "boss", ...base, text: base.text.replace(ANY_MARK_RE, ""), kind, pending: kind !== "answer" && !replied, i });
      } else items.push({ who: isReport(c) ? "report" : "mgr", ...base, i });
    });
    const t = (x) => Date.parse(x.at) || 0;
    items.sort((x, y) => t(y) - t(x) || y.i - x.i);
    return items.slice(0, n);
  }

  const speaker = (text) => { const m = /^\s*【([^】]{1,20})】/.exec(text); return m ? m[1] : "返事"; };
  function bubbleHtml(who, cls, text, at, url) {
    const t = String(text).trim();
    const link = url && safeHref(url) ? `　<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">GitHub で見る</a>` : "";
    const head = `<div class="bub-h"><b>${esc(who)}</b>　${esc(jst(at))}${link}</div>`;
    if (t.length > 300 || t.split("\n").length > 8) {
      const first = t.split("\n").find((l) => l.trim()) || "";
      return `<div class="bub ${cls}">${head}<details><summary>${esc(first.length > 40 ? first.slice(0, 40) + "…" : first)}（長いので畳んでいます）</summary><p class="bub-t">${esc(t)}</p></details></div>`;
    }
    return `<div class="bub ${cls}">${head}<p class="bub-t">${esc(t)}</p></div>`;
  }
  function turnHtml(t) {
    let h;
    if (t.who === "report") h = bubbleHtml("事業部長の毎日の報告", "rep", t.text, t.at, t.url);
    else if (t.who === "boss") h = bubbleHtml(t.kind === "answer" ? "社長（依頼への答え）" : "社長", "me", t.text, t.at, t.url) + (t.pending ? `<p class="hint">まだ返事はありません。事業部長が読むと、ここに出ます（「読み直す」で更新）。</p>` : "");
    else h = bubbleHtml(speaker(t.text), "mgr", t.text, t.at, t.url);
    return `<div class="turn">${h}</div>`;
  }

  const talkImgsHtml = (list) => list.map((im, i) => `<figure class="thumb"><img src="${esc(im.dataUrl)}" alt="付ける画像 ${i + 1}"><button type="button" class="x" data-talk="rm|${i}" aria-label="画像 ${i + 1} を外す">外す</button></figure>`).join("");

  function talkNode() {
    if (talk.node) return talk.node;
    const el = doc.createElement("section");
    el.className = "panel"; el.id = "talk-panel";
    el.innerHTML = `
      <p class="hint">確認してほしいこと・調べてほしいことを、止まっているものがなくても、いつでもここから送れます。Issue #${esc(CONFIG.talkIssue)} に社長のコメントとして書き、事業部長が読みます。</p>
      <label class="sr" for="talk-note">事業部長への一言</label>
      <textarea id="talk-note" class="ta" rows="3" placeholder="例：〇〇について調べて／△△はどうなっている？"></textarea>
      <div class="imgbox"><div class="imgs" id="talk-imgs"></div><button type="button" class="linkbtn" data-talk="pick">画像を付ける（写真・スクリーンショット）</button><input class="sr" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" data-talkfile="1" id="talk-file"></div>
      <div class="btnrow"><button type="button" class="btn primary" data-talk="send" id="talk-go">事業部長に送る</button></div>
      <div id="talk-msg" role="status" class="hint"></div>
      <div class="lbl" style="margin-top:12px">最近のやり取り（新しい順）　<button type="button" class="linkbtn" data-talk="refresh">読み直す</button></div>
      <div id="talk-list"></div>`;
    talk.node = el;
    return el;
  }

  function paintTalk() {
    const el = talkNode();
    el.querySelector("#talk-imgs").innerHTML = talkImgsHtml(talk.images);
    const msg = el.querySelector("#talk-msg");
    if (talk.error) {
      const prog = talk.images.length && talk.imgFail ? `画像：${talk.images.length} 枚のうち ${talk.images.filter((x) => x.saved).length} 枚は保存できました。` : "事業部長にはまだ届いていない可能性が高いです。";
      msg.innerHTML = `<div class="sent ng" role="alert"><b>送れませんでした。</b>${esc(talk.error)}。${esc(prog)}書いた文は残してあるので、もう一度「事業部長に送る」を押せます。${talk.canDrop && talk.images.length ? `<div class="btnrow"><button type="button" class="btn" data-talk="drop">画像を外して、言葉だけ送る</button></div>` : ""}</div>`;
    } else if (talk.status) msg.innerHTML = `<div class="sent" role="status">${esc(talk.status)}</div>`;
    else msg.textContent = "";
    const list = el.querySelector("#talk-list");
    if (talk.loadErr) list.innerHTML = `<p class="notice">${esc(talk.loadErr)}</p>`;
    else if (!talk.turns) list.innerHTML = `<p class="hint">読み込み中…</p>`;
    else if (!talk.turns.length) list.innerHTML = `<p class="hint">まだやり取りはありません。</p>`;
    else {
      const head = talk.turns.slice(0, CONFIG.talkOpen), rest = talk.turns.slice(CONFIG.talkOpen);
      list.innerHTML = head.map(turnHtml).join("") + (rest.length ? `<details><summary>それより前のやり取り（${rest.length}件）</summary>${rest.map(turnHtml).join("")}</details>` : "");
    }
    el.querySelector("#talk-go").disabled = talk.sending;
  }

  async function loadTalk() {
    try {
      talk.turns = buildTurns(await loadTalkComments(keyStore.get()), CONFIG.talkItems);
      talk.loadErr = "";
    } catch (e) {
      talk.loadErr = "やり取りを読めませんでした（" + reasonOf(e, "load") + "）。送ることはできます";
    }
    paintTalk();
  }

  async function addTalkImages(files) {
    const list = [...files].filter((f) => f && (/^image\//.test(f.type || "") || !f.type));
    if (!list.length) return;
    let bad = 0, over = 0;
    for (const f of list) {
      if (talk.images.length >= CONFIG.maxImages) { over++; continue; }
      try {
        const sh = await shrinkImage(f);
        talk.imgSeq++;
        talk.images.push({ dataUrl: sh.dataUrl, base64: sh.base64, path: imagePath("talk", talk.imgSeq), saved: false });
      } catch (e) { bad++; }
    }
    paintTalk();
    const parts = [];
    if (over) parts.push(`1回に付けられるのは ${CONFIG.maxImages} 枚までです`);
    if (bad) parts.push(`${bad} 枚は読めませんでした`);
    if (parts.length) talkNode().querySelector("#talk-msg").textContent = parts.join("。") + "。";
  }

  async function sendTalk() {
    if (talk.sending) return;
    const ta = talkNode().querySelector("#talk-note");
    talk.note = ta.value;
    const text = talk.note.trim() + imageLines(talk);
    if (!text.trim()) { talk.status = null; talk.error = null; paintTalk(); talkNode().querySelector("#talk-msg").textContent = "送る言葉か画像を入れてください。"; return; }
    talk.sending = true; talk.error = null; talk.status = null; talk.canDrop = false; talk.imgFail = false;
    paintTalk();
    const msg = talkNode().querySelector("#talk-msg");
    try {
      for (const im of talk.images) {
        if (im.saved) continue;
        msg.textContent = `画像を保存しています…（${talk.images.filter((x) => x.saved).length + 1} / ${talk.images.length}）`;
        try { await putImage(keyStore.get(), im, "talk"); im.saved = true; }
        catch (e) { talk.imgFail = true; if (e.status === 403 || e.status === 404) talk.canDrop = true; throw Object.assign(e, { phase: "image" }); }
      }
      msg.textContent = "送っています…";
      const res = await gh(repoPath(`/issues/${CONFIG.talkIssue}/comments`), keyStore.get(), { method: "POST", body: { body: buildTalkBody(text) } });
      await res.json().catch(() => ({}));
      talk.note = ""; ta.value = ""; talk.images = []; talk.imgSeq = 0;
      talk.status = "送りました。事業部長が読みます（返事は下に出ます）。";
    } catch (e) {
      talk.error = reasonOf(e, e && e.phase === "image" ? "image" : "send");
    }
    talk.sending = false;
    paintTalk();
    if (!talk.error) await loadTalk();
  }

  /* いいね候補の「済み」と畳み。この端末の localStorage に「日付|リンク」で残す。使えなければ、開いている間だけ覚える */
  const LIKES_KEY = "desk.likes";
  let likeMem = {};
  function likeRead() { try { const o = JSON.parse(global.localStorage.getItem(LIKES_KEY) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } }
  function likeMark(k) { const m = Object.assign({}, likeRead(), likeMem); return m[k]; }
  function likeSet(k, v) {
    likeMem[k] = v;
    const o = likeRead(); if (v == null) delete o[k]; else o[k] = v;
    if (v == null) delete likeMem[k];
    try { global.localStorage.setItem(LIKES_KEY, JSON.stringify(o)); } catch (e) { /* 残せなくても、開いている間は動く */ }
  }
  /* 今日の候補の日付以外の記録は消す（翌日に持ち越さない） */
  function likePurge(date) {
    const keep = (k) => String(k).startsWith(date + "|");
    Object.keys(likeMem).forEach((k) => { if (!keep(k)) delete likeMem[k]; });
    const o = likeRead(); let ch = false;
    Object.keys(o).forEach((k) => { if (!keep(k)) { delete o[k]; ch = true; } });
    if (ch) { try { global.localStorage.setItem(LIKES_KEY, JSON.stringify(o)); } catch (e) { /* 消せなくても画面は進める */ } }
  }
  function likeRepaint() {
    const el = $("#likes"); if (!el) return;
    const tmp = global.document.createElement("div"); tmp.innerHTML = likesHtml();
    const nw = tmp.firstElementChild; if (nw) el.replaceWith(nw);
  }

  /* 今日のいいね候補。X部が data/desk-likes.json に書く。日付が今日でなければ「まだ出ていません」にして、古い候補は押させない */
  function likesHtml() {
    const L = LOAD && LOAD.likes;
    if (!L) return "";
    const today = todayNum();
    const head = `<div class="lbl">今日のいいね候補</div>`;
    const dn = dayNum(L.date);
    if (L.state === "error") return `<section class="p s12" id="likes">${head}<p class="src">今日の候補を読めませんでした。<span class="unk">${esc(L.reason || "原因がわかりませんでした")}</span></p></section>`;
    if (L.state === "missing" || dn !== today) {
      const last = L.state === "ok" && isFinite(dn) ? `最後：${mdOf(L.date)}` : "出た日はまだありません";
      return `<section class="p s12" id="likes">${head}<p class="src">今日の候補はまだ出ていません（${last}）。</p></section>`;
    }
    likePurge(L.date);
    const key = (u) => L.date + "|" + u;
    const rows = L.items.map((x) => ({ x, href: safeHref(x.url) }));
    const todo = rows.filter((r) => r.href);
    const left = todo.filter((r) => !likeMark(key(r.href))).length;
    const allDone = todo.length > 0 && left === 0;
    const pref = likeMark(key("fold"));   // "1" 畳む / "0" 開く / 無ければ自動（全部済みなら畳む）
    const folded = pref === "1" ? true : pref === "0" ? false : allDone;
    const state = !todo.length ? "" : allDone ? `${todo.length}件すべて済み` : `残り${left}件`;
    const headBtn = todo.length
      ? `<button type="button" class="like-fold" data-like-fold="1" aria-expanded="${folded ? "false" : "true"}"><span class="lbl">今日のいいね候補</span><span class="like-state${allDone ? " done" : ""}">${state}</span><span class="like-arrow" aria-hidden="true">${folded ? "▸" : "▾"}</span></button>`
      : head;
    if (folded) return `<section class="p s12 folded" id="likes">${headBtn}</section>`;
    const items = rows.map(({ x, href }) => {
      const done = href && likeMark(key(href));
      const q = `<div class="like-q">${x.note ? esc(String(x.note)) : "（一言なし）"}</div>`;  // 投稿の文面（quote）は X の規約で出さない。ファイルに入っていても読まない
      const act = !href ? `<span class="unk">リンクの形が開けないものだったので外しました</span>`
        : done ? `<div class="like-row"><span class="like-done">済み</span><button type="button" class="btn like-undo" data-like-undo="${esc(href)}">戻す</button></div>`
        : `<a class="btn like-go" href="${esc(href)}" data-like-go="1" target="_blank" rel="noopener noreferrer">いいねを押す（X が開きます）</a>`;
      return `<li class="like${done ? " is-done" : ""}">${q}${act}</li>`;
    }).join("");
    const info = [
      L.removed != null && L.removed !== "" ? `除いたもの：${esc(L.removed)}件` : "",
      L.follow ? `フォロー候補：${esc(L.follow)}` : "",
      "リンクを押すと X の確認画面が出ます。押すと「済み」になります（X で本当に押したかは見ていません）。飛ばしても大丈夫です"
    ].filter(Boolean).map((t) => `<div class="src">${t}</div>`).join("");
    const orig = safeHref(L.commentUrl) ? `<a class="src" href="${esc(safeHref(L.commentUrl))}" target="_blank" rel="noopener noreferrer">GitHub の元のコメント</a>` : "";
    return `<section class="p s12" id="likes">${headBtn}${L.items.length ? `<ul class="likelist">${items}</ul>` : `<p class="src">今日は押す候補がありません。</p>`}${info}${orig}</section>`;
  }

  async function onClickBase(e) {
    const jl = e.target.closest("a[data-jump]");
    if (jl) { e.preventDefault(); if (DATA) jumpTo(jl.dataset.jump); return; }
    const lg = e.target.closest("a[data-like-go]");
    if (lg) {   // 押したら済みにする。リンクは普通に開かせ、描き直しは少し後にする
      const L = LOAD && LOAD.likes;
      if (L && L.date) likeSet(L.date + "|" + safeHref(lg.getAttribute("href")), "1");
      global.setTimeout(likeRepaint, 0); return;
    }
    const t = e.target.closest("button"); if (!t) return;
    const ds = t.dataset;
    if (ds.likeUndo != null || ds.likeFold != null) {
      const L = LOAD && LOAD.likes; if (!L || !L.date) return;
      if (ds.likeUndo != null) likeSet(L.date + "|" + ds.likeUndo, null);
      else { const folded = t.getAttribute("aria-expanded") === "false"; likeSet(L.date + "|fold", folded ? "0" : "1"); }
      likeRepaint(); return;
    }
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
    if (ds.talk) {
      const [cmd, arg] = ds.talk.split("|");
      if (cmd === "send") return sendTalk();
      if (cmd === "refresh") return loadTalk();
      if (cmd === "pick") { const inp = $("#talk-file"); if (inp) inp.click(); return; }
      if (cmd === "rm") { talk.images.splice(+arg, 1); paintTalk(); return; }
      if (cmd === "drop") {
        if (talk.sending) return;
        talk.images = []; talk.imgSeq = 0; talk.canDrop = false; talk.imgFail = false; talk.error = null;
        return sendTalk();
      }
      return;
    }
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


  /* ============ 画面 ============ */
  let DATA = null;              // いま表示している desk.json の中身
  let LOAD = null;              // いちばん新しい読み込みの結果
  let lastOk = null;            // 最後に読み込めた時刻
  let VISIT = null;             // 前に開いた時刻（開いたときに1回だけ決める）
  let state = {};               // 依頼ごとの入力と送信の状態
  const nodes = new Map();      // 依頼カードは読み込みごとに1回だけ作り、切り替えでは使い回す
  let cur = "home";
  let sinceTab = "made";
  let runsAll = false;
  let pendingJump = null;

  const NAV = [["home", "ホーム"], ["turn", "社長の番"], ["apps", "アプリ"], ["marketing", "宣伝"], ["cand", "アプリの案"], ["depts", "部署"], ["numbers", "数字"], ["system", "部署を動かす仕組み"]];
  const IC = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const TABS = [
    ["home", "ホーム", IC('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>')],
    ["turn", "社長の番", IC('<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5v.5"/>')],
    ["apps", "アプリ", IC('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>')],
    ["talk", "話す", IC('<path d="M4 5h16v11H9l-5 4z"/>')],
    ["more", "その他", IC('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>')]
  ];
  // 会社の組織（CLAUDE.md の「組織」と同じ。部署が増えたらここに足す）
  const PURPOSE = {
    "事業部長": "開発と宣伝の両方を進め、社長に聞くことをまとめる進行役。",
    "企画部": "審査を通ったアプリの案を、作る中身（機能の全部）に広げる。",
    "開発部": "企画とデザインを、社長の iPhone で動くアプリにする。",
    "試用部": "社長に見せる前に、使う人になって触り、使い続けたくなくなる所を指摘する。",
    "ストア担当": "ストアで探している人に見つけてもらうための、ページの中身（言葉・説明・見せ方）を持つ。",
    "X部": "X で作る過程と悩みのあるあるを出し、応援してくれる人と登録してくれる人を集める。",
    "縦動画部": "縦動画を1本作り、TikTok・Instagram・YouTube の3か所に出す。",
    "Threads部": "Threads で、悩みのあるあるや日常を文章で出す。",
    "リサーチ部": "毎週土曜に、売れそうなアプリの案を探して事実を集める（点数は付けない）。",
    "審査部": "アプリの案や外に出すものを、採点基準や規約に照らして確かめ、通す・直すを決める。",
    "デザイン部": "企画を、迷わず使える画面と絵にする（アプリの画面、アイコン、ストアの絵）。",
    "ナレッジ部": "社長の言葉と部署の学びを、ほかのアプリでも使えるように整理して残す。"
  };
  const GROUPS = [
    ["事業部長", "開発と宣伝の両方を1人で進め、社長に聞くことをまとめる。", ["事業部長"]],
    ["開発：アプリを作る", "アプリの中身を決め、作り、使う人の目で確かめる3部署。", ["企画部", "開発部", "試用部"]],
    ["宣伝：使いそうな人に見つけてもらう", "ストアと SNS で、悩みのある人にアプリを見つけてもらう4部署。", ["ストア担当", "X部", "縦動画部", "Threads部"]],
    ["開発と宣伝の両方の仕事を受ける", "どちらの仕事も受ける4部署。", ["リサーチ部", "審査部", "デザイン部", "ナレッジ部"]]
  ];
  const ALL_DEPTS = GROUPS.flatMap((g) => g[2]);

  const LEVELS = ["ok", "warn", "stop"];
  const STATE_JA = { done: "済み", now: "いま", plan: "予定", undated: "日付未定" };
  const hm = (iso) => { const t = Date.parse(iso); return isFinite(t) ? jst(iso) : "時刻不明"; };
  const reasonShort = (e) => {
    const s = e && e.status;
    if (s === 401) return "鍵が使えませんでした";
    if (s === 403) return "鍵の権限が足りません（Actions・Contents・Issues の読み取りが要ります）";
    if (s === 404) return "見つかりませんでした（鍵の対象に app-company が入っているか確かめてください）";
    return (e && e.message) || "原因がわかりませんでした";
  };
  const missHtml = (what, e) => `<div class="miss"><b>${esc(what)}</b>：読めませんでした（${esc(reasonShort(e))}）。ほかの面は読めています。</div>`;
  const staleHtml = () => {
    const st = deskStale(DATA.asOf, todayNum());
    return st ? `<div class="warnbox"><b>元のデータが ${esc(st.md)} のまま更新されていません</b>（${st.days}日前）。日程と返事待ちは、その時点の内容です。事業部長が desk.json を書き直すと新しくなります。</div>` : "";
  };
  const snap = () => (LOAD ? `${jst(LOAD.loadedAt)} 時点` : "");
  const nReq = () => (DATA ? openAll().length : 0);

  const issueLabel = (n) => {
    if (n == null) return "";
    if (n === CONFIG.talkIssue) return "事業部長との会話";
    if (n === CONFIG.likesIssue) return "押すだけの候補";
    const rows = DATA ? DATA.timeline.flatMap((g) => g.rows.filter((r) => r.issue === n).map((r) => ({ r, g }))) : [];
    if (rows.length === 1) return rows[0].r.label || `#${n}`;
    if (rows.length > 1 && rows.every((x) => x.g.group === "広める")) return "宣伝";
    return `#${n}`;
  };

  /* ---- 部品 ---- */
  const P = (title, cls, body, meta) => `<section class="p ${cls}"><h3><span>${title}</span>${meta ? `<i>${meta}</i>` : ""}</h3>${body}</section>`;
  const G = (h) => `<div class="grid">${h}</div>`;
  const bar = (title, lead, back) => (back ? `<button class="back" data-go="${back[0]}">‹ ${back[1]}</button>` : "") + `<header class="bar"><h1>${title}</h1><span class="asof">${esc(snap())}</span></header>` + (lead ? `<p class="lead">${lead}</p>` : "");
  const lamp = (c) => `<span class="lamp ${c}"></span>`;
  const rw = (l, r) => `<div class="rw"><span>${l}</span><span>${r}</span></div>`;
  const go = (t, label) => `<button class="go" data-go="${t}">${label} ›</button>`;
  function cells(segs, withLabels) {
    let c = "", l = "";
    segs.forEach((s) => { const cl = s.state === "done" ? "d" : s.state === "now" ? "n" : ""; c += `<span class="${cl}"></span>`; if (withLabels) l += `<span class="${cl}">${esc(s.name)}</span>`; });
    return `<div class="cells">${c}</div>` + (withLabels ? `<div class="lb">${l}</div>` : "");
  }
  const openAll = () => DATA.requests.filter((r) => !(state[r.id] && state[r.id].sent));
  const blocking = (rowId) => DATA.requests.filter((r) => r.row === rowId && !(state[r.id] && state[r.id].sent));
  const nowNames = (row) => (row.segments || []).filter((s) => s.state === "now").map((s) => s.name);
  const runningDepts = () => (LOAD && LOAD.active ? [...new Set(LOAD.active.running.map((x) => STAGE_JA[x.stage] || x.stage))] : []);
  const queuedDepts = () => (LOAD && LOAD.active ? [...new Set(LOAD.active.waiting.map((x) => STAGE_JA[x.stage] || x.stage))] : []);

  /* アプリの1行：段階の目盛り（線表の区間をそのまま使う）と、いまの一言（線表と依頼から機械で作る） */
  function ladApp(row, withWhat) {
    const now = nowNames(row);
    const right = now.length ? now.join("・") : (row.segments.length && row.segments.every((s) => s.state === "done") ? "すべて済み" : "いま進めている区間なし");
    let what = "";
    if (withWhat) {
      const bl = blocking(row.id), waits = (row.segments || []).filter((s) => s.wait).map((s) => s.wait);
      what = [bl.length ? `社長の返事待ち：${bl.map((r) => r.short || r.title).join("・")}` : "", waits.length ? `外の返事待ち：${[...new Set(waits)].join("・")}` : ""].filter(Boolean).join(" ／ ");
      what = what ? `<div class="what">${esc(what)}</div>` : "";
    }
    return `<div class="lad"><div class="nm"><span>${esc(row.label || row.id)}</span><span>${esc(right)}</span></div>${cells(row.segments || [], true)}${what}</div>`;
  }
  function mkRows(rows) {
    return rows.map((r) => {
      const segs = r.segments || [];
      const idx = segs.findIndex((s) => s.state === "now");
      const nm = idx >= 0 ? `いまは「${segs[idx].name}」（${segs.length}段階の${idx + 1}つ目）` : "いま進めている区間はありません";
      return `<div class="pr"><div class="t"><b>${esc(r.label || r.id)}</b><span>${esc(nm)}</span></div>${cells(segs, false)}</div>`;
    }).join("");
  }
  function nowOf(row) {
    const bl = blocking(row.id);
    if (bl.length) return ["me", `社長の返事待ち（${bl[0].short || bl[0].title}）`];
    const w = (row.segments || []).find((s) => s.wait);
    if (w) return ["warn", w.wait];
    const act = LOAD && LOAD.active && LOAD.active.running.find((x) => x.issue === row.issue);
    if (act) return ["now", `${STAGE_JA[act.stage] || act.stage}が作業しています`];
    return ["ok", "いま止まっているものはありません"];
  }
  const lampOf = (c) => (c === "me" ? "r" : c === "warn" ? "a" : c === "now" ? "g" : "g");

  const exchHtml = (arr) => arr.map((e) => `<div class="lg"><span class="tm">${esc(hm(e.at))}</span><span class="tg">${esc(e.who)}</span><div>${esc(e.body)}</div></div>`).join("") || `<div class="empty">まだありません</div>`;
  const commitRow = (m) => `<div class="lg"><span class="tm">${esc(hm(m.at))}</span><span class="tg">${esc(m.app || "全体")}</span><div>${esc(m.s)}</div></div>`;

  /* ---- ホーム ---- */
  function sinceBody() {
    const S = LOAD.since;
    if (LOAD.errors.commits && sinceTab === "made") return missHtml("開発部が作った機能", LOAD.errors.commits);
    if (sinceTab === "made") return S.made.map(commitRow).join("") || `<div class="empty">ありません</div>`;
    return S.words.map((w) => `<div class="lg"><span class="tm">${esc(hm(w.at))}</span><span class="tg">社長</span><div>${esc(w.said)}<div class="dim" style="margin-top:2px">${esc(issueLabel(w.issue))}（Issue #${w.issue}）</div></div>${w.effect ? `<div class="nt">そのあとの AI の返事：${esc(w.effect)}</div>` : ""}</div>`).join("") || `<div class="empty">ありません</div>`;
  }
  function pHome() {
    const g0 = groupsOf(DATA);
    const run = runningDepts(), que = queuedDepts(), A = LOAD.active, E = LOAD.errors;
    const doneRuns = LOAD.runs.filter((r) => r.status === "completed" && (r.concl === "success" || RUN_FAIL.has(r.concl))).slice(0, 30);
    const okN = doneRuns.filter((r) => r.concl === "success").length, sys = okN === doneRuns.length;
    const lastRun = LOAD.runs[0];
    const n = nReq();
    let h = bar("ホーム", "いま社長が知っておくことだけを並べています。くわしくは左の一覧（スマホは「その他」）から各ページへ。");
    if (E.desk) h += missHtml("画面の元データ（desk.json）", E.desk);
    let g = "";
    g += P("社長に答えてほしいこと", "s4 k", `<div class="big">${lamp(n ? "r" : "g")}${n}<small>件</small></div><div class="note">${n ? DATA.requests.filter((r) => !state[r.id].sent).slice(0, 3).map((r) => `<a href="#turn" data-jump="${esc(r.id)}">${esc(r.short || r.title)}</a>`).join("・") : "いま答えを待っているものはありません。"}</div>` + go("turn", "社長の番を開く"));
    g += P("いま動いている部署", "s4 k", A
      ? `<div class="big">${run.length}<small>/ ${ALL_DEPTS.length} 部署</small></div><div class="note">順番待ちは ${A.waiting.length} 件。${run.length ? esc(run.join("・")) + " が作業中。" : "いま作業中の部署はありません。"}${lastRun ? `直近の実行は ${esc(lastRun.dept)}（${esc(hm(lastRun.at))}）。` : ""}</div>` + go("depts", "部署のページを開く")
      : missHtml("いま動いている部署", E.active || new ApiError(0, "")) + go("depts", "部署のページを開く"));
    g += P("部署を動かす仕組みは止まっていないか", "s4 k o12", E.runs ? missHtml("実行の履歴", E.runs) + go("system", "仕組みのページを開く")
      : `<div class="big" style="font-size:44px">${lamp(sys ? "g" : "a")}${sys ? "正常" : "要確認"}</div><div class="note">${sys ? `直近 ${doneRuns.length} 回の実行はすべて成功。` : `失敗した実行があります（直近 ${doneRuns.length} 回のうち ${okN} 回が成功）。`}${lastRun ? `最新は ${esc(hm(lastRun.at))}。` : ""}</div>` + go("system", "仕組みのページを開く"));
    const wt = DATA.waiting[0];
    g += P("アプリの進み具合", "s6", (g0.apps.map((r) => ladApp(r, true)).join("") || `<div class="empty">線表にアプリの行がありません</div>`) + (wt ? `<div class="note" style="margin-top:4px">${lamp("a")}いま待っているもの：${esc(wt.text)}。</div>` : "") + go("apps", "アプリのページを開く"));
    g += P("宣伝の進み具合", "s6", (mkRows(g0.mk) || `<div class="empty">線表に宣伝の行がありません</div>`) + go("marketing", "宣伝のページを開く"));
    const baseTxt = VISIT.kind === "first" ? `初めて開いたので、きのうのこの時刻（${jst(new Date(VISIT.baseline).toISOString())}）から数えています。` : `前に開いたのを ${jst(new Date(VISIT.baseline).toISOString())} として数えています。`;
    g += P("前にこの画面を開いてから増えたこと", "s12", `<p class="sub" style="margin:0 0 10px">${esc(baseTxt)}押すと中身が見えます。</p>`
      + `<div class="tabs2"><button class="tab2 ${sinceTab === "made" ? "on" : ""}" data-since="made"><b>${LOAD.since.made.length}件</b>開発部が作った機能</button><button class="tab2 ${sinceTab === "words" ? "on" : ""}" data-since="words"><b>${LOAD.since.words.length}件</b>社長が書いたコメント</button></div><div id="sincebody">${sinceBody()}</div>`);
    return h + G(g);
  }

  /* ---- 社長の番 ---- */
  function pTurn() {
    const E = LOAD.errors;
    let h = bar("社長の番", "事業部長が社長に聞きたいこと（答えるまで進めないもの）と、これまでの承認の記録です。");
    if (E.desk) h += missHtml("画面の元データ（desk.json）", E.desk);
    const n = nReq();
    let g = P("いま答えてほしいこと", "s12", (n === 0 ? `<div class="big" style="font-size:44px">${lamp("g")}0<small>件</small></div><div class="note">いま答えを待っているものはありません。</div>` : "")
      + (LOAD.unknownIssues.length ? `<div class="warnbox">Issue #${LOAD.unknownIssues.join("・#")} のコメントが読めず、答え済みかどうか確かめられませんでした。二重に答えないよう、GitHub で確かめてから答えてください。</div>` : "")
      + (DATA.requests.length ? `<div id="req-slot"></div>` : ""));
    if (E.approvals) g += P("承認の記録", "s12", missHtml("承認の記録（approvals.jsonl）", E.approvals));
    else {
      const A = LOAD.approvals, ap = A.filter((a) => a.decision === "approved").length, md2 = A.filter((a) => a.modified).length;
      g += P("承認と却下の数", "s12", `<div class="fun three"><div><b>${ap}</b><small>承認</small></div><div><b>${A.length - ap}</b><small>却下</small></div><div><b>${md2}</b><small>社長が直してから承認</small></div></div>`);
      g += P(`これまでの承認の記録（${A.length}件・新しい順）`, "s12", A.map((a) => `<div class="lg"><span class="tm">${esc(mdOf(a.date))}</span><span class="pill ${a.decision === "approved" ? "ok" : "stop"}">${a.decision === "approved" ? "承認" : "却下"}</span><div>${esc(a.subject)}<div class="dim">${esc(a.type)}${a.modified ? "　／　社長が直してから承認" : ""}</div></div></div>`).join("") || `<div class="empty">記録はまだありません</div>`);
    }
    return h + G(g);
  }

  /* ---- アプリ ---- */
  function pApps() {
    const rows = groupsOf(DATA).apps, E = LOAD.errors;
    let h = bar("アプリ", "いま作っているアプリです。押すと、くわしいページが開きます。");
    let g = "";
    rows.forEach((r) => {
      const c = caseOf(r);
      g += P(esc(r.label || r.id), "s6", ladApp(r, true) + (c ? `<div class="sub" style="margin-top:8px">${esc(c.summary || "")}</div>` : "") + `<div class="dim" style="margin-top:6px">最後に動いたのは ${esc(movedOf(r.issue))}</div>` + go("app/" + r.id, `${esc(r.label || r.id)}のくわしいページ`));
    });
    if (!rows.length) g += P("アプリ", "s12", `<div class="empty">線表にアプリの行がありません</div>`);
    g += P("最近作った機能（前に開いてから）", "s12", E.commits ? missHtml("作った機能", E.commits) : LOAD.since.made.map(commitRow).join("") || `<div class="empty">ありません</div>`, E.commits ? "" : `${LOAD.since.made.length}件`);
    return h + G(g);
  }
  function caseOf(row) { return (LOAD.cases || []).find((c) => c.name && row.label && (c.name.includes(row.label) || row.label.includes(c.name))); }
  function movedOf(issue) {
    const ts = [];
    LOAD.runs.forEach((r) => { if (r.issue === issue) ts.push(Date.parse(r.at)); });
    (LOAD.comments[issue] || []).forEach((x) => ts.push(Date.parse(x.created_at)));
    const m = Math.max(...ts.filter(isFinite));
    return isFinite(m) ? jst(new Date(m).toISOString()) : "記録なし";
  }
  function expHtml(row) {
    const e = LOAD.errors.comments[row.issue];
    if (e) return missHtml(`Issue #${row.issue} のコメント`, e);
    const x = latestExp(LOAD.comments[row.issue]);
    if (!x) return `<div class="sub">実機で開くリンク（exp://）は、Issue #${row.issue} のコメントに見つかりませんでした。</div>`;
    return `<p class="sub" style="margin:0 0 10px">社長の iPhone で動かすためのリンクです。最後に貼られたのは ${esc(hm(x.at))}。Safari に貼って、Expo Go で開きます（exp:// のリンクは、直接押しても開かないことがあります）。</p><code class="code" id="x-${esc(row.id)}">${esc(x.url)}</code><div style="margin-top:10px"><button class="btn sm pri" data-xcopy="${esc(x.url)}" data-sel="x-${esc(row.id)}">リンクをコピー</button></div>`;
  }
  function filesHtml(row) {
    const e = LOAD.errors.files && LOAD.errors.files[row.id], f = LOAD.files[row.id];
    if (e) return missHtml(`apps/${row.label} のファイル一覧`, e);
    if (!f) return `<div class="empty">読み込んでいません</div>`;
    const list = (arr, empty) => {
      const one = (x) => `<div class="dl2"><div class="l">${esc(x.at ? mdOf(jstDay(x.at)) : "日付不明")}</div><div>${safeHref(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a>` : esc(x.name)}</div></div>`;
      return arr.length ? arr.slice(0, 3).map(one).join("") + (arr.length > 3 ? `<details><summary>ほか ${arr.length - 3} 件</summary>${arr.slice(3).map(one).join("")}</details>` : "") : `<div class="empty">${empty}</div>`;
    };
    return `<div class="l" style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--sub)">企画のファイル（新しい順）</div>${list(f.plan, "企画のファイルは見つかりませんでした")}<div class="l" style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--sub);margin-top:10px">試用部の試用メモ（新しい順）</div>${list(f.trial, "試用メモは見つかりませんでした")}<div class="dim" style="margin-top:8px">題は apps/${esc(row.label)}/ の「企画」「試用メモ」で始まるファイル名、日付はそのファイルを最後に変えた記録の日です。中身の要約は、この画面ではまだ出せません。</div>`;
  }
  function pApp(id) {
    const row = groupsOf(DATA).apps.find((r) => r.id === id);
    if (!row) return bar("アプリ", "このアプリは線表にありません。", ["apps", "アプリの一覧へ"]);
    const n = nowOf(row), c = caseOf(row);
    let h = bar(esc(row.label || row.id), `GitHub の会話は Issue #${row.issue}。最後に動いたのは ${esc(movedOf(row.issue))}。`, ["apps", "アプリの一覧へ"]);
    let g = P("いまどの段階か", "s6", ladApp(row, true) + `<div class="note" style="margin-top:4px">${lamp(lampOf(n[0]))}${esc(n[1])}</div>`);
    g += P("実機で見る", "s6", expHtml(row));
    g += P("企画と試用メモ", "s12", (c ? `<div class="dl2"><div class="l">案の要約</div><div>${esc(c.summary || "")}</div></div>` : "") + filesHtml(row));
    const ex = LOAD.errors.comments[row.issue] ? missHtml(`Issue #${row.issue} のコメント`, LOAD.errors.comments[row.issue]) : exchHtml(exchanges(LOAD.comments[row.issue], 6));
    g += P("社長と事業部長のやり取り", "s12", ex, `Issue #${row.issue}・新しい順に6件`);
    return h + G(g);
  }

  /* ---- 宣伝 ---- */
  function ganttHtml() {
    const today = todayNum(), gn = dayNum(DATA.goal.date), all = [];
    DATA.timeline.forEach((g) => g.rows.forEach((r) => (r.segments || []).forEach((s) => all.push(dayNum(s.from), dayNum(s.to)))));
    const fin = all.filter(isFinite);
    const given = (k, d) => { const v = dayNum((DATA.range || {})[k]); return isFinite(v) ? v : d; };
    const S = given("from", Math.min(today - 1, ...fin)), E = given("to", Math.max(isFinite(gn) ? gn + 9 : today + 30, ...fin));
    const span = Math.max(1, E - S), pct = (n) => (Math.min(100, Math.max(0, ((n - S) / span) * 100))).toFixed(2) + "%";
    const x = DATA.timeline.map((gp) => {
      let o = `<div class="gg">${esc(gp.group)}</div>`;
      gp.rows.forEach((r) => {
        o += `<div class="gr"><div>${esc(r.label || r.id)}</div><div class="gt"><div class="today" style="left:${pct(today)}"></div>`;
        resolveSegments(r, today, gn, S).filter((s) => s.b > S && s.a < E && s.b > s.a).forEach((s) => {
          const cl = STATE_JA[s.state] ? s.state : "plan", l = ((Math.max(S, s.a) - S) / span) * 100, w = Math.max(((Math.min(E, s.b) - Math.max(S, s.a)) / span) * 100, 1.2);
          o += `<div class="seg ${cl}${s.wait ? " wait" : ""}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%" title="${esc(`${s.name}（${STATE_JA[cl]}${s.wait ? "・" + s.wait : ""}）`)}">${esc(s.name)}</div>`;
        });
        o += `</div></div>`;
      });
      return o;
    }).join("");
    if (!DATA.timeline.length) return `<div class="empty">日程のデータがありません</div>`;
    return `<div class="gantt"><div class="gin">${x}</div></div><p class="dim" style="margin:8px 0 0">見方：灰色は終わったこと ／ 青は今進めていること ／ 点線の枠はこれから（斜線は日付が未定）／ 黄色の枠は外の返事待ち ／ 赤い縦線は今日（${md(today)}）。細くて字が出ない所は、触ると名前が出ます。</p>`;
  }
  function pMk() {
    const E = LOAD.errors, L = LOAD.likes;
    const gd = DATA.goal.date, left = isFinite(dayNum(gd)) ? dayNum(gd) - todayNum() : null;
    let h = bar("宣伝", `アプリを使いそうな人に見つけてもらう仕事です。公開の目安は ${esc(isFinite(dayNum(gd)) ? mdOf(gd) : "未定")}${left !== null ? (left >= 0 ? `（あと${left}日）` : `（${-left}日過ぎた）`) : ""}。${DATA.goal.outlookText ? esc(DATA.goal.outlookText) + "。" : ""}`);
    if (E.desk) h += missHtml("画面の元データ（desk.json）", E.desk);
    let g = P("公開までの日程", "s12", staleHtml() + ganttHtml(), `日程の元データ ${esc(DATA.asOf ? hm(DATA.asOf) : "不明")} 時点`);
    g += P("外の返事待ち", "s6", staleHtml() + (DATA.waiting.map((w) => `<div class="rw col"><span>${lamp(w.level === "stop" ? "r" : w.level === "ok" ? "g" : "a")}<b>${esc(w.text)}</b></span><span class="sub">${esc(w.note || "")}</span></div>`).join("") || `<div class="empty">いまはなし</div>`));
    g += P("この先の予定", "s6", DATA.upcoming.map((u) => `<div class="rw"><span><b>${esc(u.title)}</b><div class="sub">${esc(u.sub || "")}</div></span><span class="mono">${esc(mdOf(u.date))}</span></div>`).join("") || `<div class="empty">記録にある予定はありません</div>`);
    g += likesHtml();
    const iss = CONFIG.issues.filter((n) => n === 4 || groupsOf(DATA).mk.some((r) => r.issue === n))[0] || 4;
    g += P("事業部長とのやり取り", "s12", E.comments[iss] ? missHtml(`Issue #${iss} のコメント`, E.comments[iss]) : exchHtml(exchanges(LOAD.comments[iss], 5)), `Issue #${iss}・新しい順に5件`);
    return h + G(g);
  }

  /* ---- アプリの案 ---- */
  function pCand() {
    let h = bar("アプリの案", "リサーチ部が見つけ、審査部が点数を付けた、アプリの案の一覧です（data/cases.json）。点数が高い順。");
    if (LOAD.errors.cases) return h + G(P("案の一覧", "s12", missHtml("アプリの案（cases.json）", LOAD.errors.cases)));
    const C = LOAD.cases, cnt = {};
    C.forEach((c) => { cnt[c.status] = (cnt[c.status] || 0) + 1; });
    const order = ["開発中", "承認済み", "保留", "見送り"], seen = order.filter((s) => cnt[s]);
    Object.keys(cnt).forEach((s) => { if (!seen.includes(s)) seen.push(s); });
    let g = P("案の数", "s12", `<div class="fun">${seen.map((s) => `<div><b>${cnt[s]}</b><small>${esc(s)}</small></div>`).join("")}</div>`, `${C.length}件`);
    g += P("案の一覧と審査部の判断", "s12", C.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).map((c) => {
      const cl = c.status === "承認済み" || c.status === "開発中" ? "ok" : c.status === "見送り" ? "stop" : "warn";
      const sc = typeof c.score === "number" ? Math.min(100, Math.max(0, c.score)) : null;
      return `<div class="dl2" style="grid-template-columns:minmax(0,1fr)"><div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><b style="font-size:18px;color:var(--ink)">${esc(c.name)}</b><span class="pill ${cl}">${esc(c.status)}</span><span class="mono sub">${sc !== null ? sc + "点" : ""}${c.main_keyword_volume ? `　検索 ${esc(c.main_keyword_volume)} 回/月（「${esc(c.main_keyword)}」）` : ""}</span></div>`
        + (sc !== null ? `<div class="bar2" style="width:${sc}%;background:var(--${cl === "ok" ? "ok" : cl === "stop" ? "stop" : "warn"})"></div>` : "")
        + `<div class="sub" style="font-size:15px">${esc(c.summary || "")}</div><details><summary>審査部の判断を見る</summary><div class="sub" style="margin-top:4px">${esc(clean(c.verdict || "", 400))}</div></details></div>`;
    }).join("") || `<div class="empty">案はまだありません</div>`);
    return h + G(g);
  }

  /* ---- 部署 ---- */
  function activeRowHtml(x) {
    const dept = STAGE_JA[x.stage] || x.stage, first = x.note.split(/\r?\n/)[0].trim();
    const note = first ? (first.length > 40 ? first.slice(0, 40) + "…" : first) : "", href = safeHref(x.url);
    const body = `<b>${esc(dept)}</b>　${esc(issueLabel(x.issue))}${note ? `　<span class="src">${esc(note)}</span>` : ""}　<span class="src">${esc(sinceText(x.since, LOAD.loadedAt))}</span>`;
    return `<div class="act-row">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${body}</a>` : body}</div>`;
  }
  function sinceText(iso, nowIso) {
    const t = Date.parse(iso), n = Date.parse(nowIso);
    if (!isFinite(t) || !isFinite(n)) return "";
    const m = Math.max(0, Math.floor((n - t) / 60000));
    if (m < 1) return "1分未満";
    return (m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}` : `${m}分`) + "前から";
  }
  function pDepts() {
    const E = LOAD.errors, A = LOAD.active;
    const ymd = new Date(todayNum() * DAY).toISOString().slice(0, 10);   // 今日（日本時間）の YYYY-MM-DD
    const stats = deptStats(LOAD.runs, LOAD.commits, ymd, ALL_DEPTS);
    const unnamedToday = LOAD.runs.filter((r) => r.day === ymd && !r.named).length;
    const namedFrom = LOAD.runs.filter((r) => r.day === ymd && r.named).map((r) => r.at).sort()[0] || "";
    const run = runningDepts(), que = queuedDepts();
    let h = bar("部署", "会社の12の部署を、組織の形で並べています。ランプが点いているのは、いま動いている部署です。");
    let g = P("いま動いている・順番待ち", "s12", !A ? missHtml("いま動いている実行", E.active || new ApiError(0, ""))
      : (!A.running.length && !A.waiting.length ? `<div class="empty">いま動いている部署はありません</div>`
        : (A.running.length ? `<div class="lbl">いま動いている</div>${A.running.map(activeRowHtml).join("")}` : "") + (A.waiting.length ? `<div class="lbl" style="margin-top:8px">順番待ち</div>${A.waiting.map(activeRowHtml).join("")}` : "")));
    GROUPS.forEach((gp) => {
      g += P(gp[0], "s12", `<p class="sub" style="margin:-4px 0 4px">${gp[1]}</p>` + gp[2].map((nm) => {
        const d = stats[nm], on = run.includes(nm);
        const last = d.lastWhat ? `<b>${esc(d.lastWhat)}</b>（${esc(hm(d.lastT))}・${esc(d.lastApp)}）` : (E.commits ? `<span class="unk">読めませんでした</span>` : "記録がありません（まだ仕事をしていない）");
        return `<div class="dp"><div><div class="nm">${lamp(on ? "g" : "")}${esc(nm)}</div><div class="st ${on ? "on" : ""}">${on ? "いま動いている" : "いまは動いていない"}${que.includes(nm) ? "（順番待ちあり）" : ""}</div></div>`
          + `<div><div>${esc(PURPOSE[nm] || "")}</div><div class="last">最後にした仕事：${last}</div></div>`
          + `<div class="cnt">きょうの仕事<br>実行 <b>${E.runs ? "?" : d.runsToday}</b> 回<br>記録 <b>${E.commits ? "?" : d.commitsToday}</b> 件</div></div>`;
      }).join(""));
    });
    g += P("数え方", "s12", `<div class="sub">「きょう」は ${md(todayNum())} の0時（日本時間）から。「実行」は、GitHub で部署を自動で起こした実行の名前（先頭が工程名）で数えました。${E.runs ? "実行の履歴が読めなかったので、実行の数は出せていません。" : `実行の名前に工程が入ったのは今日の ${namedFrom ? esc(hm(namedFrom)) : "（まだ無し）"} からなので、それより前の実行（今日 ${unnamedToday} 回）は部署が分からず、数えていません。`}「記録」は、作業の記録（git のコミット）の書き出しか末尾にある部署名で数えました（きょう全体では実行の数より多く出ます）。「受付」（社長のコメントを受けて事業部長を起こす窓口）は部署に数えていません。</div>`);
    return h + G(g);
  }

  /* ---- 数字 ---- */
  function sparkH(arr, lab) {
    if (!arr.length) return `<div class="empty">ありません</div>`;
    const mx = Math.max(...arr.map((x) => x[1]));
    return `<div class="sp">${arr.map((x) => `<div><b>${x[1]}</b><span class="tr"><u style="height:${Math.max(x[1] / mx * 100, 1)}%"></u></span><em>${lab(x[0])}</em></div>`).join("")}</div>`;
  }
  function pNumbers() {
    const E = LOAD.errors, C = LOAD.cases;
    let h = bar("数字", "いま手元のデータで出せる分だけです。");
    const nBuild = C.filter((c) => c.status === "開発中" || c.status === "承認済み").length;
    const pub = LOAD.results && Array.isArray(LOAD.results.apps) ? LOAD.results.apps.length : null;
    let g = P("案から公開まで", "s12", E.cases ? missHtml("アプリの案（cases.json）", E.cases)
      : `<div class="fun three"><div><b>${C.length}</b><small>アプリの案</small></div><div><b>${nBuild}</b><small>作ると決めた</small></div><div><b>${E.results ? "?" : pub === null ? "?" : pub}</b><small>公開後の実績が入ったアプリ（results.json）</small></div></div>`
      + `<div class="note" style="margin-top:12px">公開の見込み：${esc(DATA.goal.outlookText || "未確認")}。気になる点：${esc(DATA.goal.concern || "なし")}。</div><div class="dim" style="margin-top:6px">売上・ダウンロード数・投稿の反応は、まだこの画面で読める記録がありません。</div>`);
    const cd = E.commits ? null : countByDay(LOAD.commits.map((c) => c.day), 10);
    g += P("1日あたりの作業の記録の数", "s6", cd ? sparkH(cd, (d) => d.slice(8)) : missHtml("作業の記録", E.commits), cd && cd.length ? `${mdOf(cd[0][0])}〜${mdOf(cd[cd.length - 1][0])}・色が違うのは最後の日` : "");
    const ad = E.approvals ? null : countByDay(LOAD.approvals.map((a) => a.date), 8);
    g += P("1日あたりの承認の数", "s6", ad ? sparkH(ad, (d) => d.slice(8)) : missHtml("承認の記録", E.approvals), ad && ad.length ? `${mdOf(ad[0][0])}〜${mdOf(ad[ad.length - 1][0])}・色が違うのは最後の日` : "");
    g += P("これまでの合計", "s12", `<div class="fun three"><div><b>${E.approvals ? "?" : LOAD.approvals.length}</b><small>社長の承認・却下の件数</small></div><div><b>${E.commits ? "?" : LOAD.commits.length}</b><small>作業の記録（git のコミット）の数。新しい方から最大${CONFIG.commitPages * 100}件まで</small></div><div><b>${pub === null ? "?" : pub}</b><small>公開後の実績の件数（results.json）</small></div></div>`
      + `<div class="dim" style="margin-top:10px">ダウンロード数、課金、投稿の反応は、まだ数が無いか、この画面で読める記録がありません。</div>`);
    return h + G(g);
  }

  /* ---- 部署を動かす仕組み ---- */
  function pSystem() {
    const E = LOAD.errors, R = LOAD.runs;
    const done = R.filter((r) => r.status === "completed" && (r.concl === "success" || RUN_FAIL.has(r.concl))).slice(0, 30);
    const ok = done.filter((r) => r.concl === "success").length, sys = ok === done.length;
    let h = bar("部署を動かす仕組み", "部署を順に自動で起こす仕組み（GitHub 上の「リレー」）が、止まっていないかを見るページです。");
    const st = deskStale(DATA.asOf, todayNum());
    let g = P("止まっていないか", "s12", E.runs ? missHtml("実行の履歴", E.runs)
      : rw(lamp(sys ? "g" : "a") + "直近の実行", sys ? `直近 ${done.length} 回すべて成功${done[0] ? `（最新は ${esc(hm(done[0].at))}）` : ""}` : `${ok} / ${done.length} 回が成功`)
      + rw(lamp(runningDepts().length ? "g" : "") + "いま動いている実行", LOAD.active ? `${LOAD.active.running.length} 件（順番待ち ${LOAD.active.waiting.length} 件）` : `<span class="unk">読めませんでした</span>`)
      + rw(lamp(st ? "a" : "g") + "画面の元データ", DATA.asOf ? `desk.json は ${esc(hm(DATA.asOf))} 時点${st ? `（${esc(st.md)} のまま更新されていません）` : ""}` : "desk.json の時刻が読めませんでした"));
    g += P(`直近${done.length}回の実行`, "s12", E.runs ? missHtml("実行の履歴", E.runs) : `<div class="rep-bars" style="margin-bottom:10px">${done.map((r) => `<span title="${esc(hm(r.at) + " " + r.dept)}" style="width:12px;height:20px;background:var(--${r.concl === "success" ? "ok" : "stop"})"></span>`).join("")}</div><div>成功 ${ok} 回 ／ ${done.length} 回　<span class="sub">左が新しい実行。緑は成功、赤は失敗</span></div>`);
    const list = runsAll ? R : R.slice(0, 30);
    g += P("実行の一覧", "s12", E.runs ? missHtml("実行の履歴", E.runs) : `<p class="sub" style="margin:0 0 6px">どの部署が、どの話（Issue）について、何を頼まれて動いたかです。</p>` + list.map((r) => {
      const iss = r.issue ? `${issueLabel(r.issue)} #${r.issue}` : "";
      const cl = r.concl === "success" ? "ok" : r.status !== "completed" ? "me" : "stop";
      const lab = r.status !== "completed" ? (r.status === "in_progress" ? "実行中" : "順番待ち") : r.concl === "success" ? "成功" : esc(r.concl || r.status);
      return `<div class="lg"><span class="tm">${esc(hm(r.at))}</span><span class="pill ${cl}">${lab}</span><div><b>${esc(r.dept)}</b>${iss ? `　<span class="sub">${esc(iss)}</span>` : ""}</div>${r.note ? `<div class="nt">申し送り：${esc(clean(r.note, 160))}</div>` : ""}</div>`;
    }).join("") + (!runsAll && R.length > 30 ? `<div style="margin-top:12px"><button class="btn sm" data-allruns="1">残り ${R.length - 30} 回も見る</button></div>` : ""), runsAll ? `${R.length}回` : "新しい順に30回");
    g += P("この画面で出せていないこと", "s12", `<div class="sub">企画のあらまし・試用部の指摘の中身の要約（いまは題・日付・リンクだけ）、実行にかかった時間、使用量、売上・ダウンロード数・投稿の反応。</div>`);
    return h + G(g);
  }

  /* ---- 見た目（明るい・暗い） ---- */
  const curMode = () => {
    const t = doc.documentElement.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    try { return global.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch (e) { return "dark"; }   // 暗いのが基本
  };
  function paintPrefs() { const m = curMode(); doc.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.getAttribute("data-mode") === m)); }
  const modesHtml = () => `<div class="modes"><button class="modeb" data-mode="light">明るい</button><button class="modeb" data-mode="dark">暗い</button></div>`;

  function pMore() {
    let items = "";
    NAV.forEach((n) => { if (!["home", "turn", "apps"].includes(n[0])) items += `<button class="moreitem" data-go="${n[0]}">${n[1]}<span>›</span></button>`; });
    return bar("その他", "") + G(P("ほかのページ", "s12", items) + P("見た目：明るい・暗い", "s12", `<div style="max-width:320px">${modesHtml()}</div><div class="btnrow"><button type="button" class="btn sm" data-act="reload">読み直す</button><button type="button" class="btn sm" data-act="forget">鍵を消す</button></div><div class="dim" style="margin-top:6px">${esc(snap())}</div>`));
  }

  /* ---- 話す（右の列／スマホは「話す」タブ） ---- */
  function chrome() {
    $("#side").innerHTML = `<div class="brand">社長の机</div>` + NAV.map((n) => `<button class="navb" data-go="${n[0]}"><span>${n[1]}</span>${n[0] === "turn" ? `<span class="badge" id="navbadge">0</span>` : ""}</button>`).join("")
      + `<div class="sidefoot">${modesHtml()}<span class="dim" id="sidestamp"></span><span id="tools" hidden><button type="button" class="linkbtn" data-act="reload">読み直す</button>　<button type="button" class="linkbtn" data-act="forget">鍵を消す</button></span></div>`;
    $("#tabbar").innerHTML = TABS.map((t) => `<button class="tabb" data-go="${t[0]}"><b>${t[2]}</b><span>${t[1]}</span>${t[0] === "turn" ? `<span class="badge" id="tabbadge" hidden>0</span>` : ""}</button>`).join("");
    $("#talkcol").innerHTML = `<header class="bar" style="padding-bottom:6px"><h1 style="font-size:20px">事業部長と話す</h1></header>`;
    $("#talkcol").appendChild(talkNode());
    talkNode().hidden = true;
  }
  function badges() {
    const n = DATA ? nReq() : 0;
    const a = $("#navbadge"), b = $("#tabbadge");
    if (a) { a.textContent = n; a.classList.toggle("hot", n > 0); }
    if (b) { b.textContent = n; b.hidden = n === 0; b.classList.add("hot"); }
    const s = $("#sidestamp"); if (s) s.textContent = lastOk ? `読み込み ${jst(lastOk)}${DATA && DATA.asOf ? `・元データ ${jst(DATA.asOf)}` : ""}` : "";
    $("#tools").hidden = !keyStore.get();
  }

  /* ---- ルーター ---- */
  const isPC = () => { try { return global.matchMedia("(min-width:1100px)").matches; } catch (e) { return true; } };
  const PAGE_FN = { home: pHome, turn: pTurn, apps: pApps, marketing: pMk, cand: pCand, depts: pDepts, numbers: pNumbers, system: pSystem, more: pMore };
  function renderPage() {
    if (!DATA) return;
    let html;
    try { html = cur.startsWith("app/") ? pApp(cur.slice(4)) : PAGE_FN[cur](); }
    catch (e) { html = bar("表示できませんでした", "") + G(P("エラー", "s12", `<div class="miss">この面を組み立てられませんでした（${esc((e && e.message) || "")}）。「読み直す」を試してください。</div>`)); }
    const back = ["marketing", "cand", "depts", "numbers", "system"].includes(cur) ? `<button class="back backmore" data-go="more">‹ その他へ</button>` : "";
    $("#view").innerHTML = back + html;
    const slot = $("#req-slot");
    if (slot) DATA.requests.forEach((r) => { if (nodes.get(r.id)) slot.appendChild(nodes.get(r.id)); });
    badges(); paintPrefs();
    if (pendingJump) { const id = pendingJump; pendingJump = null; jumpTo(id); }
  }
  function route() {
    let r = (global.location.hash || "").replace("#", "");
    if (!PAGE_FN[r] && r !== "talk" && !r.startsWith("app/")) r = "home";
    if ((r === "talk" || r === "more") && isPC()) r = "home";
    cur = r;
    doc.body.className = r === "talk" ? "rt-talk" : "";
    if (r !== "talk") { renderPage(); const m = $("#main"); if (m) m.scrollTop = 0; global.scrollTo(0, 0); }
    const navKey = r.startsWith("app/") ? "apps" : r;
    doc.querySelectorAll(".navb").forEach((b) => b.classList.toggle("on", b.getAttribute("data-go") === navKey));
    const tabKey = ["home", "turn", "apps", "talk"].includes(navKey) ? navKey : "more";
    doc.querySelectorAll(".tabb").forEach((b) => b.classList.toggle("on", b.getAttribute("data-go") === tabKey));
    paintPrefs();
  }
  function goto(t) { if (global.location.hash === "#" + t) route(); else global.location.hash = "#" + t; }
  function draw() { if (DATA) { const m = $("#main"), y = m ? m.scrollTop : 0, wy = global.pageYOffset; renderPage(); if (m) m.scrollTop = y; global.scrollTo(0, wy); } }

  /* 依頼の答える欄へ飛ぶ。社長の番のページでなければ、そのページへ移ってから */
  function jumpTo(id) {
    if (cur !== "turn") { pendingJump = id; goto("turn"); return; }
    const el = nodes.get(id); if (!el) return;
    el.dataset.touched = "1"; setOpen(el, true);
    let calm = false; try { calm = global.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* 動かなくてよい */ }
    try { el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" }); } catch (e) { /* 動かなくてよい */ }
    el.classList.add("flash"); global.setTimeout(() => el.classList.remove("flash"), 1600);
    try { el.querySelector(".req-head").focus({ preventScroll: true }); } catch (e) { /* 動かなくてよい */ }
  }


  /* ============ 鍵が無いとき・読めなかったとき ============ */
  function setupHtml(msg) {
    return `<section class="p s12 setup" id="setup">
      <h2>はじめに：GitHub の鍵を貼ってください</h2>
      <p>この画面は、社長の鍵で app-company の記録を読み、答えを Issue のコメントとして書き込みます。鍵はこの端末のこのブラウザの中にだけ保存し、GitHub 以外には送りません。前の画面（old/）に鍵を貼ってあれば、同じ端末ではそのまま使えます。</p>
      <p class="notice">iPhone は、先に Safari の共有ボタンから「ホーム画面に追加」をして、ホーム画面のアイコンから開いてから貼ってください。Safari とホーム画面のアイコンでは保存場所が別なので、Safari で貼ってもアイコン側には入りません。</p>
      <h3>鍵の作り方（5分ほど）</h3>
      <ol class="checks" id="key-steps">
        <li>GitHub にログインした状態で、<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">鍵を作る画面</a>を開く</li>
        <li>「Token name」に「社長の画面」と入れる（名前は何でもよい）</li>
        <li>「Resource owner」は Yoshiki0423 のままにする</li>
        <li>「Expiration」（期限）を選ぶ。おすすめは 90 days</li>
        <li>「Repository access」で「Only select repositories」を選び、app-company だけを選ぶ</li>
        <li>「Repository permissions」で、Issues を「Read and write」、Contents を「Read and write」、Actions を「Read-only」にする（Metadata は自動で「Read-only」。ほかは触らない）</li>
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
    talkNode().hidden = true;
    $("#view").innerHTML = G(setupHtml(msg));
    badges();
  }

  function reasonOf(e, phase) {
    const s = e && e.status;
    if (s === 401) return "鍵が使えませんでした。期限が切れたか、貼り間違いの可能性があります";
    if (phase === "image" && s === 403) return "鍵に書き込みの権限がありません（Contents が「Read-only」のままです）。作り直し方：GitHub で鍵を作り直し、Repository permissions の Contents を「Read and write」にして、新しい鍵を貼り直してください。言葉だけの答えは、画像を外せば送れます";
    if (phase === "image" && s === 404) return "画像の保存先が見つかりませんでした。鍵の対象に app-company が入っているか、Contents が「Read and write」か確かめてください";
    if (phase === "image" && s === 422) return "画像を GitHub が受け付けませんでした";
    if (s === 403) return phase === "send"
      ? "書き込みが断られました。鍵の Issues が「Read and write」になっているか確かめてください（GitHub が混み合っているときも出ます）"
      : "読み込みが断られました。鍵の権限（Contents・Issues・Actions の読み取り）を確かめてください（GitHub が混み合っているときも出ます）";
    if (s === 404) return phase === "send"
      ? "書き込み先の Issue が見つかりませんでした。鍵の対象に app-company が入っているか確かめてください"
      : "app-company のデータが見つかりませんでした。鍵の「Repository access」に app-company が入っているか確かめてください";
    if (s === 422) return "GitHub が文を受け付けませんでした";
    return (e && e.message) || "原因がわかりませんでした";
  }

  function showLoadError(e) {
    const reason = reasonOf(e, "load");
    const keep = DATA ? `<p>下は ${esc(jst(lastOk))} に読み込んだときの中身です。</p>` : "";
    $("#notice").innerHTML = `<div class="err" role="alert">読み込めませんでした。<p>${esc(reason)}。</p>${keep}<div class="btnrow"><button type="button" class="btn" data-act="reload">読み直す</button><button type="button" class="btn" data-act="forget">鍵を消して貼り直す</button></div></div>`;
  }

  /* ============ 読み込み ============ */
  async function reload() {
    const token = keyStore.get();
    if (!token) { showSetup(); return; }
    $("#tools").hidden = false;
    const sp = $("#sidestamp"); if (sp) sp.textContent = "読み込み中…" + (lastOk ? `（前回 ${jst(lastOk)}）` : "");
    if (!DATA) $("#view").innerHTML = G(P("読み込み中", "s12", `<div class="empty">GitHub から読んでいます…</div>`));
    let L;
    try { L = await loadAll(token); } catch (e) { draw(); showLoadError(e); badges(); return; }
    $("#notice").innerHTML = "";
    // 送っていない入力は、読み直しても残す
    const prev = state;
    nodes.forEach((el, id) => { const t = el.querySelector("textarea"); if (t && prev[id]) prev[id].note = t.value; });
    LOAD = L; DATA = L.data; lastOk = L.loadedAt; state = {}; nodes.clear();
    LOAD.since = sinceCounts(VISIT.baseline, L.commits, L.comments);
    DATA.requests.forEach((r) => {
      const a = (L.answers[r.issue] || {})[r.id], p = prev[r.id];
      state[r.id] = a
        ? { choice: null, flags: [], sent: a.text, sentUrl: a.url, sentAt: a.at, fromHistory: true, note: "", images: [] }
        : { choice: p && !p.sent ? p.choice : null, flags: p && !p.sent ? p.flags : [], sent: null, note: p && !p.sent ? p.note : "", images: p && !p.sent ? p.images || [] : [], imgSeq: p && !p.sent ? p.imgSeq || 0 : 0 };
      nodes.set(r.id, makeNode(r));
      paintZone(r);
    });
    talkNode().hidden = false;
    route();
    await loadTalk();
  }

  /* ============ 押されたとき ============ */
  let tmr = null;
  function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); global.clearTimeout(tmr); tmr = global.setTimeout(() => t.classList.remove("on"), 2600); }

  async function onClick(e) {
    const t = e.target.closest("button");
    if (t) {
      const ds = t.dataset;
      if (ds.go != null) { goto(ds.go); return; }
      if (ds.since != null) { sinceTab = ds.since; draw(); return; }
      if (ds.allruns != null) { runsAll = true; draw(); return; }
      if (ds.mode != null) {
        doc.documentElement.setAttribute("data-theme", ds.mode);
        try { global.localStorage.setItem(CONFIG.themeKey, ds.mode); } catch (err) { /* 覚えられなくても切り替えは効く */ }
        paintPrefs(); return;
      }
      if (ds.xcopy != null) {
        const sel = ds.sel && doc.getElementById(ds.sel);
        const fallback = () => { if (sel) { const r = doc.createRange(); r.selectNodeContents(sel); const s = global.getSelection(); s.removeAllRanges(); s.addRange(r); } toast("コピーできませんでした。選択したので、長押しでコピーしてください"); };
        try { await global.navigator.clipboard.writeText(ds.xcopy); toast("コピーしました"); } catch (err) { fallback(); }
        return;
      }
    }
    return onClickBase(e);
  }

  function start() {
    const now = Date.now();
    VISIT = visitBaseline(now, readVisit());
    writeVisit({ baseline: VISIT.baseline, at: now, kind: VISIT.kind });
    chrome();
    try { const sv = global.localStorage.getItem(CONFIG.themeKey); if (sv === "light" || sv === "dark") doc.documentElement.setAttribute("data-theme", sv); } catch (e) { /* 覚えていなければ端末の設定に従う */ }
    doc.addEventListener("click", (e) => { onClick(e).catch(() => { /* 画面は落とさない */ }); });
    doc.addEventListener("change", (e) => {
      const tf = e.target && e.target.closest && e.target.closest("input[data-talkfile]");
      if (tf && DATA) {
        const fl = [...(tf.files || [])];
        try { tf.value = ""; } catch (err) { /* 同じ写真を選び直せなくても進める */ }
        addTalkImages(fl).catch(() => { /* 画面は落とさない */ });
        return;
      }
      const inp = e.target && e.target.closest && e.target.closest("input[data-file]");
      if (!inp || !DATA) return;
      const r = DATA.requests.find((x) => x.id === inp.dataset.file); if (!r) return;
      const files = [...(inp.files || [])];
      try { inp.value = ""; } catch (err) { /* 同じ写真を選び直せなくても進める */ }
      addImages(r, files).catch(() => { /* 画面は落とさない */ });
    });
    doc.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target && e.target.id === "token-in") { const b = doc.querySelector('[data-act="save-token"]'); if (b) b.click(); } });
    global.addEventListener("hashchange", route);
    global.addEventListener("resize", () => { if ((cur === "talk" || cur === "more") && isPC()) route(); });
    route();
    return reload();
  }

  global.Desk3 = {
    CONFIG, TALK_RE, buildTurns, buildTalkBody, imagePath, findAnswers, buildBody, relayFromRuns, parseRunTitle, activeFromRuns, normalize, safeHref, resolveSegments,
    mediaPath, fetchMedia, runInfo, toRun, parseCommit, toCommit, deptStats, visitBaseline, sinceCounts, deskStale, latestExp, parseApprovals, countByDay, exchanges, groupsOf,
    started: null,
    start() { this.started = start(); return this.started; }
  };
  if (!global.DESK_NO_AUTOSTART) global.Desk3.start();
})(window);
