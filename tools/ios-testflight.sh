#!/bin/sh
# Panache sur TestFlight : construit le jeu, l'archive iOS (Release) et l'envoie à App Store Connect.
#   sh tools/ios-testflight.sh            → construit et envoie
#   sh tools/ios-testflight.sh --archive  → construit et exporte l'.ipa sans l'envoyer (dans /tmp/panache-ios/export)
# La signature et l'envoi passent par la clé d'API App Store Connect (~/.appstoreconnect/private_keys/AuthKey_<id>.p8) :
# ASC_KEY_ID et ASC_ISSUER la désignent (par défaut celle de l'équipe). Le numéro de build est le nombre de commits,
# qui ne fait que croître : chaque envoi a le sien. L'app doit exister dans App Store Connect (créée une fois à la main).
set -e
cd "$(dirname "$0")/.."
KEY_ID="${ASC_KEY_ID:-P2DPLW2SRN}"
ISSUER="${ASC_ISSUER:-fb365280-db5a-48bb-84b3-98ae481c1235}"
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_$KEY_ID.p8"
OUT=/tmp/panache-ios
BUILD=$(git rev-list --count HEAD)
AUTH="-allowProvisioningUpdates -authenticationKeyPath $KEY -authenticationKeyID $KEY_ID -authenticationKeyIssuerID $ISSUER"
DEST=upload
[ "$1" = "--archive" ] && DEST=export

npm run build
npx cap sync ios
rm -rf "$OUT"
mkdir -p "$OUT"
cat > "$OUT/options.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$DEST</string>
  <key>teamID</key><string>AKMNXGVVGX</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Panache.xcarchive" -derivedDataPath "$OUT/dd" CURRENT_PROJECT_VERSION="$BUILD" $AUTH archive | tail -3
xcodebuild -exportArchive -archivePath "$OUT/Panache.xcarchive" -exportOptionsPlist "$OUT/options.plist" -exportPath "$OUT/export" $AUTH | tail -5
echo "build $BUILD : $DEST"
