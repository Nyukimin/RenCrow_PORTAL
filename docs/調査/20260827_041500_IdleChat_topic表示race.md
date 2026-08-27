---
title: 調査 — IdleChat TOPIC表示がAPIと食い違うrace
date: 2026-08-27 04:15
status: resolved
skill: debug-investigate
symptom: status APIのcurrent_topicが非空でもPORTALのTOPICが-になる
frequency: 断続的。5秒pollと操作直後refreshが重なった場合
inputs: live API、Playwright network/DOM、portal.js
related: docs/調査/20260726_001328_Chat_IdleChat現行契約QA.md
---

## 概要

複数の`refreshStatus`が並行し、古い応答が新しい状態を上書きできることを確認した。request generationを導入し、最新refreshだけがDOMとplayback stateを更新するよう修正した。

## 調査経緯

### 仮説1: APIとPORTALが異なるfieldを参照している
- **根拠**: APIとDOMの値が食い違っていた。
- **検証結果**: 棄却
- **証拠**:
  - APIとsourceはともに`current_topic`を使用していた。
  - live proxy応答にも同fieldが存在した。
- **チェックリスト結果**:
  - ☑ 確証バイアス: field名一致を直接確認した。
  - ☑ 頻度制約: 恒常的なfield違いは断続発生と矛盾する。
  - ☑ ライフサイクル: 初回、interval、操作後refreshを追跡した。
  - ☑ 既存知見: 既存IdleChat契約QAと矛盾しない。

### 仮説2: 並行refreshの完了順で古い応答が新状態を上書きする
- **根拠**: 5秒intervalに加えplayback操作後も同じ非排他的関数を呼ぶ。
- **検証結果**: 確認
- **証拠**:
  - 各呼出しに順序判定がなく、success/errorの双方が無条件にDOMを更新していた。
  - PlaywrightでAPI応答とDOMの`-`を同一browser session内で再現した。
- **チェックリスト結果**:
  - ☑ 確証バイアス: 単純field違いと常時API failureを反証した。
  - ☑ 頻度制約: requestが重なるときだけの断続発生に一致する。
  - ☑ ライフサイクル: success/errorと初回/interval/操作後を確認した。
  - ☑ 既存知見: 過去QAのcanonical APIを維持する。

## 根本原因

- **原因**: `refreshStatus`に最新request判定がなかった。
- **メカニズム**: 後から開始したrequestより先に開始したrequestが遅く完了すると、古いtopicまたはerror fallbackが最新DOMを上書きする。
- **影響範囲**: TOPICとIdleChat playback controls。

## 修正案

1. 単調増加するrequest generationを採番する。
2. success/errorとも最新generationだけを反映する。

## 関連ソースファイル

- `internal/portal/web/portal.js` - status refreshの順序gate。
- `internal/portal/server_test.go` - 順序gateの回帰契約。

## 教訓（将来の調査への知見）

- 定期pollと操作直後refreshを併用する表示は、応答完了順をstate更新順として扱わない。
