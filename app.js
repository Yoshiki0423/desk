/* 社長の机（本番）
 * この入れ物には会社のデータを一切置かない。開いたときに、社長の鍵で GitHub の API から読む。
 *   画面のデータ … app-company の data/desk.json（Contents API）
 *   リレーの成否 … Actions API（読めなければ desk.json の値）
 *   答え済みの判定 … 各 Issue のコメントに、社長が書いた「<!-- desk:answer 依頼のid -->」があるか
 *   答える … Issue のコメントとして書き込む（社長の鍵なので、書いた人は社長になる）
 * 見た目と動きは試作（app-company の tools/社長の画面/index.html）と同じ。違うのは「データの取り方」と「送る」だけ。
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
    runsPerPage: 20
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
    if (!d || typeof d !== "object" || !Array.isArray(d.requests) || !Array.isArray(d.issues)) {
      throw new ApiError(-1, "desk.json の形が違います（issues と requests が要ります）");
    }
    return {
      asOf: d.asOf || null,
      sourceNote: d.sourceNote || "",
      issues: d.issues.map((i) => ({ recent: [], phase: "", ...i })),
      desk: d.desk || null,
      requests: d.requests.filter((r) => r && r.id && r.answer),
      depts: Array.isArray(d.depts) ? d.depts.map((x) => ({ issues: [], ...x })) : [],
      relay: { recent: [], failNote: "", ...(d.relay || {}) },
      events: Array.isArray(d.events) ? d.events.map((e) => ({ issues: [], ...e })) : [],
      nextTile: d.nextTile || { num: "—", unit: "", sub: "予定の記録なし" },
      held: Array.isArray(d.held) ? d.held.map((h) => ({ issues: [], ...h })) : []
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
  const STATUS = { run: ["動いている", "good"], boss: ["社長待ち", "warn"], wait: ["ほか待ち", "acc"], idle: ["出番待ち", "idle"], unk: ["未確認", "bad"] };

  let DATA = null;              // いま表示している中身（loadAll の結果の data）
  let LOAD = null;              // いちばん新しい読み込みの結果
  let lastOk = null;            // 最後に読み込めた時刻
  let state = {};               // 依頼ごとの入力と送信の状態
  const nodes = new Map();      // 依頼カードは読み込みごとに1回だけ作り、切り替えでは使い回す
  let view = "all";

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

  function answerHtml(r) {
    const a = r.answer, id = esc(r.id);
    let h = `<div class="answer" id="${id}-ans">`;
    if (a.type === "choice") h += `<div class="btnrow" role="group" aria-label="答えを選ぶ">${(a.choices || []).map((c) => `<button type="button" class="btn choice" data-choice="${id}|${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join("")}</div>`;
    h += `<label class="hint" for="${id}-note">${a.type === "choice" ? "一言（任意）" : "直すなら一言（OK だけなら空でよい）"}</label>`;
    h += `<textarea id="${id}-note" class="note" rows="2" placeholder="${esc(a.notePlaceholder || "")}"></textarea>`;
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
    const s = state[r.id];
    return `<div class="answer"><div class="sent ng" role="alert"><b>送れませんでした。</b>${esc(s.error)}。Issue にはまだ書き込まれていない可能性が高いです。<pre>${esc(s.pending)}</pre></div>
      <div class="btnrow"><button type="button" class="btn primary" data-retry="${esc(r.id)}">もう一度送る</button></div>
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
    return parts.join("\n");
  }

  async function deliver(r, text) {
    const s = state[r.id];
    s.sending = true; s.pending = text; s.error = null;
    nodes.get(r.id).querySelectorAll("[data-send],[data-retry]").forEach((b) => { b.disabled = true; });
    const msg = nodes.get(r.id).querySelector(`[id="${CSS_ID(r.id)}-msg"]`);
    if (msg) msg.textContent = "送っています…";
    try {
      const out = await postAnswer(keyStore.get(), r.issue, r.id, text);
      Object.assign(s, { sent: text, sentUrl: out.url, sentAt: out.at, fromHistory: false, pending: null, note: "" });
    } catch (e) {
      s.error = reasonOf(e, "send");
    }
    s.sending = false;
    paintZone(r); draw();
  }

  function send(r, mode) {
    if (state[r.id].sending) return;
    const text = buildComment(r, mode);
    if (!text) { const m = nodes.get(r.id).querySelector(`[id="${CSS_ID(r.id)}-msg"]`); if (m) m.textContent = "答えか一言を入れてください。"; return; }
    return deliver(r, text);
  }

  /* ---------- 集計（試作と同じ） ---------- */
  const reqsFor = (v) => (v === "all" ? DATA.requests : DATA.requests.filter((r) => r.issue === +v.slice(1)));
  const openOf = (list) => list.filter((r) => !state[r.id].sent);
  const cnt = (list) => { const o = openOf(list); return { need: o.filter((r) => r.urgency === "need").length, ask: o.filter((r) => r.urgency !== "need").length }; };
  const issueList = (list) => { const m = {}; list.forEach((r) => { m[r.issue] = (m[r.issue] || 0) + 1; }); return Object.keys(m).map((k) => `#${k} ${m[k]}件`).join("・") || "なし"; };
  const deptFor = (d, n) => { const l = d.lines && d.lines[n]; return l ? { ...d, ...l } : d; };
  const tile = (label, num, unit, sub, cls) => `<div class="tile ${cls || ""}"><div class="t-label">${esc(label)}</div><div class="t-num">${esc(num)}<small>${esc(unit)}</small></div><div class="t-sub">${sub}</div></div>`;

  /* ---------- 部品（試作と同じ） ---------- */
  function deptsHtml(list, n) {
    if (!list.length) return `<div class="empty">この Issue に関係する部署の記録はありません。</div>`;
    return `<ul class="depts">${list.map((x0) => { const x = n ? deptFor(x0, n) : x0; const [t, c] = STATUS[x.status] || STATUS.unk; return `<li class="dept"><b>${esc(x.name)}</b><span class="pill ${c}">${t}</span><p>${esc(x.line)}</p>${x.at ? `<time datetime="${esc(x.at)}">${jst(x.at)} の動き</time>` : `<time>時刻は未確認</time>`}</li>`; }).join("")}</ul>`;
  }
  function evHead(e) {
    if (e.every) return e.every;
    const date = String(e.date || "");
    if (date.length === 10) { const [, m, dd] = date.split("-"); const wd = "日月火水木金土"[new Date(date + "T00:00:00Z").getUTCDay()] || "?"; return `${+m}/${+dd}（${wd}）`; }
    const [y, m] = date.split("-"); return m ? `${y}年${+m}月` : date;
  }
  function eventsHtml(list) {
    if (!list.length) return `<div class="empty">この Issue の予定は記録にありません。全体の予定は「全体」で見られます。</div>`;
    return `<ul class="events">${list.map((e) => `<li class="ev"><div class="when">${esc(evHead(e))}<small>${esc(e.sub || "")}</small></div><div><p>${esc(e.text)}</p><span class="by">出典：${esc(e.by)}</span></div></li>`).join("")}</ul>`;
  }
  function heldHtml(list) {
    if (!list.length) return `<div class="empty">この Issue で溜めているものは記録にありません。</div>`;
    return `<ul class="queue">${list.map((h) => `<li>${esc(h.text)}<small>${h.issues.length ? "#" + h.issues.map(esc).join("・#") + "・" : ""}${esc(h.when)}</small></li>`).join("")}</ul>`;
  }
  const sec = (id, title, small, body) => `<section id="${id}"><div class="sec-h"><h2>${esc(title)}</h2>${small ? `<small>${small}</small>` : ""}</div>${body}</section>`;

  function issueState(iss) {
    const c = cnt(reqsFor("i" + iss.n));
    if (c.need) return ["答えが要る " + c.need + "件", "warn"];
    if (c.ask) return ["お願い " + c.ask + "件", "acc"];
    return ["社長待ちなし", "good"];
  }

  function overviewHtml() {
    const d = DATA, all = openOf(d.requests), c = cnt(d.requests);
    const needL = all.filter((r) => r.urgency === "need"), askL = all.filter((r) => r.urgency !== "need");
    const by = (s) => d.depts.filter((x) => x.status === s).length;
    const rel = d.relay.recent, ng = rel.filter((x) => x[0] === "!").length;
    const bars = rel.slice().reverse().map((x) => `<i class="${x[0] === "!" ? "ng" : ""}"></i>`).join("");
    const relSrc = LOAD.relaySource === "actions" ? "（GitHub の実行履歴より）" : `（<span class="unk">実行履歴が読めなかったので desk.json の記録</span>）`;
    const tiles = `<div class="tiles n6">
      ${tile("答えが要る", c.need, "件", esc(issueList(needL)), c.need ? "need" : "")}
      ${tile("お願い（急ぎではない）", c.ask, "件", esc(issueList(askL)))}
      ${tile("動いている部署", by("run"), "/ " + d.depts.length, `社長待ち ${by("boss")}・ほか待ち ${by("wait")}・出番待ち ${by("idle")}・<span class="unk">未確認 ${by("unk")}</span>`)}
      ${tile("次の予定", d.nextTile.num, d.nextTile.unit, esc(d.nextTile.sub))}
      ${tile("溜めているもの", d.held.length, "件", "いまは社長に聞きません")}
      ${tile("リレー直近" + rel.length + "回", rel.length - ng, "/ " + rel.length + " 成功", `<div class="bars" role="img" aria-label="古い順に左から。失敗${ng}回">${bars}</div>${esc(d.relay.failNote)}${relSrc}`)}
    </div>`;
    const cards = d.issues.map((iss) => {
      const [t, k] = issueState(iss), last = iss.recent[iss.recent.length - 1], cc = cnt(reqsFor("i" + iss.n));
      const dn = d.depts.filter((x) => x.issues.includes(iss.n)).length;
      const lastHtml = last ? `<div class="ic-last"><b>${jst(last.at)} ${esc(last.who)}</b>　${esc(last.text)}</div>` : "";
      return `<button type="button" class="icard ${cc.need ? "hot" : ""}" data-go="i${esc(iss.n)}">
        <div class="ic-top"><b>#${esc(iss.n)} ${esc(iss.name)}</b><span class="pill ${k}">${esc(t)}</span></div>
        <div class="ic-phase">${esc(iss.phase)}</div>
        ${lastHtml}
        <div class="ic-foot">関係する部署 ${dn}　タップでこの Issue だけを見る</div></button>`;
    }).join("");
    const desk = d.desk ? `<div class="strip">#${esc(d.desk.n)} ${esc(d.desk.name)} は、この画面の元になる Issue なので「全体」に含めています。最終更新 ${jst(d.desk.updatedAt)}・コメント ${esc(d.desk.comments)}件。</div>` : "";
    const relayNote = `<div class="relay">部署ごとの工程名は、実行履歴からは<span class="unk">未確認</span>。</div>`;
    return tiles
      + `<div>${sec("issues", "Issue ごとの状況", "タップで切り替え", `<div class="icards">${cards}</div>${desk}`)}</div>`
      + `<div class="cols">
          ${sec("todo", "社長がやること", `答えが要る ${c.need}件・お願い ${c.ask}件`, `<div class="stack" id="req-slot"></div>`)}
          <div class="side">
            ${sec("work", "各部署の状況", "社長は何もしなくてよい", `<div class="panel">${deptsHtml(d.depts)}${relayNote}</div>`)}
            ${sec("next", "次の予定", "", `<div class="panel">${eventsHtml(d.events)}</div>`)}
            ${sec("held", "溜めているもの", "いまは聞きません", `<div class="panel">${heldHtml(d.held)}</div>`)}
          </div>
        </div>`;
  }

  function issueHtml(n) {
    const d = DATA, iss = d.issues.find((i) => i.n === n), rs = reqsFor("i" + n), c = cnt(rs);
    const ds = d.depts.filter((x) => x.issues.includes(n));
    const dsRun = ds.map((x) => deptFor(x, n)).filter((x) => x.status === "run").length;
    const evs = d.events.filter((e) => e.issues.includes(n)), hs = d.held.filter((h) => h.issues.includes(n));
    const [st, k] = issueState(iss);
    const tiles = `<div class="tiles n4">
      ${tile("答えが要る", c.need, "件", c.need ? esc(rs.filter((r) => r.urgency === "need" && !state[r.id].sent).map((r) => r.dept).join("・")) : "なし", c.need ? "need" : "")}
      ${tile("お願い（急ぎではない）", c.ask, "件", c.ask ? "飛ばしても進みます" : "なし")}
      ${tile("関係する部署", ds.length, "部署", `動いている ${dsRun}`)}
      ${tile("この Issue の予定", evs.length, "件", evs.length ? esc(evHead(evs[0]).replace(/（.*/, "") + " ほか") : "記録にありません")}
    </div>`;
    const head = `<div class="panel" style="padding:14px"><div class="tags"><span class="pill ${k}">${esc(st)}</span></div><h2 style="font-size:19px;margin-top:6px">#${esc(n)} ${esc(iss.full || iss.name)}</h2><p class="lead" style="margin:6px 0 0">${esc(iss.phase)}</p></div>`;
    const none = `<div class="none">いま社長がやることは無し。</div>`;
    const feed = iss.recent.length ? `<ul class="feed">${iss.recent.slice().reverse().map((x) => `<li><time datetime="${esc(x.at)}">${jst(x.at)}</time><span><b>${esc(x.who)}</b>${esc(x.text)}</span></li>`).join("")}</ul>` : `<div class="empty">記録にありません。</div>`;
    return head + tiles
      + `<div class="cols">
          ${sec("todo", "社長がやること", "", rs.length ? `<div class="stack" id="req-slot"></div>` : none)}
          <div class="side">
            ${sec("recent", "最新の動き", "新しい順（Issue のコメントより）", `<div class="panel">${feed}</div>`)}
            ${sec("work", "関係する部署", "", `<div class="panel">${deptsHtml(ds, n)}</div>`)}
            ${sec("next", "予定", "", `<div class="panel">${eventsHtml(evs)}</div>`)}
            ${sec("held", "溜めているもの", "いまは聞きません", `<div class="panel">${heldHtml(hs)}</div>`)}
          </div>
        </div>`;
  }

  function tabsHtml() {
    const mk = (v, label) => { const c = cnt(reqsFor(v)), t = c.need + c.ask; return `<button type="button" class="tab" data-go="${esc(v)}" aria-pressed="${view === v}">${esc(label)}<span class="bd ${c.need ? "need" : ""}" aria-label="社長待ち ${t}件">${t}</span></button>`; };
    return mk("all", "全体") + DATA.issues.map((i) => mk("i" + i.n, `#${i.n} ${i.short || i.name}`)).join("");
  }

  function stampText() {
    if (!lastOk) return "まだ読み込めていません";
    const rec = DATA && DATA.asOf ? `・最新の記録 ${jst(DATA.asOf)}` : "";
    return `読み込み ${jst(lastOk)}${rec}`;
  }

  function draw() {
    $("#stamp").textContent = stampText();
    if (!DATA) return;
    $("#tabs").innerHTML = tabsHtml();
    $("#view").innerHTML = view === "all" ? overviewHtml() : issueHtml(+view.slice(1));
    const slot = $("#req-slot");
    if (slot) reqsFor(view).forEach((r) => {
      const el = nodes.get(r.id);
      if (view !== "all" && !el.dataset.touched && r.urgency === "need" && !state[r.id].sent) setOpen(el, true);
      slot.appendChild(el);
    });
  }

  function go(v) {
    view = v; draw();
    try { global.scrollTo(0, 0); } catch (e) { /* 動かなくてよい */ }
    try { global.history.replaceState(null, "", "#" + v); } catch (e) { try { global.location.hash = v; } catch (e2) { /* 動かなくてよい */ } }
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
    $("#tabs").innerHTML = "";
    $("#notice").innerHTML = "";
    $("#stamp").textContent = "鍵がまだありません";
    $("#view").innerHTML = setupHtml(msg);
  }

  function reasonOf(e, phase) {
    const s = e && e.status;
    if (s === 401) return "鍵が使えませんでした。期限が切れたか、貼り間違いの可能性があります";
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
        ? { choice: null, flags: [], sent: a.text, sentUrl: a.url, sentAt: a.at, fromHistory: true, note: "" }
        : { choice: p && !p.sent ? p.choice : null, flags: p && !p.sent ? p.flags : [], sent: null, note: p && !p.sent ? p.note : "" };
      nodes.set(r.id, makeNode(r));
      paintZone(r);
    });
    let h = ""; try { h = global.location.hash.replace("#", ""); } catch (e) { /* 無くてよい */ }
    if (view === "all" || !DATA.issues.some((i) => "i" + i.n === view)) view = (h === "all" || DATA.issues.some((i) => "i" + i.n === h)) ? h : "all";
    draw();
    showPartialNotice(L);
  }

  /* ============ 押されたとき ============ */
  async function onClick(e) {
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
    if (ds.go) go(ds.go);
    else if (ds.toggle) { const el = nodes.get(ds.toggle); el.dataset.touched = "1"; setOpen(el, t.getAttribute("aria-expanded") !== "true"); }
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
    else if (ds.retry) { const r = reqOf(ds.retry); if (r && state[r.id].pending && !state[r.id].sending) return deliver(r, state[r.id].pending); }
    else if (ds.undo) { const r = reqOf(ds.undo); if (r) { state[r.id] = { choice: null, flags: [], sent: null, note: "" }; paintZone(r); draw(); } }
    else if (ds.copy) {
      const out = t.closest(".real").querySelector(".src[role=status]");
      try { await global.navigator.clipboard.writeText(ds.copy); out.textContent = "コピーしました。Safari のアドレス欄に貼ってください。"; }
      catch (err) { out.textContent = "コピーできませんでした。上のリンクを長押しして選んでください。"; }
    }
  }

  function start() {
    doc.addEventListener("click", (e) => { onClick(e).catch(() => { /* 画面は落とさない */ }); });
    doc.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target && e.target.id === "token-in") { const b = doc.querySelector('[data-act="save-token"]'); if (b) b.click(); } });
    return reload();
  }

  global.Desk = {
    CONFIG, findAnswers, buildBody, relayFromRuns, normalize, safeHref,
    started: null,
    start() { this.started = start(); return this.started; }
  };
  if (!global.DESK_NO_AUTOSTART) global.Desk.start();
})(window);
