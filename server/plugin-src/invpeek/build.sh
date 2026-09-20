#!/bin/sh
# builds server/plugins/InvPeek.jar with plain javac (no Maven/Gradle). Loads at the NEXT server restart.
set -e
cd "$(dirname "$0")"
CP="$(find /root/workspace/server/libraries -name '*.jar' | tr '\n' ':')"
rm -rf build && mkdir -p build/classes
javac --release 21 -nowarn -cp "$CP" -d build/classes src/invpeek/InvPeek.java
jar cf build/InvPeek.jar -C build/classes invpeek -C resources plugin.yml
cp build/InvPeek.jar /root/workspace/server/plugins/InvPeek.jar
jar tf /root/workspace/server/plugins/InvPeek.jar
