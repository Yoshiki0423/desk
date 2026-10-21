# 社長の机（入れ物）

社長が iPhone のホーム画面と PC のブラウザから開く画面です。管制室の型で、いま動いている部署・止めているもの・公開までの進み具合を見て、社長が止めているものがあれば、実物を見てその場で答えます。

- このリポジトリは公開です。**会社のデータは一切置きません**。置くのは入れ物のコード（HTML・JS・アイコン）とテストだけです
- 中身は、開いたときに社長の GitHub の鍵（fine-grained token）で、非公開のリポジトリから読みます。鍵はその端末のブラウザの中（localStorage）にだけ置き、GitHub 以外には送りません
- 答えは、その Issue に社長のコメントとして書き込みます。先頭行に `<!-- desk:answer 依頼のid -->` を付け、次に開いたときはこの印で「回答済み」を判定します

## ファイル

- `index.html`・`app.js` 画面本体（管制室の型。2026-10-21 に `v3/` から入れ替えた）。データの取り方・表示・答えの書き込み
- `old/` 前の画面（公開日からの線表）。戻せるように残してあり、https://yoshiki0423.github.io/desk/old/ で今も開ける
- `v3/` 入れ替え前の仮の置き場。古いリンクをルートへ案内するだけ
- `manifest.webmanifest`・`icons/` ホーム画面に置くためのもの（アイコンは `node tools/make-icons.js` で作り直せる）
- `test/` 新しい画面のテスト、`test/old/` 前の画面のテスト。GitHub の API を偽物に差し替えて動かす。テストのデータは架空（`test/fixture.js`）

## テスト

```
npm install
npm test
```

## 公開

GitHub Pages（main のルート）。https://yoshiki0423.github.io/desk/
