# 社長の机（入れ物）

社長が iPhone のホーム画面と PC のブラウザから開き、承認依頼の実物を見てその場で答える画面です。

- このリポジトリは公開です。**会社のデータは一切置きません**。置くのは入れ物のコード（HTML・JS・アイコン）とテストだけです
- 中身は、開いたときに社長の GitHub の鍵（fine-grained token）で、非公開のリポジトリから読みます。鍵はその端末のブラウザの中（localStorage）にだけ置き、GitHub 以外には送りません
- 答えは、その Issue に社長のコメントとして書き込みます。先頭行に `<!-- desk:answer 依頼のid -->` を付け、次に開いたときはこの印で「回答済み」を判定します

## ファイル

- `index.html` 画面の見た目（試作のまま）
- `app.js` データの取り方・表示・答えの書き込み
- `manifest.webmanifest`・`icons/` ホーム画面に置くためのもの（アイコンは `node tools/make-icons.js` で作り直せる）
- `test/` GitHub の API を偽物に差し替えたテスト。テストのデータは架空

## テスト

```
npm install
npm test
```

## 公開

GitHub Pages（main のルート）。https://yoshiki0423.github.io/desk/
