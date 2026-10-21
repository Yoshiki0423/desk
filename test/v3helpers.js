/* v3（新しい画面）を jsdom で開き、GitHub の API を偽物に差し替えて動かす道具。会社の実データは使わない */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "v3");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const API = "https://api.github.com/repos/Yoshiki0423/app-company";
const json = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const RUNS = [
  { id: 1, display_title: "development｜11｜機能を足す", event: "workflow_dispatch", status: "in_progress", created_at: "2030-01-02T02:00:00Z", run_started_at: "2030-01-02T02:00:30Z", html_url: "https://github.com/example/x/actions/runs/1" },
  { id: 2, display_title: "x｜12｜投稿", event: "workflow_dispatch", status: "completed", conclusion: "success", created_at: "2030-01-02T01:00:00Z" },
  { id: 3, display_title: "リレー", event: "issue_comment", status: "completed", conclusion: "success", created_at: "2030-01-02T00:30:00Z" },
  { id: 4, display_title: "trial｜11｜確認", event: "workflow_dispatch", status: "completed", conclusion: "failure", created_at: "2030-01-01T10:00:00Z" }
];
const COMMITS = [
  { commit: { message: "開発(架空アプリ): 画面を直した（開発部）\n\n本文", author: { date: "2030-01-02T02:30:00Z" } } },
  { commit: { message: "事業部長: 記録した（事業部長）", author: { date: "2030-01-02T01:30:00Z" } } },
  { commit: { message: "開発(架空アプリ): きのうの機能（開発部）", author: { date: "2030-01-01T02:30:00Z" } } }
];
const COMMENTS = {
  11: [
    { user: { login: "bot" }, body: "実機: exp://u.expo.dev/aaa/group/g1 です。", created_at: "2030-01-01T05:00:00Z", html_url: "https://github.com/example/x#1" },
    { user: { login: "Yoshiki0423" }, body: "社長のひとこと <img src=x onerror=alert(1)>", created_at: "2030-01-02T01:00:00Z", html_url: "https://github.com/example/x#2" },
    { user: { login: "bot" }, body: "了解しました", created_at: "2030-01-02T01:10:00Z", html_url: "https://github.com/example/x#3" }
  ]
};

function makeFetch(routes) {
  const calls = [];
  const fetch = async (url, opts) => {
    const o = opts || {};
    const method = o.method || "GET";
    calls.push({ url, method, body: o.body ? JSON.parse(o.body) : null });
    for (const r of routes) if ((r.method || "GET") === method && r.match(decodeURIComponent(url))) return r.reply(decodeURIComponent(url), o);
    return json(404, { message: "Not Found" });
  };
  return { fetch, calls };
}

function routes(o) {
  const contents = (p, fn) => ({ match: (u) => u === `${API}/contents/${p}`, reply: fn });
  return [
    contents("data/desk.json", () => (o.desk ? o.desk() : json(200, JSON.stringify(require("./fixture")())))),
    contents("data/approvals.jsonl", () => (o.approvals ? o.approvals() : json(200, '{"_説明":"x"}\n{"date":"2030-01-01","type":"種類","subject":"架空の承認","decision":"approved","modified":false}\n{"date":"2030-01-02","type":"種類","subject":"架空の却下","decision":"rejected","modified":true}\n'))),
    contents("data/cases.json", () => (o.cases ? o.cases() : json(200, { cases: [{ id: "c1", name: "架空アプリの案", status: "開発中", score: 80, summary: "架空の要約", verdict: "架空の判断" }] }))),
    contents("data/results.json", () => json(200, { apps: [] })),
    { match: (u) => u.startsWith(`${API}/contents/apps/`), reply: (u) => (o.appFiles ? o.appFiles(u) : json(200, [{ name: "企画_全部入り.md", path: "apps/架空アプリ/企画_全部入り.md", type: "file", html_url: "https://github.com/example/x/blob/main/a.md" }, { name: "試用メモ.md", path: "apps/架空アプリ/試用メモ.md", type: "file", html_url: "https://github.com/example/x/blob/main/b.md" }])) },
    { match: (u) => u.startsWith(`${API}/commits?`) && /[?&]path=/.test(u), reply: () => json(200, [{ commit: { author: { date: "2030-01-01T09:00:00Z" } } }]) },
    { match: (u) => u.startsWith(`${API}/commits?`), reply: (u) => (o.commits ? o.commits(u) : /page=1(&|$)/.test(u) ? json(200, COMMITS) : json(200, [])) },
    { match: (u) => u.startsWith(`${API}/actions/workflows/relay.yml/runs`), reply: (u) => {
        if (o.runs) return o.runs(u);
        if (/status=queued/.test(u)) return json(200, { workflow_runs: [] });
        if (/status=in_progress/.test(u)) return json(200, { workflow_runs: RUNS.filter((r) => r.status === "in_progress") });
        return json(200, { workflow_runs: /page=1(&|$)/.test(u) ? RUNS : [] });
      } },
    { match: (u) => u === `${API}/contents/data/desk-likes.json`, reply: () => json(404, { message: "Not Found" }) },
    { match: (u) => /\/issues\/\d+$/.test(u), reply: (u) => json(200, { number: 5, comments: 0 }) },
    { match: (u) => /\/issues\/\d+\/comments\?/.test(u), reply: (u) => {
        const n = +u.match(/\/issues\/(\d+)\/comments/)[1], page = +(u.match(/[?&]page=(\d+)/) || [0, 1])[1];
        if (o.comments) return o.comments(n, page);
        return json(200, page === 1 ? (COMMENTS[n] || []) : []);
      } },
    { method: "PUT", match: (u) => u.startsWith(`${API}/contents/`), reply: () => json(201, { content: { path: "x" } }) },
    { method: "POST", match: (u) => /\/issues\/\d+\/comments$/.test(u), reply: (u, op) => (o.post ? o.post(u, op) : json(201, { html_url: "https://github.com/example/x/issues/1#issuecomment-99", created_at: "2030-01-02T05:00:00Z" })) }
  ];
}

async function boot(opt) {
  const o = opt || {};
  const dom = new JSDOM(HTML, { url: "https://yoshiki0423.github.io/desk/v3/" + (o.hash || ""), runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  if (o.token !== null) w.localStorage.setItem("desk.token", o.token || "github_pat_test");
  if (o.visit) w.localStorage.setItem("desk.v3.visit", JSON.stringify(o.visit));
  w.DESK_TODAY = o.today || "2030-01-02";
  const f = makeFetch(o.routes || routes(o));
  w.fetch = f.fetch;
  w.confirm = () => true;
  w.DESK_SHRINK = async (file) => ({ dataUrl: "data:image/jpeg;base64,QUJD", base64: "QUJD", w: 10, h: 10, name: file.name });
  w.scrollTo = () => {};
  w.eval(APP);
  await w.Desk3.started;
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => w.setTimeout(r, 0)); };
  return {
    dom, w, doc: w.document, calls: f.calls, settle,
    $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)],
    go: async (page) => { w.location.hash = "#" + page; await settle(); },
    click: async (el) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await settle(); }
  };
}
module.exports = { boot, json, RUNS, COMMITS, API };
