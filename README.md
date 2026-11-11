# herdr-layout

我自己用的 [Herdr](https://herdr.dev) 介面：一個 layout（`my-main`）加七個 mod，以 Herdr 內建的 main layout 為基礎改的。在另一台裝好 Herdr 的電腦上跑一次 `./install.sh`，就會變成一樣的樣子。

*A personal Herdr layout (`my-main`) and six mods built from Herdr's shipped ones. Clone and run `./install.sh` on any Mac with Herdr.*

## 跟內建 main layout 不一樣的地方

**上方分頁列（`my-tabs`）**
- macOS 的視窗按鈕放在分頁列上，不壓在側邊欄上面。
- 分頁標題用 agent 自己取的名字，例如 Claude Code 的 session 名稱。
- 分頁照緊急程度排序：需要你的排最左邊。
- 重新命名分頁（右鍵 Rename 或雙擊分頁）時，會請 Claude Haiku 依那個分頁的 agent 最近在做的事建議一個名字，約 3～4 秒後自動填進輸入框（你還沒打字的話）；不想用可以點「Keep "原本的名字"」。按 Save 後名字就固定，不會再跟著 terminal 標題變。
- 分頁右鍵的 Close 會先跳確認視窗（`my-menu`，複製自 Herdr 的 `menu`，只改了這點）。確認視窗是 `my-confirm`（複製自 `confirm`），關閉類的 Confirm 按鈕是紅色的。
- 工作中的分頁，圖示會跟側邊欄一樣慢慢閃爍（2 秒一次）；做完但還沒看的分頁保持全亮，看過的會稍微變淡。
- 寬度不夠時，Files / Changes 只顯示圖示，多出來的分頁收進「+N」。
- Files / Changes 面板**每個分頁（session）各自記住**開或關；切換分頁時面板會用約 0.24 秒的動畫滑開或收合。寬度所有分頁共用。也可以用 `herdr-app do my-tabs.files`／`.changes`／`.close` 開關面板。

**左側欄（`my-chrome`、`my-spaces`、`my-agents`）**
- 可以收合成像 Chrome 那樣只有圖示的窄欄（40px），展開或收合時寬度會平滑變化。拖曳邊緣也能變窄。
- Spaces：每個 space 有固定顏色的字母頭像；worktree 排在原本的 checkout 底下，只在不尋常時才顯示分支和 ahead/behind。
- Agents 列表：
  - 可以依 space 分組或依優先順序排。
  - 子 agent 會以樹狀顯示在 parent 底下，可以收合。
  - 收合成窄欄時，用圖示動畫表示狀態：卡住會跳、工作中慢慢閃、閒置稍微變淡。
  - 滑鼠停在某列上會顯示 Recap 小卡，最上面是 session 標題，下面是 Claude Code / Grok 的「while you were away」摘要。沒有 recap（或已經看過）時，改顯示最後一則回應的開頭，最多 5 行（Claude Code、Grok、opencode 都有）。收合成窄欄時，什麼都沒有也會顯示標題。
  - 閒置超過 6 小時的 session 移到列表最底部的「Archived」區。右鍵一列可以手動 Archive / Unarchive、釘選，或 Close（關掉它的 pane，跟 tab 的 Close 一樣；只剩它一個時整個 tab 會關掉），Close 會先跳確認視窗。手動的選擇維持到那個 agent 狀態下次改變為止；釘選的不會被封存。Archived 只顯示最新的 3 個，上方的「N more」按鈕會把較舊的往上展開。
  - Claude Code 的圖示會照狀態換成 Clawd 的小動畫：working 頭上冒思考泡泡、需要你時一臉困惑、done（做完還沒看）開心地跳；idle 維持原本的圖示。換狀態時舊的先淡出、新的再淡入（各約 0.14 秒）。Herdr 不在前景時不播 GIF，這時改用拆開的 PNG 格（`clawd-<狀態>/`）依時間換格，每 0.12 秒重畫一次，只在畫面上有 Clawd 時才跑。GIF 取自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank)、[clawd-pet](https://github.com/abderrahimghazali/clawd-pet)、[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)（出處見 `mods/my-agents/clawd.LICENSE`），裁成 36px，每個不到 10 KB。
  - Claude Code 停下來但還有 shell 開著時，由 decision model 判斷：還在等 shell 就繼續顯示 working，在等你回答就等同 blocked，做完或判斷不出來就維持原本的狀態。側邊欄、上方 tab、space、pane header 和狀態列都看同一份結果。
  - 釘選的 session 隔成最上面一塊（底下一條分隔線，中間有一個斜放的實心小圖釘，線和圖釘同色）；「+ New tab」在一般列表的最後、Archived 之上；釘選或取消時，它會從原本的位置收起、在上面那塊展開（約 0.2 秒）。
- **Agent 完成或需要你時改成 macOS 系統通知**，並收掉 Herdr 視窗內右下角的提示。
- 底部按鈕依序是 Commands（指令面板，展開時顯示快捷鍵）、Settings、Add machine。

**Pane 與底部狀態列（`my-pane`、`my-status`）**
- Pane 標題列比較安靜：只有資料夾和 agent 狀態，加上 split、zoom、close 按鈕，高 26px。
- 主畫面上下不留外框空白，只保留左右 4px。
- 底部狀態列顯示機器、分支和 agent 數量；右邊是 Claude 方案用量的 bar，百分比寫在 bar 裡：**Fable 本週**、**本週（全部模型）**、**5 小時**（沒有資料的不顯示）。跟 claude.ai 一樣，本週的 bar 前段用 Fable 的顏色標出 Fable 用掉的部分。滑上去會顯示重置時間和 Fable 的上限，90% 以上變紅。每 5 分鐘更新一次。
- 模型@思考程度和 ctx 剩餘 % 留在 Claude Code／Grok 自己的 status line。

**Files 面板（`my-files`）**
- 點 `.html` 檔直接用預設瀏覽器打開，不在面板裡顯示原始碼。

**提示音**
- 完成和需要你都改成 macOS 內建 Glass 音效的前 0.4 秒，聲音短而清脆。

## 需要

- macOS 上的 Herdr，而且至少開過一次，讓 `~/.config/herdr-app` 存在。
- `python3`（Recap 和安裝程式會用到）、`jq`（status line 會用到）、`git`。

## 安裝

```sh
git clone https://github.com/YiChen03175/herdr-layout.git
cd herdr-layout
./install.sh               # 全部
./install.sh --no-agents   # 不改 Claude Code / Grok 的設定
```

安裝程式會做這些事：

1. 把 `mods/my-*` 複製到 `~/.config/herdr-app/mods/`，`layouts/my-main.json` 複製到 `layouts/`。
2. 把提示音複製到 `~/.config/herdr-app/sounds/`，並在 `settings.json` 的 `sounds` 指定它們。其他設定不動。
3. Claude Code：把 `~/.claude/settings.json` 的 `statusLine` 換成 `mods/my-status/statusline.sh`（資料夾 │ 模型@思考程度 │ ctx）。原本已有 status line 的話會改成執行原本那個。
4. Grok：在 `~/.grok/config.toml` 加上 `[ui.status_line]`。如果你已經有自己的設定，安裝程式不會改它，只會告訴你要怎麼改。
5. Herdr 有在執行的話，直接切換到 `my-main`。

被取代的檔案都會先備份到 `~/.config/herdr-app-backups/<時間>/`，重複執行也安全。已經開著的 Claude Code / Grok 要重開，新的 status line 才會出現。

`zoom` 是每台螢幕各自的偏好，不會被複製。需要的話用 ⌘= / ⌘- 調整。

## 這些 mod 會執行或讀取的東西

依 Herdr 的建議，列出 mod 碰到自己資料夾以外的地方：

| mod | 做什麼 |
|---|---|
| `my-agents` | 執行 `osascript` 發 macOS 通知；執行 `herdr-app status` 確認右下角提示的數量再關掉；每 5 秒執行 `python3 recap.py`，讀取 `~/.claude/sessions/`、Claude Code 的對話紀錄，以及 `~/.grok/` 的 session，找出最新的 recap 和最後一則回應；opencode 的回應透過 `hc` 和 `opencode api` 從它在跑的 server 讀，用 terminal 標題「OC | <session 標題>」對到 session。每 4 秒執行 `python3 decide.py`：Claude Code 停下來但還有 shell 開著時，把最後一則回應和正在跑的指令（先遮蔽常見的 secret 格式）送到 OpenRouter 的 decision model，這是這個 mod 唯一連網路的地方。key 放在 `~/.config/herdr-app/secrets/openrouter-decider.key`，不在這個 repo 裡；沒有 key 時不做判斷，狀態維持 Herdr 回報的。同一次停下只問一次；每次問的內容和結果都記在 `~/.config/herdr-app/data/my-agents/decisions.log`，沒問的也會記原因，這份 log 不在這個 repo 裡。 |
| `my-spaces` | 執行 `git`（status、rev-parse）讀取分支和 worktree；執行 `hc machine ls` 列出其他機器。 |
| `my-files` | 在這台電腦上點 `.html`／`.htm` 時執行 `open <檔案>`，用預設瀏覽器打開；其他檔案和遠端 space 照舊在面板裡預覽。 |
| `my-rename` | 重新命名分頁時執行 `python3 suggest.py`：Claude Code 的話讀它 session 的標題、開頭你說的前 3 則（每則最多 600 字）、最近一次 compact 的 summary（最多 3500 字，取頭尾）和最近 8 則訊息（你說的和它回的，每則最多 700 字），請它依整個 session 的主題命名，其他程式讀 terminal 畫面最後一段，先遮蔽常見的 secret 格式，再送到 OpenRouter 的 `anthropic/claude-haiku-5.5`（reasoning effort medium）。key 放在 `~/.config/herdr-app/secrets/openrouter-rename.key`，不在這個 repo 裡；走 OpenRouter 的 BYOK（你在 OpenRouter 設的 Anthropic key，費用由 Anthropic 收）；每次請求的 terminal、建議的名字、秒數、provider、是否 BYOK 和花費記在 `~/.config/herdr-app/data/my-rename/suggest.log`。 |
| `my-status` | 每 5 分鐘執行 `python3 usage.py`：用 `claude -p --safe-mode --strict-mcp-config` 起一個不讀 CLAUDE.md、skills、plugins、hooks、MCP 的 Claude Code，向它要 `/usage` 的資料（實驗性的 `get_usage` 請求）。不呼叫模型、不耗 token，登入由 Claude Code 自己處理，這個 mod 不碰 token。結果存在 `~/.config/herdr-app/data/my-status/usage.json`。 |

## 已知限制

- 右下角提示是用編號找出來關掉的（Herdr 設定裡沒有關閉它的選項）。如果剛好同一瞬間有其他彈出視窗打開，可能會關錯。
- macOS 通知只會出現在主螢幕，也就是有選單列的那一台。
- 錯誤類的提示（例如程式啟動失敗）仍然顯示在 Herdr 視窗內。

## 移除

按 ⌘⇧L（`layout.switch`）切回 Herdr 的 main，再刪掉 `~/.config/herdr-app/mods/my-*` 和 `layouts/my-main.json`。Claude Code / Grok 的設定可以從備份資料夾還原。

## 修改後同步回 repo

在 Herdr 裡改完之後：

```sh
./export.sh    # 把本機的 mods、layout、提示音複製回 repo
git diff       # 確認後 commit
```

## 授權

Apache-2.0，見 [LICENSE](LICENSE)。這些 mod 是從 Herdr 內建的 `agents`、`files`、`workspace-chrome`、`pane`、`spaces`、`tabs`、`workspace-status` 複製後修改的，原始著作權屬於 Herdr 作者，同樣以 Apache-2.0 授權。圖示來自 [Lucide](https://lucide.dev)（ISC）。
