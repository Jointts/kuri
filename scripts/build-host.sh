#!/bin/sh
# Compiles the pet's helper process (host/*.ts) to plain JavaScript in host/dist/, which is what the mod runs: it needs only
# Node (18 or newer), no TypeScript and no flags. Run it after changing anything in host/, and commit the result.
#
# usage: scripts/build-host.sh        (needs `tsc` and @types/node; TSC=/path/to/tsc to name the compiler, and any extra
#                                      argument, e.g. --typeRoots <dir>, goes to tsc)
set -e
cd "$(dirname "$0")/.."
rm -rf host/dist
"${TSC:-tsc}" -p host/tsconfig.json "$@"
printf '{"type":"module"}\n' > host/dist/package.json
echo "built $(ls host/dist/*.js | wc -l | tr -d ' ') files into host/dist"
