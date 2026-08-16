#!/bin/zsh
# DESC: Build the Link Keeper share-target APK with the bare SDK tools — no Gradle, no deps.
#
# The app is three Java files with zero resources and zero libraries, which is exactly the case
# where Gradle earns nothing: aapt2 links the manifest, javac compiles against android.jar,
# d8 dexes, and apksigner signs with the standard debug key. Whole build runs in seconds.
#
# Usage:
#   ./build.zsh              # → build/linkkeeper.apk
#   ./build.zsh --install    # …then adb install -r
#
# Needs: ANDROID_HOME or the default macOS SDK path, JDK 11+ on PATH.

set -euo pipefail

here=${0:A:h}
sdk=${ANDROID_HOME:-$HOME/Library/Android/sdk}
[[ -d $sdk ]] || { print -u2 "no Android SDK at $sdk — set ANDROID_HOME"; exit 1 }

# Newest installed build-tools and platform win.
bt=($sdk/build-tools/*(N/On))
platform=($sdk/platforms/android-*(N/On))
(( $#bt && $#platform )) || { print -u2 "SDK is missing build-tools or a platform"; exit 1 }
bt=$bt[1]
jar=$platform[1]/android.jar

out=$here/build
rm -rf "$out"
mkdir -p "$out/classes"

print "aapt2  : linking manifest against ${platform[1]:t}"
link_extra=()
if [[ -d $here/res ]]; then
  "$bt/aapt2" compile --dir "$here/res" -o "$out/res.zip"
  link_extra=("$out/res.zip")
fi
"$bt/aapt2" link -o "$out/base.apk" -I "$jar" --manifest "$here/AndroidManifest.xml" \
  --min-sdk-version 26 --target-sdk-version 35 $link_extra

print "javac  : compiling"
javac --release 11 -classpath "$jar" -d "$out/classes" "$here"/src/keeper/link/share/*.java

print "d8     : dexing"
"$bt/d8" --release --lib "$jar" --output "$out" "$out/classes"/keeper/link/share/*.class

# classes.dex must live at the APK root, stored alongside the linked resources.
cd "$out"
zip -qj base.apk classes.dex

print "align  : zipalign + debug signature"
"$bt/zipalign" -f 4 base.apk linkkeeper.apk

keystore=$HOME/.android/debug.keystore
if [[ ! -f $keystore ]]; then
  mkdir -p "${keystore:h}"
  keytool -genkeypair -keystore "$keystore" -storepass android -keypass android \
    -alias androiddebugkey -dname CN=Android\ Debug,O=Android,C=US \
    -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
fi
"$bt/apksigner" sign --ks "$keystore" --ks-pass pass:android "$out/linkkeeper.apk"

print "built  : ${out/#$HOME/~}/linkkeeper.apk ($(du -h "$out/linkkeeper.apk" | cut -f1 | tr -d ' '))"

if [[ ${1:-} == --install ]]; then
  adb install -r "$out/linkkeeper.apk"
fi
