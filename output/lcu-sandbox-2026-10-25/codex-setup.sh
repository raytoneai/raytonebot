set -u
trial_dir=/home/user/lcu-trial
if [ -f /home/user/.codex/config.toml ]; then
  cp -p /home/user/.codex/config.toml "$trial_dir/codex-config.before.toml"
fi
LCU_NO_UPDATE_CHECK=1 "$trial_dir/installed/current/bin/lcu" setup --agent codex --yes --session direct
