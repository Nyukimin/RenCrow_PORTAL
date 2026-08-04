# RenCrow_PORTAL

RenCrow_PORTALは、MioやShiroが部屋の中で会話するAI VTuber形式の画面を、外部利用者が閲覧・操作するための独立Webポータルです。デバッグViewer、状態の正本、演算処理は持たず、`RenCrow_CORE`のPublic APIへ許可した要求だけを中継します。

`RenCrow_ASSISTANT`との連携後は、個人・家族の予定、Routine、通知履歴、端末設定を表示・操作するWeb clientにもなります。生活Routine、PUSH、delivery状態の正本はASSISTANTであり、PORTALへ複製しません。現在の実装はCORE proxyのみで、ASSISTANT API連携はplannedです。

## 標準Go配布

標準artifactはGo binary `rencrow-portal`と`go:embed`したbrowser assetです。
JavaScriptは利用者のbrowserで実行するため、Node.js runtimeを標準installerへ要求しません。
PORTALはPython／Node.js server、独自の会話runtime、物理backendを同梱しません。
標準配布の正本は
[RenCrow_COREの「標準Go配布境界」](https://github.com/Nyukimin/RenCrow_CORE/blob/main/docs/04_アーキテクチャ概要.md#標準go配布境界)
です。

PORTAL serverはUbuntu、Windows、macOSのnative Go binaryとして同じCORE proxy contract、
Config、health、errorを提供します。PORTALはWSLや外部databaseを標準依存にせず、CUDA用WSLを
含む物理computeへ直接接続しません。

`GET /health/live`はPORTAL Go processだけのliveness、`GET /health/ready`はCORE Public APIを
含むreadinessです。COREへ到達できない場合もprocessはliveのまま、readinessだけが503と
`status=unavailable`を返します。

## モード

- `IdleChat`: AI VTuberの部屋を閲覧する画面。画面が可視になるとIdleChatを開始し、手動の開始・停止操作は持たない
- `Chat`: AI VTuber画面に加えて、会話送信、会話相手の選択、TTS再生、STTマイク入力。画面が可視の間はIdleChatを停止する
- `Games`: ゲームとAgentの選択、Agent-owned sessionの起動、GAMES Observerの観戦、Retry／Start over

公開modeは`Chat`、`IdleChat`、`Games`の3系統です。
Chatでは会話対象のMio／Shiro／Kuro／Midoriを1体だけ中央表示します。IdleChatは切替buttonを持たず、画面表示直後からMioとShiroをChatと同じキャラクターサイズで同時表示します。画面幅を縦に4等分した左1/4をMioの中心、右1/4をShiroの中心とします。Chatのキャラチップは会話送信先と単独表示キャラを選択します。
GamesではCOREの`supported_games`に含まれるタイトルだけを起動できます。現在のAgent E2E対象はNetHackです。盤面とturn結果はGAMES Observer、Agent identityと判断はCOREを正本とし、PORTALは利用者向けの選択・session・観戦UIだけを持ちます。

Debug、Ops、Repair、設定変更などの管理APIは中継しません。

ASSISTANT連携でも、読み取り画面からwrite actionを許可せず、他利用者のprivate data、secret、device credentialを中継しません。

## PuruPuruアバター描画

PORTALは[PuruPuruPNGTuber](https://github.com/rotejin/PuruPuruPNGTuber)の描画コードを`internal/portal/web/purupuru/`へ同梱し、iframeや簡易rendererを使いません。ChatのDOMとschedulerには選択中の1体、IdleChatにはMio／Shiroの2体、Gamesには4体を登録します。Chatの相手切替では、現在の1体を表示・更新したまま切替先をdetached shellで準備し、準備完了後にCOREのrecipient確認を行い、同期的にruntimeを交換します。準備またはCORE確認に失敗した場合はpending runtimeだけを破棄し、現在のavatarと選択状態を維持します。顔変形、髪揺れ、呼吸、瞬き、口差分、影、前後アイテムレイヤーはPuruPuru原版の処理を保持し、1本の`requestAnimationFrame` schedulerから登録済みavatarだけを更新します。IdleChatではKuro／MidoriをDOM生成しないため、対応するruntime初期化と画像asset通信も行いません。

| character | PuruPuru source package | runtime element |
| --- | --- | --- |
| Mio | `assets/Mio/Mio.purupuru` | `<purupuru-avatar character="mio">` |
| Shiro | `assets/Shiro/Shiro02.purupuru` | `<purupuru-avatar character="shiro">` |
| Kuro | `assets/Kuro/Kuro.purupuru` | `<purupuru-avatar character="kuro">` |
| Midori | `assets/Midori/Midori02.purupuru` | `<purupuru-avatar character="midori">` |

各キャラは、6表情、前髪、後ろ髪、packageで定義されたitem layer、`default-settings.json`を持ちます。画像は透過PNGで同じキャンバス寸法に揃えます。表示サイズと4人の配置は`portal.css`が所有します。

口パクはテキスト長から疑似生成しません。COREから受け取ったTTS audioをWeb Audio APIの`AnalyserNode`へ接続し、実音声のRMS振幅を発話者の`AvatarInstance`へ渡します。会話の送信先はCOREの公開Agent IDである`mio`、`shiro`、`kuro`、`midori`を使い、画面上では`room-partner-mio`、`room-partner-shiro`、`room-partner-kuro`、`room-partner-midori`で示します。

PuruPuru更新時は手編集で差分を移植せず、同期コマンドで原版と生成runtimeを更新します。キャラの正本はフォルダ直下のLoose PNGではなく、上表の生成済み`.purupuru`です。同期処理がpackage内の表情、前後髪、item layer、`settings.json`を展開し、PuruPuru由来コードの帰属・Apache-2.0・改変表示を再付与します。生成テストは、同梱した原版`app.js`から`runtime-app.js`が再現できることも検証します。

```powershell
go run ./cmd/sync-purupuru -source C:\Users\nyuki\Documents\GenerativeAI\PuruPuruPNGTuber
```

### アバター素材の差し替え

1. PuruPuru側で対象キャラの`.purupuru`を再生成し、上表のpackage名へ配置する。
2. 上記`sync-purupuru`を実行し、PORTALへ原版runtimeとpackage内容を同期する。
3. `file`またはImageMagickの`identify`で、PNGとして読めること、正方形であること、alpha channelがあることを確認する。
4. `make check`でtest、vet、PORTAL binary buildを実行する。
5. PORTALを再起動する。
6. source assetと稼働PORTALの配信assetが一致することを確認する。

```bash
sha256sum internal/portal/web/purupuru/assets/Midori/front-hair.png
curl -fsS http://127.0.0.1:18791/assets/purupuru/assets/Midori/front-hair.png | sha256sum
```

7. `http://127.0.0.1:18791/?mode=Chat`を実ブラウザで開き、4人の画像欠損、透過、動き、画面内配置をdesktop幅とnarrow幅で確認する。

PORTALは`//go:embed web/*`でassetをbinaryへ埋め込むため、ファイルを置き換えただけでは稼働中の表示は変わりません。必ず再ビルド・再起動します。`internal/portal/web/`配下の未参照ファイルもbinaryへ埋め込まれるため、旧画像や作業用バックアップはこのディレクトリへ残しません。vendored PuruPuruのライセンスとPortal固有差分は`internal/portal/web/purupuru/README.md`に記録します。

### ライセンスと配布範囲

RenCrow_PORTAL本体と`runtime-host.js`／`runtime-host.css`はルートのMIT License、PuruPuru由来の`app.js`／`index.html`／`styles.css`／生成`runtime-app.js`はApache License 2.0です。著作権・入手元・改変内容・現在の上流`NOTICE`の有無は`THIRD_PARTY_NOTICES.md`、Apache License全文は`internal/portal/web/purupuru/LICENSE`を正本とします。

PuruPuru付属のdemo画像、スクリーンショット、アイコン、フォント、vendored MediaPipeは同梱しません。`internal/portal/web/purupuru/assets/<character>/`のPNGは、明示的に設定したRenCrowキャラクターpackageから展開したRenCrow素材であり、PuruPuru由来コードのライセンス範囲には含めません。

### Avatar管理Skill

PORTAL専用の`rencrow-avatar-manager` Skillは`skills/rencrow-avatar-manager/`を正本としてGit管理します。Codexから自動検出させる場合は、管理者権限を必要としないディレクトリジャンクションを作成します。

```powershell
powershell -ExecutionPolicy Bypass -File .\skills\rencrow-avatar-manager\scripts\install.ps1
```

SkillはPuruPuru package、PORTAL展開Asset、Chat／IdleChat配置、テスト、再ビルド、HTTP配信Asset、実ブラウザ表示を一連で検査します。

## Interaction profile

PORTALは、COREのChat／IdleChat／Games能力をWebで利用するInteraction profileです。

```text
RenCrow_PORTAL
  = RenCrow Interaction Client
  + Web Renderer
  + Chat / IdleChat / Games mode policy
```

CORE、PORTAL、CMD、ASSISTANTの間で揃えるのは、Chat、IdleChat、Games、recipient、event、
session、STT／TTS、Task、errorの意味です。PORTALはそれらをWeb画面へ投影しますが、
別の会話runtime、会話履歴、IdleChat状態、Task状態を持ちません。

| capability | PORTALでの表現 | 現在状態 |
| --- | --- | --- |
| Chat | `Chat`の会話・添付入力とmessage表示 | 実装済み |
| IdleChat | `IdleChat`の読み取り表示と、画面在席に連動する自動開始・停止 | 実装済み |
| Games | Agent-owned gameの選択・起動・観戦・session lifecycle | 実装済み |
| recipient | browser tab内の選択と、送信requestの明示宛先 | 実装済み |
| STT／TTS | browser microphone、audio再生、ACK | 実装済み |
| CORE Task | 許可された状態・結果の表示 | CORE側APIに従う |
| ASSISTANT Routine／PUSH | 予定、通知、端末、履歴のcard／設定UI | planned |

同じ能力を全modeへ公開しません。`IdleChat`の利用者向け操作は読み取り専用で、期限付きの
surface在席通知だけをstate-changingな例外とします。`Chat`と`Games`は各modeの明示allowlist
だけを操作可能とし、認証scopeとserver側認可も必要です。将来ASSISTANTのPUSHを表示する
場合も第二のmessage形式を独自に作らず、利用者、source、category、相関IDを保った
Interaction outputをWeb cardまたはmessageとして描画します。

PORTALが閉じていてもASSISTANTのRoutineとPUSHは動作しなければなりません。PORTALは
ASSISTANTの配信経路やschedulerにはならず、ASSISTANT Public APIのViewer／設定clientに
限定します。

## COREとの操作契約

PORTALは状態の正本を持たず、Chat操作をCOREのPublic APIへ通知します。

- 会話相手の切替は`POST /viewer/recipient-selection`で観測eventを発行し、実際の送信先は`POST /viewer/send`の`to`で確定する
- Chat／IdleChat画面は可視状態を`POST /viewer/surface-presence`でCOREへ通知する。Chat在席を最優先としてIdleChatを停止し、ChatがなくIdleChat在席がある場合だけIdleChatを開始する。PORTALから`/viewer/idlechat/start|stop`は使用しない
- Chatは修飾キーを伴わない`Enter`で送信し、`Shift+Enter`で改行する。IME／FEPの変換確定では送信しない。会話・入力・主要状態表示の文字サイズは小／中／大の3段階とし、browser local storageへ保存する
- `POST /viewer/send`には`viewer_client_id`、`input_source`、`user_id`、`device_name`を付け、COREが返す`job_id`をrequest / response相関の正本とする。受付から同じ`job_id`の利用者向け応答または終端errorまで、入力欄とMio／Shiro／Kuro／Midoriの切替をロックする
- ファイル、画面、カメラ画像は`multipart/form-data`の`attachments`として`POST /viewer/send`へ送り、PORTALからVision backendを直接指定しない。COREの公開上限である画像20 MiB、動画100 MiB、その他10 MiB、合計120 MiBをclient側でも先に検査する
- Chat会話欄は`message.received`、利用者向け`agent.response`、公開対象の`agent.progress`／`agent.acknowledge`を表示し、IdleChat会話欄は`idlechat.message`だけを表示してmode間で混在させない。`message_id`をSSE再接続時の重複排除へ使い、`agent.thinking`やrouting／worker eventは会話本文として残さない
- `input_source`は手入力の`text`と音声確定入力の`stt`を区別する。現行は認証UIを持たないため`user_id=viewer-user`、`device_name`はbrowserが公開するOS／platform名とし、tab固有識別には`viewer_client_id`を使う
- PORTAL serverはCOREへのproxy requestへ`X-RenCrow-Client: RenCrow_PORTAL`と、modeに応じた`X-RenCrow-Interaction-Profile: portal-chat | portal-idlechat | portal-games`を付ける。profileは能力policyであり認証credentialではない
- Gamesはstatus、sessions、events、Observer、launch、sessionのRetry／Start overだけを許可する。`/viewer/games/decision`、`/viewer/games/result`、Observerのlaunch／frame／summary ingestは中継しない
- Games画面は`/viewer/games/observer`を同一origin iframeへ表示する。Observer responseだけを`SAMEORIGIN`とし、PORTAL pageとPuruPuru assetは引き続きframe不可とする
- Observerの動的style属性はObserver responseの`style-src`だけで許可し、inline scriptは許可しない。PORTAL本体のCSPへ`unsafe-inline`を追加しない
- PuruPuru overlayはiframe外へ置き、`bridge.decision_mode=agent`かつ`decision.agent_id=frame.persona`のObserverFrameにある`result.speech`だけをAgent発話候補とする。`decision.reason`やlocal brain出力を発話へ変換しない
- 接続元IPのforwardingとHTTP User-AgentはCORE側で操作元ログとして安全化して記録する
- TTSは`POST /viewer/active-control`で再生権を取得し、`GET /viewer/tts/audio`で音声を取得して、再生完了を`POST /viewer/tts/playback-ack`へ返す
- STTは同じactive-controlのinput権を取得し、`GET /stt`のWebSocketへ16 kHz PCM16を送る
- `IdleChat`はsurface在席通知以外のこれらの操作を許可しない

Chat／IdleChatの排他表示、lease、複数tab、event／TTS filter、失敗時表示の詳細は
[`PORTAL_Chat_IdleChat排他ライフサイクル仕様`](docs/仕様/PORTAL_Chat_IdleChat排他ライフサイクル仕様.md)
を正とします。cross-module contractはRenCrow_COREの機能仕様、アーキテクチャ概要、Public API仕様を優先します。

## 起動

```bash
make build
./build/rencrow-portal
```

Windowsの配布用buildは次の入口を使います。

```powershell
.\scripts\build.ps1
.\build\rencrow-portal.exe
```

どちらのbuild入口も、binaryと同じ配布directoryへ`LICENSE`、`THIRD_PARTY_NOTICES.md`、`licenses/PuruPuruPNGTuber-Apache-2.0.txt`を配置します。EXEやZIPを配布するときは、このlayout全体を対象にします。

常駐運用ではuser serviceを使います。

```bash
make install-service
systemctl --user enable --now rencrow-portal.service
```

serviceは`~/.local/bin/rencrow-portal`を実行し、PORTALとCOREを別processとして管理します。

既定値:

```text
PORTAL  http://127.0.0.1:18791
CORE    http://127.0.0.1:18790
```

設定ファイルを使う場合:

```bash
cp portal.example.json portal.json
./build/rencrow-portal -config portal.json
```

環境変数でも上書きできます。

```text
RENCROW_PORTAL_LISTEN
RENCROW_CORE_URL
RENCROW_PORTAL_DEFAULT_MODE
RENCROW_PORTAL_CONFIG
```

外部公開時はPORTALの前段に認証済みリバースプロキシまたはTailscale Serveを置いてください。既定では安全側としてloopbackだけで待ち受けます。

通常のDebug ViewerはCOREの`/viewer`に残ります。外部利用者向けViewerはPORTALが所有し、次の3 URLを公開します。

```text
http://127.0.0.1:18791/?mode=Chat
http://127.0.0.1:18791/?mode=IdleChat
http://127.0.0.1:18791/games
```

## 検証

Linux／macOSでは`go test ./...`で振る舞いを検証します。ローカルWindowsでは
`.test.exe`を生成する`go test`を使わず、repo内の`Tmp/test-runtime/`へ限定して
`go vet ./...`と`go build ./...`を実行します。

```powershell
.\scripts\test-local.ps1
```

Push済みcommitのUbuntu testとWindows build/vetは次のscriptから起動・確認します。

```powershell
.\scripts\test-github-ci.ps1
```

GitHub管理の`ubuntu-latest` runnerが`go test ./...`と`go vet ./...`を、
`windows-latest` runnerが`go build ./...`と`go vet ./...`を実行します。
