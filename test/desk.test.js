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
const blkN = (t) => t.$("#blkN").textContent;   // 「社長が止めているもの」の件数

test("鍵が無いと、作り方の案内（番号つき8手順と3つの権限）が出て、GitHub は呼ばない", async () => {
  const t = await boot({});
  assert.ok(t.$("#setup"));
  assert.equal(t.$$("#key-steps li").length, 8);
  const all = t.$("#key-steps").textContent;
  for (const s of ["Only select repositories", "app-company", "Issues を「Read and write」", "Contents を「Read and write」", "Actions を「Read-only」"]) assert.ok(all.includes(s), s);
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
  assert.equal(blkN(t), "3件");
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
  assert.ok(txt.includes("2 / 3 成功"));
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
  assert.equal(blkN(t), "2件");
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
  assert.equal(blkN(t), "2件");
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
  assert.equal(blkN(t), "3件", "失敗したものは未回答のまま");
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

/* ---- 線表の画面 ---- */
const seg = (t, row, name) => t.$$(`.row[data-row="${row}"] .seg`).find((e) => e.textContent === name);
const pctOf = (el, prop) => parseFloat(el.style[prop]);

test("上の結論：公開まであと何日と、止めているものの件数・見込み", async () => {
  const t = await boot({ token: T });
  const v = t.$(".verdict").textContent;
  assert.ok(v.includes("30日"), v);                 // 2030-01-02 から 2030-02-01
  assert.ok(v.includes("公開（2/1）まで"));
  assert.ok(v.includes("架空の見込み"));
  assert.ok(v.includes("架空の心配"));
  assert.equal(blkN(t), "3件");
  const jumps = t.$$("#blkP [data-jump]").map((a) => a.textContent);
  assert.deepEqual(jumps, ["架空の投稿 →", "架空の確認 →", "架空のリンク →"]);
});

test("公開日を過ぎたら、日数ではなく「日過ぎた」と出す", async () => {
  const t = await boot({ token: T, today: "2030-02-03" });
  assert.ok(t.$(".verdict").textContent.includes("2日過ぎた"));
});

test("線表：作る・広めるの行と、区間の状態（済み・いま・予定・日付未定）と外の返事待ち", async () => {
  const t = await boot({ token: T });
  assert.deepEqual(t.$$(".grp").map((e) => e.textContent), ["作る", "広める"]);
  assert.deepEqual(t.$$(".row").map((e) => e.dataset.row), ["app11", "mk12", "quiet"]);
  assert.ok(seg(t, "app11", "開発").classList.contains("done"));
  assert.ok(seg(t, "app11", "確認").classList.contains("now"));
  assert.ok(seg(t, "app11", "準備").classList.contains("undated"));
  assert.ok(seg(t, "app11", "審査").classList.contains("plan"));
  assert.ok(seg(t, "app11", "審査").classList.contains("waitb"), "外の返事待ちの印");
  assert.ok(!seg(t, "app11", "準備").classList.contains("waitb"));
  assert.ok(t.$(".row[data-row=quiet] .track").textContent.trim() === "", "区間が無い行は空");
});

test("線表：横の位置は日付どおり（範囲 1/1〜2/11 の 41日）で、終わりの無い区間は前後からつながる", async () => {
  const t = await boot({ token: T });
  const day = 100 / 41;
  const kai = seg(t, "app11", "確認");            // 1/2 から、終わりが無い「いま」→ 今日から7日先（1/9）まで
  assert.ok(Math.abs(pctOf(kai, "left") - 1 * day) < 0.05);
  assert.ok(Math.abs(pctOf(kai, "width") - 7 * day) < 0.05);
  const jun = seg(t, "app11", "準備");            // 始まり無し → 前の終わり（1/9）、終わりは 1/20
  assert.ok(Math.abs(pctOf(jun, "left") - 8 * day) < 0.05);
  assert.ok(Math.abs(pctOf(jun, "left") + pctOf(jun, "width") - 19 * day) < 0.05);
  const today = t.$(".vline.today"), goal = t.$(".vline.goal");
  assert.ok(Math.abs(pctOf(today, "left") - 1 * day) < 0.05);
  assert.ok(Math.abs(pctOf(goal, "left") - 31 * day) < 0.05);
  assert.equal(t.$(".vlab.goal").textContent, "公開");
});

test("線表の行：止めている依頼がある行だけ「社長」の印が付き、答えると印が消えて件数も減る", async () => {
  const t = await boot({ token: T });
  assert.ok(t.$(".row[data-row=app11] .badge"));
  assert.ok(t.$(".row[data-row=app11] .nm").classList.contains("me"));
  assert.ok(t.$(".row[data-row=mk12] .badge"));
  assert.ok(!t.$(".row[data-row=quiet] .badge"));
  assert.ok(t.$(".row[data-row=quiet] .nm").classList.contains("ok"));
  // app11 の依頼は2つ。1つ答えても、もう1つが残る間は印が残る
  await openReq(t, "req-11-posts");
  await click(t.w, t.$('[data-send="req-11-posts|ok"]'));
  assert.ok(t.$(".row[data-row=app11] .badge"));
  assert.equal(blkN(t), "2件");
  await openReq(t, "req-11-choice");
  await click(t.w, t.$('[data-choice="req-11-choice|ある"]'));
  await click(t.w, t.$('[data-send="req-11-choice|choice"]'));
  assert.ok(!t.$(".row[data-row=app11] .badge"), "答え切ったので印は消える");
  assert.ok(t.$(".row[data-row=app11] .nm").classList.contains("ok"));
  assert.equal(blkN(t), "1件");
});

test("飛べる：線表の「社長」の印と、上の件数の下のリンクから、その依頼の答える欄が開く", async () => {
  const t = await boot({ token: T });
  assert.equal(t.$('[data-toggle="req-12-links"]').getAttribute("aria-expanded"), "false");
  await click(t.w, t.$(".row[data-row=mk12] .badge"));
  assert.equal(t.$('[data-toggle="req-12-links"]').getAttribute("aria-expanded"), "true");
  assert.ok(t.$('[id="req-12-links"]').classList.contains("flash"));
  assert.ok(!t.$('[id="req-12-links-body"]').hidden);
  await click(t.w, t.$('#blkP [data-jump="req-11-choice"]'));
  assert.equal(t.$('[data-toggle="req-11-choice"]').getAttribute("aria-expanded"), "true");
  assert.equal(t.w.document.activeElement.dataset.toggle, "req-11-choice", "開いた依頼に移る");
});

test("止めているものが0件なら「いまはなし」で、「社長がやること」の欄は出ない", async () => {
  const f = fixture(); f.requests = [];
  const t = await boot({ token: T, desk: () => json(200, JSON.stringify(f)) });
  assert.equal(blkN(t), "0件");
  assert.ok(t.$("#blkP").textContent.includes("いまはなし"));
  assert.equal(t.$("#todo"), null);
  assert.ok(!t.$(".badge"));
  assert.equal(t.$$(".row").length, 3, "線表は出る");
});

test("全部答え済みなら0件になり、答え済みの依頼カードは残る", async () => {
  const comments = (n) => json(200, n === 11 ? [bossComment("req-11-posts", "OK"), bossComment("req-11-choice", "ある")]
    : n === 12 ? [bossComment("req-12-links", "OK")] : []);
  const t = await boot({ token: T, comments });
  assert.equal(blkN(t), "0件");
  assert.equal(t.$$("#req-slot .req").length, 3);
  assert.ok(!t.$(".badge"));
});

test("この先の予定と、返事待ち（社長の操作はいらない）が別の欄で出る", async () => {
  const t = await boot({ token: T });
  const txt = t.$("#view").textContent;
  assert.ok(txt.includes("この先の予定") && txt.includes("1/5") && txt.includes("架空の予定"));
  assert.ok(txt.includes("返事待ち（社長の操作はいらない）") && txt.includes("架空の返事待ち"));
  assert.ok(!t.$("#blkP").textContent.includes("返事待ち"), "返事待ちは「止めているもの」に数えない");
});

test("古い形の desk.json（issues があり timeline が無い）は、そう伝えて落ちない", async () => {
  const old = { issues: [], requests: [], depts: [] };
  const t = await boot({ token: T, desk: () => json(200, JSON.stringify(old)) });
  assert.ok(t.$("#notice").textContent.includes("まだ古い形"));
  assert.ok(t.$("#tools") && !t.$("#tools").hidden);
});

test("区間の日付の決め方：始まり無し＝前の終わり／終わり無し＝次の始まり（無ければ公開日）", async () => {
  const Desk = (await boot({})).w.Desk;
  const r = { segments: [{ name: "a", from: "2030-01-01", to: "2030-01-05", state: "done" }, { name: "b", state: "undated" }, { name: "c", from: "2030-01-10", to: "2030-01-12", state: "plan" }, { name: "d", state: "undated" }] };
  const day = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
  const out = Desk.resolveSegments(r, day("2030-01-02"), day("2030-02-01"), day("2030-01-01"));
  assert.equal(out[1].a, day("2030-01-05"));
  assert.equal(out[1].b, day("2030-01-10"));
  assert.equal(out[3].a, day("2030-01-12"));
  assert.equal(out[3].b, day("2030-02-01"));
});

test("入れ物に会社のデータや鍵を持たない（鍵らしき文字や Issue のコメントの URL が無い）", () => {
  for (const f of ["index.html", "app.js", "manifest.webmanifest"]) {
    const s = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.ok(!/github_pat_[A-Za-z0-9]{10,}/.test(s), f + " に鍵らしき文字");
    assert.ok(!s.includes("issuecomment-"), f + " に Issue のコメントの URL");
  }
});

/* ============ 画像を付ける ============ */
const attach = async (t, id, n) => {
  const inp = t.$(`[id="${id}-file"]`);
  const files = Array.from({ length: n }, (_, i) => ({ name: `p${i}.png`, type: "image/png" }));
  Object.defineProperty(inp, "files", { value: files, configurable: true });
  inp.dispatchEvent(new t.w.Event("change", { bubbles: true }));
  await new Promise((r) => t.w.setTimeout(r, 0)); await new Promise((r) => t.w.setTimeout(r, 0));
  await click(t.w, t.$("body"));
};
const puts = (t) => t.calls.filter((c) => c.method === "PUT");
const posts = (t) => t.calls.filter((c) => c.method === "POST");

test("画像：見本が出て、外せる。置き場所は data/desk-images/<日付>/<依頼id>/ の下", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await attach(t, "req-11-posts", 2);
  assert.equal(t.$$('[id="req-11-posts-imgs"] img').length, 2);
  assert.ok(t.$$('[id="req-11-posts-imgs"] img')[0].src.startsWith("data:image/jpeg"), "見本は data: （CSP で許可済み）");
  await click(t.w, t.$('[data-rmimg="req-11-posts|0"]'));
  assert.equal(t.$$('[id="req-11-posts-imgs"] img').length, 1);
});

test("画像：先に保存して、成功したら答えのコメントを書く（パスとリンクを入れる）", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await attach(t, "req-11-posts", 2);
  t.$('[id="req-11-posts-note"]').value = "スイッチが上寄り";
  await click(t.w, t.$('[data-send="req-11-posts|note"]'));
  assert.equal(puts(t).length, 2);
  const p0 = puts(t)[0];
  assert.match(p0.url, /^https:\/\/api\.github\.com\/repos\/Yoshiki0423\/app-company\/contents\/data\/desk-images\/\d{4}-\d\d-\d\d\/req-11-posts\/\d{6}-1\.jpg$/);
  assert.equal(p0.body.content, "QUJD");
  assert.equal(p0.body.branch, "main");
  assert.equal(p0.headers.Authorization, "Bearer " + T);
  const order = t.calls.filter((c) => c.method === "PUT" || c.method === "POST").map((c) => c.method);
  assert.deepEqual(order, ["PUT", "PUT", "POST"], "画像が先、コメントが最後");
  const body = posts(t)[0].body.body;
  assert.ok(body.startsWith("<!-- desk:answer req-11-posts -->\nスイッチが上寄り\n\n画像 2 枚"), body);
  assert.ok(body.includes("- data/desk-images/") && body.includes("https://github.com/Yoshiki0423/app-company/blob/main/data/desk-images/"));
  assert.ok(t.$('[id="req-11-posts-zone"]').textContent.includes("送りました"));
});

test("画像：言葉なしで画像だけでも送れる", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await attach(t, "req-11-posts", 1);
  await click(t.w, t.$('[data-send="req-11-posts|note"]'));
  assert.equal(puts(t).length, 1);
  assert.equal(posts(t).length, 1);
});

test("画像：途中で失敗したら何が送れたかを出し、もう一度送ると続きから（保存済みは二重に保存しない）", async () => {
  let n = 0;
  const put = () => (++n === 2 ? json(500, { message: "boom" }) : json(201, {}));
  const t = await boot({ token: T, put });
  await openReq(t, "req-11-posts");
  await attach(t, "req-11-posts", 3);
  await click(t.w, t.$('[data-send="req-11-posts|ok"]'));
  const zone = t.$('[id="req-11-posts-zone"]');
  assert.ok(zone.textContent.includes("3 枚のうち 1 枚は保存できました、2 枚は送れていません"), zone.textContent);
  assert.equal(posts(t).length, 0, "画像が揃うまでコメントは書かない");
  const firstPath = puts(t)[0].url;
  await click(t.w, t.$('[data-retry="req-11-posts"]'));
  const urls = puts(t).map((c) => c.url);
  assert.equal(urls.filter((u) => u === firstPath).length, 1, "保存済みの1枚目は再送しない");
  assert.equal(new Set(urls).size, 3);
  assert.equal(posts(t).length, 1);
  assert.ok(posts(t)[0].body.body.includes("画像 3 枚"));
});

test("画像：コメントだけ失敗したときも、やり直しで画像は再保存しない", async () => {
  let n = 0;
  const post = () => (++n === 1 ? json(500, { message: "boom" }) : json(201, { html_url: "https://github.com/example/x/issues/11#comment-8", created_at: "2030-01-02T06:00:00Z" }));
  const t = await boot({ token: T, post });
  await openReq(t, "req-11-posts");
  await attach(t, "req-11-posts", 1);
  await click(t.w, t.$('[data-send="req-11-posts|ok"]'));
  await click(t.w, t.$('[data-retry="req-11-posts"]'));
  assert.equal(puts(t).length, 1);
  assert.equal(posts(t).length, 2);
});

test("画像：鍵に書き込みの権限が無い（403）と分かる言葉で出し、画像を外せば言葉だけ送れる", async () => {
  const t = await boot({ token: T, put: () => json(403, { message: "Resource not accessible by personal access token" }) });
  await openReq(t, "req-11-posts");
  await attach(t, "req-11-posts", 1);
  t.$('[id="req-11-posts-note"]').value = "ここ直して";
  await click(t.w, t.$('[data-send="req-11-posts|note"]'));
  const zone = t.$('[id="req-11-posts-zone"]');
  assert.ok(zone.textContent.includes("鍵に書き込みの権限がありません"));
  assert.ok(zone.textContent.includes("作り直し方"));
  assert.equal(posts(t).length, 0);
  await click(t.w, t.$('[data-dropimg="req-11-posts"]'));
  assert.equal(posts(t).length, 1);
  assert.equal(posts(t)[0].body.body, "<!-- desk:answer req-11-posts -->\nここ直して", "画像の行は入らない");
});

test("画像：画像なしの答えは今までどおり（PUT しない）", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await click(t.w, t.$('[data-send="req-11-posts|ok"]'));
  assert.equal(puts(t).length, 0);
  assert.deepEqual(posts(t)[0].body, { body: "<!-- desk:answer req-11-posts -->\nOK" });
});

test("画像：7枚目は付けず知らせる／縮められない写真は数えて知らせる", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await attach(t, "req-11-posts", 8);
  assert.equal(t.$$('[id="req-11-posts-imgs"] img').length, 6);
  assert.ok(t.$('[id="req-11-posts-msg"]').textContent.includes("6 枚まで"));
  const t2 = await boot({ token: T, shrink: async () => { throw new Error("x"); } });
  await openReq(t2, "req-11-posts");
  await attach(t2, "req-11-posts", 1);
  assert.equal(t2.$$('[id="req-11-posts-imgs"] img').length, 0);
  assert.ok(t2.$('[id="req-11-posts-msg"]').textContent.includes("1 枚は読めませんでした"));
});

test("画像：CSP は GitHub 以外に送らず、画像は data: だけで見せる。読み直しても付けた画像は残る", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(html.includes("connect-src https://api.github.com;"));
  assert.ok(html.includes("img-src 'self' data:;") && !/blob:/.test(html));
  assert.ok(html.includes("app.js?v=9"));
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  await attach(t, "req-11-posts", 1);
  await click(t.w, t.$('#tools [data-act="reload"]'));
  await openReq(t, "req-11-posts");
  assert.equal(t.$$('[id="req-11-posts-imgs"] img').length, 1);
  assert.ok(t.calls.every((c) => c.url.startsWith("https://api.github.com/")));
});

test("欄が欠けた依頼でも黙って消さず出し、中身が空の見出し（推し・お金・実物など）は出さない", async () => {
  const f = fixture();
  f.requests = [{ id: "req-bare", issue: 21, urgency: "need", title: "欄の少ない依頼", kind: "text" }];
  f.timeline = f.timeline.map((g) => ({ ...g, rows: g.rows.map((r) => ({ ...r })) }));
  const t = await boot({ token: T, desk: () => json(200, JSON.stringify(f)) });
  await openReq(t, "req-bare");
  const card = t.$("#req-bare");
  assert.ok(card, "依頼が出ている");
  assert.equal(blkN(t), "1件");
  assert.ok(card.textContent.includes("欄の少ない依頼"));
  assert.ok(card.querySelector("[data-send]"), "答えのボタンが出る（answer が無くても）");
  for (const w of ["推し", "お金", "取り消せるか", "効く範囲", "決めること"]) assert.ok(!card.textContent.includes(w), `${w} の見出しは出ない`);
  assert.ok(!card.querySelector(".real"), "実物の枠は出ない");
  assert.ok(!card.querySelector(".facts"));
});

test("欄が揃った依頼では、推し・お金・取り消せるか・効く範囲・実物の見出しが出る", async () => {
  const t = await boot({ token: T });
  await openReq(t, "req-11-posts");
  const card = t.$("#req-11-posts");
  for (const w of ["推し", "お金", "取り消せるか", "効く範囲", "決めること", "実物"]) assert.ok(card.textContent.includes(w), `${w} が出る`);
});

/* ---------- 事業部長に話しかける ---------- */
const mgr = (text, at, login) => ({ user: { login: login || "github-actions[bot]" }, body: text, created_at: at, html_url: "https://github.com/example/x/issues/5#issuecomment-" + at.length });
const talkRoutes = (list, extra) => ({ issue: (n) => json(200, { number: n, comments: list.length }), comments: (n, page) => json(200, n === 5 ? list : []), ...(extra || {}) });
const talkPosts = (t) => posts(t).filter((c) => /\/issues\/5\/comments$/.test(c.url));
const settleN = async (t) => { for (let i = 0; i < 10; i++) await new Promise((r) => t.w.setTimeout(r, 0)); };

test("話しかけ：止めているものが0件でも、結論のすぐ下に常に出る", async () => {
  const d = fixture(); d.requests = [];
  const t = await boot({ token: T, ...talkRoutes([]), desk: () => json(200, JSON.stringify(d)) });
  const talk = t.$("#talk");
  assert.ok(talk, "話しかける欄がある");
  assert.ok(talk.textContent.includes("事業部長に話しかける"));
  assert.equal(talk.parentElement.id, "talk-slot");
  const act = talk.parentElement.previousElementSibling, vd = act.previousElementSibling;
  assert.equal(act.id, "active", "話しかける欄の上は、いま動いている欄");
  assert.ok(vd.querySelector(".verdict") || vd.className.includes("verdict"), "その上が結論");
  assert.equal(t.$("#todo"), null, "依頼の欄は出ない");
});

test("話しかけ：送ると #5 に <!-- desk:talk --> つきの社長のコメントで書き、送ったと分かる", async () => {
  const t = await boot({ token: T, ...talkRoutes([]) });
  t.$("#talk-note").value = "禁煙の相談先を調べて\n2行目";
  await click(t.w, t.$('[data-talk="send"]'));
  const p = talkPosts(t);
  assert.equal(p.length, 1);
  assert.equal(p[0].body.body, "<!-- desk:talk -->\n禁煙の相談先を調べて\n2行目");
  assert.equal(p[0].headers.Authorization, "Bearer " + T);
  assert.ok(t.$("#talk-msg").textContent.includes("送りました。事業部長が読みます（返事は下に出ます）"));
  assert.equal(t.$("#talk-note").value, "", "送ったら空にする");
  assert.ok(!p[0].body.body.includes("desk:answer"), "答えの印は付けない");
});

test("話しかけ：空のまま送ると送らずに知らせる", async () => {
  const t = await boot({ token: T, ...talkRoutes([]) });
  await click(t.w, t.$('[data-talk="send"]'));
  assert.equal(talkPosts(t).length, 0);
  assert.ok(t.$("#talk-msg").textContent.includes("入れてください"));
});

test("話しかけ：失敗したら文を残し、もう一度送れる", async () => {
  let n = 0;
  const t = await boot({ token: T, ...talkRoutes([]), post: () => (++n === 1 ? json(403, { message: "x" }) : json(201, { html_url: "https://github.com/example/x/issues/5#issuecomment-9", created_at: "2030-01-02T05:00:00Z" })) });
  t.$("#talk-note").value = "また送る";
  await click(t.w, t.$('[data-talk="send"]'));
  assert.ok(t.$("#talk-msg").textContent.includes("送れませんでした"));
  assert.equal(t.$("#talk-note").value, "また送る");
  await click(t.w, t.$('[data-talk="send"]'));
  assert.ok(t.$("#talk-msg").textContent.includes("送りました"));
  assert.equal(talkPosts(t).length, 2);
});

test("話しかけ：画像は先に保存してから #5 にコメント（パスとリンク入り）", async () => {
  const t = await boot({ token: T, ...talkRoutes([]) });
  const inp = t.$("#talk-file");
  Object.defineProperty(inp, "files", { value: [{ name: "a.png", type: "image/png" }, { name: "b.png", type: "image/png" }], configurable: true });
  inp.dispatchEvent(new t.w.Event("change", { bubbles: true }));
  await settleN(t);
  assert.equal(t.$$("#talk-imgs img").length, 2);
  t.$("#talk-note").value = "この画面を見て";
  await click(t.w, t.$('[data-talk="send"]'));
  assert.equal(puts(t).length, 2);
  assert.match(puts(t)[0].url, /\/contents\/data\/desk-images\/\d{4}-\d\d-\d\d\/talk\/\d{6}-1\.jpg$/);
  assert.deepEqual(t.calls.filter((c) => c.method === "PUT" || c.method === "POST").map((c) => c.method), ["PUT", "PUT", "POST"]);
  const b = talkPosts(t)[0].body.body;
  assert.ok(b.startsWith("<!-- desk:talk -->\nこの画面を見て\n\n画像 2 枚"), b);
  assert.ok(b.includes("https://github.com/Yoshiki0423/app-company/blob/main/data/desk-images/"));
});

test("話しかけ：最近のやり取りを新しい順に並べる。毎日の報告は畳み、社長の言葉に混ぜない", async () => {
  const long = "【事業部長】毎日の報告\n" + "長い報告 ".repeat(100);
  const list = [
    mgr(long, "2030-01-01T09:00:00Z"),
    { user: { login: "Yoshiki0423" }, body: "<!-- desk:talk -->\n一つ目の相談", created_at: "2030-01-01T10:00:00Z", html_url: "" },
    mgr("【事業部長】一つ目への返事です", "2030-01-01T11:00:00Z"),
    { user: { login: "Yoshiki0423" }, body: "<!-- desk:talk -->\n二つ目の相談", created_at: "2030-01-02T01:00:00Z", html_url: "" },
    mgr(long, "2030-01-02T02:00:00Z")
  ];
  const t = await boot({ token: T, ...talkRoutes(list) });
  const txt = t.$("#talk-list").textContent;
  assert.ok(txt.indexOf("二つ目の相談") < txt.indexOf("一つ目の相談"), "新しい順");
  assert.ok(txt.includes("一つ目への返事です"));
  assert.ok(!txt.includes("desk:talk"), "印は見せない");
  const reports = [...t.$$("#talk-list .turn")].filter((x) => x.textContent.includes("毎日の報告"));
  assert.equal(reports.length, 2);
  for (const r of reports) {
    assert.ok(r.querySelector("details"), "長い報告は畳む");
    assert.ok(!r.textContent.includes("相談"), "報告は社長の言葉と混ざらない");
  }
  assert.ok(t.$$("#talk-list .turn")[0].textContent.includes("毎日の報告"), "いちばん新しい報告が先頭");
});

test("話しかけ：1件ずつ created_at の新しい順に並ぶ（社長の言葉も返事も報告も同じ1列）", async () => {
  const rep = "【事業部長】毎日の報告\nきょう";
  const list = [
    { user: { login: "Yoshiki0423" }, body: "<!-- desk:talk -->\nA相談", created_at: "2030-01-01T10:00:00Z", html_url: "" },
    mgr("【事業部長】A返事", "2030-01-01T11:00:00Z"),
    mgr(rep, "2030-01-01T12:00:00Z"),
    { user: { login: "Yoshiki0423" }, body: "<!-- desk:talk -->\nB相談", created_at: "2030-01-01T13:00:00Z", html_url: "" },
    mgr("【企画部】B返事", "2030-01-01T14:00:00Z")
  ];
  const t = await boot({ token: T, ...talkRoutes(list) });
  const turns = [...t.$$("#talk-list .turn")].map((x) => x.textContent);
  const key = ["B返事", "B相談", "毎日の報告", "A返事", "A相談"];
  assert.deepEqual(key.map((k) => turns.findIndex((x) => x.includes(k))), [0, 1, 2, 3, 4]);
  assert.ok(turns[0].includes("企画部"), "返事の名前は残る");
  assert.ok(!turns[3].includes("まだ返事"), "返事のある相談に返事待ちは出ない");
});

test("話しかけ：buildTurns は1件ずつ新しい順に n 件。返事待ちは次の社長の言葉・報告までに返事が無い相談だけ", async () => {
  const t = await boot({ token: T, ...talkRoutes([]) });
  const boss = (b, at) => ({ user: { login: "Yoshiki0423" }, body: b, created_at: at, html_url: "" });
  const out = t.w.Desk.buildTurns([
    boss("<!-- desk:talk -->\n一", "2030-01-01T01:00:00Z"),
    boss("<!-- desk:talk -->\n二", "2030-01-01T02:00:00Z"),
    mgr("【事業部長】二への返事", "2030-01-01T03:00:00Z"),
    boss("<!-- desk:answer x -->\n答え", "2030-01-01T04:00:00Z")
  ], 4);
  assert.deepEqual([...out.map((x) => x.who + ":" + x.text.trim())], ["boss:答え", "mgr:【事業部長】二への返事", "boss:二", "boss:一"]);
  assert.deepEqual([...out.map((x) => !!x.pending)], [false, false, false, true], "一だけ、次の社長の言葉までに返事が無い");
});

test("話しかけ：返事が無い最新の相談には返事待ちと出す。10件まで、5件目より前は畳む", async () => {
  const list = [];
  for (let i = 1; i <= 12; i++) list.push({ user: { login: "Yoshiki0423" }, body: "<!-- desk:talk -->\n相談" + String(i).padStart(2, "0"), created_at: "2030-01-" + String(i).padStart(2, "0") + "T01:00:00Z", html_url: "" });
  const t = await boot({ token: T, ...talkRoutes(list) });
  const all = t.$("#talk-list").textContent;
  assert.ok(all.includes("相談12") && all.includes("相談03") && !all.includes("相談02"), "10件まで");
  assert.ok(t.$("#talk-list .turn").textContent.includes("まだ返事はありません"));
  assert.ok(t.$("#talk-list > details"), "古い方は畳む");
  assert.equal(t.$$("#talk-list > .turn").length, 5, "畳まずに見せるのは5件");
  assert.ok(t.$("#talk-list > details summary").textContent.includes("5件"));
});

test("画面の並び：いま動いている欄は結論の下・話しかける欄の上", async () => {
  const t = await boot({ token: T, ...talkRoutes([]) });
  const act = t.$("#active"), slot = t.$("#talk-slot");
  assert.ok(act && slot);
  assert.ok(act.compareDocumentPosition(slot) & 4, "いま動いている欄が話しかける欄より先");
});

test("話しかけ：コメントが多い #5 は最後のページから読む。読めなくても送る欄は使える", async () => {
  const seen = [];
  const t = await boot({ token: T, issue: () => json(200, { comments: 250 }), comments: (n, page) => { if (n === 5) seen.push(page); return json(200, page === 3 ? [{ user: { login: "Yoshiki0423" }, body: "<!-- desk:talk -->\n最後のページ", created_at: "2030-01-02T01:00:00Z" }] : []); } });
  assert.equal(seen[0], 3, "最後のページから");
  assert.ok(t.$("#talk-list").textContent.includes("最後のページ"));
  const t2 = await boot({ token: T, issue: () => json(403, { message: "x" }) });
  assert.ok(t2.$("#talk-list").textContent.includes("やり取りを読めませんでした"));
  assert.ok(t2.$('[data-talk="send"]'), "送る欄は使える");
});

test("話しかけ：依頼への答えの判定には影響しない（desk:talk は答え済みに数えない）", async () => {
  const t = await boot({ token: T, comments: (n) => json(200, n === 11 ? [{ user: { login: "Yoshiki0423" }, body: "<!-- desk:talk -->\n相談", created_at: "2030-01-02T04:00:00Z" }] : []) });
  assert.equal(t.$$(".pill.good:not([hidden])").length, 0, "答え済みは0件");
  assert.equal(blkN(t), "3件", "止めているものの件数は変わらない");
});
