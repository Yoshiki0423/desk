/* 画面を jsdom で開き、GitHub の API を偽物（モック）に差し替えて動かす道具 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const API = "https://api.github.com/repos/Yoshiki0423/app-company";

const json = (status, body, extra) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(extra || {}) } });

/* routes：[{ method, match(url), reply(url, opts) }] を上から順に見る。見つからなければ 404 */
function makeFetch(routes) {
  const calls = [];
  const fetch = async (url, opts) => {
    const o = opts || {};
    const method = o.method || "GET";
    calls.push({ url, method, headers: o.headers || {}, body: o.body ? JSON.parse(o.body) : null });
    for (const r of routes) {
      if ((r.method || "GET") === method && r.match(url)) return r.reply(url, o);
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch, calls };
}

/* よく使う GitHub の返事 */
function standardRoutes(opt) {
  const o = opt || {};
  return [
    { match: (u) => u === `${API}/contents/data/desk.json`, reply: () => o.desk ? o.desk() : json(200, JSON.stringify(require("./fixture")())) },
    { match: (u) => u.startsWith(`${API}/actions/workflows/relay.yml/runs`), reply: () => o.runs ? o.runs() : json(200, { workflow_runs: [] }) },
    { match: (u) => /\/issues\/\d+\/comments\?/.test(u), reply: (u) => {
        const n = +u.match(/\/issues\/(\d+)\/comments/)[1], page = +(u.match(/[?&]page=(\d+)/) || [0, 1])[1];
        return o.comments ? o.comments(n, page) : json(200, []);
      } },
    { method: "POST", match: (u) => /\/issues\/\d+\/comments$/.test(u), reply: (u, op) => o.post ? o.post(u, op) : json(201, { html_url: "https://github.com/example/x/issues/1#issuecomment-99", created_at: "2030-01-02T05:00:00Z" }) }
  ];
}

async function boot(opt) {
  const o = opt || {};
  const dom = new JSDOM(HTML, { url: "https://yoshiki0423.github.io/desk/" + (o.hash || ""), runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  if (o.token) w.localStorage.setItem("desk.token", o.token);
  const f = makeFetch(o.routes || standardRoutes(o));
  w.fetch = f.fetch;
  w.confirm = () => true;
  w.scrollTo = () => {};
  w.eval(APP);
  await w.Desk.started;
  return { dom, w, doc: w.document, calls: f.calls, $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)] };
}

/* 押したあとの非同期の処理が終わるのを待つ */
const settle = async (w) => { for (let i = 0; i < 10; i++) await new Promise((r) => w.setTimeout(r, 0)); };
const click = async (w, el) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await settle(w); };

module.exports = { boot, click, settle, json, standardRoutes, API };
