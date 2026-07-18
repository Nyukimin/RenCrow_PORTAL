# AGENTS.md

このリポジトリは、RenCrowを外部利用者へ公開するWeb画面を所有する。

- `mode=view`: 閲覧専用。COREへの更新要求を許可しない。
- `mode=live`: 配信用の閲覧専用画面。Labの部屋・操作UIを含めない。
- `mode=lab`: 会話送信など、明示的に許可した操作だけをCOREへ中継する。
- Debug、Ops、Repair、設定変更、管理APIは所有・中継しない。
- Persona、Memory、会話状態、Job、LLM/STT/TTS演算、ASSISTANTのRoutine／delivery状態の正本を持たない。
- CORE runtimeとCORE Public APIの正本は `/home/nyukimi/RenCrow/RenCrow_CORE` とする。
- personal／family scope、生活Routine、PUSH、端末deliveryの正本は `/home/nyukimi/RenCrow/RenCrow_ASSISTANT` とする。
- ASSISTANT Public APIの正本も `/home/nyukimi/RenCrow/RenCrow_ASSISTANT` とする。
- 起動管理CLIの正本は `/home/nyukimi/RenCrow/RenCrow_CMD` とする。

PORTALは静的UIと許可制リバースプロキシだけを持つ薄いGoサーバーとする。
新しいAPIを中継する場合は、methodとpathをallowlistへ追加し、`view`／`live`からwriteできないテストとdebug/admin APIを遮断するテストを必須とする。
ASSISTANT APIを中継する場合も同じ境界を適用し、他利用者のprivate data、secret、device credentialを公開しない。
