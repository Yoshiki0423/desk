/* いま動いている部署：実行ごとの名前の分解、拾う／拾わないの判定、画面の出方、読めないとき */
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, json, API } = require("./helpers");
const { standardRoutes } = require("./helpers");

const T = "github_pat_TEST_FAKE";
const load = async () => { const t = await boot({ token: T }); return t.w.Desk; };

test("実行の名前を「工程｜Issue番号｜申し送り」に分ける（申し送りの｜・改行は残す。形が違えば null）", async () => {
  const D = await load();
  const p = D.parseRunTitle("development｜11｜開発へ。\n二行目");
  assert.equal(p.stage, "development"); assert.equal(p.issue, 11); assert.equal(p.note, "開発へ。\n二行目");
  assert.equal(D.parseRunTitle("trial｜｜ここは｜残す").issue, null);
  assert.equal(D.parseRunTitle("trial｜｜ここは｜残す").note, "ここは｜残す");
  assert.equal(D.parseRunTitle("リレー"), null);
  assert.equal(D.parseRunTitle("workflow_dispatch"), null);
  assert.equal(D.parseRunTitle("｜3｜x"), null);
  assert.equal(D.parseRunTitle(undefined), null);
});

test("拾うのは、終わっていない・人が起こした・名前が「工程｜」の形の実行だけ", async () => {
  const D = await load();
  const run = (o) => ({ id: Math.random(), status: "in_progress", event: "workflow_dispatch", display_title: "trial｜11｜x", html_url: "https://github.com/a/b/actions/runs/1", created_at: "2030-01-02T03:00:00Z", run_started_at: "2030-01-02T03:01:00Z", ...o });
  const r = D.activeFromRuns([
    run({ id: 1 }),
    run({ id: 2, status: "queued", display_title: "design｜12｜y", run_started_at: null }),
    run({ id: 3, status: "completed" }),
    run({ id: 4, event: "issue_comment" }),
    run({ id: 5, event: "push" }),
    run({ id: 6, display_title: "リレー" }),
    run({ id: 1 })
  ]);
  assert.equal(r.running.length, 1);
  assert.equal(r.running[0].since, "2030-01-02T03:01:00Z");
  assert.equal(r.waiting.length, 1);
  assert.equal(r.waiting[0].since, "2030-01-02T03:00:00Z");
  assert.equal(JSON.stringify(D.activeFromRuns(null)), JSON.stringify({ running: [], waiting: [] }));
});

const runsFor = (list) => (u) => {
  const st = (u.match(/status=(\w+)/) || [])[1];
  return json(200, { workflow_runs: list.filter((r) => r.status === st) });
};
const base = { event: "workflow_dispatch", html_url: "https://github.com/Yoshiki0423/app-company/actions/runs/9" };

test("画面：部署名・アプリ名・申し送りの1行目・経過・リンクが出る。申し送りはエスケープされる", async () => {
  // 読み込みの時刻は実時間。経過は「◯分前から」になることだけ確かめる
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const t = await boot({ token: T, runs: (u) => {
    if (!/status=/.test(u)) return json(200, { workflow_runs: [] });
    return runsFor([
      { ...base, id: 1, status: "in_progress", display_title: "development｜11｜<img src=x onerror=alert(1)>を直す\n二行目は出さない", created_at: ago(30), run_started_at: ago(7) },
      { ...base, id: 2, status: "queued", display_title: "x｜4｜朝の投稿", created_at: ago(2) },
      { ...base, id: 3, status: "in_progress", event: "issue_comment", display_title: "manager｜｜数秒", created_at: ago(1) }
    ])(u);
  } });
  const box = t.$("#active");
  assert.ok(box, "欄がある");
  const txt = box.textContent;
  assert.ok(txt.includes("いま動いている") && txt.includes("順番待ち"));
  assert.ok(txt.includes("開発部") && txt.includes("架空アプリ"), txt);
  assert.ok(txt.includes("7分前から"), txt);
  assert.ok(txt.includes("X部") && txt.includes("#4") && txt.includes("2分前から"), txt);
  assert.ok(!txt.includes("数秒") && !txt.includes("二行目"));
  assert.equal(box.querySelector("img"), null, "申し送りの HTML は文字として出る");
  assert.ok(txt.includes("<img src=x"));
  assert.equal(box.querySelector("a").href, "https://github.com/Yoshiki0423/app-company/actions/runs/9");
  assert.ok(t.calls.some((c) => c.url.includes("status=in_progress")) && t.calls.some((c) => c.url.includes("status=queued")));
});

test("画面：何も無いときは1行、読めないときはその欄だけに書いてほかは壊さない", async () => {
  const t = await boot({ token: T });
  assert.ok(t.$("#active").textContent.includes("いま動いている部署はありません"));
  const t2 = await boot({ token: T, runs: (u) => (/status=/.test(u) ? json(403, { message: "Resource not accessible" }) : json(200, { workflow_runs: [{ status: "completed", conclusion: "success", created_at: "2030-01-02T03:00:00Z" }] })) });
  assert.ok(t2.$("#active").textContent.includes("読めませんでした"));
  assert.ok(t2.$("#view").textContent.includes("リレー直近"), "リレーの欄は残る");
});
