/* 社長の机：fetch をモックして、読み込み・答え済みの判定・書き込みの本文・失敗時の表示を確かめる */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { boot, click, json, API } = require("./helpers");
const fixture = require("./fixture");

const T = "github_pat_TEST_FAKE";   // 架空の鍵（本物ではない）
const bossComment = (id, text, at, login) => ({
  user: { login: login || "Yoshiki0423" }, body: `<!-- desk:answer ${id} -->\n${text}`, created_at: at || "2030-01-02T04:00:00Z",
  html_url: "https://github.com/example/x/issues/11#comment-50"
});
const openReq = async (t, id) => { await click(t.w, t.$(`[data-toggle="${id}"]`)); };
const tabTexts = (t) => t.$$("#tabs .tab").map((b) => b.textContent);

test("鍵が無いと、作り方の案内（番号つき8手順と3つの権限）が出て、GitHub は呼ばない", async () => {
  const t = await boot({});
  assert.ok(t.$("#setup"));
  assert.equal(t.$$("#key-steps li").length, 8);
  const all = t.$("#key-steps").textContent;
  for (const s of ["Only select repositories", "app-company", "Issues を「Read and write」", "Contents を「Read-only」", "Actions を「Read-only」"]) assert.ok(all.includes(s), s);
  assert.equal(t.calls.length, 0);
  assert.equal(t.$("#tools").hidden, true);
});

test("鍵を貼って保存すると localStorage に入り、desk.json を読んで表示する", async () => {
  const t = await boot({});
  t.$("#token-in").value = "  " + T + "  ";
  await click(t.w, t.$('[data-act="save-token"]'));
  assert.equal(t.w.localStorage.getItem("desk.token"), T);
  const d = t.calls.find((c) => c.url === `${API}/contents/data/desk.json`);
  assert.ok(d, "desk.json を読んだ");
  assert.equal(d.headers.Authorization, "Bearer " + T);
  assert.equal(d.headers.Accept, "application/vnd.github.raw+json");
  assert.ok(t.calls.every((c) => c.url.startsWith("https://api.github.com/")), "GitHub 以外に送らない");
  assert.deepEqual(tabTexts(t), ["全体3", "#11 架空アプリ2", "#12 マーケ1"]);
  assert.equal(t.$$("#req-slot .req").length, 3);
});

test("最後に読み込んだ時刻が出て、「読み直す」でもう一度読む", async () => {
  const t = await boot({ token: T });
  assert.match(t.$("#stamp").textContent, /^読み込み \d+\/\d+ \d\d:\d\d・最新の記録 1\/2 12:04$/);
  const before = t.calls.length;
  await click(t.w, t.$('#tools [data-act="reload"]'));
  assert.ok(t.calls.length > before);
});

test("リレーの成否は Actions の実行履歴から取る（実行中・飛ばした回は数えない）", async () => {
  const runs = [
    { status: "completed", conclusion: "success", created_at: "2030-01-02T03:00:00Z" },
    { status: "in_progress", conclusion: null, created_at: "2030-01-02T03:01:00Z" },
    { status: "completed", conclusion: "failure", created_at: "2030-01-02T02:00:00Z" },
    { status: "completed", conclusion: "skipped", created_at: "2030-01-02T01:00:00Z" },
    { status: "completed", conclusion: "success", created_at: "2030-01-02T00:00:00Z" }
  ];
  const t = await boot({ token: T, runs: () => json(200, { workflow_runs: runs }) });
  const txt = t.$("#view").textContent;
  assert.ok(txt.includes("リレー直近3回"), txt);
  assert.ok(txt.includes("2/ 3 成功"));
  assert.ok(txt.includes("GitHub の実行履歴より"));
  assert.ok(t.calls.some((c) => c.url === `${API}/actions/workflows/relay.yml/runs?per_page=20`));
});

test("Actions が読めなければ desk.json の値を使い、そう書く", async () => {
  const t = await boot({ token: T, runs: () => json(403, { message: "Resource not accessible" }) });
  const txt = t.$("#view").textContent;
  assert.ok(txt.includes("リレー直近2回"));
  assert.ok(txt.includes("desk.json の架空の記録"));
  assert.ok(t.$("#notice").textContent.includes("実行履歴が読めませんでした"));
});

test("答え済みの判定：社長の印つきコメントだけを数える（他人・別の id・印なしは数えない）", async () => {
  const comments = (n) => (n === 11 ? json(200, [
    bossComment("req-11-posts", "OK"),
    bossComment("req-11-choice", "ある", undefined, "someone-else"),
    { user: { login: "Yoshiki0423" }, body: "OK（印なし）", created_at: "2030-01-02T04:00:00Z" },
    bossComment("req-99-other", "OK")
  ]) : json(200, []));
  const t = await boot({ token: T, comments });
  assert.equal(t.$('[id="req-11-posts-sentpill"]').hidden, false);
  assert.equal(t.$('[id="req-11-choice-sentpill"]').hidden, true);
  assert.ok(t.$('[id="req-11-posts-zone"]').textContent.includes("回答済み"));
  assert.deepEqual(tabTexts(t), ["全体2", "#11 架空アプリ1", "#12 マーケ1"]);
});

test("答え済みの判定：コメントが100件を超えても次のページまで読む", async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ user: { login: "bot" }, body: "x" + i, created_at: "2030-01-01T00:00:00Z" }));
  const comments = (n, page) => (n === 11 ? json(200, page === 1 ? filler : [bossComment("req-11-choice", "ない")]) : json(200, []));
  const t = await boot({ token: T, comments });
  assert.equal(t.$('[id="req-11-choice-sentpill"]').hidden, false);
  assert.ok(t.calls.some((c) => c.url.includes("/issues/11/comments?per_page=100&page=2")));
});

test("答え済みの判定：同じ依頼に二度答えていたら新しい方を出す", async () => {
  const comments = (n) => (n === 11 ? json(200, [bossComment("req-11-choice", "ない", "2030-01-02T05:00:00Z"), bossComment("req-11-choice", "ある", "2030-01-02T04:00:00Z")]) : json(200, []));
  const t = await boot({ token: T, comments });
  assert.equal(t.$('[id="req-11-choice-zone"] pre').textContent, "ない");
});

test("コメントが読めなかった Issue は「確かめられませんでした」と出し、未回答として残す", async () => {
  const comments = (n) => (n === 12 ? json(500, {}) : json(200, []));
  const t = await boot({ token: T, comments });
  assert.ok(t.$('[id="req-12-links"]').textContent.includes("回答済みか確かめられませんでした"));
  assert.ok(t.$("#notice").textContent.includes("Issue #12 のコメントが読めず"));
  assert.ok(!t.$('[id="req-11-posts"]').textContent.includes("確かめられませんでした"));
});

test("書き込みの本文：OK だけ → 先頭に印、次の行に OK", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await click(t.w, t.$('[data-send="req-11-posts|ok"]'));
  const p = t.calls.find((c) => c.method === "POST");
  assert.equal(p.url, `${API}/issues/11/comments`);
  assert.equal(p.headers.Authorization, "Bearer " + T);
  assert.deepEqual(p.body, { body: "<!-- desk:answer req-11-posts -->\nOK" });
  assert.ok(t.$('[id="req-11-posts-zone"]').textContent.includes("送りました"));
  assert.equal(t.$('[id="req-11-posts-sentpill"]').hidden, false);
  assert.equal(tabTexts(t)[0], "全体2");
});

test("書き込みの本文：直したい投稿と一言（番号順に並ぶ）", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await click(t.w, t.$('[data-flag="req-11-posts|2"]'));
  await click(t.w, t.$('[data-flag="req-11-posts|0"]'));
  t.$('[id="req-11-posts-note"]').value = "  語尾を柔らかく  ";
  await click(t.w, t.$('[data-send="req-11-posts|note"]'));
  const p = t.calls.find((c) => c.method === "POST");
  assert.equal(p.body.body, "<!-- desk:answer req-11-posts -->\n直したい：日1・日3\n語尾を柔らかく");
});

test("書き込みの本文：選ぶ形は、選ぶまで送れず、選んだ答えと一言を送る", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-choice");
  assert.equal(t.$('[data-send="req-11-choice|choice"]').disabled, true);
  await click(t.w, t.$('[data-choice="req-11-choice|分からない"]'));
  t.$('[id="req-11-choice-note"]').value = "設定に見当たらない";
  await click(t.w, t.$('[data-send="req-11-choice|choice"]'));
  const p = t.calls.find((c) => c.method === "POST");
  assert.equal(p.body.body, "<!-- desk:answer req-11-choice -->\n分からない\n設定に見当たらない");
});

test("空のまま「一言を送る」を押すと送らずに知らせる", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await click(t.w, t.$('[data-send="req-11-posts|note"]'));
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(t.$('[id="req-11-posts-msg"]').textContent, "答えか一言を入れてください。");
});

test("書き込みに失敗したら、その旨と「もう一度送る」を出し、押すと同じ本文で送り直す", async () => {
  let n = 0;
  const post = () => (++n === 1 ? json(500, { message: "boom" }) : json(201, { html_url: "https://github.com/example/x/issues/11#comment-7", created_at: "2030-01-02T06:00:00Z" }));
  const t = await boot({ token: T, post });
  await openReq(t, "req-11-posts");
  await click(t.w, t.$('[data-send="req-11-posts|ok"]'));
  const zone = t.$('[id="req-11-posts-zone"]');
  assert.ok(zone.textContent.includes("送れませんでした"));
  assert.ok(zone.querySelector('[role="alert"]'));
  assert.equal(t.$('[id="req-11-posts-sentpill"]').hidden, true);
  assert.equal(tabTexts(t)[0], "全体3", "失敗したものは未回答のまま");
  await click(t.w, t.$('[data-retry="req-11-posts"]'));
  const posts = t.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, posts[0].body);
  assert.ok(t.$('[id="req-11-posts-zone"]').textContent.includes("送りました"));
});

test("つながらずに失敗したときも、送り直しのボタンを出す", async () => {
  const t = await boot({ token: T, post: () => { throw new TypeError("Failed to fetch"); } });
  await openReq(t, "req-11-choice");
  await click(t.w, t.$('[data-choice="req-11-choice|ある"]'));
  await click(t.w, t.$('[data-send="req-11-choice|choice"]'));
  assert.ok(t.$('[id="req-11-choice-zone"]').textContent.includes("GitHub につながりませんでした"));
  assert.ok(t.$('[data-retry="req-11-choice"]'));
});

test("鍵が使えない（401）と、その旨を出し、「鍵を消す」で localStorage から消えて案内に戻る", async () => {
  const t = await boot({ token: T, desk: () => json(401, { message: "Bad credentials" }) });
  assert.ok(t.$("#notice").textContent.includes("鍵が使えませんでした"));
  assert.equal(t.$("#stamp").textContent, "まだ読み込めていません");
  await click(t.w, t.$('#notice [data-act="forget"]'));
  assert.equal(t.w.localStorage.getItem("desk.token"), null);
  assert.ok(t.$("#setup"));
});

test("desk.json が見つからない（404）と、鍵の対象を確かめるよう出す", async () => {
  const t = await boot({ token: T, desk: () => json(404, {}) });
  assert.ok(t.$("#notice").textContent.includes("Repository access"));
});

test("読み直しに失敗しても、前に読めた中身と時刻は残す", async () => {
  let n = 0;
  const desk = () => (++n === 1 ? json(200, JSON.stringify(fixture())) : json(503, {}));
  const t = await boot({ token: T, desk });
  await click(t.w, t.$('#tools [data-act="reload"]'));
  assert.ok(t.$("#notice").textContent.includes("読み込めませんでした"));
  assert.ok(t.$("#notice").textContent.includes("読み込んだときの中身です"));
  assert.match(t.$("#stamp").textContent, /^読み込み /);
  assert.equal(t.$$("#req-slot .req").length, 3);
});

test("読み直しても、送っていない一言は消えない", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  t.$('[id="req-11-posts-note"]').value = "書きかけ";
  await click(t.w, t.$('#tools [data-act="reload"]'));
  assert.equal(t.$('[id="req-11-posts-note"]').value, "書きかけ");
});

test("javascript: などのリンクは押せる形にしない", async () => {
  const t = await boot({ token: T });
  const hrefs = t.$$("a").map((a) => a.getAttribute("href"));
  assert.ok(hrefs.includes("https://example.com/a"));
  assert.ok(!hrefs.some((h) => /^javascript:/i.test(h)));
});

test("Issue の切り替え：#11 を押すとその分だけになり、答えが要る依頼は開いている", async () => {
  const t = await boot({ token: T });
  await click(t.w, t.$('#tabs [data-go="i11"]'));
  assert.equal(t.$$("#req-slot .req").length, 2);
  assert.equal(t.$('[data-toggle="req-11-posts"]').getAttribute("aria-expanded"), "true");
  assert.equal(t.w.location.hash, "#i11");
});

test("入れ物に会社のデータや鍵を持たない（鍵らしき文字や Issue のコメントの URL が無い）", () => {
  for (const f of ["index.html", "app.js", "manifest.webmanifest"]) {
    const s = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.ok(!/github_pat_[A-Za-z0-9]{10,}/.test(s), f + " に鍵らしき文字");
    assert.ok(!s.includes("issuecomment-"), f + " に Issue のコメントの URL");
  }
});
