/* 開いている間の自動読み直し。時計は待たず、autoTick を直接呼んで確かめる（時計の設定は CONFIG と scheduleAuto の別のテストで） */
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, json } = require("./helpers");

const fixture = require("./fixture");
const setHidden = (b, hidden) => {
  Object.defineProperty(b.doc, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
};
const withDesk = (state) => ({ desk: () => { const d = fixture(); if (state.extra) d.requests.push(state.extra); return json(200, JSON.stringify(d)); } });
const newReq = { id: "req-99-new", row: "app11", short: "新しい依頼", issue: 11, dept: "開発部", urgency: "need", title: "新しい依頼", decide: "架空", effect: "架空", kind: "steps", steps: ["a"], push: "OK", money: "0", reversible: "戻せる", scope: "x", source: "x.md", answer: { type: "choice", choices: ["はい", "いいえ"] } };

test("自動：何も変わっていなければ読むだけで描き直さない（カードも開いたまま・同じ要素のまま）", async () => {
  const b = await boot({ hash: "#turn" });
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  const before = b.$("#req-11-posts");
  const n = b.calls.length;
  await b.w.Desk3.autoTick(); await b.settle();
  assert.ok(b.calls.length > n, "読み直している");
  assert.equal(b.$("#req-11-posts"), before, "要素を作り直していない");
  assert.equal(b.$("#req-11-posts .req-head").getAttribute("aria-expanded"), "true");
  assert.match(b.$("#stamp").textContent, /最後に読んだ時刻/);
  b.w.close();
});

test("自動：新しい依頼が来たら出る。開いている畳み・書きかけの答え・選んだ答えは残る", async () => {
  const st = {};
  const b = await boot({ hash: "#turn", ...withDesk(st) });
  assert.equal(b.$$("#view .req").length, 3);
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  await b.click(b.$('[data-toggle="req-11-choice"]'));
  b.$("#req-11-posts textarea").value = "書きかけ";
  await b.click(b.$('[data-choice="req-11-choice|ない"]'));
  b.$("#req-11-choice details.fulltext").open = true;
  st.extra = newReq;
  await b.w.Desk3.autoTick(); await b.settle();
  assert.equal(b.$$("#view .req").length, 4, "新しい依頼が出た");
  assert.equal(b.$("#req-11-posts .req-head").getAttribute("aria-expanded"), "true");
  assert.equal(b.$("#req-11-choice .req-head").getAttribute("aria-expanded"), "true");
  assert.equal(b.$("#req-11-posts textarea").value, "書きかけ");
  assert.equal(b.$('[data-choice="req-11-choice|ない"]').getAttribute("aria-pressed"), "true");
  assert.equal(b.$("#req-11-choice details.fulltext").open, true);
  assert.equal(b.$("#req-99-new .req-head").getAttribute("aria-expanded"), "false");
  b.w.close();
});

test("自動：入力欄に文字カーソルがある間は読み直さない。外れたら読む", async () => {
  const b = await boot({ hash: "#turn" });
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  const ta = b.$("#req-11-posts textarea"); ta.focus();
  assert.equal(b.doc.activeElement, ta);
  const n = b.calls.length;
  await b.w.Desk3.autoTick(); await b.settle();
  assert.equal(b.calls.length, n, "入力中は GitHub も呼ばない");
  ta.blur();
  await b.w.Desk3.autoTick(); await b.settle();
  assert.ok(b.calls.length > n);
  b.w.close();
});

test("自動：事業部長への一言を書いている最中でも、右の列の下書きは消えない", async () => {
  const st = {};
  const b = await boot({ hash: "#turn", ...withDesk(st) });
  b.$("#talk-note").value = "調べてほしいこと";
  st.extra = newReq;
  await b.w.Desk3.autoTick(); await b.settle();
  assert.equal(b.$("#talk-note").value, "調べてほしいこと");
  b.w.close();
});

test("自動：読めなかったときは画面を壊さず、時刻の横に知らせる。403 のときは間をあける", async () => {
  let fail = false;
  const b = await boot({ hash: "#turn", desk: () => (fail ? json(403, { message: "rate limit" }) : json(200, JSON.stringify(fixture()))) });
  fail = true;
  await b.w.Desk3.autoTick(); await b.settle();
  assert.equal(b.$$("#view .req").length, 3, "前の中身が残る");
  assert.equal(b.$("#notice").textContent.trim(), "", "エラーの帯は出さない");
  assert.match(b.$("#stamp").textContent, /自動で読み直せませんでした/);
  b.w.close();
});

test("自動：画面が隠れている間は読まない。戻ったらすぐ1回読む", async () => {
  const b = await boot({ hash: "#turn", auto: true });
  const D = b.w.Desk3;
  setHidden(b, true);
  b.doc.dispatchEvent(new b.w.Event("visibilitychange"));
  const n = b.calls.length;
  await D.autoTick(); await b.settle();
  assert.equal(b.calls.length, n, "隠れている間は呼ばない");
  setHidden(b, false);
  b.doc.dispatchEvent(new b.w.Event("visibilitychange"));
  await b.settle();
  assert.equal(b.calls.length, n, "読んだばかりなら、戻っても重ねて読まない");
  // 10分たったことにして、もう一度戻る
  const realNow = b.w.Date.now;
  b.w.Date.now = () => realNow() + 10 * 60e3;
  setHidden(b, true); b.doc.dispatchEvent(new b.w.Event("visibilitychange"));
  setHidden(b, false); b.doc.dispatchEvent(new b.w.Event("visibilitychange"));
  await b.settle();
  assert.ok(b.calls.length > n, "しばらくぶりに戻ったら、すぐ読む");
  b.w.close();
});

test("自動：間隔は、ふだんは長く、答えを送った直後だけ短い。数字は上限に余裕がある", async () => {
  const b = await boot({ hash: "#turn", auto: true });
  const C = b.w.Desk3.CONFIG;
  assert.ok(C.autoFastMs < C.autoSlowMs && C.autoSlowMs >= 60e3 && C.autoSlowMs <= 120e3);
  assert.ok(C.autoFastMs >= 15e3 && C.autoFastWindowMs <= 5 * 60e3);
  const perRead = 40;   // 1回の読み直しの GitHub 呼び出し数（多めに見た数）
  const worstPerHour = (3600e3 / C.autoSlowMs) * perRead + 5 * (C.autoFastWindowMs / C.autoFastMs) * perRead;   // 1時間に5回答えた場合
  assert.ok(worstPerHour < 5000 * 0.8, `1時間 ${worstPerHour} 回は上限の8割以内`);
  b.w.close();
});

test("自動：答えを送ると短い間隔の時計に切り替わる（時計が動いて、20秒ごとの読み直しを予約する）", async () => {
  const b = await boot({ hash: "#turn", auto: true });
  const delays = [];
  const orig = b.w.setTimeout.bind(b.w);
  b.w.setTimeout = (fn, ms, ...a) => { delays.push(ms); return orig(fn, ms, ...a); };
  await b.click(b.$('[data-toggle="req-11-posts"]'));
  await b.click(b.$('[data-send="req-11-posts|ok"]'));
  assert.ok(delays.includes(b.w.Desk3.CONFIG.autoFastMs), "送った直後は短い間隔");
  b.w.close();
});
