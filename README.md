# herdr-layout

我自己用的 [Herdr](https://herdr.dev) 介面：一個 layout（`my-main`）加七個 mod，以 Herdr 內建的 main layout 為基礎改的。在另一台裝好 Herdr 的電腦上跑一次 `./install.sh`，就會變成一樣的樣子。

*A personal Herdr layout (`my-main`) and seven mods built from Herdr's shipped ones. Clone and run `./install.sh` on any Mac with Herdr.*

## 跟內建 main layout 不一樣的地方

**上方分頁列（`my-tabs`）**
- macOS 的視窗按鈕放在分頁列上，不壓在側邊欄上面。
- 分頁標題用 agent 自己取的名字，例如 Claude Code 的 session 名稱。
- 分頁照緊急程度排序：需要你的排最左邊。
- 工作中的分頁會有一道光由左往右掃過；做完但還沒看的分頁保持全亮，看過的會稍微變淡。
- 寬度不夠時，Files / Changes / GitLab 只顯示圖示，多出來的分頁收進「+N」。

**右側 GitLab 面板（`my-gitlab`）**
- 分頁列右上多一個 GitLab，排在 Files、Changes 左邊，打開依序是：To review（指定我 review 而且我還沒 review 的，有才出現、不能收合）、Open（我開的還沒 merge 的 MR，不含 closed）、Merged（最近 7 天 merge 的）。
- 每一列有標題、專案、`!編號`，點一下用瀏覽器打開。前面一個圖示代表狀態：紅色警告是 conflict；✗ / ● 是 pipeline 失敗 / 執行中；黃色圈圈勾是 CI 過了但還沒 approve；綠色 ✓ 是 CI 過了也 approve 了。時間在右邊，Merged 預設收起來。標題是 MR 所在的組織名稱（例如 maxnion），右上角的「↻ 3m」點了會重新整理。
- 在 Open 的 MR 上按右鍵：用瀏覽器打開，或關閉這個 MR（會先跳確認視窗，Enter 確認、Esc 取消；關掉的 MR 之後還能在 GitLab 上重新打開）。
- 有 MR 等我 review 時，GitLab 按鈕右上角會有紅色數字。
- 面板開著時每 2 分鐘更新，打開時如果資料超過 30 秒會馬上更新；收起來時每 5 分鐘更新一次，Herdr 一開就會先更新一次，讓按鈕上的數字保持正確（layout 裡一個 0 px 的 `gitlab-poll` 區塊負責）。

**左側欄（`my-chrome`、`my-spaces`、`my-agents`）**
- 可以收合成像 Chrome 那樣只有圖示的窄欄（40px），展開或收合時寬度會平滑變化。拖曳邊緣也能變窄。
- Spaces：每個 space 有固定顏色的字母頭像；worktree 排在原本的 checkout 底下，只在不尋常時才顯示分支和 ahead/behind。
- Agents 列表：
  - 可以依 space 分組或依優先順序排，也可以釘選。
  - 子 agent 會以樹狀顯示在 parent 底下，可以收合。
  - 收合成窄欄時，用圖示動畫表示狀態：卡住會跳、工作中慢慢閃、閒置稍微變淡。
  - 滑鼠停在某列上會顯示 Recap 小卡，內容是 Claude Code / Grok 的「while you were away」摘要。
- **Agent 完成或需要你時改成 macOS 系統通知**，並收掉 Herdr 視窗內右下角的提示。通知三行依序是狀態（Ready／Needs you）、agent 所在的 repo（不在 repo 裡就是資料夾名稱）、session 名稱，旁邊附上 agent 的圖示（Claude Code、Grok…）。點通知會切回 Herdr 並跳到那個 agent（需要 `terminal-notifier`；沒裝的話改用 `osascript`，點了會打開「指令碼編寫程式」）。
- 底部按鈕依序是 Commands（指令面板，展開時顯示快捷鍵）、Settings、Add machine。

**Pane 與底部狀態列（`my-pane`、`my-status`）**
- Pane 標題列比較安靜：只有資料夾和 agent 狀態，加上 split、zoom、close 按鈕，高 26px。
- 主畫面上下不留外框空白，只保留左右 4px。
- 底部狀態列顯示機器、分支和 agent 數量。焦點在 Claude Code 或 Grok 時，右邊會顯示 **模型@思考程度** 和 **ctx 剩餘 %**；agent 自己的 status line 在 Herdr 裡會自動隱藏。

**提示音**
- 完成和需要你都改成 macOS 內建 Glass 音效的前 0.4 秒，聲音短而清脆。

## 需要

- macOS 上的 Herdr，而且至少開過一次，讓 `~/.config/herdr-app` 存在。
- `python3`（Recap 和安裝程式會用到）、`jq`（status line 交接會用到）、`git`。
- 點通知跳回 agent 要 `terminal-notifier`（`brew install terminal-notifier`），第一次要在「系統設定 → 通知」允許它。
- GitLab 面板要 [`glab`](https://gitlab.com/gitlab-org/cli) 並登入過（`brew install glab && glab auth login`）。

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
3. Claude Code：把 `~/.claude/settings.json` 的 `statusLine` 換成 `mods/my-status/statusline.sh`。原本已有 status line 的話會包在裡面，在 Herdr 外照常顯示。
4. Grok：在 `~/.grok/config.toml` 加上 `[ui.status_line]`。如果你已經有自己的設定，安裝程式不會改它，只會告訴你要怎麼改。
5. Herdr 有在執行的話，直接切換到 `my-main`。

被取代的檔案都會先備份到 `~/.config/herdr-app-backups/<時間>/`，重複執行也安全。已經開著的 Claude Code / Grok 要重開，底部的模型和 ctx 才會出現。

`zoom` 是每台螢幕各自的偏好，不會被複製。需要的話用 ⌘= / ⌘- 調整。

## 這些 mod 會執行或讀取的東西

依 Herdr 的建議，列出 mod 碰到自己資料夾以外的地方：

| mod | 做什麼 |
|---|---|
| `my-agents` | 執行 `terminal-notifier` 發 macOS 通知（沒裝時用 `osascript`），點通知時執行 `herdr-app do agent.focus` 跳到那個 agent；執行 `herdr-app status` 確認右下角提示的數量再關掉；每 5 秒執行 `python3 recap.py`，讀取 `~/.claude/sessions/`、Claude Code 的對話紀錄，以及 `~/.grok/` 的 session，找出最新的 recap。不連網路。 |
| `my-gitlab` | 執行 `glab api graphql` 讀取自己的 MR（開著的、7 天內 merge 的、要我 review 的）；確認視窗按下 Close 時，用 `mergeRequestUpdate` 把那個 MR 設成 closed；點擊時執行 `open <網址>`。 |
| `my-spaces` | 執行 `git`（status、rev-parse）讀取分支和 worktree；執行 `hc machine ls` 列出其他機器。 |
| `my-status` | 讀取 `~/.config/herdr-app/data/my-status/agents/<終端機>.json`，由 `statusline.sh` 寫入。 |

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

Apache-2.0，見 [LICENSE](LICENSE)。這些 mod 是從 Herdr 內建的 `agents`、`workspace-chrome`、`pane`、`spaces`、`tabs`、`workspace-status` 複製後修改的，原始著作權屬於 Herdr 作者，同樣以 Apache-2.0 授權。圖示來自 [Lucide](https://lucide.dev)（ISC）。
