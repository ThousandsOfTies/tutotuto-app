# Cloud Run API

TutoTutoとDoriDoriは同じ `hometeacher-api` を使用する。
本番とstagingの公開元は **TutoTutoの `repos/tutotuto-app`** に一本化する。CopiCopiのAPIは別サービス。
共有サーバーは採点 `/api/grade-work`、TutoTutoの追加質問 `/api/ask-question`、
DoriDoriの本文参照用 `/api/book/*` をすべて含む。
DoriDori側の公開コマンドは停止するため、DoriDoriのサーバー変更も必要な範囲でこちらへ反映してから公開する。
アプリ固有のUIまで自動的に取り込む方針ではない。

アプリのディレクトリで実行する（Windowsでは `npm.cmd` も使用可能）。

```sh
npm run prepare:server
npm run deploy:server:staging
# stagingの /api/health と /api/models、採点・追加質問・本の質問を確認した後:
npm run deploy:server
```

stagingと本番の両方で次を確認する。

- `GET /api/health` と `GET /api/models` が200を返す。
- 空のJSON `{}` を `POST /api/grade-work`、`POST /api/ask-question`、`POST /api/book/ask`、`POST /api/book/reference-media` へ送ると、
  各API固有の入力検証エラー（400）を返す。404はルート欠落なので公開を進めない。この確認ではGeminiを呼び出さない。
- stagingでは実際の教材で採点・追加質問・本の質問も確認する。入力検証だけではAI応答の動作確認にはならない。
- 参考資料APIも質問と回答で確認し、画像URLの取得・出典・作者・ライセンスを確認する。画像が取得できなくても回答APIは独立して動作する。

`deploy:server` と `deploy:server:staging` はどちらも先にソースを準備する。
既存のシェルスクリプトもこのコマンドを呼ぶ。
Google Cloud CLIで対象プロジェクトへのログインとデプロイ権限が必要。
APIキー等は既存のSecret Managerから取得する。既存の他の環境変数は維持する。

`prepare:server` は生成用ディレクトリ `.cloud-run` を作り直し、
サーバーの `src/`・`tsconfig.json`・依存定義・lockfileと、共通の採点定義、`server/Dockerfile` のみをコピーする。
共通定義は兄弟サブモジュールの現在のチェックアウトから取得する。
公開時はメタリポジトリが固定しているコミットを確認すること。
ルートの `gcloud run deploy --source .` は使用せず、
必ず `--source .cloud-run` を使用する。`.env` や認証ファイルはコピーされない。

Docker内の `server/` で `npm ci` とビルドを実行し、共通定義を `dist/index.js` にまとめる。
実行イメージはサーバー用依存だけを含み、TypeScript実行ツールやフロント資産を必要としない。
依存を更新する場合は `server/package.json` を変更し、
`npm install --package-lock-only --prefix server` でlockfileも更新する。

Dockerを利用できる環境でのローカル確認:

```sh
npm run prepare:server
docker build -t hometeacher-api-check .cloud-run
docker run --rm -p 8080:8080 --env GEMINI_API_KEY hometeacher-api-check
```
