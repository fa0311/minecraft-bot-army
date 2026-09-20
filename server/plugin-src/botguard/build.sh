#!/bin/sh
# builds server/plugins/BotGuard.jar with plain javac (no Maven/Gradle). Loads at the NEXT server restart.
set -e
cd "$(dirname "$0")"
LIBS=/root/workspace/server/libraries
CP="$(find "$LIBS" -name '*.jar' | tr '\n' ':')"
rm -rf build && mkdir -p build/classes
javac --release 21 -nowarn -cp "$CP" -d build/classes src/botguard/BotGuard.java src/botguard/BotGuardTest.java
java -cp "build/classes:$CP" botguard.BotGuardTest          # name/address logic against the live roster; non-zero exit stops the build
jar cf build/BotGuard.jar -C build/classes botguard/BotGuard.class -C resources plugin.yml -C resources config.yml
# NEVER copy over the jar of a RUNNING server (same inode: the JVM's open zip goes bad). Install = new file + rename; the running JVM keeps the old inode, the next start loads the new one.
cp build/BotGuard.jar /root/workspace/server/plugins/.BotGuard.jar.new && mv /root/workspace/server/plugins/.BotGuard.jar.new /root/workspace/server/plugins/BotGuard.jar
jar tf /root/workspace/server/plugins/BotGuard.jar
