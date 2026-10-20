/* テスト用の架空のデータ（会社の実データではない。形だけ desk.json と同じ。今日は 2030-01-02、公開日は 2030-02-01） */
module.exports = function fixture() {
  return {
    version: 2,
    asOf: "2030-01-02T03:04:00Z",
    sourceNote: "架空",
    goal: { date: "2030-02-01", label: "公開", outlook: "warn", outlookText: "架空の見込み", concern: "架空の心配" },
    range: { from: "2030-01-01", to: "2030-02-11" },
    timeline: [
      { group: "作る", rows: [
        { id: "app11", label: "架空アプリ", issue: 11, status: "ok", segments: [
          { name: "開発", from: "2030-01-01", to: "2030-01-02", state: "done" },
          { name: "確認", from: "2030-01-02", state: "now" },
          { name: "準備", to: "2030-01-20", state: "undated" },
          { name: "審査", from: "2030-01-20", to: "2030-01-31", state: "plan", wait: "架空の返事待ち" }
        ] }
      ] },
      { group: "広める", rows: [
        { id: "mk12", label: "架空マーケ", issue: 12, status: "warn", segments: [
          { name: "型", from: "2030-01-01", to: "2030-01-15", state: "now" },
          { name: "発信", from: "2030-01-15", to: "2030-02-11", state: "plan" }
        ] },
        { id: "quiet", label: "静か", status: "ok", segments: [] }
      ] }
    ],
    requests: [
      { id: "req-11-posts", row: "app11", short: "架空の投稿", issue: 11, commentUrl: "https://github.com/example/x/issues/11#issuecomment-1",
        dept: "マーケ部", urgency: "need", title: "架空の投稿3本を見て", decide: "架空", effect: "架空", kind: "posts",
        posts: [{ day: "日1", note: "n1", text: "架空の文1" }, { day: "日2", note: "n2", text: "架空の文2" }, { day: "日3", note: "n3", text: "架空の文3" }],
        push: "OK", money: "0", reversible: "戻せる", scope: "この3本", source: "架空.md",
        answer: { type: "ok_or_note", okLabel: "OK（3本このまま）", notePlaceholder: "", flagPosts: true } },
      { id: "req-11-choice", row: "app11", short: "架空の確認", issue: 11, commentUrl: "https://github.com/example/x/issues/11#issuecomment-2",
        dept: "マーケ部", urgency: "need", title: "架空の確認", decide: "架空", effect: "架空", kind: "steps", steps: ["a", "b"],
        push: "見る", money: "0", reversible: "戻せる", scope: "これだけ", source: "架空.md",
        answer: { type: "choice", choices: ["ある", "ない", "分からない"] } },
      { id: "req-12-links", row: "mk12", short: "架空のリンク", issue: 12, commentUrl: "javascript:alert(1)",
        dept: "開発部", urgency: "ask", title: "架空のリンク", decide: "架空", effect: "架空", kind: "links",
        links: [{ label: "安全なリンク", href: "https://example.com/a" }, { label: "危ないリンク", href: "javascript:alert(1)" }],
        push: "押す", money: "0", reversible: "戻せる", scope: "1件", source: "架空.md",
        answer: { type: "ok_or_note", okLabel: "OK", notePlaceholder: "" } }
    ],
    waiting: [{ text: "架空の返事待ち", note: "架空の補足", level: "warn" }],
    upcoming: [{ date: "2030-01-05", title: "架空の予定", sub: "架空の補足" }],
    relay: { recent: ["2030-01-01T00:00:00Z", "!2030-01-01T00:01:00Z"], failNote: "desk.json の架空の記録" }
  };
};
