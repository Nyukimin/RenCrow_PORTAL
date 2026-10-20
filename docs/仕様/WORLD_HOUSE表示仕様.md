# WORLD / HOUSE 表示仕様（v1.4.0 統合設計）

**状態:** 設計採用・正式表示未実装。現行の `/world-poc` は既定 OFF の R04 Mock PoC であり、本仕様の WorldSnapshot、空間、Actor 活動、音声の受入証拠ではない。

出典は 206 の `RenCrow/Tmp/WORLD/WORLD_実装仕様一式_v1.4.0_20261020.zip`（SHA-256 `f5e69cdca00e3551656dcd5839355802b9cebf03989d778861f176b90907559f`）の `WORLD_v1.4.0/WORLD_Integrated_Spec_v1.4.0.md` §13〜14、`appendices/03_RenCrow_LivingWorld.md`、`contracts/acceptance_matrix.json`。CORE の認証・公開 API と WORLD の確定状態は各 owner の正本に従う。

## 表示の入力と所有

| 入力・結果 | Owner | PORTAL の扱い |
| --- | --- | --- |
| WORLD の時間、位置、在室、移動、訪問、確定 Event | WORLD | 認証済み CORE read bridge の公開投影だけを受ける。ブラウザから WORLD へ直結しない |
| CORE の実 Actor、会話、Task/Run、本人の知識、発話・音声 | CORE | owner の確認済み参照と許可範囲だけを表示する。生活ポーズから知的成果を作らない |
| Camera、LCP、仕事場、PinP、描画、画面内の音声調停 | PORTAL | World/CORE の状態を変えず、同一 page の一つの表示状態から射影する |

WORLD の `mio/shiro/kuro/midori/aka/ao/kin/gin` は HOUSE の住人・表示対象で、Lumina は訪問中だけ追加できる。最大９体の表示と９体の常住は異なる。CORE の認証済み実 Actor は現行契約の Mio/Shiro/Kuro/Midori であり、四神の WORLD 在室から独立した CORE Agent 権限、会話、Coder 推論を推測しない。Lumina のモデル表示、訪問 Presence、本人の会話接続、実発話も別の事実として扱う。

## 二視点と状態

- LCP は HOUSE の三層正面断面、Workplace は同じ１階の約45度斜視を表示する。両者は同じ `world_id`、Timeline、epoch、確定 state、空間版から射影し、仕事場用の複製 World や別の生活 Loop を作らない。
- 同一 page に一つの WorldViewModel/購読を置く。Main と PinP はこれを共有し、入れ替えは表示位置と camera だけを変える。World/CORE への Command、Task 開始、発話、TTS、追加購読を発生させない。狭い画面でも二つの view と Main/PinP の表示位置が識別できる。
- 仕事場は１階に実在し、公開許可された個体だけを描く。室内外、階、奥行き、遮蔽、席、移動の見え方は WORLD の測量済み空間と確定 Event に従う。未測量なら位置・階段移動・家具接触を補作せず、「未検証」の状態で示す。
- `queued`、`running`、`waiting/blocked`、stale な WorkSet、fresh な空 Set を混同しない。作業姿勢は実仕事の成功を意味しない。CORE の結果 receipt がない成果を表示しない。

## 認証済み配信と失敗表示

- 正式表示は CORE が定義する認証・policy・閲覧 scope の read bridge を経由する。現行 R04 Mock の GET-only route を本番用へ暗黙に改名・昇格させない。正式 endpoint、DTO、PORTAL の mode/allowlist は CORE と PORTAL の owner 仕様を揃えてから実装する。
- 最初の Snapshot とその後の ordered Delta は同じ確定境界でつなぐ。Viewer の `view_cursor` は権限別の不透明値とし、WORLD 全体の非公開 Event 連番をブラウザに露出しない。Delta は公開投影の前後差分で追加・退出・redaction を扱う。再接続時の cursor 欠落、逆順、保持期限切れ、scope 変更、epoch 変更では表示を stale にして新 Snapshot へ同期する。古い情報を「現在」として示さない。
- 認証拒否、CORE/WORLD 不可用、Snapshot 失敗、空間未検証、音声不可用を区別して表示する。既定 fallback がなければ unavailable とし、Mock、静止画像、過去の成功を現在の WORLD 状態と偽装しない。秘密の Event、私室、未許可の Actor 観測を DOM、ログ、表示 cursor から漏らさない。
- Main/PinP は一つの音声再生 Coordinator を共有し、同一ブラウザ Session では `utterance_id + presentation_revision` で重複再生を防ぐ。音声の受信・再生失敗は WORLD の発話事実を取り消さない。複数端末を横断する一回性は本仕様の保証範囲外。

## 実装と受入

R12 以降の正式 PORTAL mode は、R06 WORLD 永続状態、R07 認証 API、R08/R09 CORE 投影・read bridge、R10/R11 生活と空間の成立を入力とする。R13 で二視点・同一 store・ordered Delta を受け入れ、R14 で参考画と実機 PC/スマートフォン横画面を比較する完成美術 Gate を別に通す。Blender 仮レンダ、R04 Mock、HOUSE の候補素材を本番美術合格にしない。

受入は ZIP の `W14-AC-015`〜`018`（配信・非公開情報）、`W14-AC-023`（Main/PinP と音声）、`W14-AC-024`（HOUSE の８住人・Visitor・二視点・美術・長時間運転）を対応させる。各試験は実 WORLD → CORE の認証済み read bridge → PORTAL → 利用者の表示・音声を通し、再起動・再接続・閲覧 scope の変更を含める。ZIP の24件はすべて `not_run` であり、本書の追加を実機受入へ換算しない。
