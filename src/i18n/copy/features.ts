import type { AppLocale } from "../locales.ts";

/** Copy for product surfaces added after the original shell. English text is the typed key. */
export const featureCopy = {
  "Could not save. Check the connection and retry.": {
    "zh": "保存失败，请检查连接后重试。",
    "ja": "保存できませんでした。接続を確認して再試行してください。"
  },
  "The source chat is open, but this record is no longer available. Refresh the list and try again.": {
    "zh": "来源对话已打开，但所选记录已不可用。请刷新列表后重试。",
    "ja": "元の会話を開きましたが、選択した記録は利用できません。一覧を更新して再試行してください。"
  },
  "Bot sync failed: ": {
    "zh": "Bot 配置同步失败：",
    "ja": "Bot の設定同期に失敗しました："
  },
  "Global": {
    "zh": "全局",
    "ja": "全体"
  },
  "Draft storage unavailable; input is kept on this page": {
    "zh": "无法保存表单草稿，输入仍保留在页面",
    "ja": "下書きを保存できません。入力内容はこのページに保持されています"
  },
  "Configuration has been checked. Continue the original task. Check completed steps and current state first; do not repeat successful actions or actions with an unconfirmed outcome. Keep the existing approval rules.\n\nOriginal request:\n": {
    "zh": "配置已检查，请继续原任务。先核对已经完成的步骤和当前状态，不要重复执行已成功或结果尚未确认的操作；需要对外操作时仍按原权限请求批准。\n\n原请求：\n",
    "ja": "設定を確認しました。元のタスクを続けてください。まず完了済みの手順と現在の状態を確認し、成功した操作や結果が未確認の操作を繰り返さないでください。既存の承認ルールに従ってください。\n\n元のリクエスト：\n"
  },
  "Check model service": {
    "zh": "检查模型服务",
    "ja": "モデルサービスを確認"
  },
  "Check MCP connection": {
    "zh": "检查 MCP 连接",
    "ja": "MCP 接続を確認"
  },
  "Manage saved logins": {
    "zh": "管理登录凭据",
    "ja": "保存済みログインを管理"
  },
  "Open browser to sign in": {
    "zh": "打开浏览器登录",
    "ja": "ブラウザーでログイン"
  },
  "# Group assignments\n\nReview uncertain effects before using `/task ID complete`, `cancel` or `retry`.": {
    "zh": "# 群任务\n\n待核对任务：核对实际结果后发送 `/task 任务ID complete`、`cancel` 或 `retry`。",
    "ja": "# グループタスク\n\n結果が不明な操作は実際の状態を確認してから、`/task ID complete`、`cancel` または `retry` を使用してください。"
  },
  "File changed; restored edits are kept. Review and reopen the latest version.": {
    "zh": "文件已变化，恢复的草稿保留；请核对后重新打开最新版本",
    "ja": "ファイルが変更されています。復元した下書きは保持されています。内容を確認し、最新版を開き直してください。"
  },
  "Draft storage unavailable; edits remain on this page": {
    "zh": "无法保存编辑草稿，内容仍保留在页面",
    "ja": "下書きを保存できません。編集内容はこのページに保持されています"
  },
  "Save to the shared workspace before attaching to another member": {
    "zh": "请先另存到共享工作区，再引用给当前成员",
    "ja": "別のメンバーに添付する前に、共有ワークスペースへ保存してください"
  },
  "Attached to the composer; the next turn reads the latest file": {
    "zh": "已加入输入框附件；发送时会读取最新文件",
    "ja": "入力欄に添付しました。送信時に最新のファイルを読み込みます"
  },
  "Document saved": {
    "zh": "文档已保存",
    "ja": "文書を保存しました"
  },
  "Saved": {
    "zh": "已保存",
    "ja": "保存しました"
  },
  "Check the connection or configuration, then continue with the original request and attachments.": {
    "zh": "可检查连接或配置，再继续这项任务。原请求和附件会保留。",
    "ja": "接続や設定を確認してから、元のリクエストと添付ファイルでタスクを続けられます。"
  },
  "Continue task": {
    "zh": "继续任务",
    "ja": "タスクを続ける"
  },
  "The host run is active or unconfirmed. Reopen this conversation to check it first.": {
    "zh": "主机任务尚未结束或状态未确认，请先重新打开会话核对。",
    "ja": "ホストのタスクが実行中、または状態が未確認です。会話を開き直して確認してください。"
  },
  "This task has newer work. Reopen the conversation to review it.": {
    "zh": "这项任务已有后续进展，请重新打开会话查看。",
    "ja": "このタスクには新しい進展があります。会話を開き直して確認してください。"
  },
  "The original request or attachments are unavailable. Reopen the conversation and retry.": {
    "zh": "原请求或附件暂时不可用，请重新打开会话后重试。",
    "ja": "元のリクエストまたは添付ファイルを利用できません。会話を開き直して再試行してください。"
  },
  "Click to chat, right-click to edit Bot": {
    "zh": "点击聊天，右键编辑 Bot",
    "ja": "クリックでチャット、右クリックで Bot を編集"
  },
  "Edit": {
    "zh": "编辑",
    "ja": "編集"
  },
  "Edit this Bot": {
    "zh": "编辑此 Bot",
    "ja": "この Bot を編集"
  },
  "This Bot’s memories": {
    "zh": "此 Bot 的记忆",
    "ja": "この Bot の記憶"
  },
  "This Bot’s routines": {
    "zh": "此 Bot 的例行任务",
    "ja": "この Bot の定期タスク"
  },
  "Face": {
    "zh": "脸蛋",
    "ja": "顔"
  },
  "Hair": {
    "zh": "头发",
    "ja": "髪型"
  },
  "Accessory": {
    "zh": "配饰",
    "ja": "アクセサリー"
  },
  "Face colour": {
    "zh": "脸蛋颜色",
    "ja": "顔の色"
  },
  "Eye colour": {
    "zh": "眼睛颜色",
    "ja": "目の色"
  },
  "Hair colour": {
    "zh": "头发颜色",
    "ja": "髪の色"
  },
  "Accessory colour": {
    "zh": "配饰颜色",
    "ja": "アクセサリーの色"
  },
  "Create Bot": {
    "zh": "创建 Bot",
    "ja": "Bot を作成"
  },
  "Edit Bot": {
    "zh": "编辑 Bot",
    "ja": "Bot を編集"
  },
  "Close": {
    "zh": "关闭",
    "ja": "閉じる"
  },
  "Set its role and communication style. Leave fields blank to keep the defaults. Changes apply from the next turn.": {
    "zh": "设定它的职责和表达习惯，留空的项目沿用默认设置。保存后在下一轮对话生效。",
    "ja": "役割や話し方を設定します。空欄は既定値を使用します。変更は次のターンから適用されます。"
  },
  "New Bot": {
    "zh": "新 Bot",
    "ja": "新しい Bot"
  },
  "Name": {
    "zh": "名称",
    "ja": "名前"
  },
  "Name your Bot": {
    "zh": "给 Bot 起个名字",
    "ja": "Bot に名前を付ける"
  },
  "Start with a role": {
    "zh": "从一个职责开始",
    "ja": "役割から始める"
  },
  "Optional starting text. Your own edits are preserved.": {
    "zh": "可选。填入参考内容，保留你已修改的文字。",
    "ja": "任意のひな形です。自分で編集した内容は保持されます。"
  },
  "Role and expertise": {
    "zh": "职责与专长",
    "ja": "役割と専門分野"
  },
  "Personality and style": {
    "zh": "性格与表达习惯",
    "ja": "性格と話し方"
  },
  "Standing instructions": {
    "zh": "长期要求",
    "ja": "継続的な指示"
  },
  "For example: help with product research and check sources": {
    "zh": "例如：帮助我做产品研究，核实信息来源",
    "ja": "例：製品調査を手伝い、情報源を確認する"
  },
  "For example: direct and patient; lead with the answer": {
    "zh": "例如：直接、耐心，先给结论",
    "ja": "例：率直かつ丁寧に、結論から伝える"
  },
  "For example: separate facts from assumptions and cite key decisions": {
    "zh": "例如：区分事实和假设，保留重要决定的依据",
    "ja": "例：事実と仮定を区別し、重要な判断の根拠を示す"
  },
  "Engine, model and capabilities": {
    "zh": "引擎、模型与能力",
    "ja": "エンジン・モデル・機能"
  },
  "Engine": {
    "zh": "引擎",
    "ja": "エンジン"
  },
  "Separate chats; shares this engine's workspace and permissions.": {
    "zh": "独立聊天记录，共用该引擎的工作区与权限。",
    "ja": "会話履歴は独立しています。ワークスペースと権限は同じエンジンで共有します。"
  },
  "Default model": {
    "zh": "默认模型",
    "ja": "既定のモデル"
  },
  "Follow the conversation": {
    "zh": "跟随当前对话",
    "ja": "会話の設定に従う"
  },
  "unavailable": {
    "zh": "已不可用",
    "ja": "利用不可"
  },
  "Use all enabled servers": {
    "zh": "使用全部已启用服务",
    "ja": "有効なすべてのサーバーを使用"
  },
  " (disabled)": {
    "zh": "（已停用）",
    "ja": "（無効）"
  },
  "Add servers in Settings → MCP.": {
    "zh": "在设置的 MCP 中添加服务。",
    "ja": "設定 → MCP でサーバーを追加してください。"
  },
  "Add instructions in Settings → MCP and Skills.": {
    "zh": "在设置的 MCP 与 Skills 中添加工作方法。",
    "ja": "設定 → MCP と Skills で作業手順を追加してください。"
  },
  "New Codex tools become available in a new conversation; revoking existing tools takes effect immediately.": {
    "zh": "Codex 新增工具需新建对话后使用；已有工具的撤销立即生效。",
    "ja": "Codex の新しいツールは新規会話から利用できます。既存ツールの取り消しは直ちに適用されます。"
  },
  "Avatar and appearance": {
    "zh": "头像与外观",
    "ja": "アバターと外観"
  },
  "Default avatar": {
    "zh": "恢复默认头像",
    "ja": "既定のアバター"
  },
  "Hair palette": {
    "zh": "推荐发色",
    "ja": "髪色パレット"
  },
  "Cancel": {
    "zh": "取消",
    "ja": "キャンセル"
  },
  "Saving…": {
    "zh": "保存中…",
    "ja": "保存中…"
  },
  "Save": {
    "zh": "保存",
    "ja": "保存"
  },
  "MCP & Skills": {
    "zh": "MCP 与 Skills",
    "ja": "MCP と Skills"
  },
  "Model usage": {
    "zh": "模型用量",
    "ja": "モデル使用量"
  },
  "Developer": {
    "zh": "开发者模式",
    "ja": "開発者モード"
  },
  "Check model options. Output cannot exceed the context window.": {
    "zh": "请检查模型参数，输出上限不能超过上下文窗口。",
    "ja": "モデルのパラメーターを確認してください。出力上限はコンテキストウィンドウ以下にしてください。"
  },
  "Filter routines by Bot": {
    "zh": "按 Bot 筛选例行任务",
    "ja": "Bot で定期タスクを絞り込む"
  },
  "All Bots": {
    "zh": "全部 Bot",
    "ja": "すべての Bot"
  },
  "This routine changed elsewhere. Your draft is kept. Discard changes and edit again to load the latest version.": {
    "zh": "任务已在其他页面修改，草稿仍保留。请放弃更改后重新编辑，以载入最新内容。",
    "ja": "別の画面でタスクが変更されました。下書きは保持されています。変更を破棄して編集し直すと最新版を読み込めます。"
  },
  "Enter a task name.": {
    "zh": "请填写任务名称。",
    "ja": "タスク名を入力してください。"
  },
  "Enter task instructions.": {
    "zh": "请填写任务指令。",
    "ja": "タスクの指示を入力してください。"
  },
  "Enter a valid five-field cron expression.": {
    "zh": "请检查时间规则，需要五段有效 cron。",
    "ja": "有効な 5 フィールドの cron 式を入力してください。"
  },
  "Enter a valid time zone, such as Asia/Shanghai.": {
    "zh": "请填写有效时区，例如 Asia/Shanghai。",
    "ja": "有効なタイムゾーン（例：Asia/Tokyo）を入力してください。"
  },
  "Not run": {
    "zh": "未运行",
    "ja": "未実行"
  },
  "Instructions": {
    "zh": "任务指令",
    "ja": "指示"
  },
  "Repeat": {
    "zh": "重复",
    "ja": "繰り返し"
  },
  "Daily": {
    "zh": "每天",
    "ja": "毎日"
  },
  "Weekdays": {
    "zh": "工作日",
    "ja": "平日"
  },
  "Weekly": {
    "zh": "每周",
    "ja": "毎週"
  },
  "Custom": {
    "zh": "自定义",
    "ja": "カスタム"
  },
  "Time": {
    "zh": "时间",
    "ja": "時刻"
  },
  "Day": {
    "zh": "星期",
    "ja": "曜日"
  },
  "Schedule (cron)": {
    "zh": "时间规则（cron）",
    "ja": "スケジュール（cron）"
  },
  "Time zone": {
    "zh": "时区",
    "ja": "タイムゾーン"
  },
  "Save changes": {
    "zh": "保存修改",
    "ja": "変更を保存"
  },
  "Discard changes": {
    "zh": "放弃更改",
    "ja": "変更を破棄"
  },
  "Wait for this run to finish before saving.": {
    "zh": "任务运行中，结束后可保存。",
    "ja": "実行が終了してから保存してください。"
  },
  "Unsaved. Closing settings keeps this draft on this page.": {
    "zh": "尚未保存。关闭设置会暂存此页的编辑内容。",
    "ja": "未保存です。設定を閉じても、このページに下書きが保持されます。"
  },
  "Next planned": {
    "zh": "下次计划",
    "ja": "次回の予定"
  },
  "No matching time within the next year.": {
    "zh": "未来一年内没有匹配的计划时间。",
    "ja": "今後 1 年以内に一致する実行時刻がありません。"
  },
  "Disabled; scheduled runs are paused.": {
    "zh": "已停用，不会按时运行。",
    "ja": "無効です。定期実行は停止しています。"
  },
  "Last run": {
    "zh": "最近运行",
    "ja": "前回の実行"
  },
  "The host was busy. This occurrence was skipped and was not replayed.": {
    "zh": "运行资源被占用，本次未运行，未自动补跑。",
    "ja": "ホストが使用中だったため、今回はスキップされました。自動再実行は行われませんでした。"
  },
  "The host missed this scheduled time. This occurrence was not replayed.": {
    "zh": "主机未及时检查该计划时间，本次未运行，未自动补跑。",
    "ja": "ホストが予定時刻を逃しました。自動再実行は行われませんでした。"
  },
  "Run history": {
    "zh": "运行记录",
    "ja": "実行履歴"
  },
  "View result": {
    "zh": "查看本轮结果",
    "ja": "結果を見る"
  },
  "Show less": {
    "zh": "收起",
    "ja": "折りたたむ"
  },
  "The latest 20 runs are listed; full results stay in the conversation.": {
    "zh": "保留最近 20 次记录，完整结果在对话中。",
    "ja": "最新 20 件を表示しています。完全な結果は会話に保持されています。"
  },
  "Group": {
    "zh": "群聊",
    "ja": "グループ"
  },
  "Memories can be shared globally, with one Bot, or within one group. Chat saves default to the current Bot or group; global memories are available in every conversation.": {
    "zh": "记忆可供所有 Bot、指定 Bot 或指定群聊使用。聊天中保存时默认归当前 Bot 或群聊，全局记忆供所有对话使用。",
    "ja": "記憶は全体、特定の Bot、特定のグループで共有できます。チャットからの保存先は現在の Bot またはグループで、全体の記憶はすべての会話で利用できます。"
  },
  "Filter memories by scope": {
    "zh": "按范围筛选记忆",
    "ja": "範囲で記憶を絞り込む"
  },
  "All scopes": {
    "zh": "全部范围",
    "ja": "すべての範囲"
  },
  "No memories in this scope.": {
    "zh": "这个范围还没有记忆。",
    "ja": "この範囲にはまだ記憶がありません。"
  },
  "New memory scope": {
    "zh": "新记忆的范围",
    "ja": "新しい記憶の範囲"
  },
  "Memory scope": {
    "zh": "记忆范围",
    "ja": "記憶の範囲"
  },
  "Self-learning (RSL)": {
    "zh": "自学习（RSL）",
    "ja": "自己学習（RSL）"
  },
  "Reviews complex tasks and corrections while idle. Text proposals only: engines, code, persona and user memory stay unchanged. Candidates require review. Disabled means no learning calls.": {
    "zh": "空闲时分析复杂任务与纠正，只生成文字建议。不会修改引擎、代码、人设或用户记忆。候选需审核；未启用时不产生学习调用。",
    "ja": "アイドル時に複雑なタスクや修正を分析し、文章で改善案を作成します。エンジン、コード、人格、ユーザーの記憶は変更しません。候補には審査が必要です。無効時は学習の呼び出しを行いません。"
  },
  "Reload": {
    "zh": "重新加载",
    "ja": "再読み込み"
  },
  "Enable background learning": {
    "zh": "启用后台学习",
    "ja": "バックグラウンド学習を有効にする"
  },
  "Reuse approved lessons": {
    "zh": "复用已审核经验",
    "ja": "承認済みの教訓を再利用"
  },
  "Only relevant tasks for the same Bot and engine. Disabling cannot erase native session context; start a new conversation for a clean baseline.": {
    "zh": "仅同 Bot、同引擎的相关任务使用。停用不清除原生会话已看到的内容，恢复干净基线请新建对话。",
    "ja": "同じ Bot・エンジンの関連タスクにのみ適用します。無効にしても既存セッションの文脈は消えません。影響のない状態で始めるには新しい会話を作成してください。"
  },
  "Daily call limit (UTC)": {
    "zh": "每日调用上限（UTC）",
    "ja": "1 日の呼び出し上限（UTC）"
  },
  "Daily call limit": {
    "zh": "每日调用上限",
    "ja": "1 日の呼び出し上限"
  },
  "Today": {
    "zh": "本日",
    "ja": "本日"
  },
  "Unknown usage": {
    "zh": "用量未知",
    "ja": "不明な使用量"
  },
  "Queued": {
    "zh": "排队",
    "ja": "待機中"
  },
  "Reviewing": {
    "zh": "分析中",
    "ja": "分析中"
  },
  "Idle": {
    "zh": "空闲",
    "ja": "アイドル"
  },
  "Uses the task model: about 6000 input characters and 500 output tokens per call. Daily calls are capped; reported tokens may be incomplete and are not a bill. Queues do not survive restarts.": {
    "zh": "额外调用使用原任务模型，最多约 6000 字符输入、500 tokens 输出；每日次数是硬限制，token 为已报告部分，不是账单。队列不跨重启恢复。",
    "ja": "タスクのモデルを使用します。1 回あたり入力は約 6,000 文字、出力は最大 500 トークンです。1 日の呼び出し数に上限があります。報告されたトークン数は不完全な場合があり、請求額ではありません。待機列は再起動後に復元されません。"
  },
  "No candidates. Eligible new tasks are reviewed while idle once enabled.": {
    "zh": "暂无候选经验。开启后，符合条件的新任务会在空闲时分析。",
    "ja": "候補はまだありません。有効にすると、対象となる新しいタスクをアイドル時に分析します。"
  },
  "Approve": {
    "zh": "批准",
    "ja": "承認"
  },
  "Reject / Disable": {
    "zh": "拒绝 / 停用",
    "ja": "却下 / 無効化"
  },
  "Delete": {
    "zh": "删除",
    "ja": "削除"
  },
  "Model options": {
    "zh": "模型参数",
    "ja": "モデルのパラメーター"
  },
  "Use your provider's documented limits. Blank fields retain compatible defaults. These options configure Pi.": {
    "zh": "按服务商文档填写。留空使用兼容默认值；只影响 Pi 的模型注册。",
    "ja": "プロバイダーの仕様に従って入力してください。空欄は互換性のある既定値を使用します。Pi のモデル登録に適用されます。"
  },
  "Model": {
    "zh": "配置的模型",
    "ja": "モデル"
  },
  " (removed from model list)": {
    "zh": "（已移出模型列表）",
    "ja": "（モデル一覧から削除済み）"
  },
  "Context window (tokens)": {
    "zh": "上下文窗口（token）",
    "ja": "コンテキストウィンドウ（トークン）"
  },
  "Maximum output (tokens)": {
    "zh": "最大输出（token）",
    "ja": "最大出力（トークン）"
  },
  "Image input": {
    "zh": "图片输入",
    "ja": "画像入力"
  },
  "Default (supported)": {
    "zh": "默认（支持）",
    "ja": "既定（対応）"
  },
  "Supported": {
    "zh": "支持",
    "ja": "対応"
  },
  "Text only": {
    "zh": "仅文本",
    "ja": "テキストのみ"
  },
  "Reasoning": {
    "zh": "推理能力",
    "ja": "推論"
  },
  "Use existing defaults": {
    "zh": "沿用默认识别",
    "ja": "既存の設定を使用"
  },
  "Not supported": {
    "zh": "不支持",
    "ja": "非対応"
  },
  "Reset this model's options": {
    "zh": "恢复此模型默认参数",
    "ja": "このモデルのパラメーターをリセット"
  },
  "Find documents by path or keyword": {
    "zh": "按路径或关键词找文档",
    "ja": "パスやキーワードで文書を検索"
  },
  "Search limit reached; narrow the query": {
    "zh": "结果已达到扫描上限，请缩小搜索范围",
    "ja": "検索上限に達しました。条件を絞り込んでください"
  },
  "Reference chat": {
    "zh": "引用对话",
    "ja": "会話を参照"
  },
  "No saved chats to reference": {
    "zh": "暂无可引用的已保存对话",
    "ja": "参照できる保存済み会話はありません"
  },
  "Applies before the next model call; does not stop current output": {
    "zh": "在下一次模型调用前接收补充，不会立即停止当前输出",
    "ja": "次のモデル呼び出し前に適用します。現在の出力は停止しません"
  },
  "Artifact scope": {
    "zh": "产物范围",
    "ja": "成果物の範囲"
  },
  "This chat": {
    "zh": "当前对话",
    "ja": "この会話"
  },
  "All chats": {
    "zh": "全部对话",
    "ja": "すべての会話"
  },
  "Find artifacts": {
    "zh": "查找产物",
    "ja": "成果物を検索"
  },
  "Refresh artifacts": {
    "zh": "刷新产物",
    "ja": "成果物を更新"
  },
  "Finding artifacts…": {
    "zh": "正在查找产物…",
    "ja": "成果物を検索中…"
  },
  "Could not load artifacts. Try again.": {
    "zh": "产物读取失败，请重试。",
    "ja": "成果物を読み込めませんでした。再試行してください。"
  },
  "Retry": {
    "zh": "重试",
    "ja": "再試行"
  },
  "History scan limit reached; results may be incomplete. Open the source chat to inspect its artifacts.": {
    "zh": "已达到历史扫描上限，结果可能不完整。可打开原对话查看产物。",
    "ja": "履歴の検索上限に達したため、結果が不完全な場合があります。元の会話で成果物を確認できます。"
  },
  "Some chats could not be read; results may be incomplete.": {
    "zh": "部分对话无法读取，结果可能不完整。",
    "ja": "一部の会話を読み込めなかったため、結果が不完全な場合があります。"
  },
  "No matching artifacts": {
    "zh": "没有找到匹配的产物",
    "ja": "一致する成果物はありません"
  },
  "File unavailable": {
    "zh": "文件已不可用",
    "ja": "ファイルを利用できません"
  },
  "Loading…": {
    "zh": "加载中…",
    "ja": "読み込み中…"
  },
  "Load more": {
    "zh": "加载更多",
    "ja": "さらに読み込む"
  },
  "No matching artifacts in this chat": {
    "zh": "当前对话没有匹配的产物",
    "ja": "この会話に一致する成果物はありません"
  },
  "View source": {
    "zh": "查看来源",
    "ja": "参照元を見る"
  },
  "Source": {
    "zh": "来源",
    "ja": "参照元"
  },
  "File previews show current contents": {
    "zh": "文件预览显示当前内容",
    "ja": "ファイルのプレビューは現在の内容を表示します"
  },
  "Submit to conversation": {
    "zh": "提交到对话",
    "ja": "会話に送信"
  },
  "Submission recorded; check the conversation or queue": {
    "zh": "已记录提交，请核对对话或队列",
    "ja": "送信を記録しました。会話または待機列を確認してください"
  },
  "Retry enqueue": {
    "zh": "重试加入队列",
    "ja": "待機列への追加を再試行"
  },
  "New submission": {
    "zh": "新建一次提交",
    "ja": "新しく送信"
  },
  "Save as document": {
    "zh": "另存为文档",
    "ja": "文書として保存"
  },
  "Edit document": {
    "zh": "编辑文档",
    "ja": "文書を編集"
  },
  "Attach to composer": {
    "zh": "引用到输入框",
    "ja": "入力欄に添付"
  },
  "Document filename": {
    "zh": "文档文件名",
    "ja": "文書のファイル名"
  },
  "Save location": {
    "zh": "保存位置",
    "ja": "保存先"
  },
  "Agent workspace": {
    "zh": "当前成员工作区",
    "ja": "現在のメンバーのワークスペース"
  },
  "Shared workspace": {
    "zh": "共享工作区",
    "ja": "共有ワークスペース"
  },
  "Save copy": {
    "zh": "保存副本",
    "ja": "コピーを保存"
  },
  "Linked conversation": {
    "zh": "已关联来源对话",
    "ja": "元の会話に関連付け済み"
  },
  "Document content": {
    "zh": "文档内容",
    "ja": "文書の内容"
  },
  "Preview (keep draft)": {
    "zh": "返回预览（保留草稿）",
    "ja": "プレビューに戻る（下書きを保持）"
  },
  "Discard draft and load latest": {
    "zh": "放弃草稿，加载最新文件",
    "ja": "下書きを破棄して最新版を読み込む"
  },
  "Working…": {
    "zh": "处理中…",
    "ja": "処理中…"
  },
  "Add agent": {
    "zh": "添加 Agent",
    "ja": "Agent を追加"
  },
  "Add an agent to the chat": {
    "zh": "添加 Agent 到聊天",
    "ja": "チャットに Agent を追加"
  },
  "Chat members": {
    "zh": "聊天成员",
    "ja": "チャットのメンバー"
  },
  "Select one or more": {
    "zh": "选择一位或多位",
    "ja": "1 人以上選択"
  },
  "Joined": {
    "zh": "已加入",
    "ja": "参加済み"
  },
  "Add to chat ({count})": {
    "zh": "加入聊天（{count}）",
    "ja": "チャットに追加（{count}）"
  },
  "Select agents to add": {
    "zh": "选择要加入的 Agent",
    "ja": "追加する Agent を選択"
  },
  "Members": {
    "zh": "成员",
    "ja": "メンバー"
  },
  "Members: {count}": {
    "zh": "{count} 位成员",
    "ja": "メンバー {count} 人"
  },
  "Me": {
    "zh": "我",
    "ja": "自分"
  },
  "You": {
    "zh": "你",
    "ja": "あなた"
  },
  "In the group": {
    "zh": "在群里",
    "ja": "参加中"
  },
  "Removed": {
    "zh": "已移出",
    "ja": "退出済み"
  },
  "Select members to start a conversation.": {
    "zh": "选择成员，开始对话。",
    "ja": "メンバーを選んで会話を始めましょう。"
  },
  "Assistant": {
    "zh": "助手",
    "ja": "アシスタント"
  },
  "Planner": {
    "zh": "规划",
    "ja": "計画"
  },
  "Builder": {
    "zh": "实施",
    "ja": "実装"
  },
  "General assistant": {
    "zh": "通用助手",
    "ja": "汎用アシスタント"
  },
  "Thinking…": {
    "zh": "正在思考…",
    "ja": "考え中…"
  },
  "Group coordination": {
    "zh": "群聊编排",
    "ja": "グループの調整"
  },
  "Message the group… (type @ to select members)": {
    "zh": "发到群里…（输入 @ 选择成员）",
    "ja": "グループにメッセージ…（@ でメンバーを選択）"
  },
  "Hi, I’m {name}": {
    "zh": "你好，我是 {name}",
    "ja": "こんにちは、{name} です"
  },
  "Could not reconnect after 5 attempts. The host task may still be running. Once connected, select this conversation again from the sidebar.": {
    "zh": "连续 5 次无法连接主机，已停止本地重连；未确认主机任务已停止。恢复连接后请从侧栏重新选择此会话。",
    "ja": "5 回試行しましたが再接続できませんでした。ホストのタスクはまだ実行中の可能性があります。接続が回復したら、サイドバーからこの会話を選び直してください。"
  },
  "At most 10 attachments": {
    "zh": "最多 10 个附件",
    "ja": "添付は最大 10 件です"
  },
  "Bot configuration has not loaded. Please retry shortly.": {
    "zh": "Bot 配置尚未加载，请稍后重试。",
    "ja": "Bot の設定を読み込んでいません。しばらくしてから再試行してください。"
  },
  "Show all {count} runs": {
    "zh": "查看全部 {count} 次",
    "ja": "全 {count} 件を表示"
  },
  "Input tokens": {
    "zh": "输入 token",
    "ja": "入力トークン"
  },
  "Output tokens": {
    "zh": "输出 token",
    "ja": "出力トークン"
  },
  "Review started": {
    "zh": "已开始分析",
    "ja": "分析を開始しました"
  },
  "Candidate awaiting review": {
    "zh": "候选经验待审核",
    "ja": "候補の審査待ち"
  },
  "No new supported lesson": {
    "zh": "暂无有依据的新经验",
    "ja": "根拠のある新しい教訓はありません"
  },
  "Review stopped or failed; usage may be incomplete": {
    "zh": "分析已停止或失败，用量可能不完整",
    "ja": "分析が停止または失敗しました。使用量が不完全な場合があります"
  },
  "Pending": {
    "zh": "待开始",
    "ja": "未着手"
  },
  "Running": {
    "zh": "进行中",
    "ja": "実行中"
  },
  "Completed": {
    "zh": "已完成",
    "ja": "完了"
  },
  "Cancelled": {
    "zh": "已取消",
    "ja": "キャンセル済み"
  },
  "Failed": {
    "zh": "失败",
    "ja": "失敗"
  },
  "Needs review": {
    "zh": "待核对",
    "ja": "要確認"
  },
  "Awaiting review": {
    "zh": "待审核",
    "ja": "審査待ち"
  },
  "Approved": {
    "zh": "已批准",
    "ja": "承認済み"
  },
  "Rejected": {
    "zh": "已拒绝",
    "ja": "却下済み"
  },
  "Failed or stopped; review the result first": {
    "zh": "失败或已停止，请先核对结果",
    "ja": "失敗または停止しました。先に結果を確認してください"
  },
  "Round": {
    "zh": "圆形",
    "ja": "丸形"
  },
  "Oval": {
    "zh": "椭圆",
    "ja": "楕円形"
  },
  "Soft square": {
    "zh": "圆角方形",
    "ja": "角丸四角形"
  },
  "None": {
    "zh": "无",
    "ja": "なし"
  },
  "Quiff": {
    "zh": "飞机头",
    "ja": "クイッフ"
  },
  "Bob": {
    "zh": "波波头",
    "ja": "ボブ"
  },
  "Pixie": {
    "zh": "侧分短发",
    "ja": "ピクシー"
  },
  "Buns": {
    "zh": "双丸子",
    "ja": "ツインお団子"
  },
  "Long": {
    "zh": "侧分长发",
    "ja": "ロング"
  },
  "Clip": {
    "zh": "发夹",
    "ja": "ヘアピン"
  },
  "Bow": {
    "zh": "蝴蝶结",
    "ja": "リボン"
  },
  "Star": {
    "zh": "星星",
    "ja": "星"
  },
  "Glasses": {
    "zh": "圆眼镜",
    "ja": "丸眼鏡"
  },
  "Headphones": {
    "zh": "头戴耳机",
    "ja": "ヘッドホン"
  },
  "Headset": {
    "zh": "耳麦",
    "ja": "ヘッドセット"
  },
  "Cap": {
    "zh": "棒球帽",
    "ja": "キャップ"
  },
  "Beanie": {
    "zh": "针织帽",
    "ja": "ニット帽"
  },
  "Raytone navy": {
    "zh": "Raytone 深蓝",
    "ja": "Raytone ネイビー"
  },
  "Claude orange": {
    "zh": "Claude 橙",
    "ja": "Claude オレンジ"
  },
  "Slate": {
    "zh": "灰蓝",
    "ja": "スレート"
  },
  "Taupe": {
    "zh": "暖棕",
    "ja": "トープ"
  },
  "Ivory": {
    "zh": "米白",
    "ja": "アイボリー"
  },
  "Invalid form schema": {
    "zh": "表单结构无效",
    "ja": "フォームの構造が無効です"
  },
  "Invalid form field": {
    "zh": "表单字段无效",
    "ja": "フォームの項目が無効です"
  },
  "Invalid numeric bounds": {
    "zh": "数字范围无效",
    "ja": "数値の範囲が無効です"
  },
  "Invalid options": {
    "zh": "选项无效",
    "ja": "選択肢が無効です"
  },
  "Unknown field": {
    "zh": "未知字段",
    "ja": "不明な項目です"
  },
  "{field}: required": {
    "zh": "{field}：必填",
    "ja": "{field}：必須です"
  },
  "{field}: invalid value": {
    "zh": "{field}：值无效",
    "ja": "{field}：値が無効です"
  },
  "Activity avatar preview": {
    "zh": "工作头像预览",
    "ja": "作業中アバターのプレビュー"
  },
  "Finished / Stopped": {
    "zh": "结束 / 停止",
    "ja": "終了 / 停止"
  },
  "Research": {
    "zh": "研究",
    "ja": "調査"
  },
  "Planning": {
    "zh": "规划",
    "ja": "計画"
  },
  "Building": {
    "zh": "实现",
    "ja": "実装"
  },
  "These editable templates use English instructions; replies follow your request’s language or the interface setting.": {
    "zh": "可编辑模板使用英文指令；回复会跟随你的请求语言或界面设定语言。",
    "ja": "編集可能なひな形は英語の指示を使用します。返信はリクエストの言語または画面の言語設定に従います。"
  },
  "Assign only to {name}": {
    "zh": "只交给 {name}",
    "ja": "{name} のみに依頼"
  },
  "Assignments": {
    "zh": "分工",
    "ja": "役割分担"
  },
  "Start": {
    "zh": "开始",
    "ja": "開始"
  },
  "Workspace reads, writes and commands are authorized for this turn.": {
    "zh": "本轮工作区内的读写与命令不再逐个询问",
    "ja": "このターンのワークスペース内の読み書きとコマンドを許可します"
  },
  "Only this member will handle the request.": {
    "zh": "仅由这位成员完成本轮请求",
    "ja": "このメンバーのみがリクエストを処理します"
  },
  "Not now": {
    "zh": "先不做",
    "ja": "今は実行しない"
  },
  "Do not execute this request.": {
    "zh": "这条消息不执行",
    "ja": "このリクエストは実行しません"
  },
  "Message receipt is unconfirmed. It was not resent automatically. Check the task before retrying.": {
    "zh": "无法确认这条消息已被主机接收；未自动重发，请检查任务后重试。",
    "ja": "ホストがメッセージを受信したか確認できません。自動再送は行っていません。タスクを確認してから再試行してください。"
  },
  "Pi connection timed out.": {
    "zh": "连接主机超时。",
    "ja": "ホストへの接続がタイムアウトしました。"
  },
  "Pi event stream timed out.": {
    "zh": "等待主机事件超时。",
    "ja": "ホストのイベント待機がタイムアウトしました。"
  },
  "Pi stream ended before a terminal event arrived.": {
    "zh": "连接已结束，尚未确认任务完成。",
    "ja": "接続が終了しました。タスクの完了は未確認です。"
  },
  "Pi runtime failed.": {
    "zh": "主机运行失败。",
    "ja": "ホストの実行に失敗しました。"
  },
  "Please wait for the current reply to finish before changing members.": {
    "zh": "请等当前回复结束后再调整成员。",
    "ja": "現在の返信が終了してからメンバーを変更してください。"
  },
  "Delivered version": {
    "zh": "交付版本",
    "ja": "納品時のバージョン"
  },
  "Current workspace file": {
    "zh": "当前工作区文件",
    "ja": "現在のワークスペースファイル"
  },
  "Read-only saved version": {
    "zh": "只读交付版本",
    "ja": "読み取り専用の保存バージョン"
  },
  "Loading saved versions…": {
    "zh": "正在加载交付版本…",
    "ja": "保存済みバージョンを読み込み中…"
  },
  "Could not load saved versions. Retry to view this delivery.": {
    "zh": "无法加载交付版本。请重试以查看这次交付。",
    "ja": "保存済みバージョンを読み込めません。この納品を表示するには再試行してください。"
  },
  "Saved version context is unavailable. Open the source conversation to view it.": {
    "zh": "交付版本缺少来源会话上下文。请打开来源对话查看。",
    "ja": "保存済みバージョンの元会話がありません。元の会話を開いて表示してください。"
  },
  "Saved version is unavailable. Retry to view this delivery.": {
    "zh": "交付版本不可用。请重试以查看这次交付。",
    "ja": "保存済みバージョンを利用できません。この納品を表示するには再試行してください。"
  },
  "File previews show captured delivery contents when selected; current workspace files remain live.": {
    "zh": "选中交付版本时预览保存的内容；当前工作区文件仍会显示最新内容。",
    "ja": "納品バージョンを選ぶと保存時の内容を表示し、現在のワークスペースファイルは最新内容を表示します。"
  }
} satisfies Record<string, Record<Exclude<AppLocale, "en">, string>>;

export function featureText(locale: AppLocale, message: keyof typeof featureCopy, values: Record<string, string | number> = {}): string {
  const text = locale === "en" ? message : featureCopy[message][locale];
  return text.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

/** Only the automatic roster title is localized; user-written conversation names stay intact. */
export function groupRosterTitle(names: readonly string[], locale: AppLocale): string {
  return [featureText(locale, "Me"), ...names].join(locale === "en" ? ", " : "、");
}
export function isGroupRosterTitle(title: string, names: readonly string[]): boolean {
  return (["zh", "en", "ja"] as const).some(locale => title === groupRosterTitle(names, locale));
}

/** Localize known application errors; retain unknown service diagnostics verbatim. */
export function featureError(locale: AppLocale, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const key = Object.hasOwn(featureCopy, message) ? message : Object.entries(featureCopy).find(([, text]) => text.zh === message)?.[0];
  return key ? featureText(locale, key as keyof typeof featureCopy) : message;
}
