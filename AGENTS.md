# RenCrow_PORTAL rules

本書はRenCrow_PORTALだけの入口。[統一ルール](../AGENTS.md)を継承し、本文・モデル役割・共通検査規定を複製しない。親がcatalogではない配置では、global設定が参照するEcoSystem正本（manifestの隣のAGENTS.md）を確認する。既読なら読み直さない。

## 所有範囲

公開Web画面と許可制proxyを所有する。Chat／IdleChat／Gamesに限定し、管理API・Agent判断・Memory・Routineの正本を持たない。

## 必要なときに読む

対象の`README.md`／`docs/README.md`から現行仕様を選ぶ。下表の該当節だけを作業前に読み、対象外の節や他moduleの詳細をまとめて読まない。製品契約の不足は実装・test・production wiringと照合してowner正本へ反映する。

| 作業 | 必須の参照 |
|---|---|
| 公開画面・proxy・APIを変更する場合 | [公開画面・proxy・APIを変更する場合](rules/task-rules.md#contract) |
| 正規経路の復旧・実runtime E2Eを行う場合 | [正規経路の復旧・実runtime E2Eを行う場合](rules/task-rules.md#runtime) |
| 実装を検証する場合 | [実装を検証する場合](rules/task-rules.md#validation) |
