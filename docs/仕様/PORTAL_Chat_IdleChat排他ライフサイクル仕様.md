# PORTAL Chat／IdleChat排他ライフサイクル仕様

## 1. 目的

RenCrow_PORTALのChatとIdleChatを、同じ会話欄へ混在するmodeではなく、排他的な2つの
利用者surfaceとして扱います。

- 可視IdleChat画面は再生可能な完成成果物だけを明示的な再生操作で再生する。
- Chat、Games、その他の画面、CMDの前景利用中はIdleChat再生と夜間制作を禁止する。
- Chat画面へIdleChatのmessageと音声を表示・再生しない。
- 複数tab、画面再読込、browser異常終了でも誤った再開や孤立実行を残さない。

cross-moduleの正本はRenCrow_COREの次の文書です。

- `docs/02_機能仕様.md`の「PORTAL、Debug Viewerと観測性」
- `docs/04_アーキテクチャ概要.md`の「PORTAL Chat／IdleChat排他ライフサイクル」
- `docs/06_Public_API仕様.md`の「PORTAL surface在席API」

本書はPORTALでの画面挙動と受入条件を詳細化し、COREの契約を上書きしません。

## 2. 「画面を表示」の定義

対象はtop-level documentの現在modeと`document.visibilityState`です。

| 状態 | 在席 |
| --- | --- |
| `mode=Chat`かつ`visibilityState=visible` | `surface=chat`をclaimする |
| `mode=IdleChat`かつ`visibilityState=visible` | `surface=idlechat`をclaimする |
| `mode=Games`かつ`visibilityState=visible` | `surface=games`をclaimする |
| 独立した認証済み画面が可視 | `surface=other`をclaimする |
| `visibilityState=hidden`、`pagehide` | 現在surfaceをreleaseする |
| 同じdocument内で別modeへ遷移 | 旧Idle表示・音声を直ちに止め、同じreceiptの新しいclaimでsurfaceを原子的に置換する |
| browser crash、network断などrelease不能 | CORE側の30秒lease失効でreleaseと同等に扱う |

`viewer_client_id`はtab単位の不透明IDです。ローカルの更新番号を失った再読込ではIDを更新し、
別tabと共有しません。可視中は10秒ごとにheartbeatします。更新にはCOREのV2
`register → claim → heartbeat → release`、`runtime_epoch`、`registration_receipt`、
`update_seq`、`claim_seq`を使い、古い応答と重複要求で状態を戻しません。

## 3. 有効modeの決定

開始／停止の正本はCOREです。PORTALは`POST /viewer/surface-presence`で在席を通知し、
`/viewer/idlechat/start`または`/viewer/idlechat/stop`を呼びません。

| 有効な在席 | COREの結果 | PORTALの表示 |
| --- | --- | --- |
| Chat／Games／other／CMDが1件以上、または前景turn実行中 | 再生禁止、現再生世代を失効 | 前景画面は`foreground_ready`確認後に操作可能。IdleChatは待機 |
| 前景なし、可視IdleChatが1件以上、完成成果物あり | 再生許可。自動再生なし | 再生操作を可能にする |
| 前景なし、可視IdleChatがあるが完成成果物なし | 再生開始不可 | 不足状態を示す |
| どちらもなし | 再生開始不可 | 実行中を表示しない |

複数の前景tabがあれば最後のleaseがreleaseまたは失効するまで再生を許可しません。
最後の前景画面が閉じても、古い再生世代は復活しません。

## 4. 起動とready条件

### Chat

1. 初期状態では入力欄、送信、recipient切替、STTをdisabledにする。
2. V2 register後、`surface=chat, action=claim`を送る。
3. 現在の通信世代・画面世代の応答で`foreground_ready=true`を確認する。
4. 確認後にだけChat操作をreadyにする。

停止確認前に利用者入力を受け付けません。claim失敗、timeout、期待状態との不一致では
「IdleChat停止を確認できません。再接続中です」と表示し、Chat操作をdisabledのままにします。

### IdleChat

1. 初期状態を「開始確認中」とし、COREの応答を待たずにMioとShiroを表示する。
2. V2 register後、`surface=idlechat, action=claim`を送る。
3. 現在の通信世代・画面世代の応答で`playback_allowed`を確認する。
4. 許可され、完成成果物がある場合だけ明示操作による再生を受け付ける。前景利用中は待機を示す。

claim失敗またはtimeoutでは再生を許可しません。PORTALだけで成功状態を推測したり、
local timerだけで実行中へ変えたりしません。MioとShiroの描画は実行状態の成功表示では
ないため、開始確認中、待機中、errorでも維持します。

### Chatのキャラクター切替

- ChatのHTML DOMには選択中の`purupuru-avatar`を1個だけ生成し、通常時に非選択3体の
  runtime、画像asset通信、`requestAnimationFrame`更新を発生させない。
- 相手切替では、現在のavatarを表示・scheduler更新したまま、切替先runtimeをdetached shellへ
  読み込む。pending runtimeは準備中にDOMへ接続せず、共通schedulerへ登録しない。
- 切替先runtimeがreadyになってからCOREの`POST /viewer/recipient-selection`を呼び、応答の
  recipient一致を確認した後、同期的にcurrent shell／runtimeをpendingへ交換し、最後に画面の
  選択状態を更新する。ロード画面や空白frameを表示しない。
- asset準備またはCORE確認に失敗した場合はpending runtimeだけを破棄し、現在のavatar、
  scheduler登録、選択button、保存済みrecipientを変更しない。
- 初期表示ではlocal storageのrecipientをcustom element upgrade前に`character`へ設定し、
  選択外avatarを一度起動してから切り替える挙動を発生させない。

### IdleChatのキャラクター配置

- キャラクター切替buttonを表示しない。
- 画面へ遷移した直後からMioとShiroの2体を表示し、開始claimの完了を描画条件にしない。
- 横画面はChatの`landscape`と同じ`1920 x 1080`論理キャンバスを使い、layout viewportへ
  等比fitして中央配置する。余剰領域は左右または上下の余白とし、cropや非等方scaleを行わない。
- 縦画面には固定キャンバスを適用せず、既存のresponsive配置を維持する。
- 横画面、縦画面のどちらも、各キャラクターの描画枠を同じ向きのChat画面と同じサイズにする。
- 画面幅を縦に4等分し、PuruPuru描画枠の透明余白を除いたMioの可視キャラクター中心を左1/4の`x=25%`、Shiroの可視キャラクター中心を右1/4の`x=75%`へ置く。
- Shiroは横画面、縦画面のどちらも同じ向きの基準位置からY軸方向へ`20pt`上に配置する。MioのY位置は変更しない。
- 下部の会話欄は、横画面、縦画面のどちらも上端をPuruPuru描画枠の透明余白を除いたShiroの可視キャラクター下端へ一致させる。
- KuroとMidoriはIdleChatのHTML DOMへ生成しない。CSSで非表示にするだけの要素も置かず、
  対応するPuruPuru runtimeの初期化、画像asset通信、`requestAnimationFrame`更新を発生させない。
  GamesではMio、Shiro、Kuro、Midoriの4体を生成し、PuruPuru overlay契約を維持する。

## 5. eventと音声の分離

SSE eventは受信時点の現在modeでfilterします。mode変更前に受信したeventや再接続時の再送も
同じ規則を適用します。

COREの`idlechat.control`は会話履歴のEventSeqを持たない最新状態通知です。PORTALはHTTPの
presence応答と同じ`runtime_epoch`、`state_revision`、`playback_generation`を比較して採用し、
同じepochの古いrevisionではreadyや再生を復活させません。epochが変わったとき、またはSSEが
切断されたときはreadyを解除し、旧世代の台詞・音声・再生待ちqueueを破棄して再registerから
やり直します。SSEが再接続してもclaimなしでreadyへ戻しません。

| surface | 会話欄へ表示する | 表示しない |
| --- | --- | --- |
| Chat | `message.received`、利用者向け`agent.response`、既存契約で公開対象の`agent.progress`／`agent.acknowledge` | `idlechat.message`、thinking、routing、非公開worker event |
| IdleChat | `idlechat.message` | `message.received`、`agent.response`、thinking、routing、worker event |

Chatで処理中の表示は、現在のpending requestと同じ`trace_id`を持つ`agent.start`で「応答生成中」に更新します。会話本文は完成時の利用者向け`agent.response`に表示し、body deltaを含む`agent.thinking`の公開には依存しません。

- ChatではIdleChat由来のTTS audioを取得、再生、ACKしません。
- IdleChatでは通常Chat由来のTTS audioを取得、再生、ACKしません。
- mode切替時は旧modeの再生待ちqueueと再生中audioを停止し、旧modeのmessageを新しい会話欄へ移しません。
- ローカルmode変更ではCORE応答を待たず、旧Idle音声とtimerを先に停止します。
- 旧`runtime_epoch`・`playback_generation`を持つ遅延event、音声取得結果、`audio.play()`の完了、ACKを現画面へ適用しません。
- 重複eventは`message_id`で除外しますが、重複除外より先にmode filterを適用しても、後に適用しても表示結果が同じでなければなりません。

### Chatの音声入力（STT）のerrorとclose

Chatのマイク入力は、COREの`WS /stt`（`protocol="utterance.v1"`）へPCM16を送り、発話ごとの
`final`／`error`／`cancelled`を受け取ります。話し終わりの判定（無音による自動区切り）は
RenCrow_STTが持ち、PORTALは持ちません。自動区切りで発話が増えるため、1発話の失敗でマイクを
止めてはなりません。event別の扱いは次の通りです。

| 受信event | PORTALの扱い |
| --- | --- |
| `draft`／`partial`（textあり） | 入力欄へ表示するだけで送信しない |
| `final`（textあり） | 入力欄へ入れて`input_source=stt`で送信する。`end_reason`は判定に使わず、未知の値（`silence`など）も通常の`final`として扱う |
| `final`（textなし）、`cancelled`、`speech_start`、`ready`、未知のtype | 何もしない。マイクとinput権は維持する |
| `error`で`utterance_id`あり（発話単位。`stt_busy`、`stt_provider_error`、`stt_failed`など） | 状態行へ`STT発話エラー: <code>: <error>`を短く表示する。マイクとinput権は維持し、直前のerrorとして保持する |
| `error`で`utterance_id`なし（session-level） | マイクをOFFにし、input権を解放し、`STTエラー: <code>: <error>`を表示する |
| WebSocket close（マイクON中の、現在の接続の意図しないclose） | マイクをOFFにし、input権を解放し、closeのcode／reason／直前の発話errorを添えて表示する。自動再接続はしない |

- `utterance_id`の有無だけで発話単位とsession-levelを区別する。errorの`code`の値で区別しない。
- COREは接続を閉じるとき（上限超過）、終端を持たない各発話へ`code=stt_limit_exceeded`の発話errorを送ってから閉じる。
  発話errorではマイクを止めず、続くcloseで止めて、直前の発話errorを理由に含める。
- 既に`cleanup`で解放・差し替え済みの古い接続のcloseは、新しいSTTセッションを止めない。
- マイクOFF操作の後（停止処理中）に届いた発話errorは状態行を上書きしない。
- この判定は`internal/portal/web/stt_events.js`の純関数（`classifySTTMessage`、`describeSTTClose`）が持ち、
  効果（マイク、input権、状態行）の適用は`portal.js`が行う。

## 6. 権限境界

`mode=IdleChat`は会話送信や管理操作について読み取り専用です。state-changingな例外は
`POST /viewer/surface-presence`の`surface=idlechat`と、CORE管理のTopic Stockを再生する
`POST /viewer/idlechat/playback`だけです。

- IdleChat画面へ開始／停止buttonを置かない。
- IdleChat画面の最下部には`再生`、`スキップ（次の話題）`、`前の話題`の3buttonだけを置く。
- Topic Stockの項目、消費、次／前カーソル、再生履歴はCOREを正本とし、PORTALへ複製しない。
- Chat画面にもIdleChatの開始／停止buttonを置かない。
- `portal-idlechat`から`surface=chat`を送れない。
- `portal-chat`から`surface=idlechat`を送れない。
- 両profileから`POST /viewer/idlechat/start|stop`を中継しない。
- Debug、Ops、Repair、設定変更APIを追加公開しない。

PORTAL serverはbrowserが送ったclient/profile headerを信頼せず、page modeに応じた
`X-RenCrow-Client: RenCrow_PORTAL`とInteraction profileへ上書きします。

## 7. 受入条件

1. IdleChatだけを可視表示するとclaim応答で再生可否が分かり、ready成果物だけを明示操作で再生できる。再生由来の会話生成LLMは呼ばれない。
2. IdleChat実行中にChatを可視表示するとIdleChatと未送信TTS queueが停止し、停止確認後にChat入力が有効になる。
3. Chat表示中に届いた`idlechat.message`は、live eventでもSSE再送でもChat会話欄へ表示されない。
4. ChatとIdleChatを別tabで可視表示するとChatが優先され、IdleChat側は待機中を表示する。
5. 最後の前景tabを閉じた時、可視IdleChat tabが残っていても旧再生は自動復活しない。
6. 最後のIdleChat tabを閉じ、ChatもなければPORTAL起因のIdleChat実行は残らない。
7. tabを強制終了してreleaseできなくても30秒以内にleaseが失効し、集約状態が修復される。
8. profileとsurfaceの不一致、未知action、空の`viewer_client_id`は拒否され、状態を変更しない。
9. heartbeat、release、同一requestの再送でIdleChat sessionを二重起動しない。
10. CORE unavailable時はChat操作をreadyにせず、IdleChatを実行中と表示しない。
11. IdleChatの初期描画には切替buttonがなく、CORE応答前からChatと同寸のMioとShiroが`x=25%`／`x=75%`を中心に表示される。
12. 横画面と縦画面の双方でKuroとMidoriがIdleChatのHTML DOMへ生成されず、対応する
    PuruPuru runtimeの初期化、画像asset通信、`requestAnimationFrame`更新が発生しない。
13. Chatでは通常時のDOMとscheduler登録runtimeが選択中の1体だけであり、切替時は
    `avatar準備 -> CORE recipient確認 -> 同期commit -> 選択状態更新`の順を守る。各失敗時は
    current avatarと選択状態を維持し、ロード画面や空白frameを表示しない。
14. STTの`error`が`utterance_id`を持つ場合、マイクとinput権は維持され、状態行へ発話errorが表示される。
15. STTの`error`が`utterance_id`を持たない場合と、マイクON中の意図しないWebSocket closeでは、マイクがOFFになりinput権が解放され、理由が表示される。
16. `end_reason`が未知の値（`silence`など）の`final`は、通常の`final`と同じく入力欄へ入り送信される。
17. Games、Lumina preview、World PoCを含む可視の非Idle画面は前景leaseを持ち、夜間制作とIdle再生を禁止する。
18. CORE再起動、SSE切断・再接続、遅延heartbeat／control通知で旧readyと旧世代の音声・台詞が復活しない。
19. `register → claim`と`foreground_ready`が成立してからChat送信する。claim未成立の送信はCOREでも拒否される。

## 8. 実装と検証境界

CORE endpoint、lease集約、PORTAL allowlist、browser lifecycle、event／TTS filterを実装します。
変更時はCOREを先に検証し、CORE contract test、PORTAL proxy policy test、browser lifecycle test、
複数tab testの順に確認します。単一tabの表示成功だけで排他制御の完了とは扱いません。

## 9. owner境界

presence登録、lease、前景turn、再生policy、runtime世代の正本はCOREのRAMです。PORTALは
画面可視性を通知し、COREの結果で送信・再生・表示を制御します。通信状態のローカルコピーは
正本ではありません。CORE再起動で登録とleaseは失われ、全画面が再登録します。
