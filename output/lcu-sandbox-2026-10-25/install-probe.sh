set -eu
trial_dir=/home/user/lcu-trial
mkdir -p "$trial_dir"
cd "$trial_dir"
archive=lcu-0.13.0-linux-x64.tar.gz
curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 180 -o "$archive" "https://github.com/amontlabs/lcu/releases/download/v0.13.0/$archive"
curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 30 -o "$archive.sha256" "https://github.com/amontlabs/lcu/releases/download/v0.13.0/$archive.sha256"
sha256sum -c "$archive.sha256"
tar -xzf "$archive"
cd lcu-0.13.0-linux-x64
./scripts/install.sh --runtime-only --skip-system --prefix /home/user/lcu-trial/installed
