/* 今日のいいね候補：desk-likes.json の読み方と、読めないときに画面全体が壊れないこと */
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, click, json, standardRoutes, API } = require("./helpers");

const T = "github_pat_TEST_FAKE";
const likes = (date) => ({
  version: 1, date, commentUrl: "https://github.com/Yoshiki0423/app-company/issues/6#issuecomment-1",
  items: [
    { quote: "これは出さない投稿の文面", note: "禁煙を我慢する方法を探している人", url: "https://x.com/intent/like?tweet_id=1" },
    { note: "", url: "javascript:alert(1)" }
  ],
  removed: 9, follow: "無し"
});
const withLikes = (reply) => [{ match: (u) => u === `${API}/contents/data/desk-likes.json`, reply }, ...standardRoutes({})];

test("日付が今日なら候補が出る。押すリンクは新しいタブで、変なリンクは外す", async () => {
  const t = await boot({ token: T, routes: withLikes(() => json(200, JSON.stringify(likes("2030-01-02")))) });
  const box = t.$("#likes");
  assert.ok(box);
  assert.ok(box.textContent.includes("禁煙を我慢する方法を探している人"));
  assert.ok(!box.textContent.includes("これは出さない投稿の文面"), "quote があっても出さない");
  assert.ok(box.textContent.includes("（一言なし）"));
  const a = box.querySelector("a.like-go");
  assert.equal(a.getAttribute("href"), "https://x.com/intent/like?tweet_id=1");
  assert.equal(a.getAttribute("target"), "_blank");
  assert.equal(box.querySelectorAll("a.like-go").length, 1);
  assert.ok(box.textContent.includes("除いたもの：9件"));
});

test("日付が今日でないと、候補を出さず最後の日付を出す", async () => {
  const t = await boot({ token: T, routes: withLikes(() => json(200, JSON.stringify(likes("2030-01-01")))) });
  const box = t.$("#likes");
  assert.ok(box.textContent.includes("今日の候補はまだ出ていません（最後：1/1）"));
  assert.equal(box.querySelectorAll("a").length, 0);
});

test("ファイルが無い（404）でも、画面全体は出て、まだ出ていない表示になる", async () => {
  const t = await boot({ token: T });
  assert.ok(t.$("#likes").textContent.includes("今日の候補はまだ出ていません"));
  assert.ok(t.$("#req-slot"), "ほかの欄は出ている");
});

test("JSON が壊れていても、形が違っても、画面全体は壊れない", async () => {
  for (const body of ["{こわれた", JSON.stringify({ items: "x" })]) {
    const t = await boot({ token: T, routes: withLikes(() => json(200, body)) });
    assert.ok(t.$("#likes").textContent.includes("読めませんでした"));
    assert.ok(t.$("#req-slot"));
  }
});

/* 済み・畳み */
const two = (date) => ({
  version: 1, date, items: [
    { note: "一つ目", url: "https://x.com/intent/like?tweet_id=1" },
    { note: "二つ目", url: "https://x.com/intent/like?tweet_id=2" }
  ]
});

test("押すと済みになり、薄くなる。戻すで未済みに戻る。見出しに残り件数が出る", async () => {
  const t = await boot({ token: T, routes: withLikes(() => json(200, JSON.stringify(two("2030-01-02")))) });
  assert.ok(t.$("#likes").textContent.includes("残り2件"));
  await click(t.w, t.$("#likes a.like-go"));
  const box = t.$("#likes");
  assert.ok(box.textContent.includes("残り1件"));
  assert.equal(box.querySelectorAll("li.is-done").length, 1);
  assert.ok(box.querySelector("li.is-done").textContent.includes("済み"));
  assert.equal(box.querySelectorAll("a.like-go").length, 1);
  await click(t.w, t.$("#likes .like-undo"));
  assert.ok(t.$("#likes").textContent.includes("残り2件"));
  assert.equal(t.$$("#likes li.is-done").length, 0);
});

test("全部済むと1行に畳まれ、押すと開く。開いたあとも済みは残る", async () => {
  const t = await boot({ token: T, routes: withLikes(() => json(200, JSON.stringify(two("2030-01-02")))) });
  await click(t.w, t.$("#likes a.like-go"));
  await click(t.w, t.$("#likes a.like-go"));
  let box = t.$("#likes");
  assert.ok(box.classList.contains("folded"));
  assert.ok(box.textContent.includes("2件すべて済み"));
  assert.equal(box.querySelectorAll("li").length, 0);
  await click(t.w, box.querySelector(".like-fold"));
  box = t.$("#likes");
  assert.equal(box.querySelectorAll("li.is-done").length, 2);
  await click(t.w, box.querySelector(".like-fold"));
  assert.ok(t.$("#likes").classList.contains("folded"));
});

test("全部済んでいなくても、見出しで畳める。畳んでも残り件数が見える", async () => {
  const t = await boot({ token: T, routes: withLikes(() => json(200, JSON.stringify(two("2030-01-02")))) });
  await click(t.w, t.$("#likes .like-fold"));
  const box = t.$("#likes");
  assert.ok(box.classList.contains("folded"));
  assert.ok(box.textContent.includes("残り2件"));
  await click(t.w, box.querySelector(".like-fold"));
  assert.equal(t.$$("#likes li").length, 2);
});

test("済みはこの端末に残り、読み直しても残る。日付が変わると持ち越さず、古い記録は消える", async () => {
  const t = await boot({ token: T, routes: withLikes(() => json(200, JSON.stringify(two("2030-01-02")))) });
  await click(t.w, t.$("#likes a.like-go"));
  const saved = JSON.parse(t.w.localStorage.getItem("desk.likes"));
  assert.equal(saved["2030-01-02|https://x.com/intent/like?tweet_id=1"], "1");
  // 同じ日に読み直す
  await click(t.w, t.$('#tools [data-act="reload"]'));
  assert.ok(t.$("#likes").textContent.includes("残り1件"));
  // 翌日（候補の日付が 1/3、今日も 1/3）：昨日の記録は効かず、消える
  const t2 = await boot({ token: T, today: "2030-01-03", routes: withLikes(() => json(200, JSON.stringify(two("2030-01-03")))) });
  t2.w.localStorage.setItem("desk.likes", JSON.stringify({ "2030-01-02|https://x.com/intent/like?tweet_id=1": "1", "2030-01-02|fold": "1" }));
  await click(t2.w, t2.$('#tools [data-act="reload"]'));
  assert.ok(t2.$("#likes").textContent.includes("残り2件"));
  assert.equal(t2.$$("#likes li.is-done").length, 0);
  assert.equal(Object.keys(JSON.parse(t2.w.localStorage.getItem("desk.likes"))).length, 0);
});

test("localStorage が使えなくても画面は壊れず、その場限りで動く", async () => {
  const t = await boot({ token: T, routes: withLikes(() => json(200, JSON.stringify(two("2030-01-02")))) });
  const proto = Object.getPrototypeOf(t.w.localStorage);
  const orig = proto.setItem;
  proto.setItem = function () { throw new Error("denied"); };
  try {
    await click(t.w, t.$("#likes a.like-go"));
    assert.ok(t.$("#likes").textContent.includes("残り1件"));
    assert.equal(t.$$("#likes li.is-done").length, 1);
  } finally { proto.setItem = orig; }
});
