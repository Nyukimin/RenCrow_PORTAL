# AGENTS.md

## Model Roles

- GPT-5.6 sol is the orchestrator. It plans, delegates, monitors progress, reviews results, and coordinates the work.
- GPT-5.5 is the executor. It performs implementation, modification, testing, and other hands-on tasks.

## Branch Policy

- ユーザーが明示的に指示しない限り、新しい Git ブランチを作成してはいけない。
- 作業は現在のブランチで継続する。

このリポジトリは、RenCrowを外部利用者へ公開するWeb画面を所有する。

- `mode=IdleChat`: AI VTuberの会話を閲覧する読み取り専用画面。COREへの更新要求を許可しない。
- `mode=Chat`: 会話送信など、明示的に許可した操作だけをCOREへ中継する。
- 公開page modeとAPI prefixは`Chat`と`IdleChat`に限定する。
- 共有画面の内部DOM/CSS名は`room-*`を使う。
- Debug、Ops、Repair、設定変更、管理APIは所有・中継しない。
- Persona、Memory、会話状態、Job、LLM/STT/TTS演算、ASSISTANTのRoutine／delivery状態の正本を持たない。
- CORE runtimeとCORE Public APIの正本は `/home/nyukimi/RenCrow/RenCrow_CORE` とする。
- personal／family scope、生活Routine、PUSH、端末deliveryの正本は `/home/nyukimi/RenCrow/RenCrow_ASSISTANT` とする。
- ASSISTANT Public APIの正本も `/home/nyukimi/RenCrow/RenCrow_ASSISTANT` とする。
- 起動管理CLIの正本は `/home/nyukimi/RenCrow/RenCrow_CMD` とする。

PORTALは静的UIと許可制リバースプロキシだけを持つ薄いGoサーバーとする。
新しいAPIを中継する場合は、methodとpathをallowlistへ追加し、`IdleChat`からwriteできないテストとdebug/admin APIを遮断するテストを必須とする。
COREへのproxyは`X-RenCrow-Client: RenCrow_PORTAL`とmode別Interaction profileを必ず上書きし、browser入力をそのまま信頼しない。
ASSISTANT APIを中継する場合も同じ境界を適用し、他利用者のprivate data、secret、device credentialを公開しない。

## クロスプラットフォーム前提

このリポジトリは Windows / Linux / macOS で共通に動作する。片方の環境でのみ通る実装・テストを書かない。

- パス連結は Go の `filepath.Join()`、Python の `pathlib.Path` を使い、`/` や `\` を文字列連結しない。
- パス文字列を YAML／JSON／シェルコマンドへ埋め込む場合は必ずエスケープする。Go は `strconv.Quote()` を使う。Windows path は `\` を含むため、生の埋め込みは `\U` などが escape と解釈されパースエラーになる。
- `/tmp`、`/home/<user>` などの絶対 path を実際の入出力先にしない。Go は `t.TempDir()`、Python は `tempfile` を使う。設定値として素通しするだけの文字列は対象外とする。
- 改行コード（LF／CRLF）に依存する比較・テストを書かない。
- 実行権限、symlink、大文字小文字を区別する filesystem を前提にしない。
- 完了とする前に Windows と Linux の両方でテストを実行するか、CI の該当ジョブ結果を確認する。片方だけの結果で完了と報告しない。

## テスト実行のブロックについて

Windows 環境では、セキュリティソフトが `go test` の生成する一時実行ファイルを
断続的にブロックすることがある（`Access is denied`）。テスト内容とは無関係に
発生し、ファイル操作を含まない package でも再現する。

- ローカルWindowsでは`go test`を実行しない。
- Native Windows検証は`.github/workflows/go-test.yml`のGitHub管理
  `windows-latest` runnerで実行する。Linux jobと同じ`go test ./...`を使い、
  テストをskip、削除、弱体化しない。
- Push前はUbuntu環境で`go test ./...`を実行し、ローカルWindowsでは`go vet ./...`
  を実行する。Windows CIが未実施または失敗ならWindows側は未検証と報告する。
- Windowsからの手動実行は`scripts/test-windows-ci.ps1`を使い、Push済みの
  `origin`と同一commitだけを対象にする。
- カスペルスキーの停止、除外設定、`go test -c`などの検知迂回は行わない。

詳細は `RenCrow_CORE/rules/common/rules_testing.md` の 9.2 を参照する。
