/* 今日のいいね候補：desk-likes.json の読み方と、読めないときに画面全体が壊れないこと */
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, json, standardRoutes, API } = require("./helpers");

const T = "github_pat_TEST_FAKE";
const likes = (date) => ({
  version: 1, date, commentUrl: "https://github.com/Yoshiki0423/app-company/issues/6#issuecomment-1",
  items: [
    { quote: "禁煙を耐える方法ないですか", note: "助けを探している人", url: "https://x.com/intent/like?tweet_id=1" },
    { quote: "危ない", note: "", url: "javascript:alert(1)" }
  ],
  removed: 9, follow: "無し"
});
const withLikes = (reply) => [{ match: (u) => u === `${API}/contents/data/desk-likes.json`, reply }, ...standardRoutes({})];

test("日付が今日なら候補が出る。押すリンクは新しいタブで、変なリンクは外す", async () => {
  const t = await boot({ token: T, routes: withLikes(() => json(200, JSON.stringify(likes("2030-01-02")))) });
  const box = t.$("#likes");
  assert.ok(box);
  assert.ok(box.textContent.includes("禁煙を耐える方法ないですか"));
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
