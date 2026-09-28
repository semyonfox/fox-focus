#!/usr/bin/env bash
set -euo pipefail

mobile_dir=$(cd "$(dirname "$0")/.." && pwd)
signing_dir=/home/semyon/.local/share/fox-focus-android/signing
out_dir=/home/semyon/.local/share/fox-focus-android/builds
[[ -s "$signing_dir/fox-focus.jks" && -s "$signing_dir/signing-password" ]] || {
  echo 'Fox Focus Android signing files are missing' >&2
  exit 1
}

IFS= read -r FOX_FOCUS_SIGN_PASSWORD < "$signing_dir/signing-password"
export FOX_FOCUS_SIGN_PASSWORD
export FOX_FOCUS_KEYSTORE="$signing_dir/fox-focus.jks"
export JAVA_HOME=/home/semyon/android-build-tools/jdk-21
export ANDROID_HOME=/home/semyon/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/36.0.0:$PATH"
export CI=1 NODE_ENV=production EXPO_NO_GIT_STATUS=1 CMAKE_BUILD_PARALLEL_LEVEL=1

cd "$mobile_dir"
./node_modules/.bin/expo prebuild --platform android --no-install

python3 - <<'PY'
from pathlib import Path

app = Path('android/app/build.gradle')
source = app.read_text()
release = '''    signingConfigs {
        release {
            storeFile file(System.getenv('FOX_FOCUS_KEYSTORE'))
            storePassword System.getenv('FOX_FOCUS_SIGN_PASSWORD')
            keyAlias 'fox-focus'
            keyPassword System.getenv('FOX_FOCUS_SIGN_PASSWORD')
        }
'''
needle = '    signingConfigs {\n'
old = '            signingConfig signingConfigs.debug\n            def enableShrinkResources'
if release in source and 'signingConfig signingConfigs.release' in source:
    pass
elif source.count(needle) == 1 and source.count(old) == 1:
    app.write_text(source.replace(needle, release).replace(old, old.replace('signingConfigs.debug', 'signingConfigs.release')))
else:
    raise SystemExit('Unexpected generated Android signing config')

properties = Path('android/gradle.properties')
lines = properties.read_text().splitlines()
values = {
    'org.gradle.jvmargs': '-Xmx3072m -XX:MaxMetaspaceSize=1024m',
    'org.gradle.workers.max': '1',
    'org.gradle.parallel': 'false',
    'kotlin.compiler.execution.strategy': 'in-process',
    'reactNativeArchitectures': 'arm64-v8a',
}
lines = [line for line in lines if line.split('=', 1)[0] not in values]
lines.extend(f'{key}={value}' for key, value in values.items())
properties.write_text('\n'.join(lines) + '\n')
PY

./android/gradlew --project-dir android --no-daemon :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -x lintVitalRelease
version=$(python3 -c "import json; print(json.load(open('app.json'))['expo']['version'])")
install -d -m 755 "$out_dir"
artifact="$out_dir/fox-focus-alpha-$version-arm64.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$artifact"
sha256sum "$artifact"
