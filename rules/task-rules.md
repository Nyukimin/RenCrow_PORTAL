# RenCrow_PORTAL 作業別ルール

対象作業の節だけを着手前に読む。文中のcode／設定pathはrepository root基準。製品仕様は`docs/README.md`から選び、共通方針は配布された共通AGENTS.mdを継承する。

<a id="contract"></a>
## 公開画面・proxy・APIを変更する場合

このリポジトリは、RenCrowを外部利用者へ公開するWeb画面を所有する。

- `mode=IdleChat`: AI VTuberの会話を閲覧する読み取り専用画面。画面在席を伝える`POST /viewer/surface-presence`だけをlifecycle例外として許可し、その他のCORE更新要求を許可しない。
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
新しいAPIを中継する場合は、methodとpathをallowlistへ追加し、`IdleChat`からsurface在席通知以外をwriteできないテスト、Gamesからdecision／result／ingestできないテスト、debug/admin APIを遮断するテストを必須とする。
COREへのproxyは`X-RenCrow-Client: RenCrow_PORTAL`とmode別Interaction profileを必ず上書きし、browser入力をそのまま信頼しない。
Gamesの盤面とObserverはRenCrow_GAMES、Agent identityと判断はCOREを正本とする。PuruPuru overlayはiframe外のPORTAL documentが所有し、`RuleBasedBrain`や`decision.reason`をAgent発話として表示しない。
ASSISTANT APIを中継する場合も同じ境界を適用し、他利用者のprivate data、secret、device credentialを公開しない。

<a id="runtime"></a>
## 正規経路の復旧・実runtime E2Eを行う場合

共通の運用手順を適用し、PORTALのclientから正規CORE／RenCrow_LLM／GAMES経路への実requestを検証する。各modeの許可範囲とprofile上書きを含むproxy全体を受入対象とする。

<a id="validation"></a>
## 実装を検証する場合

公開method／path allowlist、mode別write制限、browser入力のInteraction profile上書き、debug／admin遮断を検証する。Windowsの正規runnerは`scripts/test-local.ps1`、Ubuntu behavior testとWindows build／vetを区別する。
