set -eu
trial_dir=/home/user/lcu-trial
mkdir -p "$trial_dir"
cd "$trial_dir"
curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 300 -o chatgpt_amd64.deb https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb
sha256sum chatgpt_amd64.deb
dpkg-deb --field chatgpt_amd64.deb Package Version Architecture Depends
mkdir -p app-root
dpkg-deb --extract chatgpt_amd64.deb app-root
app_path="$trial_dir/app-root/usr/lib/chatgpt"
"$app_path/resources/cua_node/bin/node" --version
cd lcu-0.13.0-linux-x64
./scripts/install.sh --runtime-only --skip-system --prefix "$trial_dir/installed" --existing-app "$app_path"
