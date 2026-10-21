/* v3（新しい画面）のテスト。純粋な数え方は Desk3 から直接、画面は jsdom + 偽の GitHub で確かめる */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { boot, json } = require("./v3helpers");

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
  const html = fs.readFileSync(path.join(__dirname, "..", "v3", "index.html"), "utf8");
  assert.ok(html.includes("connect-src https://api.github.com;"));
  assert.ok(html.includes("font-src https://fonts.gstatic.com;"));
  for (const f of ["index.html", "app.js"]) assert.ok(!/github_pat_[A-Za-z0-9]{10,}/.test(fs.readFileSync(path.join(__dirname, "..", "v3", f), "utf8")));
});
