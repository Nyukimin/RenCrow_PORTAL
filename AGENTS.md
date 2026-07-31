# AGENTS.md

## Model Roles

- GPT-5.6 sol is the orchestrator. It plans, delegates, monitors progress, reviews results, and coordinates the work.
- GPT-5.5 is the executor. It performs implementation, modification, testing, and other hands-on tasks.

## Branch Policy

- ユーザーが明示的に指示しない限り、新しい Git ブランチを作成してはいけない。
- 作業は現在のブランチで継続する。

## Repository-local test runtime

- ローカルWindowsでは`.\scripts\test-local.ps1`を使い、`go vet ./...`と
  `go build ./...`だけを実行する。`.test.exe`を生成・実行する`go test`は使わない。
- runnerは`TEMP`、`TMP`、`TMPDIR`、`GOTMPDIR`、各種cacheをrepo内の
  `Tmp/test-runtime/`へ向ける。`t.TempDir()`やcompilerの一時実行fileもこの配下に置く。
- `Tmp/`はGit管理外とし、security softwareを有効にしたままtestする。
- repo内`Tmp`でもblockされた場合は、errorとpathを記録し、renameや再実行をせず、
  GitHub ActionsのUbuntu testへ切り替える。

このリポジトリは、RenCrowを外部利用者へ公開するWeb画面を所有する。

- `mode=IdleChat`: AI VTuberの会話を閲覧する読み取り専用画面。COREへの更新要求を許可しない。
- `mode=Chat`: 会話送信など、明示的に許可した操作だけをCOREへ中継する。
- `mode=Games`: Agent-owned gameの選択、起動、観戦、Retry／Start overだけをCOREへ中継する。turn判断を人間へ公開しない。
- 公開page modeとAPI prefixは`Chat`、`IdleChat`、`Games`に限定する。
- 共有画面の内部DOM/CSS名は`room-*`を使う。
- Debug、Ops、Repair、設定変更、管理APIは所有・中継しない。
- Persona、Memory、会話状態、Job、LLM/STT/TTS演算、ASSISTANTのRoutine／delivery状態の正本を持たない。
- CORE runtimeとCORE Public APIの正本は `/home/nyukimi/RenCrow/RenCrow_CORE` とする。
- personal／family scope、生活Routine、PUSH、端末deliveryの正本は `/home/nyukimi/RenCrow/RenCrow_ASSISTANT` とする。
- ASSISTANT Public APIの正本も `/home/nyukimi/RenCrow/RenCrow_ASSISTANT` とする。
- 起動管理CLIの正本は `/home/nyukimi/RenCrow/RenCrow_CMD` とする。

PORTALは静的UIと許可制リバースプロキシだけを持つ薄いGoサーバーとする。
新しいAPIを中継する場合は、methodとpathをallowlistへ追加し、`IdleChat`からwriteできないテスト、Gamesからdecision／result／ingestできないテスト、debug/admin APIを遮断するテストを必須とする。
COREへのproxyは`X-RenCrow-Client: RenCrow_PORTAL`とmode別Interaction profileを必ず上書きし、browser入力をそのまま信頼しない。
Gamesの盤面とObserverはRenCrow_GAMES、Agent identityと判断はCOREを正本とする。PuruPuru overlayはiframe外のPORTAL documentが所有し、`RuleBasedBrain`や`decision.reason`をAgent発話として表示しない。
ASSISTANT APIを中継する場合も同じ境界を適用し、他利用者のprivate data、secret、device credentialを公開しない。

正規のCORE／RenCrow_LLM／GAMES経路が利用不能な場合、PORTALのE2Eを通すためにfake CORE、
direct backend、local代替、別model、短縮proxy経路を独断で作成・起動しない。
config、credential、process、network、RenCrow LLM Runtime、Backend／Model readiness、
logを確認して正規経路を
復旧する。復旧不能なら失敗境界を報告し、代替経路を正規runtimeまたはAgent-owned E2E成功と
扱わない。代替topologyは、れんがその例外を明示承認した場合だけ使用できる。

## クロスプラットフォーム前提

このリポジトリは Windows / Linux / macOS で共通に動作する。片方の環境でのみ通る実装・テストを書かない。

- パス連結は Go の `filepath.Join()`、Python の `pathlib.Path` を使い、`/` や `\` を文字列連結しない。
- パス文字列を YAML／JSON／シェルコマンドへ埋め込む場合は必ずエスケープする。Go は `strconv.Quote()` を使う。Windows path は `\` を含むため、生の埋め込みは `\U` などが escape と解釈されパースエラーになる。
- `/tmp`、`/home/<user>` などの絶対 path を実際の入出力先にしない。Go は `t.TempDir()`、Python は `tempfile` を使う。設定値として素通しするだけの文字列は対象外とする。
- 改行コード（LF／CRLF）に依存する比較・テストを書かない。
- 実行権限、symlink、大文字小文字を区別する filesystem を前提にしない。
- 完了とする前に Windows と Linux の両方でテストを実行するか、CI の該当ジョブ結果を確認する。片方だけの結果で完了と報告しない。

## Windows test policy

- ローカルWindowsでは`.test.exe`を生成する`go test`を実行せず、
  repository-local runnerで`go vet ./...`と`go build ./...`を実行する。
- Goの振る舞いtestはGitHub ActionsのUbuntu jobで`go test ./...`を実行する。
- Windows jobは`go build ./...`と`go vet ./...`を実行する。
- Push済みcommitのCI確認には`scripts/test-github-ci.ps1`を使う。
- security softwareの停止、除外設定、testのskip・削除・弱体化は行わない。

詳細は `RenCrow_CORE/rules/common/rules_testing.md` の 9.2 を参照する。
