# 初回教材

教材が未登録の起動時に「はじめてのTutoTuto」を1件登録します。1ページ目に参考PPTの計算・英作文・和訳の6問と、ページめくり・範囲選択・採点・SNSへの移動の案内を置き、2ページ目に同じ構成の新しい6問を用意しています。iPadの横向き表示に合わせ、上部の操作バーを除いた表示領域に収まる横長の3:2（960 × 640ポイント）です。両ページとも左に使い方、右に教科ごとに2問ずつ横並びで配置しています。右端の下向き・上向き矢印でページを往復できます。

- 本文・ファイル名・操作案内の原稿は `src/i18n/locales/{ja,en}.json` の `starterMaterial` にあります。
- 起動時の表示言語に対応するPDFとサムネイルを `TutoTutoDB` に保存します。登録後の言語切り替えでは、保存済みの教材やファイル名、書き込みを変更しません。
- `settings` ストアの `tutotuto:starter-material:v1` に登録済み・既存教材ありの状態を残します。教材を削除しても自動登録を繰り返しません。サイトデータをすべて削除すると初回扱いになります。
- PDFと完了状態は同一トランザクションで保存します。通信や保存に失敗した場合は通常画面を開き、次回起動時に再試行します。
- PDF・サムネイルをPWAの事前キャッシュに含めます。保存後はオフラインでも教材を開けます。AI採点には接続が必要です。
- 共通DBのスキーマと他アプリの初期化処理は変更していません。

## 教材の再生成

Pythonの `reportlab` とPopplerの `pdftoppm`、PDFへの埋め込みが可能な日本語TrueTypeフォントを使用します。TTCの場合は先頭のフォントを使います。生成時だけ必要で、通常のビルドには不要です。

```powershell
python scripts/generate-starter-material.py --font <通常フォントのパス> --bold-font <太字フォントのパス>
```

`public/drills/starter-{ja,en}-v1.pdf` と同名のJPGを生成します。文言を更新したら両言語を再生成し、PDFを描画して表示を確認してください。将来の教材更新でも保存済みの書き込みを上書きしないため、自動配布の変更時はID・登録状態の扱いも検討してください。

```powershell
npm run test:starter-material
npm run test:i18n
npm run typecheck
npm run build
npm run test:bundle
```
