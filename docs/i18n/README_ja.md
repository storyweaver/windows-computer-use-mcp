# Windows Computer Use MCP

<p align="center">
  <a href="../../README.md">English</a> | <a href="README_zh-CN.md">中文</a> | **日本語** | <a href="README_fr.md">Français</a> | <a href="README_de.md">Deutsch</a>
</p>

**Anthropic 公式の Chicago MCP アーキテクチャに基づいて構築された、唯一の Windows デスクトップ自動化 MCP サーバー。**

同じ 24 のツール。同じ 3 層セキュリティモデル。同じトークン最適化。ネイティブレイヤーだけを Windows 用に置き換えました。

他のデスクトップ自動化 MCP は、ツールスキーマ、セキュリティモデル、ディスパッチロジックをすべてゼロから構築しています。このプロジェクトは、Anthropic のプロダクションコード **6,300 行以上** をそのまま再利用しています。このコードは Claude Code に組み込まれた macOS デスクトップ制御と同一のものであり、ネイティブレイヤー (スクリーンショット、入力、ウィンドウ管理) のみを Windows 相当の実装に置き換えています。

---

## このアーキテクチャが他と異なる理由

多くのデスクトップ自動化 MCP は、モデルにいくつかの基本ツール (screenshot, click, type) を与えて、あとは成り行き任せです。**Chicago MCP** (Anthropic 社内のデスクトップ制御アーキテクチャ) は、根本的に異なるアプローチを取っています。デスクトップ自動化を、階層型セキュリティ、トークン予算管理、バッチ実行を備えた**ステートフルで制御されたセッション**として扱います。

このアーキテクチャを Windows に移植しました。実際にどのような違いがあるかを見てみましょう。

### アーキテクチャ比較

```
┌─────────────────────────────────────────────────────────────────────┐
│              他の MCP サーバー                                        │
│                                                                     │
│   screenshot() ──→ モデルが確認 ──→ click(x,y) ──→ 繰り返し          │
│                                                                     │
│   セキュリティなし。バッチ処理なし。トークン予算なし。状態管理なし。       │
│   モデルは毎回すべてを視覚的に解析する必要がある。                       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│              本プロジェクト (Chicago MCP アーキテクチャ)               │
│                                                                     │
│   ┌──── Session Layer ────────────────────────────────────────┐     │
│   │  request_access → 3 層パーミッション (read/click/full)     │     │
│   │  アプリ単位の許可、キーブロックリスト、フォアグラウンドゲート  │     │
│   └───────────────────────────────────────────────────────────┘     │
│   ┌──── Efficiency Layer ─────────────────────────────────────┐     │
│   │  computer_batch: N 個のアクション → 1 回の API 呼び出し     │     │
│   │  構造化 API: cursor_position, read_clipboard,              │     │
│   │    open_application — スクリーンショット不要                 │     │
│   │  targetImageSize: 二分探索で ≤1568 トークン予算に収める      │     │
│   └───────────────────────────────────────────────────────────┘     │
│   ┌──── Vision Layer (本当に必要な場合のみ) ──────────────────┐     │
│   │  screenshot → モデルが UI を確認 → click/type/scroll       │     │
│   │  zoom → 小さい文字の高解像度クロップ                        │     │
│   └───────────────────────────────────────────────────────────┘     │
│   ┌──── Native Layer (Windows) ───────────────────────────────┐     │
│   │  node-screenshots (DXGI) │ robotjs (SendInput)            │     │
│   │  koffi + Win32 API       │ sharp (JPEG/resize)            │     │
│   └───────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

### 直接比較: 機能一覧

| 機能 | **本プロジェクト** | CursorTouch<br/>Windows-MCP<br/>(5k stars) | MCPControl<br/>(306 stars) | domdomegg<br/>computer-use-mcp<br/>(176 stars) | sbroenne<br/>mcp-windows<br/>(24 stars) |
|---|:---:|:---:|:---:|:---:|:---:|
| **バッチ実行** (N アクション、1 API 呼び出し) | **対応** | 非対応 | 非対応 | 非対応 | 非対応 |
| **トークン予算最適化** (二分探索リサイズ ≤1568 トークン) | **対応** | 非対応 | 非対応 | 非対応 | 非対応 |
| **3 層アプリパーミッション** (read / click / full) | **対応** | 非対応 | 非対応 | 非対応 | 非対応 |
| **フォアグラウンドアプリゲート** (対象外アプリがフォーカス時にブロック) | **対応** | 非対応 | 非対応 | 非対応 | 非対応 |
| **危険キーブロック** (Alt+F4, Win+L, Ctrl+Alt+Del) | **対応** | 非対応 | 非対応 | 非対応 | 非対応 |
| **構造化 API** (スクリーンショットなしで情報取得) | **対応** | 一部対応 | 一部対応 | 非対応 | 対応 |
| **ズーム** (細部の高解像度クロップ) | **対応** | 非対応 | 非対応 | 非対応 | 非対応 |
| **マルチディスプレイ** (モニター名で切り替え) | **対応** | 非対応 | 非対応 | 非対応 | 非対応 |
| **Claude Code 組み込みと同一のツールスキーマ** | **対応** | 非対応 | 非対応 | 近い | 非対応 |
| **Anthropic 上流コードの再利用** | **6,300 行以上** | 0 | 0 | 0 | 0 |
| ツール数 | 24 | 19 | 12 | 6 | 10 |
| 言語 | TypeScript | Python | TypeScript | TypeScript | C# |

### バッチ実行が重要な理由

`computer_batch` がなければ、クリック→入力→Enter のシーケンスに **5 回の API ラウンドトリップ** (各 3-8 秒) が必要です。バッチ実行を使えば:

```javascript
// 5 ラウンドトリップ → 2 回。レイテンシとトークンを 60% 削減。
computer_batch([
  { action: "left_click", coordinate: [100, 200] },
  { action: "type", text: "hello world" },
  { action: "key", text: "Return" },
  { action: "screenshot" }
])
```

これをサポートしている Windows MCP サーバーは他にありません。

### 「API で取れるなら API を使う」が重要な理由

他の MCP はモデルに**すべてをスクリーンショットで視覚的に解析させます**。Chicago MCP の方針: API で情報が取れるなら、Vision トークンを無駄遣いしない。

| タスク | 他の MCP | 本プロジェクト |
|---|---|---|
| どのアプリがフォーカスされているか? | スクリーンショット → モデルがタイトルバーを読む | `getFrontmostApp()` → 構造化データ |
| カーソルの位置は? | スクリーンショット → モデルが推測 | `cursor_position` → 正確な `{x, y}` |
| クリップボードの内容を読む | Ctrl+V でメモ帳に貼付 → スクリーンショット → 読み取り | `read_clipboard` → テキスト文字列 |
| アプリケーションを開く | スクリーンショット → アイコンを探す → クリック | `open_application("Excel")` → API 呼び出し |
| モニター切り替え | スクリーンショット → 間違ったモニター → 再試行 | `switch_display("Dell U2720Q")` |

スクリーンショットを 1 回避けるだけで、約 **1,500 Vision トークン**と **3-5 秒**を節約できます。

---

## クイックスタート

### 前提条件

- **Node.js** 18+
- **Windows 10/11**
- Visual Studio Build Tools (robotjs のビルドに必要)

### インストール

```bash
git clone https://github.com/storyweaver/windows-computer-use-mcp.git
cd windows-computer-use-mcp
npm install
npm run build
```

### Claude Code での設定

プロジェクトの `.mcp.json` に以下を追加してください:

```json
{
  "mcpServers": {
    "windows-computer-use": {
      "command": "node",
      "args": ["C:/path/to/windows-computer-use-mcp/dist/index.js"]
    }
  }
}
```

Claude Code を再起動すると、`mcp__windows-computer-use__` プレフィックス付きの 24 個の新しいツールが表示されます。

### テスト

```bash
npm test          # 70 テスト (ユニット + 結合)
npm run test:unit # ユニットテストのみ
```

---

## プロジェクト構造

```
src/
├── upstream/              # @ant/computer-use-mcp から 6,300 行以上 (変更は 1 行のみ)
│   ├── toolCalls.ts       # 3,649 行: セキュリティゲート + ツールディスパッチ
│   ├── tools.ts           # 24 のツールスキーマ定義
│   ├── mcpServer.ts       # MCP Server ファクトリ + セッションバインディング
│   ├── types.ts           # 完全な型システム
│   ├── executor.ts        # ComputerExecutor インターフェース (再構築)
│   ├── keyBlocklist.ts    # 危険キーインターセプト (win32 ブランチ組み込み)
│   ├── pixelCompare.ts    # 9×9 ピクセル陳腐化検出
│   ├── imageResize.ts     # トークン予算アルゴリズム
│   └── ...                # deniedApps, sentinelApps, subGates
├── native/                # Windows ネイティブレイヤー (~400 行)
│   ├── screen.ts          # node-screenshots + sharp (DXGI キャプチャ)
│   ├── input.ts           # robotjs (SendInput マウス/キーボード)
│   ├── window.ts          # koffi + Win32 API (ウィンドウ管理)
│   └── clipboard.ts       # PowerShell Get/Set-Clipboard
├── executor-windows.ts    # ComputerExecutor 実装
├── host-adapter.ts        # HostAdapter アセンブリ
├── logger.ts              # ファイルベースロギング
└── index.ts               # stdio MCP Server エントリポイント
```

## 技術スタック

各ライブラリは、Chicago MCP が macOS で使用しているものに対応する Windows 版です:

| モジュール | macOS (Chicago MCP) | Windows (本プロジェクト) | 役割 |
|---|---|---|---|
| Screenshot | SCContentFilter | **node-screenshots** (DXGI) | 画面キャプチャ |
| Input | enigo (Rust) | **robotjs** (SendInput) | マウス & キーボード |
| Window Mgmt | Swift + NSWorkspace | **koffi** + Win32 API | ウィンドウ制御 |
| Image Processing | Sharp | **Sharp** | JPEG 圧縮 + リサイズ |
| MCP Framework | @modelcontextprotocol/sdk | **@modelcontextprotocol/sdk** | MCP プロトコル |

## 24 のツール

| カテゴリ | ツール |
|---|---|
| **セッション** | `request_access`, `list_granted_applications` |
| **ビジョン** | `screenshot`, `zoom` |
| **マウスクリック** | `left_click`, `double_click`, `triple_click`, `right_click`, `middle_click` |
| **マウス制御** | `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `cursor_position` |
| **スクロール** | `scroll` |
| **キーボード** | `type`, `key`, `hold_key` |
| **クリップボード** | `read_clipboard`, `write_clipboard` |
| **アプリ/ディスプレイ** | `open_application`, `switch_display` |
| **バッチ + 待機** | `computer_batch`, `wait` |

## セキュリティモデル

アプリごとの 3 層パーミッション -- この仕組みを持つ MCP サーバーはこれだけです:

| 層 | スクリーンショット | クリック | 入力/貼り付け |
|---|:---:|:---:|:---:|
| **read** (ブラウザ、トレーディング) | 可 | 不可 | 不可 |
| **click** (ターミナル、IDE) | 可 | 左クリックのみ | 不可 |
| **full** (その他すべて) | 可 | 可 | 可 |

さらに: 危険キーブロック、フォアグラウンドアプリゲート、セッションスコープの許可。

## ログ

```
%LOCALAPPDATA%\windows-computer-use-mcp\logs\mcp-YYYY-MM-DD.log
```

## 既知の制限事項

- **CJK テキスト入力**: 非 ASCII テキストには `write_clipboard` + `key("ctrl+v")` を使用してください
- **アプリ検出**: 現在は実行中のアプリのみ返します (レジストリスキャンは計画中)
- **ピクセル検証**: 無効化されています (非同期 sharp が同期インターフェースに対応できないため)
- **hideBeforeAction**: 無効化されています (最小化すると WebView2 子プロセスが壊れるため)

## ライセンス

MIT

## 謝辞

Anthropic の `@ant/computer-use-mcp` (Chicago MCP) に基づいて構築されており、Claude Code v2.1.88 から抽出されています。`src/upstream/` 内のコードは Anthropic のものであり、Windows ネイティブレイヤーはオリジナルです。
