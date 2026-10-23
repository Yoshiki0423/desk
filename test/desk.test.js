/* 新しい画面（ルート）のテスト。純粋な数え方は Desk3 から直接、画面は jsdom + 偽の GitHub で確かめる */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { boot, json } = require("./helpers");

const posts = (b) => b.calls.filter((c) => c.method === "POST");

test("実行の名前を分ける：工程・Issue・申し送り。コメントで起きた受付と、名前の無い実行も区別する", async () => {
  const b = await boot({});
  const D = b.w.Desk3;
  assert.deepEqual({ ...D.runInfo({ display_title: "development｜2｜機能を足す｜続き", event: "workflow_dispatch" }) }, { dept: "開発部", issue: 2, note: "機能を足す｜続き", named: true });
  assert.equal(D.runInfo({ display_title: "screening｜3｜x" }).dept, "審査部");
  assert.equal(D.runInfo({ display_title: "未知の工程名はそのまま", event: "issue_comment" }).dept, "受付");
  assert.equal(D.runInfo({ display_title: "リレー", event: "push" }).dept, "部署名なし");
  assert.equal(D.runInfo({ display_title: "newstage｜4｜x" }).dept, "newstage");
  assert.equal(D.runInfo({ display_title: "リレー", event: "push" }).named, false);
});

test("コミットの読み方：部署は末尾か書き出し、アプリは線表のアプリ名のときだけ", async () => {
  const b = await boot({});
  const P = b.w.Desk3.parseCommit;
  const apps = ["減酒", "禁煙"];
  assert.deepEqual({ ...P("開発(減酒): 写真に保存を直した（開発部）", apps) }, { dept: "開発部", app: "減酒", what: "写真に保存を直した" });
  assert.deepEqual({ ...P("事業部長(禁煙): 実機確認は OK（事業部長）", apps) }, { dept: "事業部長", app: "禁煙", what: "実機確認は OK" });
  assert.deepEqual({ ...P("禁煙: 機能を足す", apps) }, { dept: "", app: "禁煙", what: "機能を足す" });
  assert.equal(P("記録: 社長の画面を作り直す", apps).app, "");
  assert.equal(P("X部: 投稿を書いた", apps).dept, "X部");
});

test("部署ごとの数え方：きょうの実行は名前が分かるものだけ、記録は日付と部署で、最後の仕事は新しい順の先頭", async () => {
  const b = await boot({});
  const D = b.w.Desk3;
  const runs = [
    { named: true, dept: "開発部", day: "2030-01-02", at: "2030-01-02T02:00:00Z" },
    { named: true, dept: "開発部", day: "2030-01-02", at: "2030-01-02T01:00:00Z" },
    { named: true, dept: "開発部", day: "2030-01-01", at: "2030-01-01T01:00:00Z" },
    { named: false, dept: "受付", day: "2030-01-02", at: "2030-01-02T00:00:00Z" }
  ];
  const commits = [
    { iso: "2030-01-02T03:00:00Z", day: "2030-01-02", dept: "開発部", what: "新しい仕事", app: "減酒" },
    { iso: "2030-01-01T03:00:00Z", day: "2030-01-01", dept: "開発部", what: "古い仕事", app: "" },
    { iso: "2030-01-02T01:00:00Z", day: "2030-01-02", dept: "", what: "部署なし", app: "" }
  ];
  const s = D.deptStats(runs, commits, "2030-01-02", ["開発部", "試用部"]);
  assert.equal(s["開発部"].runsToday, 2);
  assert.equal(s["開発部"].commitsToday, 1);
  assert.equal(s["開発部"].lastWhat, "新しい仕事");
  assert.equal(s["開発部"].lastApp, "減酒");
  assert.equal(s["試用部"].runsToday, 0);
  assert.equal(s["試用部"].lastWhat, "");
});

test("前回からの数え方：初めては24時間前から／30分以内の開き直しは数え始めを動かさない／それ以上空けば前に開いた時刻から", async () => {
  const b = await boot({});
  const V = b.w.Desk3.visitBaseline, now = Date.parse("2030-01-02T10:00:00Z");
  assert.deepEqual({ ...V(now, null) }, { baseline: now - 24 * 3600e3, kind: "first" });
  assert.deepEqual({ ...V(now, { baseline: now - 5 * 3600e3, at: now - 10 * 60e3, kind: "prev" }) }, { baseline: now - 5 * 3600e3, kind: "prev" });
  assert.deepEqual({ ...V(now, { baseline: now - 5 * 3600e3, at: now - 2 * 3600e3, kind: "prev" }) }, { baseline: now - 2 * 3600e3, kind: "prev" });
  assert.equal(V(now, { baseline: now - 24 * 3600e3, at: now - 60e3, kind: "first" }).kind, "first");
});

test("前回からの数：開発で始まるコミットと、社長が書いたコメント（そのあとの最初の返事つき）", async () => {
  const b = await boot({});
  const D = b.w.Desk3, base = Date.parse("2030-01-02T00:00:00Z");
  const commits = [
    { iso: "2030-01-02T05:00:00Z", s: "開発(減酒): a（開発部）", what: "a", app: "減酒" },
    { iso: "2030-01-02T04:00:00Z", s: "事業部長: b（事業部長）", what: "b", app: "" },
    { iso: "2030-01-01T04:00:00Z", s: "開発(減酒): c（開発部）", what: "c", app: "減酒" }
  ];
  const comments = { 2: [
    { user: { login: "Yoshiki0423" }, body: "前のコメント", created_at: "2030-01-01T00:00:00Z" },
    { user: { login: "Yoshiki0423" }, body: "新しいコメント", created_at: "2030-01-02T01:00:00Z" },
    { user: { login: "bot" }, body: "返事です", created_at: "2030-01-02T01:05:00Z" }
  ] };
  const r = D.sinceCounts(base, commits, comments);
  assert.equal(r.made.length, 1);
  assert.equal(r.words.length, 1);
  assert.equal(r.words[0].said, "新しいコメント");
  assert.equal(r.words[0].effect, "返事です");
});

test("desk.json が古いか：2日以上前なら日付つきで返し、1日前までは古いとしない", async () => {
  const b = await boot({});
  const S = b.w.Desk3.deskStale, today = Math.floor(Date.parse("2030-01-05T00:00:00Z") / 864e5);
  assert.equal(S("2030-01-04T10:00:00Z", today), null);
  const st = S("2030-01-02T10:00:00Z", today);
  assert.equal(st.md, "1/2");
  assert.equal(st.days, 3);
  assert.equal(S("壊れた時刻", today), null);
});

test("画面：desk.json が古いと、日程と返事待ちの面に「元のデータが 1/2 のまま更新されていません」と出る", async () => {
  const b = await boot({ today: "2030-01-05", hash: "#marketing" });
  const t = b.$("#view").textContent;
  assert.ok(t.includes("元のデータが 1/2 のまま更新されていません"));
  assert.equal((b.$("#view").innerHTML.match(/のまま更新されていません/g) || []).length, 2);
  const b2 = await boot({ today: "2030-01-02", hash: "#marketing" });
  assert.ok(!b2.$("#view").textContent.includes("のまま更新されていません"));
});

test("画面：ホームは本物のデータで数える（答えてほしい件数・動いている部署・仕組みの成否・前回から）", async () => {
  const b = await boot({ visit: { baseline: Date.parse("2030-01-02T00:00:00Z"), at: Date.parse("2030-01-02T01:00:00Z"), kind: "prev" } });
  const t = b.$("#view").textContent.replace(/\s+/g, "");
  assert.ok(t.includes("社長に答えてほしいこと3件"));
  assert.ok(t.includes("1/12部署"));
  assert.ok(t.includes("開発部が作業中"));
  assert.ok(t.includes("失敗した実行があります"));   // 完了した3回のうち1回が失敗
  assert.ok(t.includes("1件開発部が作った機能"));
  assert.ok(t.includes("1件社長が書いたコメント"));
  assert.equal(b.$("#navbadge").textContent, "3");
});

test("画面：初めて開いたときは「きのうのこの時刻から」と書き、開いた時刻を端末に覚える", async () => {
  const b = await boot({});
  assert.ok(b.$("#view").textContent.includes("初めて開いたので、きのうのこの時刻"));
  const saved = JSON.parse(b.w.localStorage.getItem("desk.v3.visit"));
  assert.equal(saved.kind, "first");
  assert.ok(isFinite(saved.at) && isFinite(saved.baseline));
});

test("画面：部署のページは、きょうの実行・記録・最後にした仕事・いま動いている実行を出す", async () => {
  const b = await boot({ hash: "#depts" });
  const dp = b.$$(".dp").find((x) => x.querySelector(".nm").textContent.includes("開発部"));
  assert.ok(dp.textContent.includes("いま動いている"));
  assert.ok(dp.textContent.includes("画面を直した"));
  assert.ok(/実行\s*1\s*回/.test(dp.textContent));
  assert.ok(/記録\s*1\s*件/.test(dp.textContent));
  const mgr = b.$$(".dp").find((x) => x.querySelector(".nm").textContent.includes("事業部長"));
  assert.ok(/記録\s*1\s*件/.test(mgr.textContent));
  assert.ok(b.$("#view").textContent.includes("機能を足す"));   // 申し送りの1行目
});

test("画面：コミットが読めなくても、その面だけに「読めませんでした」と出てほかは壊れない", async () => {
  const b = await boot({ commits: () => json(403, { message: "no" }), hash: "#depts" });
  assert.ok(b.$("#view").textContent.includes("読めませんでした"));
  assert.equal(b.$$(".dp").length, 12);
  await b.go("system");
  assert.ok(b.$("#view").textContent.includes("直近"));
  await b.go("home");
  assert.ok(b.$("#view").textContent.includes("社長に答えてほしいこと"));
});

test("画面：実行の履歴が読めなければ仕組みの面だけが読めませんでしたになる", async () => {
  const b = await boot({ runs: () => json(403, { message: "no" }), hash: "#system" });
  assert.ok(b.$("#view").textContent.includes("実行の履歴：読めませんでした"));
  await b.go("turn");
  assert.ok(b.$("#view").textContent.includes("承認と却下の数"));
});

test("画面：アプリの詳細は、実機のリンク・企画と試用メモの題と日付とリンク・やり取りを出す（手書きの要約は置かない）", async () => {
  const b = await boot({ hash: "#app/app11" });
  const t = b.$("#view").textContent;
  assert.ok(t.includes("exp://u.expo.dev/aaa/group/g1"));
  assert.ok(t.includes("企画_全部入り") && t.includes("試用メモ"));
  assert.ok(b.$$("#view a").some((a) => a.href === "https://github.com/example/x/blob/main/b.md"));
  assert.ok(t.includes("中身の要約は、この画面ではまだ出せません"));
});

test("画面：他人が書いた文字はエスケープされる（コメントの本文に入った HTML は動かない）", async () => {
  const b = await boot({ hash: "#app/app11" });
  assert.equal(b.$$("#view img").length, 0);
  assert.ok(b.$("#view").textContent.includes("<img src=x onerror=alert(1)"));
});

test("画面：依頼に答えると、先頭に答えの印をつけて Issue に書く（本番と同じ本文）", async () => {
  const b = await boot({ hash: "#turn" });
  assert.equal(b.$$("#view .req").length, 3);
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  await b.click(b.$('[data-send="req-11-posts|ok"]'));
  const p = posts(b).find((c) => /issues\/11\/comments$/.test(c.url));
  assert.equal(p.body.body, "<!-- desk:answer req-11-posts -->\nOK");
  assert.ok(b.$("#req-11-posts").textContent.includes("送りました"));
  assert.equal(b.$("#navbadge").textContent, "2");
});

test("画面：事業部長に話しかけると #5 に <!-- desk:talk --> つきで書く。右の列に常にある", async () => {
  const b = await boot({});
  assert.ok(b.$("#talkcol #talk-note"));
  b.$("#talk-note").value = "調べてください";
  await b.click(b.$("#talk-go"));
  const p = posts(b).find((c) => /issues\/5\/comments$/.test(c.url));
  assert.equal(p.body.body, "<!-- desk:talk -->\n調べてください");
});

test("画面：画像を付けた答えは、先に保存してからコメント（パス入り）を書く", async () => {
  const b = await boot({ hash: "#turn" });
  await b.click(b.$('[data-toggle="req-11-choice"]'));
  const inp = b.$('input[data-file="req-11-choice"]');
  Object.defineProperty(inp, "files", { value: [{ type: "image/png", name: "a.png" }] });
  inp.dispatchEvent(new b.w.Event("change", { bubbles: true }));
  await b.settle();
  await b.click(b.$('[data-choice="req-11-choice|ある"]'));
  await b.click(b.$('[data-send="req-11-choice|choice"]'));
  const put = b.calls.find((c) => c.method === "PUT");
  assert.ok(put && /data\/desk-images\/.*req-11-choice/.test(decodeURIComponent(put.url)));
  const p = posts(b).find((c) => /issues\/11\/comments$/.test(c.url));
  assert.ok(p.body.body.startsWith("<!-- desk:answer req-11-choice -->\nある"));
  assert.ok(p.body.body.includes("data/desk-images/"));
});

test("画面：鍵が無いときは案内を出し、GitHub を呼ばない。本番と同じ鍵の置き場を使う", async () => {
  const b = await boot({ token: null });
  assert.ok(b.$("#setup"));
  assert.equal(b.calls.length, 0);
  assert.equal(b.w.Desk3.CONFIG.tokenKey, "desk.token");
});

test("画面：明るい・暗いを切り替えると端末に覚える", async () => {
  const b = await boot({});
  await b.click(b.$('[data-mode="light"]'));
  assert.equal(b.doc.documentElement.getAttribute("data-theme"), "light");
  assert.equal(b.w.localStorage.getItem("desk-theme"), "light");
});

test("画面：8ページとアプリの詳細がどれも落ちずに開く（スマホの「その他」も）", async () => {
  const b = await boot({});
  for (const p of ["home", "turn", "apps", "marketing", "cand", "depts", "numbers", "system", "more", "app/app11", "app/nothing"]) {
    await b.go(p);
    assert.ok(b.$("#view h1"), p + " が開かない");
    assert.ok(!b.$("#view").textContent.includes("表示できませんでした"), p + " で例外");
  }
});

test("CSP は GitHub の API だけに送り、外部は Google Fonts だけ。鍵らしき文字を持たない", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(html.includes("connect-src https://api.github.com;"));
  assert.ok(html.includes("font-src https://fonts.gstatic.com;"));
  for (const f of ["index.html", "app.js"]) assert.ok(!/github_pat_[A-Za-z0-9]{10,}/.test(fs.readFileSync(path.join(__dirname, "..", f), "utf8")));
});

/* 同じ id で出し直された依頼（再依頼）：依頼のコメントより前の答えは数えない */
const mkc = (login, body, at, url, id) => ({ user: { login }, body, created_at: at, html_url: url, id });
const REQ_URL = "https://github.com/example/x/issues/4#issuecomment-200";
const ANS = (at) => mkc("Yoshiki0423", "<!-- desk:answer req-4 -->\n直して", at, "https://github.com/example/x/issues/4#issuecomment-" + at.length + at, 1);

test("再依頼：答え→同じ id で出し直しなら未回答（依頼のコメントの時刻より前の答えは数えない）", async () => {
  const D = (await boot({})).w.Desk3;
  const cs = [mkc("bot", "依頼", "2030-01-01T01:00:00Z", REQ_URL, 100), ANS("2030-01-01T02:00:00Z"), mkc("bot", "出し直し", "2030-01-01T03:00:00Z", REQ_URL.replace("200", "201"), 201)];
  const a = D.findAnswers(cs, [{ id: "req-4", commentUrl: REQ_URL.replace("200", "201") }]);
  assert.equal(a["req-4"], undefined);
});

test("再依頼：出し直しのあとに答えたら回答済み（いちばん新しい答え）", async () => {
  const D = (await boot({})).w.Desk3;
  const url2 = REQ_URL.replace("200", "201");
  const cs = [ANS("2030-01-01T02:00:00Z"), mkc("bot", "出し直し", "2030-01-01T03:00:00Z", url2, 201), ANS("2030-01-01T04:00:00Z")];
  const a = D.findAnswers(cs, [{ id: "req-4", commentUrl: url2 }]);
  assert.equal(a["req-4"].at, "2030-01-01T04:00:00Z");
  assert.equal(a["req-4"].text, "直して");
});

test("再依頼：commentUrl が無い、または見つからない依頼は今までどおり（いちばん新しい答え）", async () => {
  const D = (await boot({})).w.Desk3;
  const cs = [ANS("2030-01-01T02:00:00Z"), mkc("bot", "依頼", "2030-01-01T03:00:00Z", REQ_URL, 100)];
  assert.equal(D.findAnswers(cs, [{ id: "req-4" }])["req-4"].at, "2030-01-01T02:00:00Z");
  assert.equal(D.findAnswers(cs, [{ id: "req-4", commentUrl: "https://github.com/example/x/issues/4#issuecomment-999" }])["req-4"].at, "2030-01-01T02:00:00Z");
  assert.equal(D.findAnswers(cs)["req-4"].at, "2030-01-01T02:00:00Z");
});

/* ---- 投稿に付く画像・動画 ---- */
const withMedia = (media) => () => {
  const d = require("./fixture")();
  d.requests.find((r) => r.id === "req-11-posts").posts[0].media = media;
  return json(200, JSON.stringify(d));
};
async function bootMedia(media, mediaReply) {
  const b = await boot({ hash: "#turn", desk: withMedia(media) });
  const made = [];
  b.w.URL.createObjectURL = (blob) => { made.push(blob); return "blob:test/" + made.length; };
  const orig = b.w.fetch, mcalls = [];
  b.w.fetch = async (url, o) => {
    const u = String(url);
    if (/\/contents\/marketing\//.test(u)) { mcalls.push({ url: u, headers: (o && o.headers) || {} }); return mediaReply(u); }
    return orig(url, o);
  };
  return { b, made, mcalls };
}
const bytes = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

test("media の path 検査：先頭の / ・ .. ・ 空の部分 ・ 制御文字は弾き、ふつうの path は通す", async () => {
  const b = await boot({});
  const M = b.w.Desk3.mediaPath;
  assert.equal(M("marketing/やめたい人/絵/a.png"), "marketing/やめたい人/絵/a.png");
  for (const bad of ["/etc/a.png", "../a.png", "a/../b.png", "a//b.png", "./a.png", "a\b.png", "a/b\n.png", "", null, 5]) assert.equal(M(bad), null, String(bad));
});

test("media：開く前は取らない。開くと鍵つきで raw 形式で取り、日本語の path は部分ごとにエンコードし、画像と動画を出す。開き直しても取り直さない", async () => {
  const { b, made, mcalls } = await bootMedia(
    [{ kind: "image", path: "marketing/やめたい人/絵/禁煙 今吸いたい.png" }, { kind: "video", path: "marketing/やめたい人/動画/G1.mp4" }], () => bytes());
  assert.equal(mcalls.length, 0);
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  assert.equal(mcalls.length, 2);
  assert.ok(mcalls[0].url.includes("/contents/marketing/" + encodeURIComponent("やめたい人") + "/" + encodeURIComponent("絵") + "/" + encodeURIComponent("禁煙 今吸いたい.png")));
  assert.match(mcalls[0].headers.Accept, /raw/);
  assert.match(mcalls[0].headers.Authorization, /^Bearer /);
  const post = b.$("#req-11-posts-p0");
  const img = post.querySelector("img"), vid = post.querySelector("video");
  assert.equal(img.getAttribute("src").slice(0, 5), "blob:");
  assert.equal(img.closest("a").target, "_blank");
  assert.ok(vid.controls && vid.hasAttribute("playsinline") && vid.muted);
  assert.equal(made[0].type, "image/png");
  assert.equal(made[1].type, "video/mp4");
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  assert.equal(mcalls.length, 2);
});

test("media：取れなかった物は『読めませんでした（理由）』と出し、ほかの画像と本文は壊さない。危ない path は取りに行かない", async () => {
  const { b, mcalls } = await bootMedia(
    [{ kind: "image", path: "marketing/無い.png" }, { kind: "image", path: "../secret.png" }, { kind: "image", path: "marketing/ok.png" }, { kind: "image", path: "marketing/a.exe" }],
    (u) => (/%E7%84%A1/.test(u) ? json(404, { message: "Not Found" }) : bytes()));
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  const slots = b.$$("#req-11-posts-p0 .mslot");
  assert.equal(slots.length, 4);
  assert.match(slots[0].textContent, /読めませんでした（.*見つかりません/);
  assert.match(slots[1].textContent, /読めませんでした（.*安全でない/);
  assert.ok(slots[2].querySelector("img"));
  assert.match(slots[3].textContent, /読めませんでした（.*対応していない/);
  assert.equal(mcalls.length, 2);
  assert.ok(b.$("#req-11-posts-p0 p").textContent.includes("架空の文1"));
  assert.ok(b.$("#req-11-posts-p1"));
});

test("media：投稿以外の依頼（links）の直下の media も出る。links と併用でき、動画は再生できる形で出る", async () => {
  const b = await boot({ hash: "#turn", desk: () => {
    const d = require("./fixture")();
    const r = d.requests.find((x) => x.id === "req-11-choice");
    r.kind = "links"; r.links = [{ label: "別の資料", href: "https://example.com/a" }];
    r.media = [{ kind: "video", path: "marketing/やめたい人/動画/禁煙.mp4" }, { kind: "image", path: "marketing/a.png" }];
    return json(200, JSON.stringify(d));
  } });
  const made = [], calls = [];
  b.w.URL.createObjectURL = (blob) => { made.push(blob); return "blob:t/" + made.length; };
  const orig = b.w.fetch;
  b.w.fetch = async (url, o) => { if (/\/contents\/marketing\//.test(String(url))) { calls.push(String(url)); return bytes(); } return orig(url, o); };
  await b.click(b.$('[data-toggle="req-11-choice"]'));
  const el = b.$("#req-11-choice");
  assert.equal(calls.length, 2);
  const vid = el.querySelector(".media video");
  assert.ok(vid && vid.controls && vid.hasAttribute("playsinline"));
  assert.equal(vid.getAttribute("src").slice(0, 5), "blob:");
  assert.ok(el.querySelector(".media img"));
  assert.ok(el.querySelector(".linklist a"), "links も残る");
});

test("画面：依頼の全文（fullText）を畳んで置き、Markdown を読める形にする。HTML は動かず、ファイルの場所は GitHub のリンクになる", async () => {
  const b = await boot({ hash: "#turn" });
  await b.click(b.$('[data-toggle="req-11-choice"]'));
  const d = b.$("#req-11-choice details.fulltext");
  assert.ok(d, "全文の枠がある");
  assert.equal(d.open, false, "初めは畳んである");
  assert.equal(b.$$("#req-11-posts details.fulltext").length, 0, "fullText が無い依頼には枠を出さない");
  const md = d.querySelector(".md");
  assert.equal(md.querySelector("strong").textContent.includes("決めてほしいこと"), true);
  assert.ok(md.querySelector("blockquote").textContent.includes("引用の行"));
  assert.equal(md.querySelectorAll("ul li").length, 3);
  assert.equal(md.querySelectorAll("ol li").length, 2);
  assert.ok(md.querySelector("h4"));
  assert.ok(md.querySelector("code").textContent === "コード");
  const hrefs = [...md.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  assert.ok(hrefs.includes("https://github.com/Yoshiki0423/app-company/blob/main/marketing/" + encodeURIComponent("架空") + "/" + encodeURIComponent("計画.md")));
  assert.ok(hrefs.includes("https://github.com/Yoshiki0423/app-company/blob/main/staff/" + encodeURIComponent("事業部長.md")));
  assert.ok(hrefs.includes("https://example.com/z"));
  assert.ok(!hrefs.some((h) => /^javascript:/i.test(h)), "javascript: のリンクは作らない");
  assert.equal(md.querySelectorAll("img").length, 0);
  assert.ok(md.textContent.includes("<img src=x onerror=alert(1)>"), "HTML は文字として見える");
});
