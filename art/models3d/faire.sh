#!/bin/sh
# Cuit un modèle fait main et refait ses textures :  sh art/models3d/faire.sh panhard [--fast]
cd "$(dirname "$0")/../.." || exit 1
n=$1; shift
/Applications/Blender.app/Contents/MacOS/Blender -b --python "art/models3d/$n.py" -- "$@" 2>&1 | grep -E "^\[$n|Error|Trace|line " 
python3 -W ignore art/models3d/pack.py "$n" && python3 -W ignore art/models3d/pack.py --all >/dev/null
