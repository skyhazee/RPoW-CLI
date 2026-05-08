# Installing RPOW CLI on Another PC

## Included Files

```text
rpow-native-miner.c      Native C miner source, rebuildable for another CPU or operating system.
build-native.ps1         Windows helper script for building rpow-native-miner.exe.
build-native.sh          macOS/Linux helper script for building rpow-native-miner.
rpow-cli.js              Node.js wrapper: login, cookies, API requests, retries, logs and orchestration.
rpow-miner-worker.js     Slower JavaScript fallback miner.
README.md                Full command reference and public usage guide.
index.js                 Frontend bundle used for API discovery.
```

`.rpow-cli-state.json` is intentionally not included in shared builds because it contains cookies and session data.

## Requirements

Install Node.js 18 or newer. Node.js runs the CLI wrapper; the actual mining should use the native C miner.

```powershell
node -v
```

Build the native C miner before mining. This is the recommended mining engine.

Windows output:

```powershell
.\build-native.ps1
```

macOS/Linux output:

```bash
./build-native.sh
```

## Beginner Native C Checklist

On Windows, the easiest path is:

```powershell
node -v
```

Then build the native C miner:

1. Install MSYS2 from `https://www.msys2.org/`.
2. Open "MSYS2 MinGW x64".
3. Install gcc:

```bash
pacman -S --needed mingw-w64-x86_64-gcc
```

4. Go to the project folder:

```bash
cd /c/Users/YOUR_NAME/Downloads/rpow-native-cli-portable
```

5. Build the C miner:

```bash
gcc -O3 -march=native -pthread rpow-native-miner.c -o rpow-native-miner.exe
```

6. Check that the binary exists:

```bash
ls -l rpow-native-miner.exe
```

7. Run the CLI from PowerShell:

```powershell
node rpow-cli.js mine --count 1 --workers 8 --engine native
```

On Linux/macOS, build a native binary named `rpow-native-miner`:

```bash
./build-native.sh
node rpow-cli.js mine --count 1 --workers 8 --engine native
```

## First Run

Extract the folder and open PowerShell inside it:

```powershell
node rpow-cli.js map
node rpow-cli.js login --email you@example.com
node rpow-cli.js complete-login --link "MAGIC_LINK_FROM_EMAIL"
node rpow-cli.js mine --count 10 --workers 8 --engine native
```

## Without the Native Miner

Use the JavaScript fallback miner only when the native C miner is unavailable. It is slower, but it works without a compiled binary:

```powershell
node rpow-cli.js mine --count 1 --workers 8 --engine node
```

## Useful Commands

```powershell
node rpow-cli.js me
node rpow-cli.js ledger
node rpow-cli.js activity
node rpow-cli.js logout
```

Detailed HTTP logs:

```powershell
node rpow-cli.js mine --verbose
```

Disable colors:

```powershell
$env:NO_COLOR=1
node rpow-cli.js mine
```
