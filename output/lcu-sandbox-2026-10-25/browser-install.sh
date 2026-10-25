set -eu
trial_dir=/home/user/lcu-trial
node_root="$trial_dir/app-root/usr/lib/chatgpt/resources/cua_node"
PLAYWRIGHT_BROWSERS_PATH="$trial_dir/pw-browsers" "$node_root/bin/node" "$node_root/lib/node_modules/playwright/cli.js" install chromium > "$trial_dir/playwright-install.log" 2>&1 || { tail -n 30 "$trial_dir/playwright-install.log"; exit 1; }
tail -n 8 "$trial_dir/playwright-install.log"
python3 "$trial_dir/extension-prepare.py"
LCU_NO_UPDATE_CHECK=1 "$trial_dir/installed/current/bin/lcu" setup --agent codex --chrome --yes --session direct
