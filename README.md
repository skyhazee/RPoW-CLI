# RPoW CLI Miner

CLI miner sederhana untuk RPOW2. Versi ini sudah dibuat lebih enak dipakai:

- Mode interaktif: cukup jalankan `node rpow-cli.js`
- Login pakai magic link
- Native C miner untuk performa lebih cepat
- Live dashboard saat mining
- Mode nonstop sampai dihentikan sendiri dengan `Ctrl+C`

Default API:

```text
https://api.rpow2.com
```

## Penting

File `.rpow-cli-state.json` berisi cookie/session login kamu. Jangan upload, jangan share, jangan kirim ke orang lain.

File itu sudah masuk `.gitignore`.

## Install Dari Nol di Ubuntu WSL

Masuk Ubuntu WSL, lalu jalankan:

```bash
sudo apt update
sudo apt install -y git build-essential nodejs npm
```

Clone repo:

```bash
cd ~
git clone https://github.com/skyhazee/RPoW-CLI.git
cd RPoW-CLI
```

Build native miner:

```bash
chmod +x build-native.sh
./build-native.sh
```

Cek target API:

```bash
node rpow-cli.js map
```

Pastikan muncul:

```text
API origin: https://api.rpow2.com
```

Jalankan mode interaktif:

```bash
node rpow-cli.js
```

Ikuti prompt:

```text
Email login:
Paste magic link:
Start mining now [Y/n]:
Engine [native]:
Workers (max ... auto-detected) [8]:
How many tokens to mint (0 = until stopped) [0]:
```

Tips isi prompt:

- `Engine [native]`: tekan Enter saja
- `Workers`: untuk laptop mulai dari `4` atau `6`
- `How many tokens`: isi `1` untuk test, isi `0` untuk mining terus sampai `Ctrl+C`

## Install Dari Nol di VPS Ubuntu

SSH ke VPS:

```bash
ssh root@IP_VPS_KAMU
```

Install dependency:

```bash
apt update
apt install -y git build-essential nodejs npm
```

Clone repo:

```bash
cd ~
git clone https://github.com/skyhazee/RPoW-CLI.git
cd RPoW-CLI
```

Build miner:

```bash
chmod +x build-native.sh
./build-native.sh
```

Login dan mining:

```bash
node rpow-cli.js
```

Kalau VPS kamu kecil, jangan pakai worker terlalu tinggi. Contoh aman:

```text
Workers: 2
```

Untuk VPS 4 vCPU:

```text
Workers: 3
```

Untuk VPS 8 vCPU:

```text
Workers: 6
```

## Command Cepat

Cek akun:

```bash
node rpow-cli.js me
```

Mining 1 token:

```bash
node rpow-cli.js mine --count 1 --workers 4 --engine native
```

Mining terus sampai distop:

```bash
node rpow-cli.js mine --count 0 --workers 6 --engine native
```

Mining auto-restart kalau error/putus:

```bash
chmod +x run-forever.sh
./run-forever.sh
```

Stop mining:

```text
Ctrl+C
```

Matikan dashboard, pakai log biasa:

```bash
node rpow-cli.js mine --count 0 --workers 6 --engine native --no-dashboard
```

Cek public ledger:

```bash
node rpow-cli.js ledger
```

Logout:

```bash
node rpow-cli.js logout
```

## Live Dashboard

Saat mining, tampilan terminal akan berubah menjadi dashboard:

```text
+-- MINE --------------------------------------------------------------+
|   CURRENT DIFFICULTY: 25 trailing zero bits                         |
|   TARGET            : 25 trailing zero bits                         |
|   WORKER            : 6/12 (MAX WORKER AUTO DETECT)                 |
|   CURRENT REWARD    : 0.001 RPOW per solution                       |
|   NEXT HALVING AT   : 10000000 RPOW total minted                    |
|   TO NEXT HALVING   : 146374.819791224 RPOW                         |
|   NEXT REWARD       : 0.0005 RPOW                                   |
|   HASHES (current)  : 12345678                                      |
|   RATE              : 15.20 MH/s                                    |
|   ELAPSED           : 00:00:12                                      |
|   STATUS            : MINING                                        |
|   SOLUTIONS THIS RUN: 3                                             |
|   MINED THIS RUN    : 0.003 RPOW                                    |
|   BALANCE           : 0.026 RPOW                                    |
|   ACCOUNT MINTED    : 0.026 RPOW                                    |
|   TOTAL MINTED      : 9853625.180208776 RPOW                        |
+----------------------------------------------------------------------+

+-- LOGS --------------------------------------------------------------+
| 2026-... INFO challenge ...                                         |
+----------------------------------------------------------------------+
```

Status umum:

- `MINING`: CPU sedang mencari nonce valid
- `SUBMITTING`: nonce sudah ketemu, sedang submit ke server
- `NEXT CHALLENGE`: token diterima, lanjut challenge berikutnya
- `WARN`: ada warning, biasanya challenge lama sudah claimed/expired

## Auto Restart di VPS

Pakai script ini kalau mau miner nyala lagi otomatis saat error, koneksi putus, API timeout, atau proses CLI exit:

```bash
cd ~/RPoW-CLI
chmod +x run-forever.sh
./run-forever.sh
```

Script akan tanya pilihan seperti ini:

```text
Show live dashboard [y/N]:
Engine [native]:
Workers (max ... auto-detected) [8]:
How many tokens to mint (0 = until stopped) [0]:
HTTP timeout ms [60000]:
HTTP retries [10]:
Dashboard refresh interval ms [15000]:
Restart delay seconds [10]:
Mining log interval ms [1000]:
```

Default script:

```text
COUNT=0
ENGINE=native
RESTART_DELAY=10
LOG_EVERY_MS=1000
DASHBOARD=0
TIMEOUT=60000
RETRIES=10
STOP_ON_LOGIN_REQUIRED=1
DASHBOARD_REFRESH_MS=15000
```

Artinya mining nonstop, pakai native miner, restart 10 detik setelah crash/error, dan pakai log biasa. Jawab `y` di prompt dashboard untuk tampilan live dashboard.

Saat dashboard aktif, data reward, difficulty, halving, balance, dan total minted akan direfresh dari RPOW2 secara berkala.

Kalau session expired atau muncul `login required`, auto-restart akan berhenti supaya tidak loop terus. Login ulang dulu, lalu jalankan lagi.

Contoh VPS 4 vCPU:

```bash
WORKERS=3 ASSUME_DEFAULTS=1 ./run-forever.sh
```

Contoh VPS 8 vCPU:

```bash
WORKERS=6 ASSUME_DEFAULTS=1 ./run-forever.sh
```

Kalau mau jalan di background setelah SSH ditutup:

```bash
nohup env ASSUME_DEFAULTS=1 WORKERS=3 ./run-forever.sh > rpow-miner.log 2>&1 &
```

Lihat log:

```bash
tail -f rpow-miner.log
```

Stop proses background:

```bash
pkill -f run-forever.sh
pkill -f rpow-cli.js
pkill -f rpow-native-miner
```

Alternatif yang lebih enak: pakai `tmux`.

```bash
apt install -y tmux
tmux new -s rpow
./run-forever.sh
```

Keluar dari tmux tanpa stop miner:

```text
Ctrl+B lalu D
```

Masuk lagi:

```bash
tmux attach -t rpow
```

## Update Repo di WSL atau VPS

Masuk folder repo:

```bash
cd ~/RPoW-CLI
```

Ambil update terbaru:

```bash
git pull
```

Build ulang native miner jika ada update file C:

```bash
./build-native.sh
```

Jalankan lagi:

```bash
node rpow-cli.js
```

## Pindah Session ke VPS

Cara paling aman: login ulang di VPS pakai magic link.

Jangan upload `.rpow-cli-state.json` ke GitHub.

Kalau tetap mau copy session secara manual dari WSL ke VPS, lakukan via `scp` pribadi dan jangan share file itu:

```bash
scp ~/RPoW-CLI/.rpow-cli-state.json root@IP_VPS_KAMU:~/RPoW-CLI/.rpow-cli-state.json
```

Catatan: path state default ada di folder repo, jadi biasanya filenya:

```bash
~/RPoW-CLI/.rpow-cli-state.json
```

## Troubleshooting

Kalau `node` terlalu tua:

```bash
node -v
```

Butuh Node.js 18 atau lebih baru. Di Ubuntu lama, install NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Kalau native miner belum ada:

```bash
./build-native.sh
```

Kalau permission denied:

```bash
chmod +x build-native.sh
chmod +x rpow-native-miner
```

Kalau dashboard berantakan di terminal kecil, pakai log biasa:

```bash
node rpow-cli.js mine --count 0 --workers 4 --engine native --no-dashboard
```

Kalau dashboard berhenti di `STATUS: ERROR`, update repo lalu jalankan pakai auto-restart:

```bash
git pull
./run-forever.sh
```

Auto-restart default-nya memakai log biasa. Kalau mau live dashboard, jawab `y` saat ditanya `Show live dashboard`.

Kalau RPOW2 API sedang lambat/down, tunggu dan coba lagi. Kadang mining cepat, tapi submit `/mint` menunggu server.

Kalau di VPS muncul rate limit saat login tapi email sudah masuk:

```text
magic-link request is rate-limited
```

jangan request login berulang. Copy link terbaru dari email dan jalankan sebelum expired:

```bash
node rpow-cli.js complete-login --link "PASTE_MAGIC_LINK_DARI_EMAIL"
```

Magic link biasanya cepat expired. Kalau sudah expired, tunggu sekitar 60 detik, request link baru, lalu pakai link itu segera.

Kalau `complete-login` sempat timeout lalu retry menjadi `invalid or expired link`, token kemungkinan sudah keburu dipakai server tapi response ke VPS putus. Solusinya sama: request magic link baru, lalu pakai link terbaru.

## Apa yang Dimining?

CLI ini meminta challenge dari RPOW2, lalu CPU kamu mencari nonce yang membuat:

```text
SHA-256(nonce_prefix || uint64-le nonce)
```

memenuhi difficulty, misalnya `25 trailing zero bits`.

Kalau nonce valid ditemukan, CLI submit ke server RPOW2. Jika diterima, akun kamu mendapat 1 RPOW token di ledger RPOW2.

Ini bukan mining Bitcoin dan bukan blockchain decentralized. Ini proof-of-work token di server RPOW2.

## File Penting

```text
rpow-cli.js             CLI utama
rpow-native-miner.c     Source native miner
rpow-miner-worker.js    Fallback miner JS
build-native.sh         Build miner di Linux/WSL/VPS
build-native.ps1        Build miner di Windows
index.js                Bundle frontend untuk API map
.rpow-cli-state.json    Session lokal, jangan dishare
```

## Security Notes

CLI hanya mengizinkan request ke:

```text
api.rpow2.com
rpow2.com
www.rpow2.com
```

Yang tidak boleh dipush/share:

```text
.rpow-cli-state.json
.env
rpow-native-miner
rpow-native-miner.exe
node_modules/
```
