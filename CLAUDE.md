# CLAUDE.md - RenCrow_PORTAL 作業案内

## このファイルの役割

このファイルは、Claude Code または同等の AI 開発環境が RenCrow_PORTAL で作業するための短い入口です。製品仕様の正本ではありません。

作業制約の詳細は `AGENTS.md` を参照します。このファイルと `AGENTS.md` が衝突した場合は `AGENTS.md` を優先します。

## 読む順番

1. `AGENTS.md`
2. `README.md`
3. `docs/` 配下の関連仕様
4. 関連コード、test、config

## クロスプラットフォーム前提

このリポジトリは Windows / Linux / macOS で共通に動作する。片方の環境でのみ通る実装・テストを書かない。

- パス連結は Go の `filepath.Join()`、Python の `pathlib.Path` を使い、`/` や `\` を文字列連結しない。
- パス文字列を YAML／JSON／シェルコマンドへ埋め込む場合は必ずエスケープする。Go は `strconv.Quote()` を使う。Windows path は `\` を含むため、生の埋め込みは `\U` などが escape と解釈されパースエラーになる。
- `/tmp`、`/home/<user>` などの絶対 path を実際の入出力先にしない。Go は `t.TempDir()`、Python は `tempfile` を使う。設定値として素通しするだけの文字列は対象外とする。
- 改行コード（LF／CRLF）に依存する比較・テストを書かない。
- 実行権限、symlink、大文字小文字を区別する filesystem を前提にしない。
- 完了とする前にUbuntuのGo behavior testとWindowsのbuild/vet jobを確認する。ローカルWindowsでは`.test.exe`を生成・実行しない。
