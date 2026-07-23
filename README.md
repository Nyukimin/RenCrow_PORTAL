# RenCrow_PORTAL

RenCrow_PORTALは、MioやShiroが部屋の中で会話するAI VTuber形式の画面を、外部利用者が閲覧・操作するための独立Webポータルです。デバッグViewer、状態の正本、演算処理は持たず、`RenCrow_CORE`のPublic APIへ許可した要求だけを中継します。

`RenCrow_ASSISTANT`との連携後は、個人・家族の予定、Routine、通知履歴、端末設定を表示・操作するWeb clientにもなります。生活Routine、PUSH、delivery状態の正本はASSISTANTであり、PORTALへ複製しません。現在の実装はCORE proxyのみで、ASSISTANT API連携はplannedです。

## モード

- `view`: AI VTuberの部屋を閲覧する読み取り専用画面
- `live`: 配信用の読み取り専用画面。会話とトピックを大きく表示し、部屋や操作UIは表示しない
- `lab`: AI VTuber画面に加えて、会話送信、会話相手の選択、IdleChat開始・停止、TTS再生、STTマイク入力

`live`と`lab`は別の表示です。`live`は配信、`lab`は部屋での操作・実験に使います。
Chatでは会話対象のMio／Shiro／Midoriを1体だけ中央表示します。IdleChatではMioを左、Shiroを右へ同時表示します。LabのキャラチップはChat時の会話送信先と単独表示キャラを選択します。

Debug、Ops、Repair、設定変更などの管理APIは中継しません。

ASSISTANT連携でも、読み取り画面からwrite actionを許可せず、他利用者のprivate data、secret、device credentialを中継しません。

## PuruPuruアバター描画

PORTALは[PuruPuruPNGTuber](https://github.com/rotejin/PuruPuruPNGTuber)の描画コードを`internal/portal/web/purupuru/`へ同梱し、同じページ内の3つの独立した`AvatarInstance`として起動します。iframeや簡易rendererは使いません。顔変形、髪揺れ、呼吸、瞬き、口差分、影、前後アイテムレイヤーはPuruPuru原版の処理を保持し、1本の`requestAnimationFrame` schedulerからMio／Shiro／Midoriを同時に更新します。

| character | PuruPuru source package | runtime element |
| --- | --- | --- |
| Mio | `assets/Mio/Mio.purupuru` | `<purupuru-avatar character="mio">` |
| Shiro | `assets/Shiro/Shiro02.purupuru` | `<purupuru-avatar character="shiro">` |
| Midori | `assets/Midori/Midori02.purupuru` | `<purupuru-avatar character="midori">` |

各キャラは、6表情、前髪、後ろ髪、`items/body.png`、`items/accessories.png`、`default-settings.json`を持ちます。画像は透過PNGで同じキャンバス寸法に揃えます。表示サイズと3人の配置は`portal.css`が所有します。

口パクはテキスト長から疑似生成しません。COREから受け取ったTTS audioをWeb Audio APIの`AnalyserNode`へ接続し、実音声のRMS振幅を発話者の`AvatarInstance`へ渡します。会話の送信先は従来どおり`lab-partner-mio`、`lab-partner-shiro`、`lab-partner-midori`で示しますが、未選択キャラも画面から消しません。

PuruPuru更新時は手編集で差分を移植せず、同期コマンドで原版と生成runtimeを更新します。キャラの正本はフォルダ直下のLoose PNGではなく、上表の生成済み`.purupuru`です。同期処理がpackage内の表情、前後髪、item layer、`settings.json`を展開します。生成テストは、同梱した原版`app.js`から`runtime-app.js`が再現できることも検証します。

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

7. `http://127.0.0.1:18791/?mode=lab`を実ブラウザで開き、3人の画像欠損、透過、動き、画面内配置をdesktop幅とnarrow幅で確認する。

PORTALは`//go:embed web/*`でassetをbinaryへ埋め込むため、ファイルを置き換えただけでは稼働中の表示は変わりません。必ず再ビルド・再起動します。`internal/portal/web/`配下の未参照ファイルもbinaryへ埋め込まれるため、旧画像や作業用バックアップはこのディレクトリへ残しません。vendored PuruPuruのライセンスとPortal固有差分は`internal/portal/web/purupuru/README.md`に記録します。

## Interaction profile

PORTALは、COREのChat／IdleChat能力をWebで利用するInteraction profileです。

```text
RenCrow_PORTAL
  = RenCrow Interaction Client
  + Web Renderer
  + view / live / lab mode policy
```

CORE、PORTAL、CMD、ASSISTANTの間で揃えるのは、Chat、IdleChat、recipient、event、
session、STT／TTS、Task、errorの意味です。PORTALはそれらをWeb画面へ投影しますが、
別の会話runtime、会話履歴、IdleChat状態、Task状態を持ちません。

| capability | PORTALでの表現 | 現在状態 |
| --- | --- | --- |
| Chat | `lab`の会話入力とmessage表示 | 実装済み |
| IdleChat | `view`／`live`／`lab`の表示、`lab`の開始・停止 | 実装済み |
| recipient | browser tab内の選択と、送信requestの明示宛先 | 実装済み |
| STT／TTS | browser microphone、audio再生、ACK | 実装済み |
| CORE Task | 許可された状態・結果の表示 | CORE側APIに従う |
| ASSISTANT Routine／PUSH | 予定、通知、端末、履歴のcard／設定UI | planned |

同じ能力を全modeへ公開しません。`view`と`live`は読み取り専用、`lab`は明示allowlist
だけを操作可能とし、認証scopeとserver側認可も必要です。将来ASSISTANTのPUSHを表示する
場合も第二のmessage形式を独自に作らず、利用者、source、category、相関IDを保った
Interaction outputをWeb cardまたはmessageとして描画します。

PORTALが閉じていてもASSISTANTのRoutineとPUSHは動作しなければなりません。PORTALは
ASSISTANTの配信経路やschedulerにはならず、ASSISTANT Public APIのViewer／設定clientに
限定します。

## COREとの操作契約

PORTALは状態の正本を持たず、Lab操作をCOREのPublic APIへ通知します。

- 会話相手の切替は`POST /viewer/recipient-selection`で観測eventを発行し、実際の送信先は`POST /viewer/send`の`to`で確定する
- `POST /viewer/send`には`viewer_client_id`、`input_source`、`user_id`、`device_name`を付け、COREが返す`job_id`をrequest / response相関の正本とする。受付から同じ`job_id`の利用者向け応答または終端errorまで、入力欄とMio／Shiro／Midoriの切替をロックする
- `input_source`は手入力の`text`と音声確定入力の`stt`を区別する。現行は認証UIを持たないため`user_id=viewer-user`、`device_name`はbrowserが公開するOS／platform名とし、tab固有識別には`viewer_client_id`を使う
- PORTAL serverはCOREへのproxy requestへ`X-RenCrow-Client: RenCrow_PORTAL`を付け、接続元IPのforwardingとHTTP User-AgentはCORE側で操作元ログとして安全化して記録する
- TTSは`POST /viewer/active-control`で再生権を取得し、`GET /viewer/tts/audio`で音声を取得して、再生完了を`POST /viewer/tts/playback-ack`へ返す
- STTは同じactive-controlのinput権を取得し、`GET /stt`のWebSocketへ16 kHz PCM16を送る
- `view`と`live`はこれらの操作を許可しない

## 起動

```bash
make build
./build/rencrow-portal
```

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

CORE側で`RENCROW_PORTAL_URL=http://127.0.0.1:18791`を設定すると、従来の`/viewer?mode=lab|live|view`はPORTALへ移動します。通常のデバッグViewerはCOREに残ります。

```text
http://127.0.0.1:18791/?mode=live
http://127.0.0.1:18791/?mode=lab
http://127.0.0.1:18791/?mode=view
```

## 検証

```bash
go test ./...
go vet ./...
make build
```
