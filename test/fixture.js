/* テスト用の架空のデータ（会社の実データではない。形だけ desk.json と同じ） */
module.exports = function fixture() {
  return {
    asOf: "2030-01-02T03:04:00Z",
    sourceNote: "架空",
    issues: [
      { n: 11, name: "架空アプリ", full: "架空アプリの記録", phase: "架空の段階",
        recent: [{ at: "2030-01-02T01:00:00Z", who: "事業部長", text: "架空の動き" }] },
      { n: 12, name: "架空マーケ", short: "マーケ", full: "架空のマーケ", phase: "架空の段階2", recent: [] }
    ],
    desk: { n: 15, name: "社長の机", updatedAt: "2030-01-02T03:00:00Z", comments: 0 },
    requests: [
      { id: "req-11-posts", issue: 11, commentUrl: "https://github.com/example/x/issues/11#issuecomment-1",
        dept: "マーケ部", urgency: "need", title: "架空の投稿3本を見て", decide: "架空", effect: "架空", kind: "posts",
        posts: [{ day: "日1", note: "n1", text: "架空の文1" }, { day: "日2", note: "n2", text: "架空の文2" }, { day: "日3", note: "n3", text: "架空の文3" }],
        push: "OK", money: "0", reversible: "戻せる", scope: "この3本", source: "架空.md",
        answer: { type: "ok_or_note", okLabel: "OK（3本このまま）", notePlaceholder: "", flagPosts: true } },
      { id: "req-11-choice", issue: 11, commentUrl: "https://github.com/example/x/issues/11#issuecomment-2",
        dept: "マーケ部", urgency: "need", title: "架空の確認", decide: "架空", effect: "架空", kind: "steps", steps: ["a", "b"],
        push: "見る", money: "0", reversible: "戻せる", scope: "これだけ", source: "架空.md",
        answer: { type: "choice", choices: ["ある", "ない", "分からない"] } },
      { id: "req-12-links", issue: 12, commentUrl: "javascript:alert(1)",
        dept: "開発部", urgency: "ask", title: "架空のリンク", decide: "架空", effect: "架空", kind: "links",
        links: [{ label: "安全なリンク", href: "https://example.com/a" }, { label: "危ないリンク", href: "javascript:alert(1)" }],
        push: "押す", money: "0", reversible: "戻せる", scope: "1件", source: "架空.md",
        answer: { type: "ok_or_note", okLabel: "OK", notePlaceholder: "" } }
    ],
    depts: [{ name: "事業部長", status: "boss", at: "2030-01-02T03:00:00Z", issues: [11], line: "架空" }],
    relay: { recent: ["2030-01-01T00:00:00Z", "!2030-01-01T00:01:00Z"], failNote: "desk.json の架空の記録" },
    events: [{ date: "2030-01-05", sub: "朝", by: "架空", issues: [], text: "架空の予定" }],
    nextTile: { num: "1/5", unit: "朝", sub: "架空" },
    held: [{ text: "架空の溜め", when: "あとで", issues: [11] }]
  };
};
