# AGENTS.md

## Model Roles

- GPT-5.6 sol is the orchestrator. It plans, delegates, monitors progress, reviews results, and coordinates the work.
- GPT-5.5 is the executor. It performs implementation, modification, testing, and other hands-on tasks.

## Branch Policy

- ユーザーが明示的に指示しない限り、新しい Git ブランチを作成してはいけない。
- 作業は現在のブランチで継続する。

## Repository-local test runtime

- ローカルWindowsでは`.\scripts\test-local.ps1`を使う。
- runnerは`TEMP`、`TMP`、`TMPDIR`、`GOTMPDIR`、各種cacheをrepo内の
  `Tmp/test-runtime/`へ向ける。`t.TempDir()`やcompilerの一時実行fileもこの配下に置く。
- `Tmp/`はGit管理外とし、security softwareを有効にしたままtestする。
- repo内`Tmp`でもblockされた場合は、errorを記録してUbuntuまたはWindows CIへ切り替える。

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

## Windows test policy

- system tempへ生成物を置く裸の`go test`は実行せず、repository-local runnerを使う。
- Native Windows検証はローカルrunnerと`.github/workflows/go-test.yml`の
  `windows-latest` runnerの両方で確認できる。
- Push前はUbuntu環境でも`go test ./...`を実行する。
- Push済みcommitのCI確認には`scripts/test-windows-ci.ps1`を使う。
- security softwareの停止、除外設定、testのskip・削除・弱体化は行わない。

詳細は `RenCrow_CORE/rules/common/rules_testing.md` の 9.2 を参照する。
